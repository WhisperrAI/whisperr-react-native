/**
 * @whisperr/expo — push notifications for Expo apps on Whisperr.
 *
 * - `registerForPushNotifications()` — permission + Expo push token → Whisperr
 * - `useWhisperrNotificationResponse()` — `push_opened` + the deep link for your router
 * - the config plugin (`"plugins": ["@whisperr/expo"]`) — native push setup at prebuild
 */
export {
  registerForPushNotifications,
  stopPushNotificationUpdates,
  toPermissionStatus,
  isExpoGoAndroid,
  resolveProjectId,
  type AndroidChannelOptions,
  type PushRegistrationReason,
  type PushRegistrationResult,
  type RegisterForPushOptions,
} from "./register.js";
export {
  subscribeToWhisperrNotificationOpens,
  useWhisperrNotificationResponse,
  deepLinkToHref,
  type NotificationOpenOptions,
  type WhisperrNotificationOpen,
} from "./opens.js";
