/**
 * Push token metadata and permission helpers (whisperr-spec SPEC.md → Token
 * kind). The SDK sends only what it knows: a plain token string goes out as
 * is and the server infers its kind.
 */
import { currentOSInfo } from "./lifecycle.js";
import type {
  PushEnvironment,
  PushPermissionStatus,
  PushPlatform,
  PushTokenInput,
  PushTokenKind,
  WhisperrChannel,
} from "./types.js";

const KINDS: ReadonlySet<string> = new Set<PushTokenKind>(["fcm", "apns", "expo", "onesignal_sub"]);
const PLATFORMS: ReadonlySet<string> = new Set<PushPlatform>(["ios", "android", "web", "macos", "windows", "linux"]);
const ENVIRONMENTS: ReadonlySet<string> = new Set<PushEnvironment>(["production", "sandbox"]);
const PERMISSIONS: ReadonlySet<string> = new Set<PushPermissionStatus>([
  "granted",
  "provisional",
  "denied",
  "undetermined",
]);

/** The server's Expo rule: `ExponentPushToken[…]` or `ExpoPushToken[…]`. */
const EXPO_TOKEN = /^(?:Exponent|Expo)PushToken\[[^\]]+\]$/;

/** A push token after normalization: unknown metadata is absent, never guessed. */
export interface PushRegistration {
  token: string;
  kind?: PushTokenKind;
  platform?: PushPlatform;
  pushEnv?: PushEnvironment;
}

export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN.test(token);
}

export function isPushPermissionStatus(value: unknown): value is PushPermissionStatus {
  return typeof value === "string" && PERMISSIONS.has(value);
}

/** True when the OS shows (or quietly delivers) this app's notifications. */
export function permissionAllowsPush(status: PushPermissionStatus | null): boolean {
  return status === "granted" || status === "provisional";
}

/**
 * Turns any setPushToken() input into a registration, or null for an empty
 * token.
 *
 * - A string: the token only (the server infers the kind).
 * - `{ token, kind?, platform?, pushEnv? }`: an Expo token without a kind gets
 *   `expo`; `platform` defaults to the OS the app runs on.
 * - An expo-notifications token (`{ type, data }`): `expo` → `expo`,
 *   `ios` → `apns`, `android` → `fcm`.
 */
export function normalizePushToken(input: PushTokenInput | null | undefined): PushRegistration | null {
  if (typeof input === "string") {
    const token = input.trim();
    return token ? { token } : null;
  }
  if (!input || typeof input !== "object") return null;

  if ("token" in input) {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (!token) return null;
    const kind = asKind(input.kind) ?? (isExpoPushToken(token) ? "expo" : undefined);
    return withMeta(token, kind, asPlatform(input.platform) ?? devicePlatform(), asEnv(input.pushEnv));
  }

  if ("data" in input && typeof input.data === "string") {
    const token = input.data.trim();
    if (!token) return null;
    const type = typeof input.type === "string" ? input.type : "";
    if (type === "expo") return withMeta(token, "expo", devicePlatform(), undefined);
    if (type === "ios") return withMeta(token, "apns", "ios", undefined);
    if (type === "android") return withMeta(token, "fcm", "android", undefined);
    return withMeta(token, isExpoPushToken(token) ? "expo" : undefined, devicePlatform(), undefined);
  }
  return null;
}

/** An opted-in (or opted-out) push channel carrying the registration's metadata. */
export function pushChannel(reg: PushRegistration, optedIn: boolean): WhisperrChannel {
  return {
    type: "push",
    address: reg.token,
    optedIn,
    ...(reg.kind ? { kind: reg.kind } : {}),
    ...(reg.platform ? { platform: reg.platform } : {}),
    ...(reg.pushEnv ? { pushEnv: reg.pushEnv } : {}),
  };
}

/** A stable signature of the metadata, so a token re-sent with new metadata is not deduped away. */
export function pushMeta(reg: { kind?: string; platform?: string; pushEnv?: string }): string {
  if (!reg.kind && !reg.platform && !reg.pushEnv) return "";
  return `${reg.kind ?? ""}|${reg.platform ?? ""}|${reg.pushEnv ?? ""}`;
}

/** The push metadata of a channel, in wire form, with unknown values dropped. */
export function pushWireMeta(channel: WhisperrChannel): Record<string, string> {
  if (channel.type !== "push") return {};
  const out: Record<string, string> = {};
  const kind = asKind(channel.kind);
  const platform = asPlatform(channel.platform);
  const env = asEnv(channel.pushEnv);
  if (kind) out.kind = kind;
  if (platform) out.platform = platform;
  if (env) out.push_env = env;
  return out;
}

function withMeta(
  token: string,
  kind: PushTokenKind | undefined,
  platform: PushPlatform | undefined,
  pushEnv: PushEnvironment | undefined,
): PushRegistration {
  return {
    token,
    ...(kind ? { kind } : {}),
    ...(platform ? { platform } : {}),
    ...(pushEnv ? { pushEnv } : {}),
  };
}

function devicePlatform(): PushPlatform | undefined {
  return asPlatform(currentOSInfo().platform);
}

function asKind(value: unknown): PushTokenKind | undefined {
  return typeof value === "string" && KINDS.has(value) ? (value as PushTokenKind) : undefined;
}

function asPlatform(value: unknown): PushPlatform | undefined {
  return typeof value === "string" && PLATFORMS.has(value) ? (value as PushPlatform) : undefined;
}

function asEnv(value: unknown): PushEnvironment | undefined {
  return typeof value === "string" && ENVIRONMENTS.has(value) ? (value as PushEnvironment) : undefined;
}
