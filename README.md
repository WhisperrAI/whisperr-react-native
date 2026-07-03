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
whisperr.identify("user_123", { email: "ada@acme.com", traits: { plan: "pro" } });

// when something happens
whisperr.track("subscription_cancelled", { reason: "too_expensive" });

// on logout
whisperr.reset();
```

- **Pure TypeScript, zero dependencies, zero native modules** — nothing to
  link, nothing to prebuild; fully compatible with Expo Go.
- **Anonymous → identified** — events before login buffer on-device and
  attribute to the user on `identify()`.
- **Never loses events** — durable on-device queue (via your storage adapter),
  automatic flush when the app backgrounds, batching, retry/backoff, and a
  stable `$message_id` per event so the backend dedups at-least-once retries.
- **Consent-friendly** — `optIn()` / `optOut()` persist across launches.

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

## Screens

```ts
whisperr.screen("Paywall", { plan: "pro" }); // tracks screen_viewed
```

Wire it to your navigator once, e.g. React Navigation:

```tsx
<NavigationContainer
  onStateChange={() => whisperr.screen(navigationRef.getCurrentRoute()?.name)}
>
```

## Identify

```ts
whisperr.identify("user_123", {
  traits: { name: "Ada", plan: "pro" },
  email: "ada@acme.com",
  phone: "+15551234567",
  pushToken: expoPushToken, // expands to an opted-in push channel
});

// Full channel control (consent / verification):
whisperr.identify("user_123", {
  channels: [
    { type: "email", address: "ada@acme.com", verified: true },
    { type: "sms", address: "+15551234567", optedIn: false },
  ],
});
```

## Delivery

- Events send to `POST /v1/events/batch`; identity to `POST /v1/identify`,
  authenticated with `X-API-Key` (the ingestion key is publishable).
- Event names must be lowercase `snake_case`; invalid names are dropped before
  queueing and surfaced through `onError`.
- `401`/`403` pause delivery and retain the queue (`auth`); `429`/`5xx`/network
  errors retry with backoff, then retain (`retry_exhausted`); other `4xx` drop
  the offending batch (`dropped`).

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
