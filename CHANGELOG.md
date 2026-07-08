# Changelog

## 0.2.0

- `setPushToken(token)`: first-class push-token capture. Re-identifies the
  `push` channel for the current user, buffers tokens set before `identify()`,
  no-ops on repeated tokens, and opts the previous token out on rotation —
  matching the other Whisperr SDKs and verified against the new
  `whisperr-spec` `conformance/push.json` fixtures.
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
