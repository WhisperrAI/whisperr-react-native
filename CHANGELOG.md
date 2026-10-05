# Changelog

## Unreleased

- **Push token kinds** (whisperr-spec `push.json` `kindCases`):
  `setPushToken()` also takes `{ token, kind, platform, pushEnv }` and the
  expo-notifications token objects. An Expo token in the object form is sent
  as `kind: "expo"`; `platform` defaults to `Platform.OS`; `pushEnv` is never
  guessed. A plain string sends the token only, as before. A token that is
  re-sent with new metadata goes out once more; a bare token never removes
  metadata already sent. `identify({ pushToken })` takes the same forms.
- **`setPushPermission(status)`** (`granted` | `provisional` | `denied` |
  `undetermined`): sends the trait `push_permission`, deduped across restarts.
  `denied` opts out this device's token and holds it until the permission
  comes back. Before login, the status goes with the next `identify()`.
- **`trackPushOpened()` returns `{ messageId, deepLink }`** (or `null`) so the
  app can route. It reads `whisperr_deep_link`, then `deep_link`.
  `push_opened` now carries the common automatic properties.
- **New exports:** `parseWhisperrPush()`, `isExpoPushToken()`,
  `useWhisperrClient()` (the provider's client or the singleton, never throws),
  and the push types.
- A token set before init resolves now waits for the restored last-sent pair,
  so a same-tick `identify()` + `setPushToken()` on launch stays a no-op.
- **New package [`@whisperr/expo`](packages/expo/README.md)**: config plugin,
  `registerForPushNotifications()`, `useWhisperrNotificationResponse()`.

## 0.3.0

This is a minor release with one breaking change. Read the first two items
before you upgrade.

- **Breaking:** `screen(name)` now sends `screen_viewed` with the property
  `screen_name`. It was `name`. Update any dashboards or filters that read
  `name`.
- **Automatic events are on by default.** Set `trackAppLifecycleEvents: false`
  to turn them off.
- **New optional peers:** `expo-application` and `react-native-device-info`.
  You do not need to install them. If your app already has one, the SDK uses it
  to read the app version and build.

Details:

- **Automatic lifecycle events**, on by default (`trackAppLifecycleEvents:
  false` turns them off): `app_installed`, `app_updated` (with
  `previous_version` / `previous_build`), `app_opened` (`cold_start`), and
  `app_backgrounded` (`foreground_ms`), from `AppState`. Each carries the flat
  properties `app_version`, `app_build`, `platform`, `os_name`, `os_version`,
  `sdk_name`, `sdk_version`, `locale`, and `timezone` (or
  `timezone_offset_minutes`). Install / update detection needs durable
  `storage`. An app that upgrades from SDK 0.2.x never reports a false
  `app_installed`.
- **App version without a native dependency:** pass `appVersion` / `appBuild`,
  or the SDK reads them from `expo-application` or `react-native-device-info`
  when the app already has one (optional peers). Otherwise the fields are left out.
- **Anonymous lane** (whisperr-spec `anonymous.json`): events before
  `identify()` are sent right away under `anonymous_id` instead of waiting on the
  device; `identify()` carries the handle it promotes; `reset()` rotates it. New
  handles are bare UUID v4; existing `anon_…` handles are kept.
- **`trackPushOpened(data)`** sends `push_opened` with `whisperr_message_id` (and
  `deep_link`), once per message, also across restarts.
- **Retry-After:** a `429` / `503` with `Retry-After` (seconds or HTTP-date)
  waits that long, capped at 60 s, instead of the backoff.
- **Email shortcut** no longer claims consent: `identify(id, { email })` sends
  the email channel without `opted_in` (and without `verified`). Pass an explicit
  channel to state consent.
- `screen(name)`: `name` is now required (see the breaking change above).
- `optOut()` also drops a buffered push token; `optIn()` can no longer switch on
  a client created with `disabled: true`.

## 0.2.2

- `identify()` now fills the reserved traits `timezone` (IANA name, from
  `Intl.DateTimeFormat().resolvedOptions()`) and `locale` (BCP 47, from `Intl`
  or React Native's `I18nManager`) by default, so the engine evaluates quiet
  hours in the user's zone instead of UTC and picks the message language.
  Caller-supplied values always win; a value the runtime cannot provide is
  omitted. `setPushToken()`'s partial identify stays traits-free.

## 0.2.1

- Fix: the persisted last-sent (user, token) push pair is now restored even
  when `identify(user)` runs in the launch tick (the common case). Previously
  the restore was skipped once `identify()`/`reset()` had run, so `lastPush`
  was null every launch — a post-restart rotation sent **no opt-out** for the
  old token (stale tokens accumulated opted-in) and the same-token dedup was
  defeated (identify spam on every launch). Restoring after `identify()` is
  safe: `setPushToken` only opts out / dedups against a pair whose user matches
  the current user. Only `reset()` invalidates the pair now.
- Fix: the dedup pair is a mark of what was **delivered**. A registration whose
  request is dropped (non-retryable `4xx`) or evicted on queue overflow now
  clears the pair, so the token re-registers on the next `setPushToken` instead
  of being wedged opted-out forever by a single rejection.
- `identify(pushToken:)` now rotates like `setPushToken`: a push token passed
  to `identify()` that differs from the last one sent opts the previous token
  out in the same body, instead of stranding it opted-in.
- Verified against the hardened `whisperr-spec` `conformance/push.json`
  (restart-then-reidentify rotation/dedup, `reset`, empty-token, and
  `identify(pushToken:)` cases).

## 0.2.0

- `setPushToken(token)`: first-class push-token capture. Re-identifies the
  `push` channel for the current user, buffers tokens set before `identify()`,
  no-ops on repeated tokens, and opts the previous token out on rotation —
  matching the other Whisperr SDKs and verified against the new
  `whisperr-spec` `conformance/push.json` fixtures.
- The last-sent (user, token) pair persists through the storage adapter, so
  the repeated-token no-op holds across app restarts and a rotation after a
  relaunch still opts out the stale token. `reset()` clears the persisted
  pair too.
- `useWhisperrPushToken(token)` React hook: forwards tokens from your messaging
  library (`@react-native-firebase/messaging`, `expo-notifications`, …) as they
  arrive. Still zero dependencies and zero native code.
- `reset()` now also clears buffered/remembered push tokens.

## 0.1.1

- Expose `./package.json` through the exports map so RN/Expo tooling can
  resolve it.

## 0.1.0

- Initial React Native SDK for Whisperr ingestion.
- Pure-TypeScript client (Expo Go compatible, zero native code): ordered
  durable queue over an injected AsyncStorage-compatible adapter, anonymous
  event buffering with backfill on `identify()`, batched delivery with
  retry/auth/drop classification, stable `$message_id` idempotency,
  app-background flush, `screen()`, `reset()`, and persisted
  `optIn()`/`optOut()`.
- React bindings: `WhisperrProvider` + `useWhisperr()`.
- Spec-driven wire and behavior conformance tests against `whisperr-spec`.
