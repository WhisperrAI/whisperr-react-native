/**
 * @whisperr/expo — push notifications for Expo apps on Whisperr.
 *
 * - `registerForPushNotifications()` — permission + Expo push token → Whisperr
 * - `useWhisperrNotificationResponse()` — `push_opened` + the deep link for your router, and `push_received`
 * - `requestPushAuthorization({ provisional })` — the OS prompt (or quiet iOS delivery), reported to Whisperr
 * - `useWhisperrScreens()` — `screen_viewed` with expo-router route templates
 * - the config plugin (`"plugins": ["@whisperr/expo"]`) — native push setup at prebuild
 */
export {
  registerForPushNotifications,
  requestPushAuthorization,
  stopPushNotificationUpdates,
  toWhisperrPushToken,
  applicationId,
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
  subscribeToWhisperrNotificationReceipts,
  useWhisperrNotificationResponse,
  deepLinkToHref,
  type NotificationOpenOptions,
  type NotificationReceiptOptions,
  type WhisperrNotificationOpen,
} from "./opens.js";
export { useWhisperrScreens, routeTemplate, type WhisperrScreensOptions } from "./screens.js";
