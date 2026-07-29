// Public surface of the notifications feature. Other features may import
// from here and nowhere else inside this directory.
export { handleForegroundNotification } from './foregroundHandler';
export type { ForegroundNotification, MentionPayload, CallRingPayload, NotifyPayload } from './foregroundHandler';

// Push notifications (FR-NOTIF-002)
export {
  initializePush,
  requestPushPermissions,
  registerPushToken,
  unregisterPushToken,
  subscribeToTokenRotation,
  setupForegroundSuppression,
  setupNotificationTapHandler,
  parseNotificationRoute,
  _setNotificationsForTest,
  _resetMocksForTest,
  _setStoredTokenForTest,
  _setIosMessagingForTest,
  hasRegisteredPushToken,
  isAndroid,
} from './push';
export type { NotificationRoute, NavigationHandler } from './push';

// Local notifications (WO-NOTIF-LOCAL)
export {
  notifyIncoming,
  initLocalNotifications,
  _setScheduleForTest,
  _resetScheduleForTest,
  _setRequestPermsForTest,
  _resetRequestPermsForTest,
  _resetPermRequestedForTest,
  _setRemotePushPreferredForTest,
  _resetRemotePushPreferredForTest,
  _fsSet,
  _fsReset,
} from './localNotify';
export type { NotifyEvent } from './localNotify';
