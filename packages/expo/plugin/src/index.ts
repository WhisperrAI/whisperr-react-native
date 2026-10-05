/**
 * The @whisperr/expo config plugin. Add it to the app config:
 *
 *   "plugins": [["@whisperr/expo", { "mode": "production" }]]
 *
 * It applies the expo-notifications plugin (iOS `aps-environment`
 * entitlement, Android notification icon, color, and default FCM channel)
 * with Whisperr's defaults, and warns at prebuild when push cannot work.
 * When the app config already lists expo-notifications, that entry and its
 * options win and this plugin adds only the checks.
 */
import type { ExpoConfig } from "expo/config";
import { createRunOncePlugin, withPlugins, WarningAggregator, type ConfigPlugin } from "expo/config-plugins";

// Inlined at build time.
import pkg from "../../package.json";

export interface WhisperrExpoPluginProps {
  /**
   * iOS: the APNs environment for the `aps-environment` entitlement. Default
   * `development` (the expo-notifications default); App Store and TestFlight
   * builds are re-signed for production.
   */
  mode?: "development" | "production";
  /** Android: the small notification icon, a 96×96 all-white PNG with transparency. */
  icon?: string;
  /** Android: the icon tint, for example `"#4F6BFF"`. */
  color?: string;
  /**
   * Android: the channel FCM uses when a message names none. Default
   * `"default"` — the channel registerForPushNotifications() creates.
   */
  androidChannelId?: string;
  /** Custom notification sounds (local paths, `.wav` recommended). */
  sounds?: string[];
  /** iOS: add `remote-notification` to `UIBackgroundModes` (silent pushes). Default false. */
  enableBackgroundRemoteNotifications?: boolean;
}

const NAME = "@whisperr/expo";

function listsPlugin(config: ExpoConfig, name: string): boolean {
  return (config.plugins ?? []).some((entry) => (Array.isArray(entry) ? entry[0] : entry) === name);
}

const withWhisperr: ConfigPlugin<WhisperrExpoPluginProps | void> = (config, props) => {
  const options: WhisperrExpoPluginProps = props ?? {};

  if (!listsPlugin(config, "expo-notifications")) {
    const notifications: Record<string, unknown> = {
      defaultChannel: options.androidChannelId ?? "default",
    };
    if (options.mode) notifications.mode = options.mode;
    if (options.icon) notifications.icon = options.icon;
    if (options.color) notifications.color = options.color;
    if (options.sounds?.length) notifications.sounds = options.sounds;
    if (options.enableBackgroundRemoteNotifications) notifications.enableBackgroundRemoteNotifications = true;
    config = withPlugins(config, [["expo-notifications", notifications]]);
  }

  if (!config.android?.googleServicesFile) {
    WarningAggregator.addWarningAndroid(
      NAME,
      "android.googleServicesFile is not set. Expo push on Android goes through FCM: add google-services.json to the app config and upload the FCM V1 service-account key with `eas credentials`.",
      "https://docs.expo.dev/push-notifications/fcm-credentials/",
    );
  }
  const projectId = (config.extra as { eas?: { projectId?: unknown } } | undefined)?.eas?.projectId;
  if (typeof projectId !== "string" || !projectId) {
    for (const platform of ["ios", "android"] as const) {
      WarningAggregator.addWarningForPlatform(
        platform,
        NAME,
        "extra.eas.projectId is not set, so the app cannot get an Expo push token. Run `eas init`.",
        "https://docs.expo.dev/push-notifications/push-notifications-setup/",
      );
    }
  }
  return config;
};

export default createRunOncePlugin(withWhisperr, pkg.name, pkg.version);
