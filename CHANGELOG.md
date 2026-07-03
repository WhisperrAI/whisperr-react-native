# Changelog

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
