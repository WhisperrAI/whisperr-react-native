# Changelog

## 0.2.0

- **`useWhisperrScreens()`** sends `screen_viewed` for each expo-router route,
  with the route template (`/lesson/[id]`) as `screen_name`. expo-router is an
  optional peer; without it the hook does nothing.
- Notification taps that open the app now also set `launch_source: "push"` on
  that `app_opened` with `@whisperr/react-native` 0.7.0 or later. No change in
  this package was needed for that.

## 0.1.1

- **README:** the link to `@whisperr/react-native` pointed at
  `../../README.md`, which is broken on npm. It now goes to the GitHub README
  and the docs. A new "Users and events" section shows `identify()` with
  `email` and `emailOptedIn` (`@whisperr/react-native` 0.6.0 or later), and
  `track()`. No code changes.

## 0.1.0

First release. Needs `@whisperr/react-native` 0.5.0 or later (a peer
dependency), and the Whisperr backend with contract v2.

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
- **Contract v2 push fields.** The Expo token carries the EAS project id as
  `provider_project` and the app id from `expo-application` as
  `client_app_id`. `providerProject` overrides it.
- **`tokenType: "device"`** registers the native token instead of the Expo
  token: APNs on iOS with its `push_env` (from
  `getIosPushNotificationServiceEnvironmentAsync()`: development → `sandbox`),
  FCM on Android (pass `providerProject` for the Firebase project id).
  `toWhisperrPushToken(deviceToken)` does the same mapping for apps that get
  the token themselves.
- **`requestPushAuthorization({ provisional })`** and the `provisional`
  option of `registerForPushNotifications()`: quiet iOS delivery without a
  prompt, reported to Whisperr.
- **Opens:** `push_opened` carries `action_id` and `cold_start` (true for the
  launch tap from `getLastNotificationResponseAsync()`). After a Whisperr tap
  is handled, the SDK clears the last notification response, so the next
  launch does not route the same tap again (`clearLastResponse: false` turns
  this off). Taps are also deduped by `whisperr_message_id`.
- **Receipts:** `subscribeToWhisperrNotificationReceipts()` sends
  `push_received` for Whisperr notifications that arrive in the foreground;
  `useWhisperrNotificationResponse()` calls it unless `trackReceived: false`.
- New peer dependency: `expo-application`.
