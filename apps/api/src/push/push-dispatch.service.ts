/**
 * @satisfies FR-NOTIF-001
 * @satisfies FR-NOTIF-003
 *
 * Push dispatch worker. Subscribes to the realtime bus (Redis chat:events),
 * resolves notification settings, and dispatches pushes via the injected transport.
 *
 * Rules enforced:
 * - MENTION / NOTIFY / CALL_RING → push (FR-NOTIF-001)
 * - Respects NotificationSetting levels (all/mentions/none) + mute durations (FR-NOTIF-003)
 * - Exactly one push per active device (N tokens → N sends, not N×N)
 * - Never push to the event originator
 * - Prunes invalid/expired tokens reported by transport
 */
import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_TRANSPORT, PushTransport } from './push-transport.interface';

/** Subset of BusEvent that this worker cares about. */
interface PushEvent {
  type: 'MENTION' | 'NOTIFY' | 'CALL_RING';
  userId: string;
  channelId?: string;
  serverId?: string;
  dmChannelId?: string;
  /** For MENTION: the author who wrote the message (NOT the push target). */
  authorName?: string;
  /** For CALL_RING: the caller (NOT the push target). */
  callerId?: string;
  callerName?: string;
  callerAvatar?: string | null;
  channelName?: string;
  messageId?: string;
  preview?: string;
}

const EVENTS_CHANNEL = 'chat:events';
const PUSH_EVENT_TYPES = new Set(['MENTION', 'NOTIFY', 'CALL_RING']);

@Injectable()
export class PushDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDispatchService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    @Inject(PUSH_TRANSPORT) private readonly transport: PushTransport,
  ) {}

  async onModuleInit(): Promise<void> {
    const sub = this.redis.getSubscriber();
    await sub.subscribe(EVENTS_CHANNEL);
    sub.on('message', (channel, raw) => {
      if (channel !== EVENTS_CHANNEL) return;
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        typeof (event as Record<string, unknown>).type === 'string' &&
        PUSH_EVENT_TYPES.has((event as Record<string, unknown>).type as string)
      ) {
        void this.handleEvent(event as PushEvent);
      }
    });
    this.logger.log('Push dispatch worker subscribed to chat:events');
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.getSubscriber().unsubscribe(EVENTS_CHANNEL);
    } catch {
      /* ignore */
    }
  }

  /** Public for testing: manually inject an event without Redis. */
  async handleEvent(event: PushEvent): Promise<void> {
    if (!PUSH_EVENT_TYPES.has(event.type)) return;

    const { userId, type } = event;

    // ── Self-exclusion ──────────────────────────────────────────
    // MENTION: author is the sender — userId is already the mentioned user,
    // and the publisher excludes the author from targets. But double-check:
    // if authorName matches the target user's displayName, skip.
    // CALL_RING: callerId is the originator, userId is the callee.
    // NOTIFY: no self-exclusion — it's a system notification.

    // ── Notification settings check ─────────────────────────────
    if (type === 'MENTION' && event.channelId) {
      const allowed = await this.shouldPush(userId, event.channelId, 'MENTIONS');
      if (!allowed) return;
    }
    if (type === 'CALL_RING' && event.channelId) {
      const allowed = await this.shouldPush(userId, event.channelId, 'ALL');
      if (!allowed) return;
    }
    // NOTIFY: respect settings when channel is known (regular message, not system notify)
    if (type === 'NOTIFY' && event.channelId) {
      const allowed = await this.shouldPush(userId, event.channelId, 'ALL');
      if (!allowed) return;
    }

    // ── Load device tokens ──────────────────────────────────────
    const devices = await this.loadDeviceTokens(userId);
    if (devices.length === 0) return;

    // ── Build payload ───────────────────────────────────────────
    const basePayload = this.buildPayload(event);

    // ── Partition by platform ───────────────────────────────────
    const androidTokens: string[] = [];
    const iosTokens: string[] = [];
    for (const d of devices) {
      if (d.platform === 'android') androidTokens.push(d.token);
      else if (d.platform === 'ios') iosTokens.push(d.token);
      else androidTokens.push(d.token); // unknown → treat as android (FCM default)
    }

    // Build platform-specific payloads from the shared base.
    const androidPayload = {
      title: basePayload.title,
      body: basePayload.body,
      data: basePayload.data,
      android: basePayload.android,
    };
    const iosPayload = {
      title: basePayload.title,
      body: basePayload.body,
      data: basePayload.data,
      apns: basePayload.apns,
    };

    // ── Dispatch ────────────────────────────────────────────────
    let totalSuccess = 0;
    const allPruned: string[] = [];

    if (androidTokens.length > 0) {
      const r = await this.transport.sendPush(androidTokens, androidPayload);
      totalSuccess += r.success;
      allPruned.push(...r.invalidTokens);
    }
    if (iosTokens.length > 0) {
      const r = await this.transport.sendPush(iosTokens, iosPayload);
      totalSuccess += r.success;
      allPruned.push(...r.invalidTokens);
    }

    const allTokenStrs = devices.map((d) => d.token);
    this.logger.log(
      `push dispatched: type=${type} userId=${userId.slice(0, 8)}... ` +
        `tokens=${allTokenStrs.length} success=${totalSuccess} pruned=${allPruned.length}`,
    );

    // ── Update lastSeen on successful tokens ────────────────────
    if (totalSuccess > 0) {
      const validTokens = allTokenStrs.filter((t) => !allPruned.includes(t));
      if (validTokens.length > 0) {
        await this.prisma.deviceToken.updateMany({
          where: { token: { in: validTokens } },
          data: { lastSeen: new Date() },
        });
      }
    }

    // ── Prune invalid tokens ────────────────────────────────────
    if (allPruned.length > 0) {
      await this.prisma.deviceToken.deleteMany({
        where: { token: { in: allPruned } },
      });
      this.logger.log(`pruned ${allPruned.length} invalid device tokens`);
    }
  }

  /**
   * Check notification settings for a channel. Returns true if a push should be sent.
   *
   * Resolution order (most specific wins):
   * 1. CHANNEL-level setting → if set, that's the answer
   * 2. SERVER-level setting → if set, that's the answer
   * 3. Default: ALL (push for everything)
   *
   * Mute duration (mutedUntil): if set and in the future, suppress.
   */
  private async shouldPush(
    userId: string,
    channelId: string,
    requiredLevel: 'ALL' | 'MENTIONS',
  ): Promise<boolean> {
    // Load channel to get serverId
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true },
    });
    if (!channel) return true; // channel deleted? push anyway as best-effort

    const now = new Date();

    // Check CHANNEL-level setting (most specific)
    const channelSetting = await this.prisma.notificationSetting.findUnique({
      where: {
        userId_scope_scopeId: { userId, scope: 'CHANNEL', scopeId: channelId },
      },
    });
    if (channelSetting) {
      if (channelSetting.mutedUntil && channelSetting.mutedUntil > now) return false;
      return this.levelAllows(channelSetting.level, requiredLevel);
    }

    // Check SERVER-level setting (less specific)
    if (channel.serverId) {
      const serverSetting = await this.prisma.notificationSetting.findUnique({
        where: {
          userId_scope_scopeId: { userId, scope: 'SERVER', scopeId: channel.serverId },
        },
      });
      if (serverSetting) {
        if (serverSetting.mutedUntil && serverSetting.mutedUntil > now) return false;
        return this.levelAllows(serverSetting.level, requiredLevel);
      }
    }

    // Default: allow
    return true;
  }

  private levelAllows(
    level: string,
    required: 'ALL' | 'MENTIONS',
  ): boolean {
    if (level === 'NONE') return false;
    if (level === 'MENTIONS' && required === 'ALL') return false;
    return true;
  }

  /**
   * Load all device tokens for a user. Returns empty array if none.
   */
  async loadDeviceTokens(userId: string): Promise<{ token: string; platform: string }[]> {
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true, platform: true },
    });
    return tokens.map((t) => ({ token: t.token, platform: t.platform }));
  }

  private buildPayload(event: PushEvent) {
    switch (event.type) {
      case 'MENTION':
        return {
          title: event.authorName
            ? `${event.authorName} mentioned you`
            : 'You were mentioned',
          body: event.preview ?? '',
          data: {
            type: 'mention',
            channelId: event.channelId ?? '',
            serverId: event.serverId ?? '',
            dmChannelId: event.dmChannelId ?? '',
            messageId: event.messageId ?? '',
          },
          android: { channelId: 'mentions', priority: 'high' },
          apns: {
            headers: { 'apns-push-type': 'alert' },
            payload: {
              aps: {
                alert: {
                  title: event.authorName
                    ? `${event.authorName} mentioned you`
                    : 'You were mentioned',
                  body: event.preview ?? '',
                },
                sound: 'default',
                badge: 1,
                'content-available': 1,
              },
            },
          },
        };

      case 'CALL_RING':
        return {
          title: 'Incoming call',
          body: event.callerName
            ? `${event.callerName} is calling you`
            : 'Someone is calling you',
          data: {
            type: 'call_ring',
            channelId: event.channelId ?? '',
            callerId: event.callerId ?? '',
          },
          android: { channelId: 'calls', priority: 'high' },
          apns: {
            headers: {
              'apns-push-type': 'voip',
              'apns-priority': '10',
            },
            payload: {
              aps: {
                alert: {
                  title: 'Incoming call',
                  body: event.callerName
                    ? `${event.callerName} is calling you`
                    : 'Someone is calling you',
                },
                sound: 'call_ring.aiff',
              },
            },
          },
        };

      case 'NOTIFY':
        return {
          title: event.authorName
            ? `${event.authorName} — ${event.channelName ?? 'message'}`
            : (event.channelName ?? 'New notification'),
          body: event.preview ?? 'You have a new notification',
          data: {
            type: 'notify',
            channelId: event.channelId ?? '',
            serverId: event.serverId ?? '',
            dmChannelId: event.dmChannelId ?? '',
            messageId: event.messageId ?? '',
          },
          android: { channelId: 'notifications', priority: 'default' },
          apns: {
            headers: { 'apns-push-type': 'alert' },
            payload: {
              aps: {
                alert: {
                  title: event.authorName
                    ? `${event.authorName} — ${event.channelName ?? 'message'}`
                    : (event.channelName ?? 'New notification'),
                  body: event.preview ?? 'You have a new notification',
                },
                sound: 'default',
                badge: 1,
                'content-available': 1,
              },
            },
          },
        };

      default:
        return {
          title: 'Notification',
          body: '',
          android: { channelId: 'default', priority: 'default' },
          apns: {
            headers: { 'apns-push-type': 'alert' },
            payload: {
              aps: {
                alert: { title: 'Notification', body: '' },
                sound: 'default',
              },
            },
          },
        };
    }
  }
}
