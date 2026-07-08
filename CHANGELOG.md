# Changelog

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
