import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExpoConfig } from "expo/config";
import { WarningAggregator } from "expo/config-plugins";
import withWhisperr from "./index.js";

// The package dir has expo-notifications installed, so the real plugin resolves.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function baseConfig(overrides: Partial<ExpoConfig> = {}): ExpoConfig {
  return {
    name: "demo",
    slug: "demo",
    extra: { eas: { projectId: "proj-123" } },
    android: { package: "com.demo", googleServicesFile: "./google-services.json" },
    ios: { bundleIdentifier: "com.demo" },
    _internal: { projectRoot },
    ...overrides,
  } as ExpoConfig;
}

type WithHistory = ExpoConfig & {
  _internal?: { pluginHistory?: Record<string, { name: string }> };
  mods?: { ios?: Record<string, unknown>; android?: Record<string, unknown> };
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("@whisperr/expo config plugin", () => {
  it("applies expo-notifications with the Whisperr defaults", () => {
    const config = withWhisperr(baseConfig(), { mode: "production", color: "#4F6BFF" }) as WithHistory;
    const history = config._internal?.pluginHistory ?? {};
    expect(Object.keys(history)).toEqual(expect.arrayContaining(["@whisperr/expo", "expo-notifications"]));
    // iOS entitlement + Android manifest mods are registered.
    expect(config.mods?.ios?.entitlements).toBeTypeOf("function");
    expect(config.mods?.android?.manifest).toBeTypeOf("function");
  });

  it("leaves an app's own expo-notifications entry alone", () => {
    const config = withWhisperr(
      baseConfig({ plugins: [["expo-notifications", { mode: "development" }]] }),
      {},
    ) as WithHistory;
    expect(Object.keys(config._internal?.pluginHistory ?? {})).not.toContain("expo-notifications");
  });

  it("runs once even when listed twice", () => {
    const once = withWhisperr(withWhisperr(baseConfig(), {}), {}) as WithHistory;
    expect(once._internal?.pluginHistory?.["@whisperr/expo"]?.name).toBe("@whisperr/expo");
  });

  it("warns at prebuild when push cannot work", () => {
    const android = vi.spyOn(WarningAggregator, "addWarningAndroid").mockImplementation(() => {});
    const platform = vi.spyOn(WarningAggregator, "addWarningForPlatform").mockImplementation(() => {});
    withWhisperr(baseConfig({ extra: {}, android: { package: "com.demo" } }), {});
    expect(android).toHaveBeenCalledWith("@whisperr/expo", expect.stringContaining("googleServicesFile"), expect.any(String));
    expect(platform).toHaveBeenCalledWith("ios", "@whisperr/expo", expect.stringContaining("projectId"), expect.any(String));
    expect(platform).toHaveBeenCalledWith("android", "@whisperr/expo", expect.stringContaining("projectId"), expect.any(String));
  });

  it("does not warn for a complete config", () => {
    const android = vi.spyOn(WarningAggregator, "addWarningAndroid").mockImplementation(() => {});
    const platform = vi.spyOn(WarningAggregator, "addWarningForPlatform").mockImplementation(() => {});
    withWhisperr(baseConfig(), {});
    expect(android).not.toHaveBeenCalled();
    expect(platform).not.toHaveBeenCalled();
  });
});
