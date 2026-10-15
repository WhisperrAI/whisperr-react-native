# Changelog

## 0.5.1

- **The `phone` shortcut no longer sends `opted_in: true`.** It now sends the
  `sms` channel with no consent claim, like the `email` shortcut, as the spec
  requires. The server never opted an SMS address in from the publishable key,
  so delivery does not change. Pass an explicit channel to send `optedIn`.
- **README:** Expo push is wired with `expo-notifications` directly;
  `@whisperr/expo` is not on npm yet. Confirming SMS consent from the backend
  needs `opted_in: true`. Every rejected-request drop reaches `onError`; only
  the console warning is once per status code.

- **Rejected requests warn without debug.** When the server rejects a request
  with a non-retryable `4xx` (not `401`, `403` or `429`), the SDK drops it, as
  before, and now logs a `console.warn` the first time each status code occurs,
  even with `debug` off. With `debug` on it warns on every drop. The `dropped`
  error passed to `onError` now carries the HTTP `status`. `429` and `5xx`
  keep retrying as before.
- **README: what the `email` shortcut does to consent.** An email or SMS
  address sent with the publishable key is stored as pending (unverified, not
  opted in), and Whisperr does not email it until your backend confirms the
  address with the server key. The README no longer shows `optedIn: true` /
  `verified: true` from the app, which the server ignores.

## 0.5.0

Contract v2 (whisperr-spec `v2.json`). **Release this version only after the
Whisperr backend with contract v2 is live**: an older server rejects the
anonymous identify and the new push fields with `400`.

- **Storage by default.** Without a `storage` option the SDK uses
  `@react-native-async-storage/async-storage` when the app has it installed
  (an optional peer, loaded with a guarded `require`). A passed `storage`
  still wins. With neither, the SDK stays in memory and logs one warning in
  development; it never crashes. Before, the user id was lost at each restart
  when the app passed no `storage`. Apps that passed no storage and run 0.5.0
  for the first time have no stored app version, so that start can report
  `app_installed` once.
- **Restore identify at start.** With a stored user and no opt-out, the SDK
  queues one identify at start: `external_user_id`, `anonymous_id`, and the
  restore traits (device `timezone` / `locale` + `app_language`). It skips it
  when the app calls `identify()` before the SDK finished its storage read,
  and when the same user got the same restore traits less than 24 hours ago
  (a persisted restore record; `reset()` and `optOut()` delete it). Offline
  it waits in the persisted queue, and a queued one is not doubled.
- **`setAppLanguage(tag | null)`.** Stores the language the user picked in the
  app (BCP 47, `_` read as `-`) and sends it as `traits.app_language`: a
  partial identify with a user, an anonymous identify without one. Every later
  identify and the restore identify carry it; a caller-supplied
  `traits.app_language` wins. Same value: nothing sent. `null` clears it.
- **Anonymous push tokens.** `setPushToken()` before `identify()` sends an
  anonymous identify (`anonymous_id` + the push channel) at once, instead of
  holding the token in memory. The dedupe pair is now (subject, token).
  `identify()` carries a token registered under the anonymous id and promotes
  that id. `reset()` opts the token out for the old user (or old anonymous
  id), rotates the anonymous id, and opts the token in under the new one.
  A `denied` permission before login opts the anonymous token out.
- **Push token fields.** Every opted-in push entry carries `platform`. New:
  `client_app_id` (option `clientAppId`, else `expo-application` /
  `react-native-device-info`) and `provider_project` (the EAS project id from
  `expo-constants` for Expo tokens, the Firebase project id from
  `@react-native-firebase/app` for FCM tokens; never for APNs). Both can be
  passed in the object form of `setPushToken()`. A token with less metadata
  than the last one sent never downgrades it.
- **Re-registration.** The same token is sent again at most once every 7 days,
  at launch (the pair stores `sentAt`). A pair stored by 0.4.x has no `sentAt`
  and is sent once after the upgrade.
- **`push_opened`** carries `action_id` (`default`, or the button id from an
  expo-notifications response or `trackPushOpened(data, { actionId })`) and
  `cold_start` (`trackPushOpened(data, { coldStart })`; default: true in the
  first 10 seconds after start with no background since). The return value
  has `actionId` when known.
- **`trackPushReceived(data, { foreground, source })`** sends the new
  automatic event `push_received` once per `whisperr_message_id`, also across
  restarts. `trackAppLifecycleEvents: false` stops it.
- **`requestPushAuthorization({ provisional })`** shows the OS prompt through
  `expo-notifications` or `@react-native-firebase/messaging` and reports the
  answer. Resolves `null` when neither is installed.
- **Version context.** Every event carries `app_version`, `app_build`,
  `platform`, `sdk_name`, and `sdk_version` in `context` (no value, no key).
  `context.library` stays. The SDK never puts `locale` in `context`.
- New optional peers: `@react-native-async-storage/async-storage`,
  `expo-constants`, `expo-notifications`, `@react-native-firebase/app`,
  `@react-native-firebase/messaging`.
- The test suite runs whisperr-spec `v2.json` (restore identify, app language,
  anonymous push, push registration, version context) and `automatic.json`
  `pushEventsV2`, and skips the legacy cases they supersede.

Also in 0.5.0 (merged after 0.4.0, not released before):

- **Removed: the identify trait `push_permission`.** `setPushPermission()` no
  longer writes it. An app or a dashboard filter that reads this trait gets no
  new values. Use the event `push_permission_changed` (below) instead.
- **Push permission and the token** (whisperr-spec SPEC.md "Push permission
  and the token"): `denied` opts this device's push token out and holds it.
  A token set while `denied` is held, not sent. `granted` or `provisional`
  opts the held token back in. The opt-out identify is now partial
  (`external_user_id` + `channels`). When this token was the user's only
  opted-in channel, the server marks the user suppressed
  (`all_channels_opted_out`) until a channel is opted in again.
- **`setPushPermission(status)` sends the event `push_permission_changed`**
  (whisperr-spec `automatic.json`) instead of the trait `push_permission`. The
  engine reads only the event, so "notifications turned off after a push" is
  now visible for React Native apps. `status` uses the spec names
  (`granted` → `authorized`, `undetermined` → `not_determined`) and
  `previous_status` carries the last status sent from this device. The event
  is sent once per change, also across restarts; before login it goes out
  under the anonymous id. `reset()` forgets the sent status. The SDK no longer
  writes the `push_permission` trait. The `PushPermissionStatus` type does not
  change. After an upgrade from 0.4.x, the first report sends the event once.
- **`optOut()` tells the server about this device.** When this device
  registered a push token, it sends one identify that opts the token out,
  under the user the token was registered for (after `identify()` without
  `reset()`, not always the current user). Push opt-outs still queued (a
  rotation, a `denied` report, an earlier `optOut()`) are kept ahead of it.
  The SDK delivers and retries them while opted out, also after a restart. It
  then sends nothing until `optIn()`. After `optIn()`, the next
  `setPushToken()` registers the token again. An app that opted out with 0.4.x
  sends this identify once at the first start after the upgrade.
- **`screen()` events carry the common automatic properties** (`app_version`,
  `platform`, `sdk_name`, …), like `push_opened`. `app_version` and
  `app_build` are also read when `trackAppLifecycleEvents` is off.
- The test suite runs every case of whisperr-spec `automatic.json`.

## 0.4.0

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
