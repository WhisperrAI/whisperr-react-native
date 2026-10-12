/**
 * Push token metadata and permission helpers (whisperr-spec SPEC.md → Token
 * kind). The SDK sends only what it knows: a plain token string goes out as
 * is and the server infers its kind.
 */
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
  clientAppId?: string;
  providerProject?: string;
}

export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN.test(token);
}

export function isPushPermissionStatus(value: unknown): value is PushPermissionStatus {
  return typeof value === "string" && PERMISSIONS.has(value);
}

/** A notification permission as `push_permission_changed` sends it (whisperr-spec → Automatic events). */
export type PushPermissionWireStatus = "authorized" | "provisional" | "denied" | "not_determined";

export const PERMISSION_WIRE_STATUS: Readonly<Record<PushPermissionStatus, PushPermissionWireStatus>> = {
  granted: "authorized",
  provisional: "provisional",
  denied: "denied",
  undetermined: "not_determined",
};

export function isPushPermissionWireStatus(value: unknown): value is PushPermissionWireStatus {
  return Object.values(PERMISSION_WIRE_STATUS).includes(value as PushPermissionWireStatus);
}

/** True when the OS shows (or quietly delivers) this app's notifications. */
export function permissionAllowsPush(status: PushPermissionStatus | null): boolean {
  return status === "granted" || status === "provisional";
}

/**
 * Turns any setPushToken() input into a registration, or null for an empty
 * token. Only what the input says; the client adds the detected fields
 * (platform, app id, provider project) afterwards.
 *
 * - A string: the token only (the server infers the kind).
 * - `{ token, kind?, platform?, pushEnv?, clientAppId?, providerProject? }`:
 *   an Expo token without a kind gets `expo`.
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
    return {
      ...withMeta(token, kind, asPlatform(input.platform), asEnv(input.pushEnv)),
      ...ids(input.clientAppId, input.providerProject),
    };
  }

  if ("data" in input && typeof input.data === "string") {
    const token = input.data.trim();
    if (!token) return null;
    const type = typeof input.type === "string" ? input.type : "";
    if (type === "expo") return withMeta(token, "expo", undefined, undefined);
    if (type === "ios") return withMeta(token, "apns", "ios", undefined);
    if (type === "android") return withMeta(token, "fcm", "android", undefined);
    return withMeta(token, isExpoPushToken(token) ? "expo" : undefined, undefined, undefined);
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
    ...(reg.clientAppId ? { clientAppId: reg.clientAppId } : {}),
    ...(reg.providerProject ? { providerProject: reg.providerProject } : {}),
  };
}

type MetaFields = { kind?: string; platform?: string; pushEnv?: string; clientAppId?: string; providerProject?: string };

/**
 * A stable signature of the metadata, so a token re-sent with new metadata is
 * not deduped away. The two ids are appended only when set, so a signature
 * that SDK 0.4.x persisted still matches the same metadata.
 */
export function pushMeta(reg: MetaFields): string {
  const base = [reg.kind, reg.platform, reg.pushEnv];
  const extra = reg.clientAppId || reg.providerProject ? [reg.clientAppId, reg.providerProject] : [];
  const parts = [...base, ...extra];
  if (parts.every((p) => !p)) return "";
  return parts.map((p) => p ?? "").join("|");
}

/** Rebuilds a registration from a persisted metadata signature (see pushMeta). */
export function registrationFromMeta(token: string, meta: string | undefined): PushRegistration {
  const [kind, platform, pushEnv, clientAppId, providerProject] = (meta ?? "").split("|");
  return {
    ...withMeta(token, asKind(kind), asPlatform(platform), asEnv(pushEnv)),
    ...ids(clientAppId, providerProject),
  };
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
  const clientAppId = cleanId(channel.clientAppId);
  const providerProject = cleanId(channel.providerProject);
  if (clientAppId) out.client_app_id = clientAppId;
  if (providerProject) out.provider_project = providerProject;
  return out;
}

function ids(clientAppId: unknown, providerProject: unknown): Pick<PushRegistration, "clientAppId" | "providerProject"> {
  const app = cleanId(clientAppId);
  const project = cleanId(providerProject);
  return { ...(app ? { clientAppId: app } : {}), ...(project ? { providerProject: project } : {}) };
}

/** A non-empty id without the `|` the metadata signature uses as separator. */
function cleanId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v && !v.includes("|") ? v : undefined;
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

function asKind(value: unknown): PushTokenKind | undefined {
  return typeof value === "string" && KINDS.has(value) ? (value as PushTokenKind) : undefined;
}

function asPlatform(value: unknown): PushPlatform | undefined {
  return typeof value === "string" && PLATFORMS.has(value) ? (value as PushPlatform) : undefined;
}

function asEnv(value: unknown): PushEnvironment | undefined {
  return typeof value === "string" && ENVIRONMENTS.has(value) ? (value as PushEnvironment) : undefined;
}
