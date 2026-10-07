/**
 * Automatic signals: the app lifecycle events, their shared flat properties,
 * and push-open payload parsing. Event names are shared with the Swift and
 * Flutter SDKs and the backend — do not rename them.
 */
import type { AppInfo } from "./app-info.js";
import type { WhisperrPushOpen } from "./types.js";
import { deviceTraits } from "./device.js";
import { currentOSInfo } from "./lifecycle.js";
import { LIB_VERSION } from "./runtime.js";

export const APP_INSTALLED = "app_installed";
export const APP_UPDATED = "app_updated";
export const APP_OPENED = "app_opened";
export const APP_BACKGROUNDED = "app_backgrounded";
export const SCREEN_VIEWED = "screen_viewed";
export const PUSH_OPENED = "push_opened";
export const PUSH_PERMISSION_CHANGED = "push_permission_changed";

/**
 * The flat properties every automatic event carries (canonical values shared
 * with the Swift and Flutter SDKs and the spec):
 *
 * - app_version, app_build — the app's own version / build number
 * - platform, os_name — the lowercase OS family: "ios" | "android" | "web"
 * - os_version — the OS version string
 * - sdk_name, sdk_version — "whisperr-react-native" and this package's version
 * - locale — BCP 47
 * - timezone — IANA name; when the runtime has none, timezone_offset_minutes
 *   (integer minutes east of UTC) instead
 *
 * A value the runtime cannot provide is left out, never guessed.
 */
export function automaticProperties(app: AppInfo): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (app.version) out.app_version = app.version;
  if (app.build) out.app_build = app.build;
  const os = currentOSInfo();
  if (os.platform) {
    out.platform = os.platform;
    out.os_name = os.platform;
  }
  if (os.version) out.os_version = os.version;
  out.sdk_name = SDK_NAME;
  out.sdk_version = LIB_VERSION;
  const device = deviceTraits(); // fresh each time: the zone changes when the user travels
  if (device.locale) out.locale = device.locale;
  if (device.timezone) {
    out.timezone = device.timezone;
  } else {
    const offset = timezoneOffsetMinutes();
    if (offset !== undefined) out.timezone_offset_minutes = offset;
  }
  return out;
}

export const SDK_NAME = "whisperr-react-native";

/** Minutes east of UTC right now (120 for Berlin in summer), or undefined. */
export function timezoneOffsetMinutes(): number | undefined {
  try {
    const offset = -new Date().getTimezoneOffset();
    return Number.isFinite(offset) ? offset + 0 : undefined; // + 0 turns -0 into 0
  } catch {
    return undefined;
  }
}

/** What the app looked like at the last launch this SDK recorded. */
export interface StoredAppVersion {
  version?: string;
  build?: string;
}

export type VersionChange =
  | { kind: "installed" }
  | { kind: "updated"; previous: StoredAppVersion }
  | null;

/**
 * Compares the stored launch record with this launch.
 *
 * - No record and no earlier SDK state on the device → a fresh install.
 * - No record but earlier SDK state (an app that upgraded from an SDK
 *   version without lifecycle events) → not an install; just record.
 * - A record whose version or build differs from a known current value → an
 *   update. Unknown values on either side never count as a change.
 */
export function detectVersionChange(
  stored: StoredAppVersion | null,
  current: AppInfo,
  hadPriorState: boolean,
): VersionChange {
  if (!stored) return hadPriorState ? null : { kind: "installed" };
  const versionChanged = !!stored.version && !!current.version && stored.version !== current.version;
  const buildChanged = !!stored.build && !!current.build && stored.build !== current.build;
  return versionChanged || buildChanged ? { kind: "updated", previous: stored } : null;
}

export function parseStoredAppVersion(raw: string | null): StoredAppVersion | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; build?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    const out: StoredAppVersion = {};
    if (typeof parsed.version === "string" && parsed.version) out.version = parsed.version;
    if (typeof parsed.build === "string" && parsed.build) out.build = parsed.build;
    return out;
  } catch {
    return null; // corrupt — treat as no record
  }
}

/** A Whisperr push the user opened. */
export type PushOpenedPayload = WhisperrPushOpen;

/**
 * Finds `whisperr_message_id` (and the deep link) in whatever the app's push
 * library hands over: the data map itself, a Firebase RemoteMessage
 * (`.data`), an expo-notifications response or notification
 * (`.notification.request.content.data`, the native payload under
 * `.request.trigger`), or a OneSignal notification (`.additionalData`).
 */
export function extractPushOpened(input: unknown): PushOpenedPayload | undefined {
  for (const data of candidateMaps(input)) {
    const messageId = stringValue(data.whisperr_message_id);
    if (!messageId) continue;
    // Whisperr sends the link as `whisperr_deep_link`; `deep_link` is the
    // spec's name and what earlier backends sent.
    const deepLink = stringValue(data.whisperr_deep_link) ?? stringValue(data.deep_link);
    return deepLink ? { messageId, deepLink } : { messageId };
  }
  return undefined;
}

function candidateMaps(input: unknown): Record<string, unknown>[] {
  const root = asMap(input);
  if (!root) return [];
  const notification = asMap(root.notification);
  const request = asMap(notification?.request) ?? asMap(root.request);
  const content = asMap(request?.content);
  const trigger = asMap(request?.trigger);
  const remoteMessage = asMap(trigger?.remoteMessage);
  return [
    root,
    asMap(root.data),
    asMap(root.additionalData),
    asMap(content?.data),
    asMap(trigger?.payload),
    asMap(remoteMessage?.data),
  ].filter((m): m is Record<string, unknown> => m !== undefined);
}

function asMap(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v ? v : undefined;
}
