/**
 * Unit tests: localNotify.ts (WO-NOTIF-LOCAL).
 *
 * Covers every acceptance criterion from the work order using the
 * existing src/__mocks__/expo-notifications.ts mock.
 *
 * Acceptance criteria:
 *  1. backgrounded + incoming DM → local notification presented (title + body from event)
 *  2. foregrounded + incoming DM → NO system notification; handleForegroundNotification called
 *  3. message authored by current user never notifies (either state)
 *  4. muted channel does not notify on plain message but notifies on @mention of current user
 *  5. @mention and DM both notify while backgrounded
 */

import { notifyIncoming } from '../localNotify';
import {
  _setScheduleForTest,
  _resetScheduleForTest,
  _setAppStateForTest,
  _resetAppStateForTest,
  _resetPermRequestedForTest,
  _setRemotePushPreferredForTest,
  _resetRemotePushPreferredForTest,
} from '../localNotify';
import { queryClient } from '../../../sync/queryClient';
import { keys } from '../../../sync/keys';
import { useSession } from '../../../stores/session';
import type {
  MessageCreatedFrame,
  MentionFrame,
} from '../../../realtime/events.d';
import type {
  DmChannelDto,
  NotificationSetting,
  Server,
  Channel,
} from '../../../api/schema';
import type * as Notifications from 'expo-notifications';
import { _setStoredTokenForTest } from '../push';

// ── Helpers ──

const CURRENT_USER = {
  id: 'user-me',
  username: 'me',
  displayName: 'Me',
};

const OTHER_USER = {
  id: 'user-alice',
  username: 'alice',
  displayName: 'Alice',
};

function makeMessageCreatedFrame(overrides: {
  channelId?: string;
  authorId?: string;
  authorName?: string;
  content?: string;
} = {}): MessageCreatedFrame {
  return {
    op: 'message.created',
    d: {
      message: {
        id: 'msg-1',
        channelId: overrides.channelId ?? 'ch-shared',
        authorId: overrides.authorId ?? OTHER_USER.id,
        author: {
          id: overrides.authorId ?? OTHER_USER.id,
          username: overrides.authorName ?? OTHER_USER.username,
          displayName: overrides.authorName ?? OTHER_USER.displayName,
          avatarUrl: null,
          status: null,
        },
        content: overrides.content ?? 'Hello!',
        nonce: null,
        editedAt: null,
        deletedAt: null,
        replyToId: null,
        replyTo: null,
        attachments: [],
        reactions: [],
        pinned: false,
        poll: null,
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    },
  };
}

function makeMentionFrame(overrides: {
  channelId?: string;
  authorName?: string;
  preview?: string;
  channelName?: string;
} = {}): MentionFrame {
  return {
    op: 'mention',
    d: {
      channelId: overrides.channelId ?? 'ch-shared',
      messageId: 'msg-mention-1',
      channelName: overrides.channelName ?? 'general',
      authorName: overrides.authorName ?? OTHER_USER.displayName,
      preview: overrides.preview ?? 'hey @me check this',
    },
  };
}

function makeDmChannel(channelId: string): DmChannelDto {
  return {
    id: channelId,
    type: 'DM',
    recipients: [
      {
        id: CURRENT_USER.id,
        username: CURRENT_USER.username,
        displayName: CURRENT_USER.displayName,
        avatarUrl: null,
        status: 'online',
      },
      {
        id: OTHER_USER.id,
        username: OTHER_USER.username,
        displayName: OTHER_USER.displayName,
        avatarUrl: null,
        status: 'online',
      },
    ],
    lastMessageAt: '2026-07-27T00:00:00.000Z',
  };
}

function makeNotificationSetting(
  channelId: string,
  level: NotificationSetting['level'],
): NotificationSetting {
  return {
    id: `ns-${channelId}`,
    userId: CURRENT_USER.id,
    scope: 'CHANNEL',
    scopeId: channelId,
    level,
    mutedUntil: null,
  };
}

function makeServer(id: string): Server {
  return {
    id,
    name: `Server ${id}`,
    ownerId: CURRENT_USER.id,
    iconUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    myPermissions: '0',
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-shared',
    serverId: 'srv-1',
    name: 'general',
    type: 'TEXT',
    topic: null,
    categoryId: null,
    parentId: null,
    position: 0,
    ...overrides,
  };
}

// ── Mock scheduleNotificationAsync ──

let scheduleCalls: Array<Parameters<typeof Notifications.scheduleNotificationAsync>[0]> = [];

beforeEach(() => {
  scheduleCalls = [];
  _setScheduleForTest(
    ((opts: Parameters<typeof Notifications.scheduleNotificationAsync>[0]) => {
      scheduleCalls.push(opts);
      return Promise.resolve('local-notif-id');
    }) as typeof Notifications.scheduleNotificationAsync,
  );
  // Default: foregrounded
  _setAppStateForTest('active');
  // Default: signed in as CURRENT_USER
  useSession.setState({
    status: 'signedIn',
    user: {
      ...CURRENT_USER,
      avatarUrl: null,
      status: 'online',
      friendCode: null,
    },
    tokens: null as any,
  });
  // Clear query cache
  queryClient.clear();
  _resetPermRequestedForTest();
  _setRemotePushPreferredForTest(false);
  _setStoredTokenForTest(null);
});

afterEach(() => {
  _resetScheduleForTest();
  _resetAppStateForTest();
  _resetRemotePushPreferredForTest();
  useSession.setState({ status: 'signedOut', user: null, tokens: null });
  _setStoredTokenForTest(null);
});

// ── AC1: backgrounded + incoming DM → local notification presented ──

describe('AC1: backgrounded + incoming DM', () => {
  it('presents a local notification with title and body from the event', () => {
    // Seed DM channel in cache
    queryClient.setQueryData<DmChannelDto[]>(['dms'], [
      makeDmChannel('dm-1'),
    ]);

    // Backgrounded
    _setAppStateForTest('background');

    const frame = makeMessageCreatedFrame({
      channelId: 'dm-1',
      content: 'Hey from DM!',
    });

    notifyIncoming(frame);

    expect(scheduleCalls).toHaveLength(1);
    const call = scheduleCalls[0]!;
    expect(call.content.title).toBe(OTHER_USER.displayName);
    expect(call.content.body).toBe('Hey from DM!');
    expect(call.content.data).toEqual({ dmChannelId: 'dm-1' });
    expect(call.trigger).toBeNull();
  });

  it('does not duplicate Firebase/APNs when a remote token is registered', () => {
    queryClient.setQueryData<DmChannelDto[]>(['dms'], [
      makeDmChannel('dm-1'),
    ]);
    _setAppStateForTest('background');
    _setStoredTokenForTest('registered-fcm-token');

    notifyIncoming(makeMessageCreatedFrame({ channelId: 'dm-1' }));

    expect(scheduleCalls).toHaveLength(0);
  });

  it('does not schedule locally when iOS remote push owns delivery', () => {
    queryClient.setQueryData<DmChannelDto[]>(['dms'], [
      makeDmChannel('dm-1'),
    ]);
    _setAppStateForTest('background');
    _setRemotePushPreferredForTest(true);

    notifyIncoming(makeMessageCreatedFrame({ channelId: 'dm-1' }));

    expect(scheduleCalls).toHaveLength(0);
  });
});

// ── AC2: foregrounded + incoming DM → NO system notification ──

describe('AC2: foregrounded + incoming DM', () => {
  it('does NOT schedule a system notification', () => {
    queryClient.setQueryData<DmChannelDto[]>(['dms'], [
      makeDmChannel('dm-1'),
    ]);

    // Foregrounded (default)
    _setAppStateForTest('active');

    const frame = makeMessageCreatedFrame({
      channelId: 'dm-1',
      content: 'Hey from DM!',
    });

    notifyIncoming(frame);

    expect(scheduleCalls).toHaveLength(0);
  });
});

// ── AC3: self-authored message never notifies ──

describe('AC3: self-authored message', () => {
  it('does not notify in foreground (own message)', () => {
    _setAppStateForTest('active');
    const frame = makeMessageCreatedFrame({
      authorId: CURRENT_USER.id,
      authorName: CURRENT_USER.username,
    });
    notifyIncoming(frame);
    expect(scheduleCalls).toHaveLength(0);
  });

  it('does not notify in background (own message)', () => {
    _setAppStateForTest('background');
    const frame = makeMessageCreatedFrame({
      authorId: CURRENT_USER.id,
      authorName: CURRENT_USER.username,
    });
    notifyIncoming(frame);
    expect(scheduleCalls).toHaveLength(0);
  });
});

// ── AC4: muted channel — no plain message, YES @mention ──

describe('AC4: muted channel (MENTIONS level)', () => {
  beforeEach(() => {
    // Seed shared channel and its server
    queryClient.setQueryData<Server[]>(keys.servers, [
      makeServer('srv-1'),
    ]);
    queryClient.setQueryData<Channel[]>(keys.channels('srv-1'), [
      makeChannel({ id: 'ch-shared', serverId: 'srv-1' }),
    ]);
    // Mute channel: MENTIONS level
    queryClient.setQueryData<NotificationSetting[]>(
      keys.notificationSettings,
      [makeNotificationSetting('ch-shared', 'MENTIONS')],
    );
  });

  it('does NOT notify on a plain message (no @mention)', () => {
    _setAppStateForTest('background');
    const frame = makeMessageCreatedFrame({
      channelId: 'ch-shared',
      content: 'Just a regular message',
    });
    notifyIncoming(frame);
    expect(scheduleCalls).toHaveLength(0);
  });

  it('DOES notify on an @mention of the current user', () => {
    _setAppStateForTest('background');
    const frame = makeMessageCreatedFrame({
      channelId: 'ch-shared',
      content: 'Hey @me check this out',
    });
    notifyIncoming(frame);

    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]!.content.data).toEqual({
      channelId: 'ch-shared',
      serverId: 'srv-1',
    });
  });

  it('DOES notify on @everyone mention in muted channel', () => {
    _setAppStateForTest('background');
    const frame = makeMessageCreatedFrame({
      channelId: 'ch-shared',
      content: '@everyone meeting in 5',
    });
    notifyIncoming(frame);

    expect(scheduleCalls).toHaveLength(1);
  });

  it('DOES notify on @here mention in muted channel', () => {
    _setAppStateForTest('background');
    const frame = makeMessageCreatedFrame({
      channelId: 'ch-shared',
      content: '@here please respond',
    });
    notifyIncoming(frame);

    expect(scheduleCalls).toHaveLength(1);
  });
});

// ── AC5: @mention and DM both notify while backgrounded ──

describe('AC5: @mention and DM backgrounded', () => {
  beforeEach(() => {
    queryClient.setQueryData<Server[]>(keys.servers, [
      makeServer('srv-1'),
    ]);
    queryClient.setQueryData<Channel[]>(keys.channels('srv-1'), [
      makeChannel({ id: 'ch-shared', serverId: 'srv-1' }),
    ]);
    queryClient.setQueryData<DmChannelDto[]>(['dms'], [
      makeDmChannel('dm-1'),
    ]);
    _setAppStateForTest('background');
  });

  it('DM notifies while backgrounded', () => {
    const frame = makeMessageCreatedFrame({
      channelId: 'dm-1',
      content: 'DM message',
    });
    notifyIncoming(frame);
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]!.content.data).toEqual({
      dmChannelId: 'dm-1',
    });
  });

  it('@mention frame notifies while backgrounded', () => {
    const frame = makeMentionFrame({
      channelId: 'ch-shared',
      authorName: OTHER_USER.displayName,
      preview: 'hey @me',
    });
    notifyIncoming(frame);

    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]!.content.title).toBe(OTHER_USER.displayName);
    expect(scheduleCalls[0]!.content.body).toBe('hey @me');
    expect(scheduleCalls[0]!.content.data).toEqual({
      channelId: 'ch-shared',
      serverId: 'srv-1',
    });
  });
});

// ── Edge cases ──

describe('edge cases', () => {
  it('does nothing when user is not signed in', () => {
    useSession.setState({ status: 'signedOut', user: null, tokens: null });
    _setAppStateForTest('background');
    const frame = makeMessageCreatedFrame();
    notifyIncoming(frame);
    expect(scheduleCalls).toHaveLength(0);
  });

  it('NONE level channel never notifies even with mention', () => {
    queryClient.setQueryData<Server[]>(keys.servers, [
      makeServer('srv-1'),
    ]);
    queryClient.setQueryData<Channel[]>(keys.channels('srv-1'), [
      makeChannel({ id: 'ch-shared', serverId: 'srv-1' }),
    ]);
    queryClient.setQueryData<NotificationSetting[]>(
      keys.notificationSettings,
      [makeNotificationSetting('ch-shared', 'NONE')],
    );
    _setAppStateForTest('background');
    const frame = makeMessageCreatedFrame({
      channelId: 'ch-shared',
      content: '@me hello',
    });
    notifyIncoming(frame);
    expect(scheduleCalls).toHaveLength(0);
  });

  it('DM always notifies even if a channel-level mute exists', () => {
    // Seed DM in cache AND a rogue notification setting
    queryClient.setQueryData<DmChannelDto[]>(['dms'], [
      makeDmChannel('dm-1'),
    ]);
    queryClient.setQueryData<NotificationSetting[]>(
      keys.notificationSettings,
      [makeNotificationSetting('dm-1', 'NONE')],
    );
    _setAppStateForTest('background');
    const frame = makeMessageCreatedFrame({
      channelId: 'dm-1',
      content: 'DM should notify',
    });
    notifyIncoming(frame);
    // DM path runs before the mute check — always notifies
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]!.content.data).toEqual({
      dmChannelId: 'dm-1',
    });
  });

  it('mention frame is suppressed in foreground (toast-only)', () => {
    _setAppStateForTest('active');
    const frame = makeMentionFrame({
      channelId: 'ch-shared',
    });
    notifyIncoming(frame);
    expect(scheduleCalls).toHaveLength(0);
  });
});
