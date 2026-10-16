# @whisperr/react-native

Reliable, Expo-friendly churn-signal event tracking for React Native — **zero
native code**, works in Expo Go, bare React Native, and dev clients alike.

```bash
npm i @whisperr/react-native @react-native-async-storage/async-storage
```

```tsx
import { Whisperr } from "@whisperr/react-native";

// Uses AsyncStorage automatically when it is installed.
const whisperr = Whisperr.init({ apiKey: "wpk_…" });

// after the user logs in / on session restore
whisperr.identify("user_123", { traits: { first_name: "Ada", plan: "pro" } });

// when something happens
whisperr.track("subscription_cancelled", { reason: "too_expensive" });

// on logout
whisperr.reset();
```

- **Pure TypeScript, zero dependencies, zero native modules** — nothing to
  link, nothing to prebuild; fully compatible with Expo Go. (Events work in
  Expo Go. Remote push on Android needs a development build from Expo SDK 53.)
- **Automatic app signals** — installed, updated, opened, backgrounded, with
  app / OS / locale / timezone context. No code needed.
- **Anonymous → identified** — events before login are sent right away under an
  anonymous id; `identify()` promotes them to the user, `reset()` starts a new
  anonymous visitor.
- **Never loses events** — durable on-device queue (AsyncStorage by default),
  automatic flush when the app backgrounds, batching, retry/backoff, and a
  stable `$message_id` per event so the backend dedups at-least-once retries.
- **Consent-friendly** — `optIn()` / `optOut()` persist across launches and
  stop all capture, automatic events included. `optOut()` also opts this
  device's push token out on the server.
- **Push-ready** — token kinds (Expo, FCM, APNs), permission state, and
  notification-open tracking with deep links.

## Storage (durability)

The SDK keeps the user id, the anonymous id, the queue, the push token pair,
the opt-out choice, and the app language on the device.

- **Default:** when `@react-native-async-storage/async-storage` is installed,
  the SDK uses it. You do not pass anything. In Expo:
  `npx expo install @react-native-async-storage/async-storage`.
- **Your own adapter:** pass any object with `getItem` / `setItem` /
  `removeItem` (MMKV, `expo-sqlite/kv-store`). It wins over AsyncStorage.

```ts
Whisperr.init({ apiKey: "wpk_…", storage: myMmkvAdapter });
```

- **Neither:** the SDK works in memory only. The user id is lost at each app
  restart, and events captured right before a crash or kill are lost. The SDK
  logs one warning in development. It never crashes.

AsyncStorage is an optional peer: the SDK never installs it, and a missing or
unlinked package is not an error.

## React bindings

```tsx
import { WhisperrProvider, useWhisperr } from "@whisperr/react-native";

export default function App() {
  return (
    <WhisperrProvider options={{ apiKey: "wpk_…" }}>
      <Root />
    </WhisperrProvider>
  );
}

function CancelButton() {
  const whisperr = useWhisperr();
  return <Button onPress={() => whisperr.track("cancel_tapped")} title="Cancel" />;
}
```

## Automatic events

On by default. Turn them off with `trackAppLifecycleEvents: false`.

| Event | Sent when | Extra properties |
|---|---|---|
| `app_installed` | First launch of a fresh install | — |
| `app_updated` | First launch after the app version or build changed | `previous_version`, `previous_build` |
| `app_opened` | The app comes to the foreground | `cold_start` (true for the first foreground of the process) |
| `app_backgrounded` | The app goes to the background | `foreground_ms` |
| `push_received` | You call `trackPushReceived()` for a Whisperr push | `whisperr_message_id`, `foreground`, `source` |

Every event (also your own `track()` calls) carries `app_version`,
`app_build`, `platform`, `sdk_name`, and `sdk_version` in `context`, when the
SDK knows them. It never puts `locale` in `context`.

Every automatic event also carries these flat properties, when the device can
provide them: `app_version`, `app_build`, `platform` and `os_name` (`"ios"`,
`"android"`, `"web"`), `os_version`, `sdk_name`, `sdk_version`, `locale`, and
`timezone` (IANA name; `timezone_offset_minutes` when there is none).

- `app_installed` / `app_updated` need durable storage: the SDK compares the
  version with the one it stored at the last launch. An app that upgrades from
  SDK 0.2.x stores the version silently, so it never reports a false install.
- A launch into the background (headless JS, background fetch) is not an open.
  iOS's brief `inactive` state (Control Center, calls) is not a background.

### App version and build

The SDK has no native code, so it cannot read the app version by itself. It
uses the first of these that answers, and leaves the fields out otherwise:

1. `appVersion` / `appBuild` options, if you pass them.
2. [`expo-application`](https://docs.expo.dev/versions/latest/sdk/application/),
   if the app has it (`npx expo install expo-application`).
3. [`react-native-device-info`](https://github.com/react-native-device-info/react-native-device-info),
   if the app has it.

Both packages are optional peers: the SDK never installs or requires them, so
Expo Go and apps without them keep working. In Expo Go, `expo-application`
reports Expo Go's own version; that is a development-only effect.

## Screens

```ts
whisperr.screen("Paywall", { plan: "pro" }); // tracks screen_viewed { screen_name: "Paywall", plan: "pro" }
```

Wire it to your navigator once, e.g. React Navigation:

```tsx
<NavigationContainer
  onStateChange={() => whisperr.screen(navigationRef.getCurrentRoute()?.name)}
>
```

## Identify

```ts
whisperr.identify("user_123", { traits: { first_name: "Ada", plan: "pro" } });
```

Contact channels:

```ts
whisperr.identify("user_123", {
  email: "ada@acme.com",
  emailOptedIn: true,        // the user agreed to email at signup; leave out if you don't know
  phone: "+15551234567",     // stored as pending: unverified, not opted in
  pushToken: fcmToken,       // an opted-in push channel
});

// Record the user's opt-out from the app:
whisperr.identify("user_123", { email: "ada@acme.com", emailOptedIn: false });
```

`emailOptedIn: true` sends `opted_in: true` and `consent_source: "user"` on
the email channel. `false` sends `opted_in: false`. Without it, the SDK sends
no consent claim. An explicit email channel with `optedIn: true` also sends
`consent_source: "user"`. The SDK never claims `verified`.

The app uses the publishable key (`wpk_…`), which anyone can read from the app
bundle. So whether Whisperr may email an address that the app sends depends on
your answer in Whisperr to "Does your signup get permission to email users?":

| Answer | An email address the app sends |
|---|---|
| Yes | Is opted in, unless you pass `emailOptedIn: false`. |
| Per user | Is opted in only when you pass `emailOptedIn: true`. |
| No, or not answered | Stays pending (not opted in) until your backend confirms it. |

An earlier opt-out is kept. That covers `emailOptedIn: false`, the user's
click on the unsubscribe link, and suppression after a bounce or a complaint.
A later identify from the app never opts that address back in.

Limits on what the app can do with the publishable key:

- It cannot give a user a different email address from the one the user
  already has. The server rejects that identify with `403
  contact_change_requires_server_key`. Your backend can change it.
- An address that another user of the app already has opted in stays pending.
- New opted-in addresses from the app are rate-limited per app. Over the
  limit, an address stays pending.
- `emailOptedIn: false` records an opt-out with any key.

The stricter mode is the "Require a server key" setting. With it on, only your
backend can opt an address in, whatever the app sends. To confirm consent from
your backend, identify the same user and address with the server key (`wrk_…`)
through a server SDK. For SMS, also send `opted_in: true`: the app cannot opt
an SMS address in, and an SMS address without it is never opted in. Whisperr
does not email a pending address.

`identify()` also sends `traits.timezone` (IANA, via `Intl`) and `traits.locale` (BCP 47, via `Intl` or `I18nManager`) by default when the runtime can provide them — pass your own `traits.timezone` / `traits.locale` to override, and nothing is sent for a value the device can't supply.

### Identify at every app start

At each app start, the SDK identifies the stored user again (the **restore
identify**): `external_user_id`, the anonymous id, and the traits from the
device plus the app language. This keeps the timezone, the locale, and the
language current while the user stays signed in.

- It skips the restore identify when you call `identify()` in the same tick
  as `Whisperr.init()`, and when the same traits reached the server less than
  24 hours ago.
- It goes through the same persisted queue. Offline, it waits.
- Opted out, or no stored user: nothing is sent.
- The SDK cannot know a user who signed in before you installed the SDK. Call
  `identify()` on session restore too.

### App language

Tell Whisperr the language the user picked in your app. It is not the device
locale. Whisperr writes messages in this language.

```ts
whisperr.setAppLanguage("pt-BR"); // BCP 47; "pt_BR" also works
whisperr.setAppLanguage(null);    // clear the stored value
```

- The SDK stores it and sends it at once: as a partial identify for the
  current user, or before login as an anonymous identify.
- Every later `identify()` carries it as `traits.app_language`. A
  `traits.app_language` that you pass wins.
- The same value again sends nothing. An invalid tag is ignored.

## Push notifications

The SDK never bundles a push library. Hand it the token your messaging setup
produces, and Whisperr keeps the `push` channel current:

```ts
whisperr.setPushToken({ token, kind: "fcm" });
```

### Token kinds

The token type tells Whisperr which provider can send to the token. Send it
when you know it:

| Token | Call |
|---|---|
| Expo push token (`ExponentPushToken[…]`) | `setPushToken({ token })` — detected as `expo` |
| expo-notifications token object | `setPushToken(await Notifications.getExpoPushTokenAsync({ projectId }))` → `expo`; `getDevicePushTokenAsync()` → `apns` on iOS, `fcm` on Android |
| FCM registration token | `setPushToken({ token, kind: "fcm" })` |
| Raw APNs device token (hex) | `setPushToken({ token, kind: "apns", pushEnv: "production" })` |
| OneSignal subscription id | `setPushToken({ token, kind: "onesignal_sub" })` |

- `platform` is always sent: it defaults to `Platform.OS`.
- `clientAppId` (sent as `client_app_id`): the iOS bundle id or Android
  package name. Default: `WhisperrOptions.clientAppId`, else
  `expo-application` or `react-native-device-info` when installed.
- `providerProject` (sent as `provider_project`): the Firebase project id
  (FCM), the EAS project id (Expo), or the OneSignal app id. Default: the EAS
  project id from `expo-constants` for Expo tokens, the Firebase project id
  from `@react-native-firebase/app` for FCM tokens. Never for APNs tokens.
  With these two fields the server catches a token of the wrong app or
  project before a send.
- `pushEnv` is the APNs environment: `sandbox` for development-signed builds
  (run from Xcode, development profile), `production` for TestFlight and the
  App Store. The SDK cannot read it, so set it from your build config. Without
  it, Whisperr cannot tell a sandbox token from a production token.
- A plain string (`setPushToken(token)`) sends no kind. The server then
  infers the kind from its format.
- An APNs token needs an APNs provider in Whisperr. An Expo token needs the
  Expo provider.

### Token lifecycle

- Called **after login**, it re-identifies the push channel immediately.
- Called **before login**, the token goes out at once in an anonymous
  identify (`anonymous_id` + the push channel). The next `identify()` carries
  the token and promotes the anonymous user, so the device can get push
  before the user signs in.
- **Token rotation** is handled: the previously sent token is opted out and the
  new one opted in, so stale tokens don't accumulate — and tokens from the
  user's other devices are never touched.
- Setting the **same token twice** is a no-op, so it's safe to call on every
  launch and from `onTokenRefresh`. The last-sent (user, token) pair is
  persisted through your storage adapter, so the no-op holds **across app
  restarts** — and a rotation that happens after a relaunch still opts out the
  stale token.
- `reset()` (logout) moves the token: it opts the token out for the old user,
  makes a new anonymous id, and opts the token in under it.
- **Re-registration:** the SDK sends the same token again at most once every
  7 days, at launch. The server uses it to tell a live device from a stale
  one.

### Permission

Report the OS notification permission on every launch and every return to
the foreground. A repeated status is a no-op.

```ts
whisperr.setPushPermission("granted"); // "granted" | "provisional" | "denied" | "undetermined"
```

To show the OS prompt, call `requestPushAuthorization()`. It uses
`expo-notifications` or `@react-native-firebase/messaging`, whichever the app
has, and reports the answer for you. With `provisional: true`, iOS grants
quiet delivery (Notification Center only) without a prompt.

```ts
const status = await whisperr.requestPushAuthorization({ provisional: true }); // null: no package found
```

- A new status sends the event `push_permission_changed`. Its `status` uses
  the spec names: `granted` → `authorized`, `undetermined` →
  `not_determined`; `provisional` and `denied` stay the same.
  `previous_status` is the last status sent from this device. The SDK stores
  that status, so a repeated report sends nothing, also after a restart.
  `reset()` forgets it, so the next user gets a fresh report.
- Before login, the event goes out under the anonymous id.
- `denied` opts this device's token out, so the engine does not choose push
  for it. While the status is `denied`, `setPushToken()` holds the token back.
  When you report `granted` or `provisional` again, the SDK registers it again.
- While opted out, the SDK sends nothing and keeps the stored status.

### Opt-out

`optOut()` stops all capture until `optIn()`. When this device registered a
push token, the SDK first sends one identify that opts that token out, so
Whisperr stops sending push to this device. The identify goes to the user the
token was registered for. After `identify()` without `reset()`, that is not
always the current user. Push opt-outs that are still queued (a token
rotation, a `denied` report, an earlier `optOut()`) are kept and go first, so
a token retired before the opt-out stays retired. The SDK retries these
requests like any other, also after a restart. An app that opted out with SDK
0.4.x sends this request once at the first start after the upgrade. Email,
SMS, and the user's other devices keep their state, and data already sent is
not deleted. After `optIn()`, call `setPushToken()` again to register the
token.

### Expo with `expo-notifications`

Register the Expo push token and report the permission. Connect the Expo
provider in Whisperr.

```tsx
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";

async function registerPush() {
  const status = await whisperr.requestPushAuthorization();
  if (status !== "granted" && status !== "provisional") return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  whisperr.setPushToken(await Notifications.getExpoPushTokenAsync({ projectId }));
}
```

To report taps, see [Push opens](#push-opens).

[`@whisperr/expo`](https://github.com/WhisperrAI/whisperr-react-native/tree/main/packages/expo#readme)
does this wiring in one call, adds a config plugin for native push setup, and
reports notification taps with their deep links.

### Bare React Native with `@react-native-firebase/messaging`

Firebase gives an FCM token on both platforms (on iOS, Firebase maps the APNs
token to an FCM token for you).

```tsx
import messaging from "@react-native-firebase/messaging";
import { AppState } from "react-native";
import type { PushPermissionStatus } from "@whisperr/react-native";

// messaging.AuthorizationStatus: -1 NOT_DETERMINED, 0 DENIED, 1 AUTHORIZED, 2 PROVISIONAL, 3 EPHEMERAL
function toStatus(status: number): PushPermissionStatus {
  if (status === messaging.AuthorizationStatus.PROVISIONAL) return "provisional";
  if (status === messaging.AuthorizationStatus.AUTHORIZED || status === messaging.AuthorizationStatus.EPHEMERAL) return "granted";
  if (status === messaging.AuthorizationStatus.DENIED) return "denied";
  return "undetermined";
}

async function registerPush() {
  // On Android 13+, also request POST_NOTIFICATIONS (PermissionsAndroid).
  whisperr.setPushPermission(toStatus(await messaging().requestPermission()));
  whisperr.setPushToken({ token: await messaging().getToken(), kind: "fcm" });
}

useEffect(() => {
  void registerPush();
  const unsubscribe = messaging().onTokenRefresh((token) => whisperr.setPushToken({ token, kind: "fcm" }));
  // Users change the permission in Settings: check again on each foreground.
  const sub = AppState.addEventListener("change", async (state) => {
    if (state === "active") whisperr.setPushPermission(toStatus(await messaging().hasPermission()));
  });
  return () => {
    unsubscribe();
    sub.remove();
  };
}, []);
```

### Bare React Native with `react-native-notifications` (direct APNs)

```tsx
import { Platform } from "react-native";
import { Notifications } from "react-native-notifications";

Notifications.events().registerRemoteNotificationsRegistered(({ deviceToken }) => {
  whisperr.setPushToken(
    Platform.OS === "ios"
      ? { token: deviceToken, kind: "apns", pushEnv: IS_APP_STORE_BUILD ? "production" : "sandbox" }
      : { token: deviceToken, kind: "fcm" },
  );
});
Notifications.registerRemoteNotifications();
```

`IS_APP_STORE_BUILD` is your own build flag (for example from
`react-native-config`). Report the permission with `setPushPermission()` as
above.

### Push opens

Call `trackPushOpened()` when the user taps a notification. It reads
`whisperr_message_id` and the deep link (`whisperr_deep_link`, or `deep_link`)
from the payload and sends `push_opened` once per message, so the engine
learns which messages work. Pass the data map, or the whole response / message
object. A push without `whisperr_message_id` did not come from Whisperr and is
ignored. Calling it twice for the same tap is safe, also across restarts.

It returns `{ messageId, deepLink, actionId }` for a Whisperr push (also for
a repeated tap, and while opted out), or `null`. Route to `deepLink` yourself.
`parseWhisperrPush(data)` reads the same fields without sending anything.

`push_opened` also carries:

- `action_id`: `default` for a tap on the notification, else the button id.
  The SDK reads it from an expo-notifications response. Pass it for other
  libraries: `trackPushOpened(message, { actionId })`.
- `cold_start`: true when the tap launched the app. Pass it when you know it
  (for example from `getInitialNotification()`):
  `trackPushOpened(message, { coldStart: true })`. Without it, the SDK uses
  true for an open in the first 10 seconds after start with no background
  since.

### Push receipts

Call `trackPushReceived()` from your foreground notification listener. It
sends `push_received` (`whisperr_message_id`, `foreground`, `source`) once per
message, also across restarts. It does not count as user activity. It is an
automatic event: `trackAppLifecycleEvents: false` stops it.

```ts
messaging().onMessage((message) => whisperr.trackPushReceived(message)); // foreground: true, source: "foreground"
```

With `@react-native-firebase/messaging`:

```tsx
import messaging from "@react-native-firebase/messaging";
import { Linking } from "react-native";

function openPush(message) {
  const open = whisperr.trackPushOpened(message);
  if (open?.deepLink) void Linking.openURL(open.deepLink);
}

useEffect(() => {
  // Cold start: the notification that launched the app.
  messaging().getInitialNotification().then((message) => message && openPush(message));
  // Taps that bring the app back from the background.
  return messaging().onNotificationOpenedApp(openPush);
}, []);
```

With `react-native-notifications`:

```tsx
Notifications.getInitialNotification().then((n) => n && openPush(n.payload));
Notifications.events().registerNotificationOpened((n, completion) => {
  openPush(n.payload);
  completion();
});
```

With `expo-notifications`:

```tsx
import * as Notifications from "expo-notifications";

useEffect(() => {
  Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) whisperr.trackPushOpened(response, { coldStart: true });
  });
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    whisperr.trackPushOpened(response);
  });
  return () => sub.remove();
}, []);
```

## Delivery

- Events send to `POST /v1/events/batch`; identity to `POST /v1/identify`,
  authenticated with `X-API-Key` (the ingestion key is publishable).
- Event names must be lowercase `snake_case`; invalid names are dropped before
  queueing and surfaced through `onError`.
- `401`/`403` pause delivery and retain the queue (`auth`); `429`/`5xx`/network
  errors retry with backoff, then retain (`retry_exhausted`); other `4xx` drop
  the offending batch (`dropped`). Every drop reaches `onError`. The first drop
  for each status code also logs a `console.warn`, even with `debug` off; with
  `debug` on, every drop logs one.
- A `429` or `503` with `Retry-After` (seconds or HTTP-date) waits that long,
  capped at 60 s, instead of the backoff.
- The queue flushes when the app goes to the background.

## Options

```ts
Whisperr.init({
  apiKey: "wpk_…",
  storage: myAdapter,         // optional; default AsyncStorage when installed
  flushAt: 20,                // flush when this many events are queued
  flushIntervalMs: 10000,     // periodic flush
  flushOnAppBackground: true, // flush when the app leaves the foreground
  maxQueueSize: 1000,         // oldest events drop past this
  maxRetries: 6,
  trackAppLifecycleEvents: true, // app_installed / updated / opened / backgrounded
  appVersion: "2.4.1",        // optional; else read from expo-application / react-native-device-info
  appBuild: "241",
  clientAppId: "com.acme.app", // optional; sent with push tokens as client_app_id
  onError: (e) => console.warn("whisperr:", e.type, e.message),
});
```

`Whisperr.init()` is an idempotent singleton; construct `WhisperrClient`
directly for explicit lifetimes (call `close()` when done).

## Development

The test suite consumes the shared `whisperr-spec` fixtures (wire, behavior,
anonymous, push, automatic, and the contract v2 file `v2.json`):

```bash
WHISPERR_SPEC_PATH=../whisperr-spec/conformance/wire.json npm test
```

Whisperr — predict churn, automate interventions, recover revenue.
