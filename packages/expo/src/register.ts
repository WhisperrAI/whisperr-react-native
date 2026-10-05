/**
 * registerForPushNotifications(): permission → Expo push token → Whisperr,
 * plus the follow-up work real apps forget: permission changes made in the OS
 * settings, and token rotation.
 */
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { Whisperr, type PushPermissionStatus, type WhisperrApi } from "@whisperr/react-native";

export interface AndroidChannelOptions {
  /** Channel id. Default `"default"` — the channel the config plugin names for FCM. */
  id?: string;
  /** The name users see in the system settings. Default `"Default"`. */
  name?: string;
  /** Default `AndroidImportance.DEFAULT`. Android does not let an app raise it later. */
  importance?: Notifications.AndroidImportance;
}

export interface RegisterForPushOptions {
  /** The client to report to. Default: the `Whisperr.init()` singleton. */
  client?: WhisperrApi | null;
  /**
   * EAS project id for the Expo push token. Default: `extra.eas.projectId`
   * from the app config (set by `eas init`), then `Constants.easConfig`.
   */
  projectId?: string;
  /** Show the OS permission prompt when the app may still ask. Default true. */
  requestPermission?: boolean;
  /** iOS prompt options. Default: alert, badge, and sound. Set `allowProvisional` for quiet delivery without a prompt. */
  ios?: Notifications.IosNotificationPermissionsRequest;
  /**
   * The Android notification channel to create before the prompt (Android 13+
   * shows the prompt only when a channel exists). `false` skips it when the
   * app makes its own channels.
   */
  androidChannel?: AndroidChannelOptions | false;
  /**
   * Keep Whisperr current after this call: re-check the permission each time
   * the app comes to the foreground (users change it in Settings), and fetch
   * a new Expo token when the device token rotates. Default true.
   */
  watch?: boolean;
  /** Log why no token was registered. Default false. */
  debug?: boolean;
}

/** Why registerForPushNotifications() returned no token. */
export type PushRegistrationReason =
  /** The user turned notifications off. */
  | "permission_denied"
  /** The app did not ask (requestPermission: false) or the user has not answered. */
  | "permission_undetermined"
  /** Expo Go on Android cannot receive remote push (SDK 53+). Use a development build. */
  | "expo_go_android"
  /** No EAS project id. Run `eas init` or pass `projectId`. */
  | "missing_project_id"
  /** The OS gave no token (often a simulator or emulator without Google Play). See `error`. */
  | "token_unavailable"
  /** `Whisperr.init()` has not run and no `client` was passed. */
  | "not_initialized";

export interface PushRegistrationResult {
  /** The notification permission, as reported to Whisperr. */
  status: PushPermissionStatus;
  /** The Expo push token sent to Whisperr, or null. */
  token: string | null;
  /** Set when `token` is null. */
  reason?: PushRegistrationReason;
  /** The underlying error for `token_unavailable`. */
  error?: unknown;
}

const DEFAULT_IOS: Notifications.IosNotificationPermissionsRequest = {
  allowAlert: true,
  allowBadge: true,
  allowSound: true,
};

interface Context {
  client: WhisperrApi;
  options: RegisterForPushOptions;
  token: string | null;
}

interface Watcher {
  stop(): void;
}

let watcher: Watcher | null = null;

/**
 * Asks for notification permission, gets the Expo push token, and sends both
 * to Whisperr (`setPushPermission`, then `setPushToken` with `kind: "expo"`).
 * Never throws: the result says what happened.
 *
 * Call it after `Whisperr.init()`, at the moment you want the OS prompt (for
 * example after onboarding). Calling it again is safe; Whisperr dedups.
 *
 * ```ts
 * const { status, token, reason } = await registerForPushNotifications();
 * ```
 */
export async function registerForPushNotifications(
  options: RegisterForPushOptions = {},
): Promise<PushRegistrationResult> {
  const client = options.client ?? Whisperr.instance;
  if (!client) {
    log(options, "registerForPushNotifications(): call Whisperr.init() first, or pass `client`");
    return { status: "undetermined", token: null, reason: "not_initialized" };
  }
  const ctx: Context = { client, options, token: null };
  let status: PushPermissionStatus = "undetermined";
  try {
    if (Platform.OS === "android" && options.androidChannel !== false) {
      await ensureAndroidChannel(options.androidChannel ?? {});
    }
    let permissions = await Notifications.getPermissionsAsync();
    status = toPermissionStatus(permissions);
    if (options.requestPermission !== false && !allowsPush(status) && permissions.canAskAgain !== false) {
      permissions = await Notifications.requestPermissionsAsync({ ios: options.ios ?? DEFAULT_IOS });
      status = toPermissionStatus(permissions);
    }
    client.setPushPermission(status);
  } catch (error) {
    log(options, `registerForPushNotifications(): permission check failed: ${String(error)}`);
    return { status, token: null, reason: "token_unavailable", error };
  }

  // Watch before the token request: the device-token event that request
  // causes is then recognized as ours, not as a rotation.
  if (options.watch !== false) startWatching(ctx);
  if (!allowsPush(status)) {
    return { status, token: null, reason: status === "denied" ? "permission_denied" : "permission_undetermined" };
  }
  return { status, ...(await registerToken(ctx)) };
}

/** Stops the foreground permission check and token-rotation listener that registerForPushNotifications() started. */
export function stopPushNotificationUpdates(): void {
  watcher?.stop();
  watcher = null;
}

/** Maps the expo-notifications permission response to Whisperr's status. */
export function toPermissionStatus(permissions: Notifications.NotificationPermissionsStatus): PushPermissionStatus {
  switch (permissions.ios?.status) {
    case Notifications.IosAuthorizationStatus.PROVISIONAL:
      return "provisional";
    case Notifications.IosAuthorizationStatus.AUTHORIZED:
    case Notifications.IosAuthorizationStatus.EPHEMERAL:
      return "granted";
    case Notifications.IosAuthorizationStatus.DENIED:
      return "denied";
    case Notifications.IosAuthorizationStatus.NOT_DETERMINED:
      return "undetermined";
    default:
      break;
  }
  if (permissions.granted) return "granted";
  return permissions.status === "denied" ? "denied" : "undetermined";
}

/** True in Expo Go on Android, where remote push does not work (SDK 53+). */
export function isExpoGoAndroid(): boolean {
  return Platform.OS === "android" && Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}

/** The EAS project id from the option, the app config, or the EAS build config. */
export function resolveProjectId(explicit?: string): string | undefined {
  const fromConfig = (Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined)?.eas?.projectId;
  const candidates = [explicit, fromConfig, Constants.easConfig?.projectId];
  for (const id of candidates) {
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return undefined;
}

function allowsPush(status: PushPermissionStatus): boolean {
  return status === "granted" || status === "provisional";
}

async function ensureAndroidChannel(channel: AndroidChannelOptions): Promise<void> {
  await Notifications.setNotificationChannelAsync(channel.id ?? "default", {
    name: channel.name ?? "Default",
    importance: channel.importance ?? Notifications.AndroidImportance.DEFAULT,
  });
}

async function registerToken(ctx: Context): Promise<Omit<PushRegistrationResult, "status">> {
  if (isExpoGoAndroid()) {
    log(ctx.options, "Expo Go on Android cannot receive remote push (SDK 53+). Use a development build.");
    return { token: null, reason: "expo_go_android" };
  }
  const projectId = resolveProjectId(ctx.options.projectId);
  if (!projectId) {
    log(ctx.options, "no EAS project id: run `eas init` or pass `projectId`");
    return { token: null, reason: "missing_project_id" };
  }
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    ctx.token = data;
    ctx.client.setPushToken({ token: data, kind: "expo" });
    return { token: data };
  } catch (error) {
    log(ctx.options, `no Expo push token: ${String(error)}`);
    return { token: null, reason: "token_unavailable", error };
  }
}

function startWatching(ctx: Context): void {
  stopPushNotificationUpdates();
  let inFlight: Promise<void> | null = null;
  const refresh = (fetchToken: boolean): void => {
    if (inFlight) return;
    inFlight = (async () => {
      try {
        const status = toPermissionStatus(await Notifications.getPermissionsAsync());
        ctx.client.setPushPermission(status);
        // A permission turned on in Settings: a device that never had a token
        // gets one now. A known token comes back through the SDK on its own.
        if (allowsPush(status) && (fetchToken || ctx.token === null)) await registerToken(ctx);
      } catch {
        /* the next foreground tries again */
      } finally {
        inFlight = null;
      }
    })();
  };

  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") refresh(false);
  });
  let lastDeviceToken: string | undefined;
  const tokenSub = Notifications.addPushTokenListener((deviceToken) => {
    const key = typeof deviceToken.data === "string" ? deviceToken.data : JSON.stringify(deviceToken.data);
    const first = lastDeviceToken === undefined;
    if (key === lastDeviceToken) return;
    lastDeviceToken = key;
    // The first event answers our own token request; later ones are rotations.
    if (!first) refresh(true);
  });
  watcher = {
    stop() {
      appState.remove();
      tokenSub.remove();
    },
  };
}

function log(options: RegisterForPushOptions, message: string): void {
  if (options.debug && typeof console !== "undefined") {
    // eslint-disable-next-line no-console
    console.warn(`[whisperr] ${message}`);
  }
}
