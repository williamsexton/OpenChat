/**
 * @satisfies FR-NOTIF-001
 * @satisfies FR-NOTIF-003
 *
 * Integration tests: MessagesService.create() → redis.publish → PushDispatchService.handleEvent → MockPushTransport.
 * Services are manually wired to avoid NestJS DI complexity — we test the business
 * chain, not the DI container.
 *
 * Every push path goes through the redis event bus. PushDispatchService is reached
 * ONLY by subscribing to chat:events, never by a direct method call from a service.
 *
 * One test per push case: DM, server-channel message, and @mention.
 * Plus a double-dispatch proof: one @mention → exactly ONE send.
 *
 * Perturb-and-restore: temporarily remove the redis publish, confirm test FAILS,
 * restore, confirm it PASSES. A test that passes with the feature removed proves nothing.
 */
import { MessagesService } from '../messages/messages.service';
import { PushDispatchService } from './push-dispatch.service';
import { MockPushTransport } from './mock-push.transport';

// ── Helpers ────────────────────────────────────────────────────
const NOW = new Date('2026-07-26T00:00:00Z');

function makePrismaMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'msg-1',
    channelId: overrides.channelId ?? 'ch-1',
    authorId: overrides.authorId ?? 'author-1',
    content: overrides.content ?? 'hello world',
    createdAt: NOW,
    editedAt: null,
    deletedAt: null,
    replyToId: null,
    pinned: false,
    author: {
      id: overrides.authorId ?? 'author-1',
      username: 'author',
      displayName: (overrides.authorName as string) ?? 'Author Name',
      avatarUrl: null,
      status: 'ONLINE',
    },
    attachments: [],
    reactions: [],
    replyTo: null,
    poll: null,
  };
}

interface MockPrismaConfig {
  channelServerId?: string | null;
  channelName?: string;
  authorId?: string;
  dmRecipients?: string[];
  serverMembers?: string[];
  deviceTokens?: string[];
  /** Per-member detail for @mention resolution (serverMember.findMany returns these) */
  memberDetails?: Array<{ userId: string; user: { username: string; displayName: string; status: string }; roles: Array<{ id: string; name: string; permissions: bigint }> }>;
}

function buildMockPrisma(cfg: MockPrismaConfig = {}) {
  const channelServerId = cfg.channelServerId ?? null;
  const channelName = cfg.channelName ?? 'general';
  const authorId = cfg.authorId ?? 'author-1';
  const tokens: string[] = cfg.deviceTokens ?? [];

  // findUnique returns { serverId } for channel lookups, but dispatchMentions
  // also looks up channel with name. We keep the result consistent.
  const channelLookup = jest.fn().mockImplementation((args: { where?: { id?: string }; select?: unknown }) => {
    if (args.where?.id === 'ch-1') {
      const result: Record<string, unknown> = {};
      if (!args.select || (args.select as Record<string, boolean>).serverId) result.serverId = channelServerId;
      if (!args.select || (args.select as Record<string, boolean>).name) result.name = channelName;
      return Promise.resolve(result);
    }
    return Promise.resolve(null);
  });

  const messageCreate = jest.fn().mockResolvedValue(
    makePrismaMessage({ channelId: 'ch-1', authorId, authorName: 'Author Name', content: 'hello' }),
  );

  const serverMemberFindUnique = jest.fn().mockResolvedValue(
    channelServerId ? { serverId: channelServerId, userId: authorId } : null,
  );

  const dmMemberFindMany = jest.fn().mockResolvedValue(
    (cfg.dmRecipients ?? [authorId, 'recip-1']).map((uid) => ({
      userId: uid,
      user: { username: uid, displayName: `User ${uid}` },
    })),
  );

  const srvMemberFindManyResolved =
    cfg.memberDetails ??
    (cfg.serverMembers ?? [authorId, 'member-2']).map((uid) => ({
      userId: uid,
      user: { username: uid === authorId ? 'author' : uid, displayName: uid === authorId ? 'Author Name' : `User ${uid}`, status: 'ONLINE' as const },
      roles: [] as Array<{ id: string; name: string; permissions: bigint }>,
    }));

  const serverMemberFindMany = jest.fn().mockImplementation((args: any) => {
    const filter = args?.where?.OR;
    if (filter && Array.isArray(filter)) {
      const usernames = new Set(filter.map((f: any) => f?.user?.username?.equals?.toLowerCase()).filter(Boolean));
      if (usernames.size > 0) {
        return Promise.resolve(srvMemberFindManyResolved.filter((m: any) => usernames.has(m.user.username.toLowerCase())));
      }
    }
    return Promise.resolve(srvMemberFindManyResolved);
  });

  const channelRecipientFindUnique = jest.fn().mockResolvedValue(
    channelServerId === null ? { channelId: 'ch-1', userId: authorId } : null,
  );

  const channelRecipientFindMany = jest.fn().mockResolvedValue(
    (cfg.dmRecipients ?? [authorId, 'recip-1']).map((uid) => ({
      userId: uid,
      user: { username: uid, displayName: `User ${uid}` },
    })),
  );

  const notificationSettingFindUnique = jest.fn().mockResolvedValue(null);

  const deviceTokenFindMany = jest.fn().mockResolvedValue(
    tokens.map((t) => ({ token: t, platform: 'android' })),
  );
  const deviceTokenUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
  const deviceTokenDeleteMany = jest.fn().mockResolvedValue({ count: 0 });

  const roleFindMany = jest.fn().mockResolvedValue([]);
  const serverFindUnique = jest.fn().mockResolvedValue({ ownerId: authorId, id: channelServerId });

  const tx = { message: { create: messageCreate } };

  const mockPrisma = {
    message: {
      create: messageCreate,
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    channel: {
      findUnique: channelLookup,
      findMany: jest.fn(),
    },
    serverMember: {
      findUnique: serverMemberFindUnique,
      findMany: serverMemberFindMany,
    },
    channelRecipient: {
      findUnique: channelRecipientFindUnique,
      findMany: channelRecipientFindMany,
    },
    notificationSetting: {
      findUnique: notificationSettingFindUnique,
    },
    deviceToken: {
      findMany: deviceTokenFindMany,
      updateMany: deviceTokenUpdateMany,
      deleteMany: deviceTokenDeleteMany,
    },
    role: {
      findMany: roleFindMany,
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: authorId, username: 'author', displayName: 'Author Name' }),
    },
    server: {
      findUnique: serverFindUnique,
    },
    $transaction: jest.fn().mockImplementation(async (cb: Function) => cb(tx)),
  };
  return mockPrisma;
}

function buildMockRedis() {
  return {
    getSubscriber: jest.fn().mockReturnValue({
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    }),
    publish: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn().mockReturnValue({ publish: jest.fn().mockResolvedValue(undefined) }),
    setEx: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
  };
}

// ── Tests ──────────────────────────────────────────────────────
describe('Push dispatch integration — MessagesService → redis → PushDispatchService', () => {
  let svc: MessagesService;
  let transport: MockPushTransport;
  let pushDispatch: PushDispatchService;
  let prisma: ReturnType<typeof buildMockPrisma>;
  let redis: ReturnType<typeof buildMockRedis>;
  let capturedHandler: (channel: string, raw: string) => void;

  const mkSvc = async (
    cfg: MockPrismaConfig = {},
    serversOverride?: Partial<ReturnType<typeof makeServers>>,
  ) => {
    transport = new MockPushTransport();
    transport.reset();
    prisma = buildMockPrisma(cfg);
    redis = buildMockRedis();

    pushDispatch = new PushDispatchService(redis as any, prisma as any, transport as any);
    await pushDispatch.onModuleInit();
    // Capture the real subscriber callback registered in onModuleInit
    capturedHandler = redis.getSubscriber().on.mock.calls[0][1];

    const servers = Object.assign(makeServers(cfg.authorId ?? 'author-1'), serversOverride);
    const auditLog = { write: jest.fn().mockResolvedValue(undefined) };

    // MessagesService no longer injects PushDispatchService — everything goes through redis
    const presence = { isActive: jest.fn().mockReturnValue(false) };
    svc = new MessagesService(prisma as any, redis as any, auditLog as any, servers as any, presence as any);
    (svc as any).logger = { error: jest.fn() }; // suppress real logger noise
    return { pushDispatch, servers };
  };

  function makeServers(authorId: string) {
    return {
      assertNotTimedOut: jest.fn().mockResolvedValue(undefined),
      getChannelPermissions: jest.fn().mockResolvedValue(
        // eslint-disable-next-line @typescript-eslint/no-loss-of-precision
        BigInt(0xFFFFFFFFFFFFFFFEn), // all perms (not quite all-1s to avoid exact ADMINISTRATOR)
      ),
    };
  }

  /**
   * Helper: extract events published to 'chat:events' by type.
   * redis.publish(channel, payload) — we capture calls to redis.publish.
   */
  function publishedEvents(type?: string): Array<Record<string, unknown>> {
    const calls = (redis.publish as jest.Mock).mock.calls;
    const events: Array<Record<string, unknown>> = [];
    for (const [channel, payload] of calls) {
      if (channel === 'chat:events') {
        if (!type || (payload as Record<string, unknown>).type === type) {
          events.push(payload as Record<string, unknown>);
        }
      }
    }
    return events;
  }

  // ── Case 1: DM received ──────────────────────────────────────
  describe('Case 1 — DM received (recipient not author)', () => {
    it('publishes NOTIFY to redis, then handleEvent dispatches push', async () => {
      await mkSvc({
        channelServerId: null,
        channelName: 'DM with Recip',
        authorId: 'author-1',
        dmRecipients: ['author-1', 'recip-1'],
        deviceTokens: ['tok-recip-1'],
      });

      await svc.create('ch-1', 'author-1', { content: 'hey from DM' });
      // Let fire-and-forget dispatchNotify settle (now uses redis.publish)
      await new Promise((r) => setTimeout(r, 100));

      // Verify redis publish happened
      const notifyEvents = publishedEvents('NOTIFY');
      expect(notifyEvents.length).toBe(1);
      expect(notifyEvents[0].userId).toBe('recip-1');
      expect(notifyEvents[0].channelId).toBe('ch-1');
      expect(notifyEvents[0].dmChannelId).toBe('ch-1');
      expect(notifyEvents[0].serverId).toBeUndefined();

      // Simulate the PushDispatchService subscriber: feed the published event
      capturedHandler('chat:events', JSON.stringify(notifyEvents[0]));
      await new Promise((r) => setTimeout(r, 50));
      // Now verify transport received the send
      expect(transport.sends.length).toBe(1);
      const s = transport.sends[0];
      expect(s.tokens).toContain('tok-recip-1');
      expect(s.payload.data?.type).toBe('notify');
      expect(s.payload.data?.channelId).toBe('ch-1');
      expect(s.payload.data?.dmChannelId).toBe('ch-1');
      expect(s.payload.title).toContain('Author Name');
    });
  });

  // ── Case 2: Server channel message ───────────────────────────
  describe('Case 2 — Server channel message', () => {
    it('publishes NOTIFY to all non-author server members via redis', async () => {
      await mkSvc({
        channelServerId: 'srv-1',
        channelName: 'general',
        authorId: 'author-1',
        serverMembers: ['author-1', 'member-2', 'member-3'],
        deviceTokens: ['tok-m2', 'tok-m3'],
      });

      await svc.create('ch-1', 'author-1', { content: 'hello server' });
      await new Promise((r) => setTimeout(r, 100));

      // Verify redis publish happened for each non-author member
      const notifyEvents = publishedEvents('NOTIFY');
      expect(notifyEvents.length).toBe(2);
      expect(notifyEvents[0].serverId).toBe('srv-1');
      expect(notifyEvents[0].dmChannelId).toBeUndefined();
      const userIds = notifyEvents.map((e) => e.userId).sort();
      expect(userIds).toEqual(['member-2', 'member-3']);

      // Author should NOT be in the published events
      expect(notifyEvents.find((e) => e.userId === 'author-1')).toBeUndefined();

      for (const evt of notifyEvents) {
        capturedHandler('chat:events', JSON.stringify(evt));
        await new Promise((r) => setTimeout(r, 50));
      }

      // Verify transport sends for each non-author member
      expect(transport.sends.length).toBe(2);
      const allTokens = transport.sends.flatMap((s) => s.tokens);
      expect(allTokens).toContain('tok-m2');
      expect(allTokens).toContain('tok-m3');
      for (const s of transport.sends) {
        expect(s.tokens).not.toContain('tok-author');
        expect(s.payload.data?.type).toBe('notify');
        expect(s.payload.title).toContain('Author Name');
      }
    });
  });

  // ── Case 3: @mention ─────────────────────────────────────────
  describe('Case 3 — @mention in a server channel', () => {
    it('publishes MENTION to redis (exactly one), then handleEvent dispatches exactly one push', async () => {
      await mkSvc({
        channelServerId: 'srv-1',
        channelName: 'general',
        authorId: 'author-1',
        serverMembers: ['author-1', 'member-2', 'member-3'],
        deviceTokens: ['tok-m2'],
        memberDetails: [
          { userId: 'author-1', user: { username: 'author', displayName: 'Author Name', status: 'ONLINE' }, roles: [] },
          { userId: 'member-2', user: { username: 'member2', displayName: 'Member Two', status: 'ONLINE' }, roles: [] },
          { userId: 'member-3', user: { username: 'member3', displayName: 'Member Three', status: 'ONLINE' }, roles: [] },
        ],
      });

      await svc.create('ch-1', 'author-1', { content: 'hey @member2 check this' });
      await new Promise((r) => setTimeout(r, 100));

      // ── DOUBLE-DISPATCH PROOF: exactly ONE MENTION publish ──
      const mentionEvents = publishedEvents('MENTION');
      expect(mentionEvents.length).toBe(1);
      expect(mentionEvents[0].userId).toBe('member-2');
      expect(mentionEvents[0].type).toBe('MENTION');

      capturedHandler('chat:events', JSON.stringify(mentionEvents[0]));
      await new Promise((r) => setTimeout(r, 50));

      // Exactly ONE MENTION send
      const mentionSends = transport.sends.filter((s) => s.payload.data?.type === 'mention');
      expect(mentionSends.length).toBe(1);
      expect(mentionSends[0].tokens).toContain('tok-m2');
      expect(mentionSends[0].payload.title).toContain('mentioned you');

      // NOTIFY events also publish (for non-author recipients without @mention)
      const notifyEvents = publishedEvents('NOTIFY');
      const notifyTargets = notifyEvents.map((e) => e.userId).sort();
      expect(notifyTargets).toEqual(['member-2', 'member-3']);
    });
  });

  // ── Case 4: Double-dispatch is dead ──────────────────────────
  describe('Case 4 — double-dispatch proof', () => {
    it('one @mention produces EXACTLY ONE send, not two', async () => {
      await mkSvc({
        channelServerId: 'srv-1',
        channelName: 'general',
        authorId: 'author-1',
        serverMembers: ['author-1', 'member-2'],
        deviceTokens: ['tok-m2'],
        memberDetails: [
          { userId: 'author-1', user: { username: 'author', displayName: 'Author Name', status: 'ONLINE' }, roles: [] },
          { userId: 'member-2', user: { username: 'member2', displayName: 'Member Two', status: 'ONLINE' }, roles: [] },
        ],
      });

      await svc.create('ch-1', 'author-1', { content: '@member2 hello' });
      await new Promise((r) => setTimeout(r, 100));

      // Only one MENTION published to redis
      const mentionEvents = publishedEvents('MENTION');
      expect(mentionEvents.length).toBe(1);

      capturedHandler('chat:events', JSON.stringify(mentionEvents[0]));
      await new Promise((r) => setTimeout(r, 50));

      // Exactly one send
      expect(transport.sends.length).toBe(1);
      const mentionSends = transport.sends.filter((s) => s.payload.data?.type === 'mention');
      expect(mentionSends.length).toBe(1);
    });
  });

  // ── Negative: filter guards ───────────────────────────────────
  describe('Negative — filter guards', () => {
    it('ignores non-push event types (e.g. MESSAGE_CREATED)', async () => {
      await mkSvc({
        channelServerId: null,
        authorId: 'author-1',
        dmRecipients: ['author-1', 'recip-1'],
        deviceTokens: ['tok-recip-1'],
      });
      capturedHandler('chat:events', JSON.stringify({ type: 'MESSAGE_CREATED', userId: 'recip-1', channelId: 'ch-1' }));
      await new Promise((r) => setTimeout(r, 50));
      expect(transport.sends.length).toBe(0);
    });

    it('ignores malformed JSON without throwing', async () => {
      await mkSvc({
        channelServerId: null,
        authorId: 'author-1',
        dmRecipients: ['author-1', 'recip-1'],
        deviceTokens: ['tok-recip-1'],
      });
      expect(() => capturedHandler('chat:events', 'not valid json{{{')).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
      expect(transport.sends.length).toBe(0);
    });
  });
});

// ── Perturb-and-restore proof ──────────────────────────────────
//
// To prove these tests are not vacuous, temporarily remove the redis.publish calls:
//
//   1. In dispatchMentions (messages.service.ts), comment out the
//      `await this.redis.publish('chat:events', { ... })` line.
//      Cases 3 and 4 FAIL — no MENTION published, the subscriber callback never fires.
//
//   2. In dispatchNotify (messages.service.ts), comment out the
//      `this.redis.publish('chat:events', { ... }).catch(() => {})` line.
//      Cases 1 and 2 FAIL — no NOTIFY published, the subscriber callback never fires.
//
//   3. To prove the JSON round-trip is exercised: temporarily pass a raw object
//      instead of JSON.stringify(...) to capturedHandler. The tests FAIL because
//      JSON.parse receives an object instead of a string. Restore JSON.stringify
//      and all tests PASS. A test that passes with object input is not exercising
//      the real subscriber callback.
//
// Restore the lines and all tests PASS again.
