# @whisperr/expo

Push notifications for Expo apps on Whisperr. Three parts:

1. A **config plugin**. It sets up native push at prebuild: the iOS push
   entitlement, the Android notification icon, color, and default channel.
2. **`registerForPushNotifications()`**. It asks for permission, gets the Expo
   push token, and sends both to Whisperr. It keeps them current when the user
   changes the permission in Settings or the token rotates.
3. **`useWhisperrNotificationResponse()`**. It records `push_opened` when the
   user taps a Whisperr notification, and gives you the deep link for your
   router. The cold start is included.

It builds on [`@whisperr/react-native`](https://github.com/WhisperrAI/whisperr-react-native#readme)
([docs](https://docs.whisperr.net/sdks/react-native/)), which sends your users
and events, and on
[`expo-notifications`](https://docs.expo.dev/versions/latest/sdk/notifications/).

## Install

```bash
npx expo install @whisperr/expo @whisperr/react-native expo-notifications expo-constants expo-application @react-native-async-storage/async-storage
```

Add the plugin to the app config:

```json
{
  "expo": {
    "plugins": [
      ["@whisperr/expo", { "icon": "./assets/notification-icon.png", "color": "#4F6BFF" }]
    ],
    "android": { "googleServicesFile": "./google-services.json" }
  }
}
```

Then make a new build (`eas build` or `npx expo run:ios` / `run:android`).
A config plugin changes native code, so a JavaScript-only update is not enough.

### Plugin options

| Option | Platform | Default | What it does |
|---|---|---|---|
| `mode` | iOS | `development` | The `aps-environment` entitlement. App Store and TestFlight builds are re-signed for production. |
| `icon` | Android | — | Small notification icon: a 96×96 all-white PNG with transparency. |
| `color` | Android | — | Icon tint. |
| `androidChannelId` | Android | `default` | The channel FCM uses when a message names none. `registerForPushNotifications()` creates this channel. |
| `sounds` | both | — | Custom notification sounds. |
| `enableBackgroundRemoteNotifications` | iOS | `false` | Adds `remote-notification` to `UIBackgroundModes` (silent pushes). |

The plugin applies the `expo-notifications` plugin for you. If your app config
already lists `expo-notifications`, your entry and its options win, and the
Whisperr plugin adds only its checks.

At prebuild, the plugin warns when push cannot work: no
`android.googleServicesFile`, or no `extra.eas.projectId` (run `eas init`).

### Credentials

Whisperr sends Expo tokens through Expo's push service. Expo needs:

- **iOS:** an APNs key. `eas build` sets it up, or run `eas credentials`.
- **Android:** an FCM V1 service-account key, uploaded with `eas credentials`,
  and `google-services.json` in the app config.

See [Expo: push notifications setup](https://docs.expo.dev/push-notifications/push-notifications-setup/).

## Users and events

Users and events go through `@whisperr/react-native`. Init it once with the
app key (`wpk_…`), identify the user after login, and track what they do:

```tsx
import { Whisperr } from "@whisperr/react-native";

const whisperr = Whisperr.init({ apiKey: "wpk_…" }); // uses AsyncStorage when installed

// After login and on session restore:
whisperr.identify(user.id, {
  traits: { first_name: user.firstName },
  email: user.email,
  emailOptedIn: user.agreedToEmail, // true, false, or leave it out
});

// When something happens:
whisperr.track("lesson_completed", { lesson_id: "intro" });

// On logout:
whisperr.reset();
```

`emailOptedIn` is the user's email consent. What Whisperr does with it depends
on your answer in Whisperr to "Does your signup get permission to email
users?":

| Answer | An email address the app sends |
|---|---|
| Yes | Is opted in, unless you pass `emailOptedIn: false`. |
| Per user | Is opted in only when you pass `emailOptedIn: true`. |
| No, or not answered | Stays pending (not opted in) until your backend confirms it with the server key. |

With "Require a server key" on, only your backend can opt an address in. The
app key cannot give a user a different email address from the one they
already have. The [`@whisperr/react-native` README](https://github.com/WhisperrAI/whisperr-react-native#identify)
has the details. `emailOptedIn` needs `@whisperr/react-native` 0.6.0 or later.

## Register for push

```tsx
import { registerForPushNotifications } from "@whisperr/expo";

// After Whisperr.init() and identify(), at the moment you want the OS prompt:
const { status, token, reason } = await registerForPushNotifications();
```

What it does:

1. On Android, it creates the notification channel (Android 13+ shows the
   prompt only when a channel exists).
2. It reads the permission and, if the app may still ask, shows the prompt.
3. It reports the permission: `whisperr.setPushPermission(status)`.
4. If notifications are allowed, it gets the Expo push token (the EAS
   `projectId` comes from the app config) and calls `whisperr.setPushToken()`
   with `kind: "expo"`, the EAS project id as `provider_project`, and the app
   id (`expo-application`) as `client_app_id`. The server uses the two ids to
   catch a token of the wrong project or app before a send.
5. It keeps watching: each time the app comes to the foreground it re-checks
   the permission, and it fetches a new Expo token when the device token
   rotates. `stopPushNotificationUpdates()` stops this.

It never throws. When there is no token, `reason` says why:

| `reason` | Meaning |
|---|---|
| `permission_denied` | The user turned notifications off. |
| `permission_undetermined` | The app did not ask (`requestPermission: false`) or the user did not answer. |
| `expo_go_android` | Expo Go on Android cannot receive remote push (Expo SDK 53+). Use a development build. |
| `missing_project_id` | No EAS project id. Run `eas init` or pass `projectId`. |
| `token_unavailable` | The OS gave no token, often on a simulator or emulator. See `error`. |
| `not_initialized` | `Whisperr.init()` did not run and you passed no `client`. |

Options: `client`, `projectId`, `tokenType` (`"expo"` default, or
`"device"`), `providerProject`, `requestPermission` (default `true`),
`provisional` (quiet iOS delivery without a prompt), `ios` (prompt options),
`androidChannel` (`{ id, name, importance }` or `false`), `watch` (default
`true`), `debug`.

### Device tokens (your own APNs key or Firebase project)

```ts
await registerForPushNotifications({ tokenType: "device", providerProject: "my-firebase-project" });
```

With `tokenType: "device"`, the SDK sends the native token instead of the Expo
token: an APNs token on iOS with its `push_env` (`sandbox` for a
development-signed build, else `production`, read with
`expo-application`), an FCM token on Android. Pass `providerProject` with
your Firebase project id. `toWhisperrPushToken(await
Notifications.getDevicePushTokenAsync())` does the same mapping when you get
the token yourself.

### Ask without registering

```ts
import { requestPushAuthorization } from "@whisperr/expo";
const status = await requestPushAuthorization({ provisional: true });
```

It shows the prompt (or, with `provisional`, asks iOS for quiet delivery
without a prompt) and reports the answer to Whisperr.

### What Whisperr does with the permission

- A new status sends the event `push_permission_changed` with `status`
  (`authorized`, `provisional`, `denied`, or `not_determined`) and the status
  sent before it (`previous_status`). A repeated status sends nothing, also
  across restarts.
- `denied` opts this device's push token out, so the engine does not choose
  push for it. When the permission comes back, the SDK registers the token
  again.

## Notification taps and deep links

```tsx
// app/_layout.tsx (expo-router)
import { router, Stack } from "expo-router";
import { useEffect } from "react";
import { deepLinkToHref, useWhisperrNotificationResponse } from "@whisperr/expo";

export default function RootLayout() {
  const open = useWhisperrNotificationResponse();

  useEffect(() => {
    const href = open?.deepLink ? deepLinkToHref(open.deepLink, "myapp") : null;
    if (href) router.push(href);
  }, [open]);

  return <Stack />;
}
```

- It reads `whisperr_message_id` and the deep link (`whisperr_deep_link`, or
  `deep_link`) from the notification data.
- It sends `push_opened` once per message, also across restarts.
- `push_opened` carries `action_id` (`default`, or the action button id) and
  `cold_start` (true for the tap that launched the app).
- It handles the tap that launched the app (cold start) and taps while the
  app runs. A remount does not route the same tap twice. After a Whisperr tap
  is handled, it clears the last notification response, so the next launch
  does not route the same tap again. Pass `clearLastResponse: false` if your
  own code reads `useLastNotificationResponse()`.
- It also sends `push_received` for Whisperr notifications that arrive while
  the app is in the foreground (once per message). Pass
  `trackReceived: false` to turn this off. `trackAppLifecycleEvents: false` on
  the client also stops it.
- Taps on notifications from other senders are ignored.
- `deepLinkToHref(link, scheme?)` turns `myapp://offers/annual` or
  `https://example.com/offers/annual` into `/offers/annual`. With `scheme`, it
  accepts only links with your app's scheme.

Pass `onOpen` to act on each tap directly. Outside React, use
`subscribeToWhisperrNotificationOpens(onOpen)` and
`subscribeToWhisperrNotificationReceipts()`; each returns an unsubscribe.

To show notifications while the app is in the foreground, set a handler with
`Notifications.setNotificationHandler`. See the expo-notifications docs.

## Expo Go

- Events work in Expo Go.
- Remote push does **not** work in Expo Go on Android (Expo SDK 53+).
  `registerForPushNotifications()` returns `reason: "expo_go_android"` there.
  Use a [development build](https://docs.expo.dev/develop/development-builds/introduction/).
- iOS simulators and Android emulators without Google Play often give no token.
  Test push on a real device.

## Requirements

- Expo SDK 52 or later, with `expo-notifications`, `expo-constants`, and
  `expo-application`.
- `@whisperr/react-native` 0.5.0 or later (0.6.0 or later for `emailOptedIn`).
