/** Optional-peer readers: default storage, permission prompt, push project ids, app id, language tags. */
import { describe, expect, it } from "vitest";
import { fromDeviceInfo, fromExpoApplication, resolveAppInfo } from "./app-info.js";
import { normalizeAppLanguage } from "./client.js";
import { asStorage, loadDefaultStorage } from "./default-storage.js";
import {
  expoPermissionReader,
  expoStatus,
  firebasePermissionReader,
  firebaseStatus,
  fromExpoNotifications,
  fromFirebaseMessaging,
  readPermission,
  requestPermission,
} from "./push-authorization.js";
import { easProjectId, firebaseProjectId } from "./push-environment.js";

const storageLike = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

describe("default storage", () => {
  it("accepts the AsyncStorage module or its default export, rejects anything else", () => {
    expect(asStorage({ default: storageLike })).toBe(storageLike);
    expect(asStorage(storageLike)).toBe(storageLike);
    expect(asStorage({ default: { getItem: () => null } })).toBeUndefined();
    expect(asStorage(null)).toBeUndefined();
  });

  it("is undefined when AsyncStorage is not installed (this test runtime)", () => {
    expect(loadDefaultStorage()).toBeUndefined();
  });
});

describe("requestPushAuthorization peers", () => {
  it("expo-notifications: asks with allowProvisional and maps the iOS status", async () => {
    const calls: unknown[] = [];
    const request = fromExpoNotifications({
      requestPermissionsAsync: async (r: unknown) => {
        calls.push(r);
        return { status: "granted", granted: true, ios: { status: 3 } };
      },
    })!;
    await expect(request({ provisional: true })).resolves.toBe("provisional");
    expect(calls).toEqual([{ ios: { allowAlert: true, allowBadge: true, allowSound: true, allowProvisional: true } }]);
    expect(expoStatus({ status: "denied", granted: false })).toBe("denied");
    expect(expoStatus({ status: "granted", granted: true })).toBe("granted");
    expect(expoStatus({ status: "undetermined", ios: { status: 4 } })).toBe("granted");
  });

  it("@react-native-firebase/messaging: modular API first, then the namespaced one", async () => {
    const modular = fromFirebaseMessaging({ getMessaging: () => ({}), requestPermission: async () => 2 })!;
    await expect(modular({ provisional: true })).resolves.toBe("provisional");
    const namespaced = fromFirebaseMessaging({ default: () => ({ requestPermission: async () => 0 }) })!;
    await expect(namespaced({})).resolves.toBe("denied");
    expect(firebaseStatus(-1)).toBe("undetermined");
    expect(firebaseStatus(1)).toBe("granted");
    expect(firebaseStatus(9)).toBeUndefined();
  });

  it("the first installed peer answers; a throwing one resolves undefined", async () => {
    await expect(requestPermission({}, [() => undefined, () => async () => "granted"])).resolves.toBe("granted");
    await expect(
      requestPermission({}, [
        () => async () => {
          throw new Error("prompt failed");
        },
      ]),
    ).resolves.toBeUndefined();
    await expect(requestPermission({}, [])).resolves.toBeUndefined();
    await expect(requestPermission({})).resolves.toBeUndefined(); // no peer in this runtime
  });
});

describe("automatic permission read peers (no prompt)", () => {
  it("expo-notifications: getPermissionsAsync with the iOS status (provisional, ephemeral) or Android granted", async () => {
    await expect(expoPermissionReader({ getPermissionsAsync: async () => ({ ios: { status: 3 } }) })!()).resolves.toBe(
      "provisional",
    );
    await expect(expoPermissionReader({ getPermissionsAsync: async () => ({ ios: { status: 4 } }) })!()).resolves.toBe(
      "granted",
    );
    await expect(
      expoPermissionReader({ getPermissionsAsync: async () => ({ granted: false, status: "denied" }) })!(),
    ).resolves.toBe("denied");
    await expect(
      expoPermissionReader({ getPermissionsAsync: async () => ({ granted: false, status: "undetermined" }) })!(),
    ).resolves.toBe("undetermined");
    expect(expoPermissionReader({ requestPermissionsAsync: async () => ({}) })).toBeUndefined();
  });

  it("Firebase: hasPermission, modular or namespaced", async () => {
    await expect(
      firebasePermissionReader({ getMessaging: () => ({}), hasPermission: async () => 2 })!(),
    ).resolves.toBe("provisional");
    await expect(firebasePermissionReader({ default: () => ({ hasPermission: async () => 0 }) })!()).resolves.toBe(
      "denied",
    );
    await expect(firebasePermissionReader({ default: () => ({}) })!()).resolves.toBeUndefined();
    expect(firebasePermissionReader(null)).toBeUndefined();
  });

  it("the first installed peer answers; a throwing one resolves undefined", async () => {
    await expect(readPermission([() => undefined, () => async () => "denied"])).resolves.toBe("denied");
    await expect(
      readPermission([
        () => async () => {
          throw new Error("read failed");
        },
      ]),
    ).resolves.toBeUndefined();
    await expect(readPermission()).resolves.toBeUndefined(); // no peer in this runtime
  });
});

describe("push provider project", () => {
  it("reads the EAS project id from expo-constants", () => {
    expect(easProjectId(() => ({ default: { expoConfig: { extra: { eas: { projectId: "eas-1" } } } } }))).toBe("eas-1");
    expect(easProjectId(() => ({ expoConfig: null, easConfig: { projectId: "eas-2" } }))).toBe("eas-2");
    expect(easProjectId(() => undefined)).toBeUndefined();
  });

  it("reads the Firebase project id from @react-native-firebase/app; no default app is no value", () => {
    expect(firebaseProjectId(() => ({ getApp: () => ({ options: { projectId: "fb-1" } }) }))).toBe("fb-1");
    expect(firebaseProjectId(() => ({ default: { app: () => ({ options: { projectId: "fb-2" } }) } }))).toBe("fb-2");
    expect(
      firebaseProjectId(() => ({
        getApp: () => {
          throw new Error("No Firebase App '[DEFAULT]' has been created");
        },
      })),
    ).toBeUndefined();
  });
});

describe("client_app_id from the app-info peers", () => {
  it("expo-application applicationId, then react-native-device-info getBundleId; explicit wins", () => {
    expect(fromExpoApplication({ applicationId: "com.example.app" })).toEqual({ clientAppId: "com.example.app" });
    expect(fromDeviceInfo({ getBundleId: () => "com.example.rn" })).toEqual({ clientAppId: "com.example.rn" });
    expect(
      resolveAppInfo({ clientAppId: "com.explicit" }, [() => fromExpoApplication({ applicationId: "com.example.app" })]),
    ).toEqual({ clientAppId: "com.explicit" });
    // Version from one package, the id from the next one that knows it.
    expect(
      resolveAppInfo({}, [
        () => fromExpoApplication({ nativeApplicationVersion: "1.0", nativeBuildVersion: "1" }),
        () => fromDeviceInfo({ getVersion: () => "9", getBundleId: () => "com.example.rn" }),
      ]),
    ).toEqual({ version: "1.0", build: "1", clientAppId: "com.example.rn" });
  });
});

describe("app_language tags", () => {
  it("trims, changes _ to -, and rejects what is not a language tag", () => {
    expect(normalizeAppLanguage(" pt_BR ")).toBe("pt-BR");
    expect(normalizeAppLanguage("zh-Hans-CN")).toBe("zh-Hans-CN");
    for (const bad of ["", "-de", "not a language!", "und", "d", 42, null]) {
      expect(normalizeAppLanguage(bad)).toBeNull();
    }
  });
});
