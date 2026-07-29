/**
 * Local notification bridge (WO-NOTIF-LOCAL).
 *
 * Drives real system notifications from the existing WebSocket event stream
 * with no FCM and no Firebase. expo-notifications (~57.0.7) is already a
 * dependency; this module is the first code in src/ that calls
 * scheduleNotificationAsync.
 *
 * Flow:
 *   message.created / mention frame
 *     → notifyIncoming(frame)
 *       → self-message? skip
 *       → DM? always notify
 *       → shared channel? check per-channel notification level
 *       → foreground? route to handleForegroundNotification (in-app toast)
 *       → background? scheduleNotificationAsync (real OS notification)
 *
 * Explicitly out of scope: FCM, Firebase, google-services.json, push.ts
 * registration, killed-process delivery.
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  handleForegroundNotification,
  _setAppStateForTest as _fsSet,
  _resetAppStateForTest as _fsReset,
} from './foregroundHandler';
import { queryClient } from '../../sync/queryClient';
import { keys } from '../../sync/keys';
import { useSession } from '../../stores/session';
import type {
  MessageCreatedFrame,
  MentionFrame,
} from '../../realtime/events.d';
import type {
  NotificationSetting,
  DmChannelDto,
  Server,
  Channel,
} from '../../api/schema';
import { logger } from '../../lib/logger';
import { hasRegisteredPushToken } from './push';

// ── Re-export foreground test seams so tests only import from here ──
export { _fsSet, _fsReset };

// ── Foreground state (test-controllable) ──

let _appState: 'active' | 'inactive' | 'background' =
  (() => {
    const { AppState } = require('react-native');
    return AppState.currentState as 'active' | 'inactive' | 'background';
  })();

export function _setAppStateForTest(
  state: 'active' | 'inactive' | 'background',
): void {
  _appState = state;
}

export function _resetAppStateForTest(): void {
  const { AppState } = require('react-native');
  _appState = AppState.currentState as 'active' | 'inactive' | 'background';
}

// iOS has a killed-process-capable Firebase/APNs path. When it owns delivery,
// the WebSocket bridge must not present a second local banner.
let _remotePushPreferred = Platform.OS === 'ios';

export function _setRemotePushPreferredForTest(preferred: boolean): void {
  _remotePushPreferred = preferred;
}

export function _resetRemotePushPreferredForTest(): void {
  _remotePushPreferred = Platform.OS === 'ios';
}

function remotePushOwnsBackgroundDelivery(): boolean {
  return _remotePushPreferred || hasRegisteredPushToken();
}

// ── Test seams ──

let _schedule =
  Notifications.scheduleNotificationAsync.bind(Notifications);

export function _setScheduleForTest(
  fn: typeof _schedule,
): void {
  _schedule = fn;
}

export function _resetScheduleForTest(): void {
  _schedule = Notifications.scheduleNotificationAsync.bind(Notifications);
}

let _requestPerms =
  Notifications.requestPermissionsAsync.bind(Notifications);

export function _setRequestPermsForTest(
  fn: typeof _requestPerms,
): void {
  _requestPerms = fn;
}

export function _resetRequestPermsForTest(): void {
  _requestPerms = Notifications.requestPermissionsAsync.bind(Notifications);
}

// ── Helpers ──

function isForeground(): boolean {
  return _appState === 'active';
}

function currentUser():
  | { id: string; username: string; displayName: string | null }
  | undefined {
  const u = useSession.getState().user;
  if (!u) return undefined;
  return { id: u.id, username: u.username, displayName: u.displayName };
}

/** Check the ['dms'] cache; return true if channelId is a DM channel. */
function isDmChannel(channelId: string): boolean {
  const dms = queryClient.getQueryData<DmChannelDto[]>(['dms']);
  return dms?.some((d) => d.id === channelId) ?? false;
}

/** Return the per-channel notification setting, or undefined if default (ALL). */
function getChannelSetting(
  channelId: string,
): NotificationSetting | undefined {
  const settings =
    queryClient.getQueryData<NotificationSetting[]>(keys.notificationSettings);
  return settings?.find(
    (s) => s.scope === 'CHANNEL' && s.scopeId === channelId,
  );
}

/**
 * Does message content contain an @mention of the current user?
 * Mirrors the regex from domain/mentions.ts: /@(everyone\b|here\b|([\w.-]+))/g.
 */
function isMentionOfCurrentUser(
  content: string,
  username: string,
): boolean {
  const re = /@(everyone\b|here\b|([\w.-]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const keyword = m[1]!.toLowerCase();
    if (
      keyword === 'everyone' ||
      keyword === 'here' ||
      keyword === username.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the server ID for a given channelId by scanning cached
 * server→channel lists. Returns undefined for DM channels.
 */
function getServerIdForChannel(channelId: string): string | undefined {
  const servers = queryClient.getQueryData<Server[]>(keys.servers);
  if (!servers) return undefined;
  for (const srv of servers) {
    const channels = queryClient.getQueryData<Channel[]>(
      keys.channels(srv.id),
    );
    if (channels?.some((c) => c.id === channelId)) {
      return srv.id;
    }
  }
  return undefined;
}

// ── Permission ──

let _permRequested = false;

export function _resetPermRequestedForTest(): void {
  _permRequested = false;
}

/**
 * Request POST_NOTIFICATIONS runtime permission (Android 13+).
 * Idempotent — safe to call on every sign-in.
 */
async function requestPermissionIfNeeded(): Promise<void> {
  if (_permRequested) return;
  _permRequested = true;
  if (Platform.OS !== 'android') return;
  try {
    await _requestPerms();
  } catch {
    // Non-fatal: notifications still work if permission was already granted
    // or if the user grants it later via system settings.
    logger.warn('localNotify: permission request failed');
  }
}

// ── Notification dispatch ──

/**
 * Schedule a local OS notification.
 * Called only for background delivery; foreground is handled by the caller.
 */
async function presentLocalNotification(params: {
  title: string;
  body: string;
  channelId: string;
  serverId?: string;
  isDm: boolean;
}): Promise<void> {
  const data: Record<string, string> = {};
  if (params.isDm) {
    data.dmChannelId = params.channelId;
  } else {
    data.channelId = params.channelId;
    if (params.serverId) data.serverId = params.serverId;
  }

  try {
    await _schedule({
      content: {
        title: params.title,
        body: params.body,
        data,
      },
      trigger: null, // immediate
    });
  } catch (e) {
    logger.warn('localNotify: scheduleNotificationAsync failed', {
      error: String(e),
    });
  }
}

// ── Public API ──

export type NotifyEvent = MessageCreatedFrame | MentionFrame;

/**
 * Route an incoming WS event to the appropriate notification path.
 *
 * - Foreground → handleForegroundNotification (in-app toast, no OS notification)
 * - Background with remote push → let Firebase/APNs present exactly once
 * - Background without remote push → scheduleNotificationAsync as a fallback
 * - Self-authored messages are always suppressed
 * - DM channels always notify
 * - Shared channels respect per-channel notification levels:
 *   ALL → notify, MENTIONS → notify only on @mention, NONE → suppress
 *
 * Call this from applyEvent in sync/queryClient.ts — keep it OUTSIDE
 * the cache-update path.
 */
export function notifyIncoming(event: NotifyEvent): void {
  const user = currentUser();
  if (!user) return; // not signed in

  const foreground = isForeground();

  if (event.op === 'message.created') {
    const msg = event.d.message;
    const isSelf = msg.authorId === user.id;
    if (isSelf) return;

    const dm = isDmChannel(msg.channelId);
    const title =
      msg.author?.displayName ?? msg.author?.username ?? 'Someone';
    const body = msg.content;

    if (!dm) {
      // Shared channel — check notification level
      const setting = getChannelSetting(msg.channelId);
      const level = setting?.level ?? 'ALL';

      if (level === 'NONE') return;
      if (level === 'MENTIONS') {
        const mentioned = isMentionOfCurrentUser(msg.content, user.username);
        if (!mentioned) return;
      }
      // level === 'ALL' or MENTIONS with match → proceed
    }

    if (foreground) {
      handleForegroundNotification({ kind: 'notify' });
    } else if (!remotePushOwnsBackgroundDelivery()) {
      const serverId = dm ? undefined : getServerIdForChannel(msg.channelId);
      void presentLocalNotification({
        title,
        body,
        channelId: msg.channelId,
        serverId,
        isDm: dm,
      });
    }
    return;
  }

  if (event.op === 'mention') {
    const md = event.d;
    const title = md.authorName;
    const body = md.preview;

    if (foreground) {
      handleForegroundNotification({
        kind: 'mention',
        channelName: md.channelName,
        authorName: md.authorName,
        preview: md.preview,
      });
    } else if (!remotePushOwnsBackgroundDelivery()) {
      // Check if this mention is for a DM channel
      const dm = isDmChannel(md.channelId);
      const serverId = dm ? undefined : getServerIdForChannel(md.channelId);
      void presentLocalNotification({
        title,
        body,
        channelId: md.channelId,
        serverId,
        isDm: dm,
      });
    }
  }
}

// ── Initialization (call once on sign-in) ──

/**
 * Initialize local notifications:
 *  - Request POST_NOTIFICATIONS permission on Android 13+
 *
 * Safe to call before expo-notifications push init; independent of FCM.
 * Call this from App.tsx alongside initializePush().
 */
export async function initLocalNotifications(): Promise<void> {
  await requestPermissionIfNeeded();
}
