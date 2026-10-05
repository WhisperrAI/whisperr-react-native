# Changelog

## 0.1.0

First release.

- **Config plugin** (`"plugins": ["@whisperr/expo"]`): applies the
  expo-notifications plugin with Whisperr defaults (iOS `aps-environment`,
  Android icon, color, and the `default` FCM channel). Warns at prebuild when
  `android.googleServicesFile` or `extra.eas.projectId` is missing.
- **`registerForPushNotifications()`**: creates the Android channel, asks for
  permission, reports it with `setPushPermission()`, gets the Expo push token,
  and sends it with `kind: "expo"`. Re-checks the permission on each
  foreground and fetches a new token when the device token rotates. Never
  throws; returns a `reason` when there is no token (for example
  `expo_go_android`).
- **`useWhisperrNotificationResponse()`** and
  **`subscribeToWhisperrNotificationOpens()`**: send `push_opened` for taps on
  Whisperr notifications (cold start included) and return the deep link.
- **`deepLinkToHref()`**: turns a deep link into an expo-router href.
