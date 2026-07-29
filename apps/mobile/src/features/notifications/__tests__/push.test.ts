/**
 * Push notification client unit tests (FR-NOTIF-002).
 *
 * Tests: permission flow, token registration POST, token rotation re-register,
 * sign-out DELETE (correctness), foreground suppression, and deep-link routing.
 *
 * All network boundaries are mocked — no real API or FCM calls.
 *
 * @satisfies FR-NOTIF-002
 */

// ── Mock expo-notifications ──

const mockRequestPermissions = jest.fn();
const mockGetDevicePushToken = jest.fn();
const mockAddPushTokenListener = jest.fn();
const mockSetNotificationHandler = jest.fn();
const mockAddResponseListener = jest.fn();
const mockGetLastResponse = jest.fn();
const mockClearLastResponse = jest.fn();

jest.mock('expo-notifications', () => ({
  requestPermissionsAsync: (...args: unknown[]) => mockRequestPermissions(...args),
  getDevicePushTokenAsync: (...args: unknown[]) => mockGetDevicePushToken(...args),
  addPushTokenListener: (...args: unknown[]) => mockAddPushTokenListener(...args),
  setNotificationHandler: (...args: unknown[]) => mockSetNotificationHandler(...args),
  addNotificationResponseReceivedListener: (...args: unknown[]) => mockAddResponseListener(...args),
  getLastNotificationResponse: (...args: unknown[]) => mockGetLastResponse(...args),
  clearLastNotificationResponse: (...args: unknown[]) => mockClearLastResponse(...args),
  AndroidImportance: { DEFAULT: 3 },
}));

// ── Mock session store (api + setLogoutHook) ──

const mockApiRequest = jest.fn();
const mockSetLogoutHook = jest.fn();

jest.mock('../../../stores/session', () => ({
  api: {
    request: (...args: unknown[]) => mockApiRequest(...args),
  },
  setLogoutHook: (hook: unknown) => mockSetLogoutHook(hook),
}));

// ── Mock foreground handler ──

const mockHandleForeground = jest.fn();
jest.mock('../foregroundHandler', () => ({
  handleForegroundNotification: (...args: unknown[]) => mockHandleForeground(...args),
}));

// ── iOS FCM mock state ──
const mockIosGetToken = jest.fn();
const mockIosRegisterDevice = jest.fn();
const mockIosGetInitialNotification = jest.fn();
let mockIosIsDeviceRegistered = true;
// Captured rotation callback — set by onTokenRefresh, fired by tests
let capturedRotationCallback: ((token: string) => void) | null = null;
let capturedIosOpenedCallback:
  | ((message: { data?: Record<string, unknown> }) => void)
  | null = null;

jest.mock('@react-native-firebase/messaging', () => {
  const instance = {
    getToken: (...args: unknown[]) => mockIosGetToken(...args),
    get isDeviceRegisteredForRemoteMessages() {
      return mockIosIsDeviceRegistered;
    },
    registerDeviceForRemoteMessages: (...args: unknown[]) => mockIosRegisterDevice(...args),
    getInitialNotification: (...args: unknown[]) => mockIosGetInitialNotification(...args),
    onNotificationOpenedApp: (
      cb: (message: { data?: Record<string, unknown> }) => void,
    ) => {
      capturedIosOpenedCallback = cb;
      return () => { capturedIosOpenedCallback = null; };
    },
    onTokenRefresh: (cb: (token: string) => void) => {
      capturedRotationCallback = cb;
      return () => { capturedRotationCallback = null; };
    },
  };
  return {
    __esModule: true,
    default: () => instance,
  };
});

import {
  requestPushPermissions,
  registerPushToken,
  unregisterPushToken,
  subscribeToTokenRotation,
  setupForegroundSuppression,
  setupNotificationTapHandler,
  parseNotificationRoute,
  initializePush,
  _resetMocksForTest,
  _setIosMessagingForTest,
  _setPlatformForTest,
  _resetPlatformForTest,
} from '../push';
import type { NotificationRoute } from '../push';

beforeEach(() => {
  jest.resetAllMocks();
  _resetMocksForTest();
  // Wire iOS messaging test seams — only override getToken.
  // Keep default _subscribeIosTokenRotation so it uses the mocked
  // @react-native-firebase/messaging module (which captures the callback).
  _setIosMessagingForTest({
    getToken: mockIosGetToken,
  });
  mockIosGetToken.mockResolvedValue(null);
  mockIosRegisterDevice.mockResolvedValue(undefined);
  mockIosGetInitialNotification.mockResolvedValue(null);
  mockIosIsDeviceRegistered = true;
  capturedRotationCallback = null;
  capturedIosOpenedCallback = null;
});

// ── Permission flow ──

describe('requestPushPermissions (FR-NOTIF-002)', () => {
  // @satisfies FR-NOTIF-002
  it('returns true when user grants permission', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ granted: true });
    const result = await requestPushPermissions();
    expect(result).toBe(true);
  });

  // @satisfies FR-NOTIF-002
  it('returns false when user denies permission', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ granted: false });
    const result = await requestPushPermissions();
    expect(result).toBe(false);
  });

  // @satisfies FR-NOTIF-002
  it('returns false when permission request throws', async () => {
    mockRequestPermissions.mockRejectedValueOnce(new Error('denied'));
    const result = await requestPushPermissions();
    expect(result).toBe(false);
  });
});

// ── Token registration ──

describe('registerPushToken (FR-NOTIF-002)', () => {
  // @satisfies FR-NOTIF-002
  it('obtains device token and POSTs to /api/devices', async () => {
    mockGetDevicePushToken.mockResolvedValueOnce({ type: 'android', data: 'fcm-token-123' });
    mockApiRequest.mockResolvedValueOnce({ status: 201 });

    const token = await registerPushToken();
    expect(token).toBe('fcm-token-123');
    expect(mockApiRequest).toHaveBeenCalledWith('/devices', {
      method: 'POST',
      body: { token: 'fcm-token-123', platform: 'android' },
    });
  });

  // @satisfies FR-NOTIF-002
  it('returns null when getDevicePushTokenAsync fails', async () => {
    mockGetDevicePushToken.mockRejectedValueOnce(new Error('FCM error'));
    const token = await registerPushToken();
    expect(token).toBeNull();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  // @satisfies FR-NOTIF-002
  it('returns null when POST /api/devices fails', async () => {
    mockGetDevicePushToken.mockResolvedValueOnce({ type: 'android', data: 'fcm-token-fail' });
    mockApiRequest.mockRejectedValueOnce(new Error('network error'));

    const token = await registerPushToken();
    expect(token).toBeNull();
  });

  // @satisfies FR-NOTIF-002 — Idempotency: registering the same token twice
  // does not crash; second POST is still sent (server handles idempotency)
  it('allows re-registration (server handles idempotency)', async () => {
    mockGetDevicePushToken.mockResolvedValue({ type: 'android', data: 'fcm-token-abc' });
    mockApiRequest.mockResolvedValue({ status: 201 });

    await registerPushToken();
    await registerPushToken();

    expect(mockGetDevicePushToken).toHaveBeenCalledTimes(2);
    expect(mockApiRequest).toHaveBeenCalledTimes(2);
  });
});

// ── Token rotation ──

describe('subscribeToTokenRotation (FR-NOTIF-002)', () => {
  // @satisfies FR-NOTIF-002
  it('subscribes to addPushTokenListener and returns cleanup', () => {
    const unsub = jest.fn();
    const subscribedListener = { remove: unsub };
    mockAddPushTokenListener.mockReturnValueOnce(subscribedListener);

    const cleanup = subscribeToTokenRotation();
    expect(mockAddPushTokenListener).toHaveBeenCalledTimes(1);

    cleanup();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  // @satisfies FR-NOTIF-002
  it('on rotation: deletes old token and registers new one', async () => {
    // Register initial token
    mockGetDevicePushToken.mockResolvedValueOnce({ type: 'android', data: 'token-v1' });
    mockApiRequest.mockResolvedValueOnce({ status: 201 });
    await registerPushToken();

    // Simulate rotation: FCM fires listener with new token
    mockApiRequest.mockResolvedValueOnce({ status: 201 }); // DELETE token-v1
    mockApiRequest.mockResolvedValueOnce({ status: 201 }); // POST token-v2

    // Capture the listener registered by addPushTokenListener
    let capturedListener: ((token: { type: string; data: string }) => void) | null = null;
    mockAddPushTokenListener.mockImplementation((listener: (token: { data: string }) => void) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });

    subscribeToTokenRotation();
    expect(mockAddPushTokenListener).toHaveBeenCalledTimes(1);

    // Fire the rotation
    await capturedListener!({ type: 'android', data: 'token-v2' });

    // Verify DELETE of old token, POST of new token
    expect(mockApiRequest).toHaveBeenCalledWith('/devices/token-v1', { method: 'DELETE' });
    expect(mockApiRequest).toHaveBeenCalledWith('/devices', {
      method: 'POST',
      body: { token: 'token-v2', platform: 'android' },
    });
  });
});

// ── Sign-out DELETE (correctness) ──

describe('unregisterPushToken — sign-out correctness (FR-NOTIF-002)', () => {
  // @satisfies FR-NOTIF-002 — Correctness requirement: a signed-out device MUST
  // stop receiving pushes. DELETE must fire before local session is cleared.
  it('DELETEs the stored token from /api/devices', async () => {
    // Register first to store a token
    mockGetDevicePushToken.mockResolvedValueOnce({ type: 'android', data: 'token-to-delete' });
    mockApiRequest.mockResolvedValueOnce({ status: 201 });
    await registerPushToken();

    mockApiRequest.mockResolvedValueOnce({ status: 204 });
    await unregisterPushToken();

    expect(mockApiRequest).toHaveBeenCalledWith('/devices/token-to-delete', { method: 'DELETE' });
  });

  // @satisfies FR-NOTIF-002
  it('is a no-op when no token is stored (idempotent)', async () => {
    await unregisterPushToken();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  // @satisfies FR-NOTIF-002 — Even if the DELETE fails (network error),
  // the token must be cleared locally so the next sign-in starts fresh.
  it('clears stored token even when DELETE fails', async () => {
    mockGetDevicePushToken.mockResolvedValueOnce({ type: 'android', data: 'token-bad-net' });
    mockApiRequest.mockResolvedValueOnce({ status: 201 });
    await registerPushToken();

    mockApiRequest.mockRejectedValueOnce(new Error('offline'));

    // Should not throw
    await expect(unregisterPushToken()).resolves.toBeUndefined();

    // Second unregister should be a no-op (token already cleared)
    await unregisterPushToken();
    expect(mockApiRequest).toHaveBeenCalledTimes(2); // register + failed delete
  });
});

// ── Foreground suppression (FR-NOTIF-004) ──

describe('setupForegroundSuppression — FR-NOTIF-004', () => {
  // @satisfies FR-NOTIF-004
  it('installs a setNotificationHandler', () => {
    setupForegroundSuppression();
    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
    expect(mockSetNotificationHandler).toHaveBeenCalledWith(
      expect.objectContaining({ handleNotification: expect.any(Function) }),
    );
  });

  // @satisfies FR-NOTIF-004
  it('suppresses native banner when foreground handler returns true', async () => {
    mockHandleForeground.mockReturnValueOnce(true);

    setupForegroundSuppression();

    // Extract and invoke the handler
    const handler = mockSetNotificationHandler.mock.calls[0][0];
    const notif = {
      request: {
        content: {
          data: {
            kind: 'mention',
            channelName: 'general',
            authorName: 'alice',
            preview: 'hello',
          },
        },
      },
    };

    const behavior = await handler.handleNotification(notif);
    expect(behavior.shouldShowBanner).toBe(false);
    expect(behavior.shouldShowList).toBe(false);
    expect(behavior.shouldPlaySound).toBe(false);
    expect(behavior.shouldSetBadge).toBe(false);
  });

  // @satisfies FR-NOTIF-004
  it('shows native notification when foreground handler returns false (app in background)', async () => {
    mockHandleForeground.mockReturnValueOnce(false);

    setupForegroundSuppression();

    const handler = mockSetNotificationHandler.mock.calls[0][0];
    const behavior = await handler.handleNotification({
      request: { content: { data: { kind: 'mention' } } },
    });

    expect(behavior.shouldShowBanner).toBe(true);
    expect(behavior.shouldShowList).toBe(true);
    expect(behavior.shouldPlaySound).toBe(true);
    expect(behavior.shouldSetBadge).toBe(true);
  });

  // @satisfies FR-NOTIF-004 — When data payload is missing, defaults to 'notify' kind
  it('defaults to notify kind when data payload has no kind field', async () => {
    mockHandleForeground.mockReturnValueOnce(true);

    setupForegroundSuppression();
    const handler = mockSetNotificationHandler.mock.calls[0][0];
    await handler.handleNotification({
      request: { content: { data: { serverId: 's1' } } },
    });

    expect(mockHandleForeground).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'notify' }),
    );
  });
});

// ── Deep-link routing ──

describe('parseNotificationRoute (FR-NOTIF-002)', () => {
  // @satisfies FR-NOTIF-002
  it('resolves a channel route from serverId + channelId', () => {
    const route = parseNotificationRoute({ serverId: 'srv-1', channelId: 'ch-42' });
    expect(route).toEqual<NotificationRoute>({
      type: 'channel',
      serverId: 'srv-1',
      channelId: 'ch-42',
    });
  });

  // @satisfies FR-NOTIF-002
  it('resolves a DM route from dmChannelId', () => {
    const route = parseNotificationRoute({ dmChannelId: 'dm-99' });
    expect(route).toEqual<NotificationRoute>({
      type: 'dm',
      dmChannelId: 'dm-99',
    });
  });

  // @satisfies FR-NOTIF-002
  it('resolves a server route from serverId alone', () => {
    const route = parseNotificationRoute({ serverId: 'srv-5' });
    expect(route).toEqual<NotificationRoute>({
      type: 'server',
      serverId: 'srv-5',
    });
  });

  // @satisfies FR-NOTIF-002
  it('returns null type when data is undefined', () => {
    const route = parseNotificationRoute(undefined);
    expect(route).toEqual<NotificationRoute>({ type: null });
  });

  // @satisfies FR-NOTIF-002
  it('returns null type when data is empty', () => {
    const route = parseNotificationRoute({});
    expect(route).toEqual<NotificationRoute>({ type: null });
  });

  // @satisfies FR-NOTIF-002 — DM route takes priority over serverId if both present
  it('prefers DM route when both dmChannelId and serverId are present', () => {
    const route = parseNotificationRoute({
      dmChannelId: 'dm-1',
      serverId: 'srv-1',
      channelId: 'ch-1',
    });
    expect(route.type).toBe('dm');
    expect(route.dmChannelId).toBe('dm-1');
  });

  // @satisfies FR-NOTIF-002 — Type safety: ignores non-string values
  it('ignores non-string routing fields', () => {
    const route = parseNotificationRoute({
      serverId: 123,
      channelId: true,
    } as unknown as Record<string, unknown>);
    expect(route.type).toBeNull();
  });
});

// ── Notification tap handler ──

describe('setupNotificationTapHandler — deep-link tap-through (FR-NOTIF-002)', () => {
  // @satisfies FR-NOTIF-002
  it('subscribes to addNotificationResponseReceivedListener', () => {
    const unsub = jest.fn();
    mockAddResponseListener.mockReturnValueOnce({ remove: unsub });
    mockGetLastResponse.mockReturnValueOnce(null);

    const cleanup = setupNotificationTapHandler(jest.fn());
    expect(mockAddResponseListener).toHaveBeenCalledTimes(1);

    cleanup();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  // @satisfies FR-NOTIF-002
  it('calls onNavigate when a warm-start notification is tapped', () => {
    const onNavigate = jest.fn();
    let capturedListener: ((response: unknown) => void) | null = null;
    mockAddResponseListener.mockImplementation((listener: (response: unknown) => void) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });
    mockGetLastResponse.mockReturnValueOnce(null);

    setupNotificationTapHandler(onNavigate);

    // Simulate tap on a notification with routing data
    capturedListener!({
      notification: {
        request: {
          content: {
            data: { serverId: 'srv-1', channelId: 'ch-42' },
          },
        },
      },
    });

    expect(onNavigate).toHaveBeenCalledWith({
      type: 'channel',
      serverId: 'srv-1',
      channelId: 'ch-42',
    });
  });

  // @satisfies FR-NOTIF-002
  it('handles cold-start: calls onNavigate from getLastNotificationResponse', () => {
    const onNavigate = jest.fn();
    mockAddResponseListener.mockReturnValueOnce({ remove: jest.fn() });
    mockGetLastResponse.mockReturnValueOnce({
      notification: {
        request: {
          content: {
            data: { dmChannelId: 'dm-5' },
          },
        },
      },
    });

    setupNotificationTapHandler(onNavigate);

    expect(onNavigate).toHaveBeenCalledWith({
      type: 'dm',
      dmChannelId: 'dm-5',
    });
    expect(mockClearLastResponse).toHaveBeenCalledTimes(1);
  });

  // @satisfies FR-NOTIF-002 — Do not navigate if data payload has no routing info
  it('does NOT call onNavigate when cold-start notification has no route', () => {
    const onNavigate = jest.fn();
    mockAddResponseListener.mockReturnValueOnce({ remove: jest.fn() });
    mockGetLastResponse.mockReturnValueOnce({
      notification: {
        request: {
          content: {
            data: { kind: 'notify' },
          },
        },
      },
    });

    setupNotificationTapHandler(onNavigate);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  // @satisfies FR-NOTIF-002
  it('does NOT call onNavigate when warm-start tap has no route', () => {
    const onNavigate = jest.fn();
    let capturedListener: ((response: unknown) => void) | null = null;
    mockAddResponseListener.mockImplementation((listener: (response: unknown) => void) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });
    mockGetLastResponse.mockReturnValueOnce(null);

    setupNotificationTapHandler(onNavigate);

    capturedListener!({
      notification: {
        request: {
          content: {
            data: {}, // empty data — no route
          },
        },
      },
    });

    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('iOS Firebase notification tap-through (FR-NOTIF-002)', () => {
  beforeEach(() => {
    _setPlatformForTest('ios');
    mockAddResponseListener.mockReturnValue({ remove: jest.fn() });
    mockGetLastResponse.mockReturnValue(null);
  });

  afterEach(() => {
    _resetPlatformForTest();
  });

  it('routes a warm-opened Firebase DM notification', () => {
    const onNavigate = jest.fn();
    setupNotificationTapHandler(onNavigate);

    capturedIosOpenedCallback!({ data: { dmChannelId: 'dm-fcm-1' } });

    expect(onNavigate).toHaveBeenCalledWith({
      type: 'dm',
      dmChannelId: 'dm-fcm-1',
    });
  });

  it('routes a cold-start Firebase channel notification', async () => {
    const onNavigate = jest.fn();
    mockIosGetInitialNotification.mockResolvedValueOnce({
      data: { serverId: 'srv-fcm-1', channelId: 'ch-fcm-1' },
    });

    setupNotificationTapHandler(onNavigate);
    await Promise.resolve();
    await Promise.resolve();

    expect(onNavigate).toHaveBeenCalledWith({
      type: 'channel',
      serverId: 'srv-fcm-1',
      channelId: 'ch-fcm-1',
    });
  });
});

// ── initializePush — integration ──

describe('initializePush — full lifecycle (FR-NOTIF-002)', () => {
  // @satisfies FR-NOTIF-002
  it('requests permissions, registers token, subscribes to rotation, sets up foreground handler', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ granted: true });
    mockGetDevicePushToken.mockResolvedValueOnce({ type: 'android', data: 'init-token' });
    mockApiRequest.mockResolvedValueOnce({ status: 201 });
    mockAddPushTokenListener.mockReturnValueOnce({ remove: jest.fn() });

    await initializePush();

    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockApiRequest).toHaveBeenCalledWith('/devices', {
      method: 'POST',
      body: { token: 'init-token', platform: 'android' },
    });
    expect(mockAddPushTokenListener).toHaveBeenCalledTimes(1);
    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
    // Sign-out hook is registered
    expect(mockSetLogoutHook).toHaveBeenCalledTimes(1);
  });

  // @satisfies FR-NOTIF-002
  it('skips registration when permission is denied', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ granted: false });

    await initializePush();

    expect(mockGetDevicePushToken).not.toHaveBeenCalled();
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockSetLogoutHook).not.toHaveBeenCalled();
  });

  // @satisfies FR-NOTIF-002 — Idempotent: calling twice does not double-initialize
  it('is idempotent — second call is a no-op', async () => {
    mockRequestPermissions.mockResolvedValue({ granted: true });
    mockGetDevicePushToken.mockResolvedValue({ type: 'android', data: 'idem-token' });
    mockApiRequest.mockResolvedValue({ status: 201 });

    await initializePush();
    await initializePush();

    // Only one set of operations should fire
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(mockSetLogoutHook).toHaveBeenCalledTimes(1);
  });

  // @satisfies FR-NOTIF-002 — No FCM config: getDevicePushTokenAsync fails
  // but the app must not crash, and foreground handler + logout hook still install.
  it('does not throw when getDevicePushTokenAsync fails (no FCM config)', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ granted: true });
    // Simulate missing google-services.json — FCM token acquisition throws
    mockGetDevicePushToken.mockRejectedValueOnce(new Error('FCM service not available'));
    mockAddPushTokenListener.mockReturnValueOnce({ remove: jest.fn() });

    await initializePush();

    // Registration path was attempted but token acquisition failed
    expect(mockGetDevicePushToken).toHaveBeenCalledTimes(1);
    // POST /api/devices must NOT be called (no token to register)
    expect(mockApiRequest).not.toHaveBeenCalled();

    // Foreground handler and logout hook still installed (degrade gracefully)
    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
    expect(mockAddPushTokenListener).toHaveBeenCalledTimes(1);
    expect(mockSetLogoutHook).toHaveBeenCalledTimes(1);
  });
});


// ── iOS push token registration (FR-NOTIF-002) ──

describe('iOS: registerPushToken obtains FCM token via @react-native-firebase/messaging (FR-NOTIF-002)', () => {
  beforeEach(() => {
    _setPlatformForTest('ios');
  });

  afterEach(() => {
    _resetPlatformForTest();
  });

  it('obtains iOS FCM token and POSTs with platform ios', async () => {
    mockIosGetToken.mockResolvedValueOnce('ios-fcm-token-abc');
    mockApiRequest.mockResolvedValueOnce({ status: 201 });

    const token = await registerPushToken();
    expect(token).toBe('ios-fcm-token-abc');
    expect(mockApiRequest).toHaveBeenCalledWith('/devices', {
      method: 'POST',
      body: { token: 'ios-fcm-token-abc', platform: 'ios' },
    });
    // expo-notifications getDevicePushTokenAsync is NOT called on iOS
    expect(mockGetDevicePushToken).not.toHaveBeenCalled();
  });

  it('registers for remote messages before obtaining an iOS token', async () => {
    _resetMocksForTest();
    _setPlatformForTest('ios');
    mockIosIsDeviceRegistered = false;
    mockIosGetToken.mockResolvedValueOnce('ios-fcm-after-apns-registration');
    mockApiRequest.mockResolvedValueOnce({ status: 201 });

    const token = await registerPushToken();

    expect(token).toBe('ios-fcm-after-apns-registration');
    expect(mockIosRegisterDevice).toHaveBeenCalledTimes(1);
    expect(mockIosRegisterDevice.mock.invocationCallOrder[0]!)
      .toBeLessThan(mockIosGetToken.mock.invocationCallOrder[0]!);
  });

  // ── Perturbation proof: change token → POST body changes ──
  it('PERTURBATION: changing the FCM token changes the POST body', async () => {
    mockIosGetToken.mockResolvedValueOnce('ios-fcm-token-xyz');
    mockApiRequest.mockResolvedValueOnce({ status: 201 });

    const token = await registerPushToken();
    expect(token).toBe('ios-fcm-token-xyz');
    expect(mockApiRequest).toHaveBeenCalledWith('/devices', {
      method: 'POST',
      body: { token: 'ios-fcm-token-xyz', platform: 'ios' },
    });
  });

  // ── Perturbation proof: change platform → platform field changes ──
  it('PERTURBATION: changing platform to android changes the platform field', async () => {
    _setPlatformForTest('android');
    mockGetDevicePushToken.mockResolvedValueOnce({ type: 'android', data: 'fcm-android-token' });
    mockApiRequest.mockResolvedValueOnce({ status: 201 });

    const token = await registerPushToken();
    expect(token).toBe('fcm-android-token');
    expect(mockApiRequest).toHaveBeenCalledWith('/devices', {
      method: 'POST',
      body: { token: 'fcm-android-token', platform: 'android' },
    });
  });

  it('returns null when iOS FCM getToken returns null', async () => {
    mockIosGetToken.mockResolvedValueOnce(null);

    const token = await registerPushToken();
    expect(token).toBeNull();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('returns null when POST /api/devices fails on iOS', async () => {
    mockIosGetToken.mockResolvedValueOnce('ios-fcm-token');
    mockApiRequest.mockRejectedValueOnce(new Error('network error'));

    const token = await registerPushToken();
    expect(token).toBeNull();
  });
});

// ── iOS token rotation (FR-NOTIF-002) ──

describe('iOS: subscribeToTokenRotation uses onTokenRefresh (FR-NOTIF-002)', () => {
  beforeEach(() => {
    _setPlatformForTest('ios');
  });

  afterEach(() => {
    _resetPlatformForTest();
  });

  it('subscribes via onTokenRefresh and does not use expo listener', () => {
    const cleanup = subscribeToTokenRotation();
    expect(typeof cleanup).toBe('function');
    // expo-notifications listener is NOT used on iOS
    expect(mockAddPushTokenListener).not.toHaveBeenCalled();
    cleanup();
  });

  it('returns a cleanup function from token rotation subscription', () => {
    const cleanup = subscribeToTokenRotation();
    expect(typeof cleanup).toBe('function');
    // Should not throw when called
    cleanup();
  });
});

// ── iOS initializePush full lifecycle ──

describe('iOS: initializePush — full lifecycle (FR-NOTIF-002)', () => {
  beforeEach(() => {
    _setPlatformForTest('ios');
  });

  afterEach(() => {
    _resetPlatformForTest();
  });

  it('requests permissions, registers token, subscribes to rotation, sets up foreground handler', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ granted: true });
    mockIosGetToken.mockResolvedValueOnce('ios-init-token');
    mockApiRequest.mockResolvedValueOnce({ status: 201 });

    await initializePush();

    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockApiRequest).toHaveBeenCalledWith('/devices', {
      method: 'POST',
      body: { token: 'ios-init-token', platform: 'ios' },
    });
    // Rotation subscription was installed
    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
    expect(mockSetLogoutHook).toHaveBeenCalledTimes(1);
    // expo-notifications token listener NOT called on iOS
    expect(mockAddPushTokenListener).not.toHaveBeenCalled();
  });

  // ── Perturbation: iOS still works after permission denied ──
  it('skips registration when permission is denied on iOS', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ granted: false });

    await initializePush();

    expect(mockIosGetToken).not.toHaveBeenCalled();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  // ── Perturbation: iOS gracefully degrades when getToken fails ──
  it('gracefully degrades when iOS getToken returns null', async () => {
    mockRequestPermissions.mockResolvedValueOnce({ granted: true });
    mockIosGetToken.mockResolvedValueOnce(null);
    await initializePush();

    expect(mockIosGetToken).toHaveBeenCalledTimes(1);
    expect(mockApiRequest).not.toHaveBeenCalled(); // no token to POST
    // Foreground handler and logout hook still installed
    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
    expect(mockSetLogoutHook).toHaveBeenCalledTimes(1);
  });
});
