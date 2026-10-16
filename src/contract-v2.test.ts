/**
 * Contract v2 behavior the spec fixtures do not pin: default storage, the
 * restore identify in the persisted queue, the 7-day re-registration at
 * launch, push_opened cold start / action id, push_received, the version
 * context, and requestPushAuthorization().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAppState, AppState } from "../test/react-native.js";
import { WhisperrClient } from "./client.js";
import { MemoryStorage } from "./storage.js";
import type { PushPermissionStatus, WhisperrOptions, WhisperrStorage } from "./types.js";

const h = vi.hoisted(() => ({
  defaultStorage: undefined as WhisperrStorage | undefined,
  permission: undefined as PushPermissionStatus | undefined,
  permissionCalls: [] as unknown[],
}));

vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({ locale: "de-DE" }),
}));
vi.mock("./default-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./default-storage.js")>()),
  loadDefaultStorage: () => h.defaultStorage,
}));
vi.mock("./push-authorization.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./push-authorization.js")>()),
  requestPermission: async (options: unknown) => {
    h.permissionCalls.push(options);
    return h.permission;
  },
}));
vi.mock("./push-environment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./push-environment.js")>()),
  detectPushEnvironment: () => ({
    platform: "ios",
    clientAppId: "com.example.app",
    providerProject: (kind: string) => (kind === "fcm" ? "firebase-proj" : undefined),
  }),
}));

let sent: Array<{ path: string; body: any }> = [];
let status = 200;
const RealDate = Date;

beforeEach(() => {
  sent = [];
  status = 200;
  h.defaultStorage = undefined;
  h.permission = undefined;
  h.permissionCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      sent.push({ path: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body) });
      return { ok: status >= 200 && status < 300, status } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  AppState.currentState = "active";
});

function make(overrides: Partial<WhisperrOptions> = {}): WhisperrClient {
  return new WhisperrClient({
    apiKey: "wpk_test",
    flushIntervalMs: 0,
    flushOnAppBackground: false,
    trackAppLifecycleEvents: false,
    maxRetries: 0,
    ...overrides,
  });
}

async function settle(w: WhisperrClient): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  await w.flush();
}

const identifies = () => sent.filter((r) => r.path === "/v1/identify").map((r) => r.body);
const events = () => sent.filter((r) => r.path === "/v1/events/batch").flatMap((r) => r.body.events);

describe("default storage (AsyncStorage when installed)", () => {
  it("persists the user id without a storage option, so the next start restores it", async () => {
    h.defaultStorage = new MemoryStorage();
    const first = make();
    first.identify("user_1");
    await settle(first);
    await first.close();

    const second = make();
    second.track("feature_used");
    await settle(second);
    expect(events()[0].external_user_id).toBe("user_1");
  });

  it("a passed storage wins over AsyncStorage", async () => {
    const asyncStorage = new MemoryStorage();
    h.defaultStorage = asyncStorage;
    const mine = new MemoryStorage();
    const w = make({ storage: mine });
    w.identify("user_1");
    await settle(w);
    expect(mine.getItem("whisperr.user_id")).toBe("user_1");
    expect(asyncStorage.getItem("whisperr.user_id")).toBeNull();
  });

  it("without any storage: memory only, one warning per process, never a crash", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = make({ debug: true });
    const b = make({ debug: true });
    a.identify("user_1");
    await settle(a);
    await settle(b);
    const storageWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("no storage"));
    expect(storageWarnings.length).toBeLessThanOrEqual(1);
    expect(identifies()).toHaveLength(1);
  });

  it("a broken AsyncStorage (every call throws) degrades to no persistence, not a crash", async () => {
    h.defaultStorage = {
      getItem: () => {
        throw new Error("native module missing");
      },
      setItem: () => {
        throw new Error("native module missing");
      },
      removeItem: () => {
        throw new Error("native module missing");
      },
    };
    const w = make();
    w.identify("user_1");
    w.track("feature_used");
    await settle(w);
    expect(events()).toHaveLength(1);
  });
});

describe("restore identify in the queue", () => {
  it("waits in the persisted queue while offline and goes out on the next start", async () => {
    const storage = new MemoryStorage();
    const first = make({ storage });
    first.identify("user_1");
    await settle(first);
    await first.close();
    storage.removeItem("whisperr.restore_record"); // as if the last delivery was long ago

    status = 503;
    const offline = make({ storage });
    await settle(offline);
    await offline.close();
    expect(identifies().at(-1)).toEqual({
      external_user_id: "user_1",
      anonymous_id: expect.any(String),
      traits: { locale: "de-DE" },
    });

    status = 200;
    sent = [];
    const online = make({ storage });
    await settle(online);
    // The queued restore identify from the offline start, and no second one.
    expect(identifies()).toEqual([
      { external_user_id: "user_1", anonymous_id: expect.any(String), traits: { locale: "de-DE" } },
    ]);
  });

  it("is queued at most once per process start", async () => {
    const storage = new MemoryStorage();
    storage.setItem("whisperr.user_id", "user_1");
    const w = make({ storage });
    await settle(w);
    await settle(w);
    __setAppState("background");
    __setAppState("active");
    await settle(w);
    expect(identifies()).toHaveLength(1);
  });
});

describe("push token fields and re-registration", () => {
  it("fills platform, client_app_id and provider_project by kind; never provider_project for apns", async () => {
    const w = make();
    w.identify("user_1");
    w.setPushToken({ token: "fcm_tok", kind: "fcm" });
    await settle(w);
    w.setPushToken({ token: "aa11", kind: "apns", pushEnv: "production" });
    await settle(w);
    const [, fcm, apns] = identifies();
    expect(fcm.channels).toEqual([
      {
        channel: "push",
        address: "fcm_tok",
        opted_in: true,
        kind: "fcm",
        platform: "ios",
        client_app_id: "com.example.app",
        provider_project: "firebase-proj",
      },
    ]);
    expect(apns.channels[1]).toEqual({
      channel: "push",
      address: "aa11",
      opted_in: true,
      kind: "apns",
      platform: "ios",
      push_env: "production",
      client_app_id: "com.example.app",
    });
  });

  it("WhisperrOptions.clientAppId wins over the detected one", async () => {
    const w = make({ clientAppId: "com.example.pro" });
    w.identify("user_1");
    w.setPushToken({ token: "fcm_tok", kind: "fcm" });
    await settle(w);
    expect(identifies()[1].channels[0].client_app_id).toBe("com.example.pro");
  });

  it("re-registers the stored token at launch once 7 days have passed, without a setPushToken call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new RealDate("2026-10-01T00:00:00Z"));
    const storage = new MemoryStorage();
    const first = make({ storage });
    first.identify("user_1");
    first.setPushToken({ token: "fcm_tok", kind: "fcm" });
    await settle(first);
    await first.close();

    vi.setSystemTime(new RealDate("2026-10-08T00:00:01Z"));
    sent = [];
    const second = make({ storage });
    await settle(second);
    await second.close();
    const push = identifies().filter((b) => b.channels);
    expect(push).toEqual([
      {
        external_user_id: "user_1",
        channels: [
          {
            channel: "push",
            address: "fcm_tok",
            opted_in: true,
            kind: "fcm",
            platform: "ios",
            client_app_id: "com.example.app",
            provider_project: "firebase-proj",
          },
        ],
      },
    ]);

    sent = [];
    const third = make({ storage }); // sent_at is fresh again
    await settle(third);
    expect(identifies().filter((b) => b.channels)).toEqual([]);
  });

  it("a pair persisted by SDK 0.4.x (no sent_at) is re-registered once after the upgrade", async () => {
    const storage = new MemoryStorage();
    storage.setItem("whisperr.user_id", "user_1");
    storage.setItem("whisperr.last_push", JSON.stringify({ userId: "user_1", token: "old_tok", meta: "fcm|android|" }));
    const w = make({ storage });
    await settle(w);
    expect(identifies().filter((b) => b.channels)).toEqual([
      {
        external_user_id: "user_1",
        channels: [{ channel: "push", address: "old_tok", opted_in: true, kind: "fcm", platform: "android" }],
      },
    ]);
  });

  it("an anonymous token is opted out under the handle when notifications are denied", async () => {
    const w = make();
    w.setPushToken("tok_a");
    await settle(w);
    w.setPushPermission("denied");
    await settle(w);
    const [optIn, optOut] = identifies();
    expect(optOut).toEqual({
      anonymous_id: optIn.anonymous_id,
      channels: [{ channel: "push", address: "tok_a", opted_in: false }],
    });
  });
});

describe("push_opened v2 properties", () => {
  it("action_id from an expo-notifications response; cold_start true right after start", async () => {
    const w = make();
    w.identify("user_1");
    w.trackPushOpened({
      actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
      notification: { request: { content: { data: { whisperr_message_id: "m1" } } } },
    });
    w.trackPushOpened({
      actionIdentifier: "snooze",
      notification: { request: { content: { data: { whisperr_message_id: "m2" } } } },
    });
    await settle(w);
    expect(events().map((e) => [e.properties.action_id, e.properties.cold_start])).toEqual([
      ["default", true],
      ["snooze", true],
    ]);
  });

  it("cold_start is false after the app was in the background, and false after the start window", async () => {
    const w = make({ flushOnAppBackground: true });
    w.identify("user_1");
    __setAppState("background");
    __setAppState("active");
    w.trackPushOpened({ whisperr_message_id: "m3" });
    await settle(w);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new RealDate(Date.now() + 11_000));
    const late = make();
    vi.setSystemTime(new RealDate(Date.now() + 11_000));
    late.identify("user_1");
    late.trackPushOpened({ whisperr_message_id: "m4" });
    late.trackPushOpened({ whisperr_message_id: "m5" }, { coldStart: true, actionId: "open" });
    await settle(late);
    const props = events()
      .filter((e) => e.event_type === "push_opened")
      .map((e) => [e.properties.whisperr_message_id, e.properties.cold_start, e.properties.action_id]);
    expect(props).toEqual([
      ["m3", false, "default"],
      ["m4", false, "default"],
      ["m5", true, "open"],
    ]);
  });
});

describe("push_received", () => {
  const received = () => events().filter((e) => e.event_type === "push_received");

  it("once per message id, also across a restart; foreground defaults to the app state", async () => {
    const storage = new MemoryStorage();
    const first = make({ storage, trackAppLifecycleEvents: true });
    first.identify("user_1");
    first.trackPushReceived({ whisperr_message_id: "m1" });
    first.trackPushReceived({ data: { whisperr_message_id: "m1" } });
    AppState.currentState = "background";
    first.trackPushReceived({ whisperr_message_id: "m2" }, { source: "expo_task" });
    first.trackPushReceived({ title: "other provider" });
    await settle(first);
    await first.close();

    AppState.currentState = "active";
    const second = make({ storage, trackAppLifecycleEvents: true });
    second.identify("user_1");
    second.trackPushReceived({ whisperr_message_id: "m1" });
    await settle(second);

    expect(received().map((e) => e.properties)).toEqual([
      expect.objectContaining({ whisperr_message_id: "m1", foreground: true, source: "foreground" }),
      expect.objectContaining({ whisperr_message_id: "m2", foreground: false, source: "expo_task" }),
    ]);
  });

  it("the off switch stops it, and it still returns the payload", async () => {
    const w = make({ trackAppLifecycleEvents: false });
    w.identify("user_1");
    expect(w.trackPushReceived({ whisperr_message_id: "m1" })).toEqual({ messageId: "m1" });
    await settle(w);
    expect(received()).toEqual([]);
  });
});

describe("version context (C5)", () => {
  it("every event carries the version keys in context, never locale", async () => {
    const w = make({ appVersion: "2.0.0", appBuild: "200", trackAppLifecycleEvents: true });
    w.identify("user_1");
    w.track("feature_used");
    w.screen("Home");
    await settle(w);
    for (const e of events()) {
      expect(e.context).toMatchObject({
        app_version: "2.0.0",
        app_build: "200",
        platform: "ios",
        sdk_name: "whisperr-react-native",
        sdk_version: "0.6.0",
      });
      expect(e.context).not.toHaveProperty("locale");
    }
    expect(events().map((e) => e.event_type)).toEqual(expect.arrayContaining(["feature_used", "screen_viewed", "app_opened"]));
  });
});

describe("requestPushAuthorization()", () => {
  it("asks through the installed package and reports the answer", async () => {
    h.permission = "provisional";
    const w = make();
    w.identify("user_1");
    await expect(w.requestPushAuthorization({ provisional: true })).resolves.toBe("provisional");
    await settle(w);
    expect(h.permissionCalls).toEqual([{ provisional: true }]);
    expect(events().find((e) => e.event_type === "push_permission_changed")?.properties.status).toBe("provisional");
  });

  it("resolves null when no permission package is installed", async () => {
    const w = make();
    await expect(w.requestPushAuthorization()).resolves.toBeNull();
    await settle(w);
    expect(events()).toEqual([]);
  });
});

describe("setAppLanguage edge cases", () => {
  it("before init: sent once init knows the subject; the same stored value is not sent again", async () => {
    const storage = new MemoryStorage();
    const first = make({ storage });
    first.setAppLanguage("de"); // before init, no user: an anonymous identify
    await settle(first);
    await first.close();
    const second = make({ storage });
    second.setAppLanguage("de"); // before init, same as stored: nothing
    await settle(second);
    expect(identifies()).toEqual([{ anonymous_id: expect.any(String), traits: { app_language: "de" } }]);
  });

  it("while opted out the value is stored but not sent; identify after optIn() carries it", async () => {
    const w = make();
    w.identify("user_1");
    await settle(w);
    w.optOut();
    w.setAppLanguage("fr");
    await settle(w);
    w.optIn();
    w.identify("user_1");
    await settle(w);
    expect(identifies().map((b) => b.traits)).toEqual([{ locale: "de-DE" }, { locale: "de-DE", app_language: "fr" }]);
  });
});
