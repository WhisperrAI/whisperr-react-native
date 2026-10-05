import { describe, expect, it } from "vitest";
import { fromDeviceInfo, fromExpoApplication, resolveAppInfo } from "./app-info.js";

const expoApplication = { nativeApplicationVersion: "2.4.1", nativeBuildVersion: "241" };
const deviceInfo = { default: { getVersion: () => "3.0.0", getBuildNumber: () => "300" } };

describe("app version from optional peers", () => {
  it("explicit options win over any installed package", () => {
    expect(resolveAppInfo({ version: "9.9.9", build: "999" }, [() => fromExpoApplication(expoApplication)])).toEqual({
      version: "9.9.9",
      build: "999",
    });
  });

  it("reads expo-application", () => {
    expect(resolveAppInfo({}, [() => fromExpoApplication(expoApplication)])).toEqual({ version: "2.4.1", build: "241" });
  });

  it("reads react-native-device-info (default export)", () => {
    expect(resolveAppInfo({}, [() => fromDeviceInfo(deviceInfo)])).toEqual({ version: "3.0.0", build: "300" });
  });

  it("prefers the first package that answers and never mixes two", () => {
    const partialExpo = () => fromExpoApplication({ nativeApplicationVersion: "2.4.1", nativeBuildVersion: null });
    expect(resolveAppInfo({}, [partialExpo, () => fromDeviceInfo(deviceInfo)])).toEqual({ version: "2.4.1" });
  });

  it("skips a missing or broken package and omits what nobody knows", () => {
    const missing = () => undefined;
    const broken = () => {
      throw new Error("NativeModule.RNDeviceInfo is null");
    };
    expect(resolveAppInfo({}, [missing, broken])).toEqual({});
    expect(fromDeviceInfo({ getVersion: () => "unknown", getBuildNumber: () => "unknown" })).toBeUndefined();
    expect(fromExpoApplication({ nativeApplicationVersion: null, nativeBuildVersion: null })).toBeUndefined();
  });

  it("with no peer installed (this test runtime), detection finds nothing and does not throw", () => {
    expect(resolveAppInfo({})).toEqual({});
  });
});
