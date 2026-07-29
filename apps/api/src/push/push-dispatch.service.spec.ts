/**
 * @satisfies FR-NOTIF-001
 * @satisfies FR-NOTIF-003
 *
 * Unit tests for PushDispatchService using MockPushTransport.
 * Each rule below must FAIL if the rule is removed — for the mute rule and
 * one-push-per-device rule, we demonstrate by temporarily breaking the logic,
 * showing the test go red, and restoring.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { PushDispatchService } from './push-dispatch.service';
import { MockPushTransport } from './mock-push.transport';
import { PUSH_TRANSPORT } from './push-transport.interface';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';

// ── Mock PrismaService ──────────────────────────────────────
const mockPrisma = {
  deviceToken: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  channel: {
    findUnique: jest.fn(),
  },
  notificationSetting: {
    findUnique: jest.fn(),
  },
};

// ── Mock RedisService ───────────────────────────────────────
const mockSub = {
  subscribe: jest.fn().mockResolvedValue(undefined),
  unsubscribe: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
};
const mockRedis = {
  getSubscriber: jest.fn().mockReturnValue(mockSub),
};

describe('PushDispatchService', () => {
  let service: PushDispatchService;
  let transport: MockPushTransport;

  const USER_ID = 'user-aaa';
  const CHANNEL_ID = 'ch-111';
  const SERVER_ID = 'srv-222';
  const DEVICE_TOKENS = ['tok-a', 'tok-b', 'tok-c'];

  beforeEach(async () => {
    // Reset all mocks
    jest.clearAllMocks();
    transport = new MockPushTransport();
    transport.reset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushDispatchService,
        { provide: PUSH_TRANSPORT, useValue: transport },
        { provide: RedisService, useValue: mockRedis },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(PushDispatchService);

    // Default: 3 active device tokens (all android to preserve existing test behaviour)
    mockPrisma.deviceToken.findMany.mockResolvedValue(
      DEVICE_TOKENS.map((t) => ({ token: t, platform: 'android' })),
    );
    // Default: channel exists with a server
    mockPrisma.channel.findUnique.mockResolvedValue({ serverId: SERVER_ID });
    // Default: no notification settings (allows everything)
    mockPrisma.notificationSetting.findUnique.mockResolvedValue(null);
    // Default: updateMany / deleteMany succeed
    mockPrisma.deviceToken.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.deviceToken.deleteMany.mockResolvedValue({ count: 0 });
  });

  // ── FR-NOTIF-001: MENTION → push ──────────────────────────
  it('sends push on MENTION event', async () => {
    await service.handleEvent({
      type: 'MENTION',
      userId: USER_ID,
      channelId: CHANNEL_ID,
      authorName: 'Alice',
      preview: 'Hey @you check this out',
      messageId: 'msg-1',
    });

    expect(transport.sends.length).toBe(1);
    expect(transport.sends[0].tokens).toEqual(DEVICE_TOKENS);
    expect(transport.sends[0].payload.title).toContain('Alice');
    expect(transport.sends[0].payload.data?.type).toBe('mention');
  });

  // ── FR-NOTIF-001: NOTIFY → push ───────────────────────────
  it('sends push on NOTIFY event (no settings check)', async () => {
    await service.handleEvent({ type: 'NOTIFY', userId: USER_ID });

    expect(transport.sends.length).toBe(1);
    expect(transport.sends[0].tokens).toEqual(DEVICE_TOKENS);
    expect(transport.sends[0].payload.title).toBe('New notification');
  });

  it('preserves an explicit DM route in the push data payload', async () => {
    await service.handleEvent({
      type: 'NOTIFY',
      userId: USER_ID,
      channelId: CHANNEL_ID,
      dmChannelId: CHANNEL_ID,
    });

    expect(transport.sends[0].payload.data).toMatchObject({
      type: 'notify',
      channelId: CHANNEL_ID,
      dmChannelId: CHANNEL_ID,
    });
  });

  // ── FR-NOTIF-001: CALL_RING → push ────────────────────────
  it('sends push on CALL_RING event', async () => {
    await service.handleEvent({
      type: 'CALL_RING',
      userId: USER_ID,
      channelId: CHANNEL_ID,
      callerId: 'caller-99',
      callerName: 'Bob',
    });

    expect(transport.sends.length).toBe(1);
    expect(transport.sends[0].payload.title).toBe('Incoming call');
    expect(transport.sends[0].payload.body).toContain('Bob');
  });

  // ── Zero devices → no push, no error ─────────────────────
  it('does not send push when user has zero device tokens', async () => {
    mockPrisma.deviceToken.findMany.mockResolvedValue([]);

    await service.handleEvent({ type: 'NOTIFY', userId: USER_ID });

    expect(transport.sends.length).toBe(0);
  });

  // ── Exactly one push per active device ───────────────────
  it('sends exactly one push per active device (N tokens → 1 send with N tokens)', async () => {
    await service.handleEvent({ type: 'NOTIFY', userId: USER_ID });

    expect(transport.sends.length).toBe(1);
    expect(transport.sends[0].tokens).toHaveLength(3);
    // Verify: NOT N×N (not 3 sends × 3 tokens each)
  });

  // ── FR-NOTIF-003: mute enforcement ───────────────────────
  describe('FR-NOTIF-003 — notification settings', () => {
    it('suppresses push when channel is set to NONE', async () => {
      mockPrisma.notificationSetting.findUnique.mockResolvedValue({
        level: 'NONE',
        mutedUntil: null,
      });

      await service.handleEvent({
        type: 'MENTION',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        authorName: 'Alice',
        preview: 'hey',
      });

      expect(transport.sends.length).toBe(0);
    });

    it('suppresses push when server is set to NONE', async () => {
      // channel-level returns null (no setting), server-level returns NONE
      mockPrisma.notificationSetting.findUnique
        .mockResolvedValueOnce(null) // CHANNEL lookup
        .mockResolvedValueOnce({ level: 'NONE', mutedUntil: null }); // SERVER lookup

      await service.handleEvent({
        type: 'MENTION',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        authorName: 'Alice',
        preview: 'hey',
      });

      expect(transport.sends.length).toBe(0);
    });

    it('allows MENTION push when server is set to MENTIONS', async () => {
      mockPrisma.notificationSetting.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ level: 'MENTIONS', mutedUntil: null });

      await service.handleEvent({
        type: 'MENTION',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        authorName: 'Alice',
        preview: 'hey',
      });

      expect(transport.sends.length).toBe(1);
    });

    it('suppresses CALL_RING push when server is set to MENTIONS (call needs ALL)', async () => {
      // CALL_RING requires level ALL. Server set to MENTIONS should suppress.
      mockPrisma.notificationSetting.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ level: 'MENTIONS', mutedUntil: null });

      await service.handleEvent({
        type: 'CALL_RING',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        callerId: 'caller-99',
        callerName: 'Bob',
      });

      expect(transport.sends.length).toBe(0);
    });

    it('suppresses push when mutedUntil is in the future', async () => {
      const future = new Date(Date.now() + 3600_000);
      mockPrisma.notificationSetting.findUnique.mockResolvedValue({
        level: 'ALL',
        mutedUntil: future,
      });

      await service.handleEvent({
        type: 'MENTION',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        authorName: 'Alice',
        preview: 'hey',
      });

      expect(transport.sends.length).toBe(0);
    });

    it('allows push when mutedUntil is in the past', async () => {
      const past = new Date(Date.now() - 3600_000);
      mockPrisma.notificationSetting.findUnique.mockResolvedValue({
        level: 'ALL',
        mutedUntil: past,
      });

      await service.handleEvent({
        type: 'MENTION',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        authorName: 'Alice',
        preview: 'hey',
      });

      expect(transport.sends.length).toBe(1);
    });

    it('channel-level NONE overrides server-level ALL', async () => {
      mockPrisma.notificationSetting.findUnique
        .mockResolvedValueOnce({ level: 'NONE', mutedUntil: null }) // CHANNEL
        .mockResolvedValueOnce({ level: 'ALL', mutedUntil: null }); // SERVER

      await service.handleEvent({
        type: 'MENTION',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        authorName: 'Alice',
        preview: 'hey',
      });

      expect(transport.sends.length).toBe(0);
    });

    it('NOTIFY bypasses notification settings (no channel context)', async () => {
      // Even if settings exist, NOTIFY has no channelId so settings don't apply
      mockPrisma.notificationSetting.findUnique.mockResolvedValue({
        level: 'NONE',
        mutedUntil: null,
      });

      await service.handleEvent({ type: 'NOTIFY', userId: USER_ID });

      // NOTIFY events don't call shouldPush at all
      expect(transport.sends.length).toBe(1);
    });
  });

  // ── Token pruning ─────────────────────────────────────────
  describe('token pruning', () => {
    it('prunes invalid tokens reported by transport', async () => {
      transport.setInvalidTokens(['tok-b']);

      await service.handleEvent({ type: 'NOTIFY', userId: USER_ID });

      expect(mockPrisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { token: { in: ['tok-b'] } },
      });
    });

    it('updates lastSeen on successful tokens', async () => {
      await service.handleEvent({ type: 'NOTIFY', userId: USER_ID });

      expect(mockPrisma.deviceToken.updateMany).toHaveBeenCalledWith({
        where: { token: { in: ['tok-a', 'tok-b', 'tok-c'] } },
        data: { lastSeen: expect.any(Date) },
      });
    });

    it('does not update lastSeen for pruned tokens', async () => {
      transport.setInvalidTokens(['tok-b']);

      await service.handleEvent({ type: 'NOTIFY', userId: USER_ID });

      // tok-b should be excluded from updateMany
      expect(mockPrisma.deviceToken.updateMany).toHaveBeenCalledWith({
        where: { token: { in: ['tok-a', 'tok-c'] } },
        data: { lastSeen: expect.any(Date) },
      });
    });
  });

  // ── Unknown event types are ignored ──────────────────────
  it('ignores non-push event types', async () => {
    await service.handleEvent({ type: 'MESSAGE_CREATED' } as unknown as Parameters<typeof service.handleEvent>[0]);

    expect(transport.sends.length).toBe(0);
  });

  // ── Platform-specific payload shaping ────────────────────
  describe('platform-specific payload', () => {
    it('iOS token → apns block present, android block absent', async () => {
      mockPrisma.deviceToken.findMany.mockResolvedValue([
        { token: 'tok-ios-1', platform: 'ios' },
      ]);

      await service.handleEvent({
        type: 'MENTION',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        authorName: 'Alice',
        preview: 'Hey @you',
        messageId: 'msg-1',
      });

      expect(transport.sends.length).toBe(1);
      const s = transport.sends[0];
      expect(s.tokens).toEqual(['tok-ios-1']);
      expect(s.payload.apns).toBeDefined();
      expect(s.payload.android).toBeUndefined();
      expect(s.payload.apns?.headers?.['apns-push-type']).toBe('alert');
      expect(s.payload.apns?.payload.aps.alert?.title).toContain('Alice');
      expect(s.payload.apns?.payload.aps.alert?.body).toBe('Hey @you');
      expect(s.payload.apns?.payload.aps.sound).toBe('default');
      expect(s.payload.apns?.payload.aps.badge).toBe(1);
      expect(s.payload.apns?.payload.aps['content-available']).toBe(1);
    });

    it('Android token → android block present, apns block absent', async () => {
      mockPrisma.deviceToken.findMany.mockResolvedValue([
        { token: 'tok-and-1', platform: 'android' },
      ]);

      await service.handleEvent({
        type: 'NOTIFY',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        authorName: 'Bob',
        preview: 'Hello',
      });

      expect(transport.sends.length).toBe(1);
      const s = transport.sends[0];
      expect(s.tokens).toEqual(['tok-and-1']);
      expect(s.payload.android).toBeDefined();
      expect(s.payload.apns).toBeUndefined();
      expect(s.payload.android?.channelId).toBe('notifications');
    });

    it('mixed batch → two send calls with correct platform payloads', async () => {
      mockPrisma.deviceToken.findMany.mockResolvedValue([
        { token: 'tok-and-1', platform: 'android' },
        { token: 'tok-ios-1', platform: 'ios' },
        { token: 'tok-and-2', platform: 'android' },
      ]);

      await service.handleEvent({
        type: 'MENTION',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        authorName: 'Alice',
        preview: 'ping',
        messageId: 'msg-1',
      });

      expect(transport.sends.length).toBe(2);

      const androidSend = transport.sends.find((s) =>
        s.tokens.every((t) => t.startsWith('tok-and')),
      );
      expect(androidSend).toBeDefined();
      expect(androidSend!.tokens).toEqual(['tok-and-1', 'tok-and-2']);
      expect(androidSend!.payload.android).toBeDefined();
      expect(androidSend!.payload.apns).toBeUndefined();

      const iosSend = transport.sends.find((s) =>
        s.tokens.every((t) => t.startsWith('tok-ios')),
      );
      expect(iosSend).toBeDefined();
      expect(iosSend!.tokens).toEqual(['tok-ios-1']);
      expect(iosSend!.payload.apns).toBeDefined();
      expect(iosSend!.payload.android).toBeUndefined();
    });

    it('CALL_RING iOS → voip push-type with apns-priority', async () => {
      mockPrisma.deviceToken.findMany.mockResolvedValue([
        { token: 'tok-ios-1', platform: 'ios' },
      ]);

      await service.handleEvent({
        type: 'CALL_RING',
        userId: USER_ID,
        channelId: CHANNEL_ID,
        callerId: 'caller-99',
        callerName: 'Bob',
      });

      expect(transport.sends.length).toBe(1);
      const s = transport.sends[0];
      expect(s.payload.apns?.headers?.['apns-push-type']).toBe('voip');
      expect(s.payload.apns?.headers?.['apns-priority']).toBe('10');
      expect(s.payload.apns?.payload.aps.alert?.title).toBe('Incoming call');
      expect(s.payload.apns?.payload.aps.alert?.body).toContain('Bob');
      expect(s.payload.apns?.payload.aps.sound).toBe('call_ring.aiff');
      expect(s.payload.apns?.payload.aps['content-available']).toBeUndefined();
      expect(s.payload.apns?.payload.aps.badge).toBeUndefined();
    });
  });

});
