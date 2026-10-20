/**
 * requestPushAuthorization() and the automatic permission read: the OS
 * notification permission through a package the app already has —
 * `expo-notifications`, then `@react-native-firebase/messaging`. Neither is a
 * dependency; the SDK stays pure JS. The `require` calls sit directly inside
 * `try` (see app-info.ts).
 */
import type { PushAuthorizationOptions, PushPermissionStatus } from "./types.js";

declare const require: (name: string) => unknown;

export type PermissionRequester = (options: PushAuthorizationOptions) => Promise<PushPermissionStatus | undefined>;

/** Requesters for the supported optional peers, in preference order. */
export const PERMISSION_REQUESTERS: ReadonlyArray<() => PermissionRequester | undefined> = [
  () => {
    let mod: unknown;
    try {
      mod = require("expo-notifications");
    } catch {
      return undefined;
    }
    return fromExpoNotifications(mod);
  },
  () => {
    let mod: unknown;
    try {
      mod = require("@react-native-firebase/messaging");
    } catch {
      return undefined;
    }
    return fromFirebaseMessaging(mod);
  },
];

/** Runs the first installed requester. Undefined when none is installed or the request fails. */
export async function requestPermission(
  options: PushAuthorizationOptions,
  requesters: ReadonlyArray<() => PermissionRequester | undefined> = PERMISSION_REQUESTERS,
): Promise<PushPermissionStatus | undefined> {
  for (const load of requesters) {
    let request: PermissionRequester | undefined;
    try {
      request = load();
    } catch {
      request = undefined;
    }
    if (!request) continue;
    try {
      return await request(options);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export type PermissionReader = () => Promise<PushPermissionStatus | undefined>;

/**
 * Readers for the supported optional peers, in preference order. They read
 * the permission without a prompt: expo-notifications `getPermissionsAsync()`
 * (iOS authorization status incl. provisional and ephemeral; Android
 * `areNotificationsEnabled` and, on 13+, POST_NOTIFICATIONS), Firebase
 * `hasPermission()`.
 */
export const PERMISSION_READERS: ReadonlyArray<() => PermissionReader | undefined> = [
  () => {
    let mod: unknown;
    try {
      mod = require("expo-notifications");
    } catch {
      return undefined;
    }
    return expoPermissionReader(mod);
  },
  () => {
    let mod: unknown;
    try {
      mod = require("@react-native-firebase/messaging");
    } catch {
      return undefined;
    }
    return firebasePermissionReader(mod);
  },
];

/** Reads with the first installed reader. Undefined when none is installed or the read fails. */
export async function readPermission(
  readers: ReadonlyArray<() => PermissionReader | undefined> = PERMISSION_READERS,
): Promise<PushPermissionStatus | undefined> {
  for (const load of readers) {
    let read: PermissionReader | undefined;
    try {
      read = load();
    } catch {
      read = undefined;
    }
    if (!read) continue;
    try {
      return await read();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** expo-notifications `getPermissionsAsync()` (no prompt). */
export function expoPermissionReader(mod: unknown): PermissionReader | undefined {
  const m = mod as { getPermissionsAsync?: () => Promise<unknown> } | null;
  if (!m || typeof m.getPermissionsAsync !== "function") return undefined;
  const getPermissionsAsync = m.getPermissionsAsync;
  return async () => expoStatus(await getPermissionsAsync());
}

/** @react-native-firebase/messaging `hasPermission()` (no prompt): the modular API, else the namespaced `messaging()`. */
export function firebasePermissionReader(mod: unknown): PermissionReader | undefined {
  const m = mod as {
    getMessaging?: () => unknown;
    hasPermission?: (messaging: unknown) => Promise<unknown>;
    default?: () => { hasPermission?: () => Promise<unknown> };
  } | null;
  if (!m) return undefined;
  if (typeof m.getMessaging === "function" && typeof m.hasPermission === "function") {
    const { getMessaging, hasPermission } = m;
    return async () => firebaseStatus(await hasPermission(getMessaging()));
  }
  if (typeof m.default === "function") {
    const factory = m.default;
    return async () => {
      const instance = factory();
      if (typeof instance?.hasPermission !== "function") return undefined;
      return firebaseStatus(await instance.hasPermission());
    };
  }
  return undefined;
}

/** expo-notifications `requestPermissionsAsync({ ios })`. */
export function fromExpoNotifications(mod: unknown): PermissionRequester | undefined {
  const m = mod as { requestPermissionsAsync?: (request?: unknown) => Promise<unknown> } | null;
  if (!m || typeof m.requestPermissionsAsync !== "function") return undefined;
  const requestPermissionsAsync = m.requestPermissionsAsync;
  return async ({ provisional }) => {
    const result = await requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true, ...(provisional ? { allowProvisional: true } : {}) },
    });
    return expoStatus(result);
  };
}

/** @react-native-firebase/messaging: the modular API, else the namespaced `messaging()`. */
export function fromFirebaseMessaging(mod: unknown): PermissionRequester | undefined {
  const m = mod as {
    getMessaging?: () => unknown;
    requestPermission?: (messaging: unknown, settings?: unknown) => Promise<unknown>;
    default?: () => { requestPermission?: (settings?: unknown) => Promise<unknown> };
  } | null;
  if (!m) return undefined;
  if (typeof m.getMessaging === "function" && typeof m.requestPermission === "function") {
    const { getMessaging, requestPermission: modular } = m;
    return async ({ provisional }) => firebaseStatus(await modular(getMessaging(), { provisional: !!provisional }));
  }
  if (typeof m.default === "function") {
    const factory = m.default;
    return async ({ provisional }) => {
      const instance = factory();
      if (typeof instance?.requestPermission !== "function") return undefined;
      return firebaseStatus(await instance.requestPermission({ provisional: !!provisional }));
    };
  }
  return undefined;
}

/** expo-notifications permission response → status (iOS authorization status first). */
export function expoStatus(result: unknown): PushPermissionStatus | undefined {
  const r = result as { status?: unknown; granted?: unknown; ios?: { status?: unknown } } | null;
  if (!r || typeof r !== "object") return undefined;
  switch (r.ios?.status) {
    case 0:
      return "undetermined";
    case 1:
      return "denied";
    case 2:
    case 4: // ephemeral (App Clips) delivers like authorized
      return "granted";
    case 3:
      return "provisional";
    default:
      break;
  }
  if (r.granted === true || r.status === "granted") return "granted";
  if (r.status === "denied") return "denied";
  return "undetermined";
}

/** Firebase AuthorizationStatus: -1 not determined, 0 denied, 1 authorized, 2 provisional, 3 ephemeral. */
export function firebaseStatus(value: unknown): PushPermissionStatus | undefined {
  switch (value) {
    case -1:
      return "undetermined";
    case 0:
      return "denied";
    case 1:
    case 3:
      return "granted";
    case 2:
      return "provisional";
    default:
      return undefined;
  }
}
