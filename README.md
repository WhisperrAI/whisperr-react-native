# @whisperr/react-native

Reliable, Expo-friendly churn-signal event tracking for React Native — **zero
native code**, works in Expo Go, bare React Native, and dev clients alike.

```bash
npm i @whisperr/react-native
```

```tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Whisperr } from "@whisperr/react-native";

const whisperr = Whisperr.init({ apiKey: "wrk_…", storage: AsyncStorage });

// after the user logs in / on session restore
whisperr.identify("user_123", { traits: { first_name: "Ada", plan: "pro" } });

// when something happens
whisperr.track("subscription_cancelled", { reason: "too_expensive" });

// on logout
whisperr.reset();
```

- **Pure TypeScript, zero dependencies, zero native modules** — nothing to
  link, nothing to prebuild; fully compatible with Expo Go.
- **Automatic app signals** — installed, updated, opened, backgrounded, with
  app / OS / locale / timezone context. No code needed.
- **Anonymous → identified** — events before login are sent right away under an
  anonymous id; `identify()` promotes them to the user, `reset()` starts a new
  anonymous visitor.
- **Never loses events** — durable on-device queue (via your storage adapter),
  automatic flush when the app backgrounds, batching, retry/backoff, and a
  stable `$message_id` per event so the backend dedups at-least-once retries.
- **Consent-friendly** — `optIn()` / `optOut()` persist across launches and
  stop all capture, automatic events included.

## Storage (durability)

The SDK never imports a native module itself — you hand it any
AsyncStorage-compatible adapter (`getItem`/`setItem`/`removeItem`):

```ts
// The common case:
import AsyncStorage from "@react-native-async-storage/async-storage";
Whisperr.init({ apiKey: "wrk_…", storage: AsyncStorage });

// Or MMKV, expo-sqlite/kv-store, SecureStore — anything with the same shape.
```

Without `storage` the SDK still works, but the queue is memory-only: events
captured right before a crash or app kill are lost. In Expo, install the
adapter with `npx expo install @react-native-async-storage/async-storage`.

## React bindings

```tsx
import { WhisperrProvider, useWhisperr } from "@whisperr/react-native";

export default function App() {
  return (
    <WhisperrProvider options={{ apiKey: "wrk_…", storage: AsyncStorage }}>
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

Every automatic event also carries these flat properties, when the device can
provide them: `app_version`, `app_build`, `platform` and `os_name` (`"ios"`,
`"android"`, `"web"`), `os_version`, `sdk_name`, `sdk_version`, `locale`, and
`timezone` (IANA name; `timezone_offset_minutes` when there is none).

- `app_installed` / `app_updated` need durable `storage`: the SDK compares the
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
  email: "ada@acme.com",     // an email channel; claims no consent and no verification
  phone: "+15551234567",     // an opted-in SMS channel
  pushToken: fcmToken,       // an opted-in push channel
});

// Full channel control (consent / verification):
whisperr.identify("user_123", {
  channels: [
    { type: "email", address: "ada@acme.com", optedIn: true, verified: true },
    { type: "sms", address: "+15551234567", optedIn: false },
  ],
});
```

The `email` shortcut sends neither `opted_in` nor `verified`: the SDK does not
claim consent for the user. When you hold marketing consent, say so with an
explicit channel.

`identify()` also sends `traits.timezone` (IANA, via `Intl`) and `traits.locale` (BCP 47, via `Intl` or `I18nManager`) by default when the runtime can provide them — pass your own `traits.timezone` / `traits.locale` to override, and nothing is sent for a value the device can't supply.

## Push notifications

The SDK never bundles a push library — hand it the token your own messaging
setup produces and Whisperr keeps the `push` channel current:

```ts
whisperr.setPushToken(token);
```

- Called **after login**, it re-identifies the push channel immediately.
- Called **before login**, the token is buffered and attached to the next
  `identify()`.
- **Token rotation** is handled: the previously sent token is opted out and the
  new one opted in, so stale tokens don't accumulate — and tokens from the
  user's other devices are never touched.
- Setting the **same token twice** is a no-op, so it's safe to call on every
  launch and from `onTokenRefresh`. The last-sent (user, token) pair is
  persisted through your storage adapter, so the no-op holds **across app
  restarts** — and a rotation that happens after a relaunch still opts out the
  stale token.
- After `reset()` (logout), call `setPushToken` again once the next user logs in.

With `@react-native-firebase/messaging`:

```tsx
import messaging from "@react-native-firebase/messaging";
import { useWhisperrPushToken } from "@whisperr/react-native";

function PushBridge() {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    messaging().getToken().then(setToken);
    return messaging().onTokenRefresh(setToken);
  }, []);
  useWhisperrPushToken(token); // forwards to whisperr.setPushToken()
  return null;
}
```

With `expo-notifications`:

```tsx
import * as Notifications from "expo-notifications";

const [token, setToken] = useState<string | null>(null);
useEffect(() => {
  Notifications.getDevicePushTokenAsync().then((t) => setToken(t.data));
  const sub = Notifications.addPushTokenListener((t) => setToken(t.data));
  return () => sub.remove();
}, []);
useWhisperrPushToken(token);
```

### Push opens

Call `trackPushOpened()` when the user taps a notification. It reads
`whisperr_message_id` (and `deep_link`) from the payload and sends `push_opened`
once per message, so the engine learns which messages work. Pass the data map,
or the whole response / message object. A push without `whisperr_message_id`
did not come from Whisperr and is ignored. Calling it twice for the same tap is
safe, also across restarts.

With `expo-notifications`:

```tsx
import * as Notifications from "expo-notifications";

useEffect(() => {
  // Cold start: the tap that launched the app.
  Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) whisperr.trackPushOpened(response);
  });
  // Taps while the app runs or is in the background.
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    whisperr.trackPushOpened(response);
  });
  return () => sub.remove();
}, []);
```

With `@react-native-firebase/messaging`:

```tsx
import messaging from "@react-native-firebase/messaging";

useEffect(() => {
  // Cold start: the notification that launched the app.
  messaging().getInitialNotification().then((message) => {
    if (message) whisperr.trackPushOpened(message);
  });
  // Taps that bring the app back from the background.
  return messaging().onNotificationOpenedApp((message) => whisperr.trackPushOpened(message));
}, []);
```

Route to `deep_link` yourself if you use it; the SDK only records the open.

## Delivery

- Events send to `POST /v1/events/batch`; identity to `POST /v1/identify`,
  authenticated with `X-API-Key` (the ingestion key is publishable).
- Event names must be lowercase `snake_case`; invalid names are dropped before
  queueing and surfaced through `onError`.
- `401`/`403` pause delivery and retain the queue (`auth`); `429`/`5xx`/network
  errors retry with backoff, then retain (`retry_exhausted`); other `4xx` drop
  the offending batch (`dropped`).
- A `429` or `503` with `Retry-After` (seconds or HTTP-date) waits that long,
  capped at 60 s, instead of the backoff.
- The queue flushes when the app goes to the background.

## Options

```ts
Whisperr.init({
  apiKey: "wrk_…",
  storage: AsyncStorage,      // durable queue + identity (recommended)
  flushAt: 20,                // flush when this many events are queued
  flushIntervalMs: 10000,     // periodic flush
  flushOnAppBackground: true, // flush when the app leaves the foreground
  maxQueueSize: 1000,         // oldest events drop past this
  maxRetries: 6,
  trackAppLifecycleEvents: true, // app_installed / updated / opened / backgrounded
  appVersion: "2.4.1",        // optional; else read from expo-application / react-native-device-info
  appBuild: "241",
  onError: (e) => console.warn("whisperr:", e.type, e.message),
});
```

`Whisperr.init()` is an idempotent singleton; construct `WhisperrClient`
directly for explicit lifetimes (call `close()` when done).

## Development

The test suite consumes the shared `whisperr-spec` fixtures:

```bash
WHISPERR_SPEC_PATH=../whisperr-spec/conformance/wire.json npm test
```

Whisperr — predict churn, automate interventions, recover revenue.
