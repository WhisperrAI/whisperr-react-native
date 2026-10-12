/**
 * The storage the SDK uses when the app passes none:
 * `@react-native-async-storage/async-storage`, an optional peer. It is never a
 * hard dependency: when the package is missing (or its native module is not
 * linked) the SDK falls back to memory and never crashes.
 *
 * The `require` sits directly inside `try` for the same reason as in
 * app-info.ts: Metro bundles a missing optional module as a stub that throws at
 * runtime. tsup.config.ts keeps the literal `require("…")` in the ESM build.
 */
import type { WhisperrStorage } from "./types.js";

declare const require: (name: string) => unknown;

export const ASYNC_STORAGE_PACKAGE = "@react-native-async-storage/async-storage";

/** AsyncStorage when the app has it installed, else undefined. */
export function loadDefaultStorage(): WhisperrStorage | undefined {
  let mod: unknown;
  try {
    mod = require("@react-native-async-storage/async-storage");
  } catch {
    return undefined;
  }
  return asStorage(mod);
}

/** The module (or its default export) when it has the AsyncStorage contract. */
export function asStorage(mod: unknown): WhisperrStorage | undefined {
  for (const candidate of [(mod as { default?: unknown } | null)?.default, mod]) {
    const s = candidate as Partial<WhisperrStorage> | null | undefined;
    if (
      s &&
      typeof s === "object" &&
      typeof s.getItem === "function" &&
      typeof s.setItem === "function" &&
      typeof s.removeItem === "function"
    ) {
      return s as WhisperrStorage;
    }
  }
  return undefined;
}
