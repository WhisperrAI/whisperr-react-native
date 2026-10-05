import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAppState, __setPlatform, AppState } from "../test/react-native.js";
import { WhisperrClient } from "./client.js";
import { LIB_VERSION } from "./runtime.js";
import { MemoryStorage } from "./storage.js";
import type { WhisperrOptions } from "./types.js";

// Pin the device-derived values so the flat properties are exact.
const device = vi.hoisted(() => ({ traits: { timezone: "Europe/Berlin", locale: "de-DE" } as Record<string, string> }));
vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({ ...device.traits }),
}));

let captured: Array<{ path: string; body: any }> = [];

beforeEach(() => {
  captured = [];
  device.traits = { timezone: "Europe/Berlin", locale: "de-DE" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      captured.push({ path: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  AppState.currentState = "active";
  __setPlatform({ OS: "ios", Version: "17.4", constants: { systemName: "iOS" } });
});

function makeClient(overrides: Partial<WhisperrOptions> = {}): WhisperrClient {
  return new WhisperrClient({
    apiKey: "wrk_test",
    flushIntervalMs: 0,
    maxRetries: 0,
    appVersion: "2.4.1",
    appBuild: "241",
    ...overrides,
  });
}

/** Lets queued lifecycle handling run, then delivers everything. */
async function settle(w: WhisperrClient): Promise<void> {
  await (w as unknown as { lifecycleChain: Promise<void> }).lifecycleChain;
  await w.flush();
}

function events(): any[] {
  return captured.filter((c) => c.path === "/v1/events/batch").flatMap((c) => c.body.events);
}
function names(): string[] {
  return events().map((e) => e.event_type);
}

const FLAT = {
  app_version: "2.4.1",
  app_build: "241",
  platform: "ios",
  os_name: "ios",
  os_version: "17.4",
  sdk_name: "whisperr-react-native",
  sdk_version: LIB_VERSION,
  locale: "de-DE",
  timezone: "Europe/Berlin",
};

describe("automatic lifecycle events", () => {
  it("a fresh install sends app_installed, then app_opened (cold start), with the flat properties", async () => {
    const w = makeClient({ storage: new MemoryStorage() });
    await settle(w);

    expect(names()).toEqual(["app_installed", "app_opened"]);
    expect(events()[0].properties).toEqual(FLAT);
    expect(events()[1].properties).toEqual({ ...FLAT, cold_start: true });
    // Sent under the anonymous handle until identify().
    expect(events()[0].anonymous_id).toBeTruthy();
    await w.close();
  });

  it("identify() in the launch tick does not hide a fresh install", async () => {
    const w = makeClient({ storage: new MemoryStorage() });
    w.identify("user_1"); // writes user_id before init reads storage
    await settle(w);
    expect(names()).toEqual(["app_installed", "app_opened"]);
    await w.close();
  });

  it("a relaunch on the same version sends only app_opened", async () => {
    const storage = new MemoryStorage();
    await makeClient({ storage }).close();
    captured = [];

    const w = makeClient({ storage });
    await settle(w);
    expect(names()).toEqual(["app_opened"]);
    await w.close();
  });

  it("a new version sends app_updated with the previous version and build", async () => {
    const storage = new MemoryStorage();
    await makeClient({ storage }).close();
    captured = [];

    const w = makeClient({ storage, appVersion: "2.5.0", appBuild: "250" });
    await settle(w);
    expect(names()).toEqual(["app_updated", "app_opened"]);
    expect(events()[0].properties).toEqual({
      ...FLAT,
      app_version: "2.5.0",
      app_build: "250",
      previous_version: "2.4.1",
      previous_build: "241",
    });
    await w.close();
  });

  // Every key SDK 0.2.x persisted. Upgrading the SDK must not report an install.
  const legacyState: Array<[string, string]> = [
    ["whisperr.anon_id", "anon_7d1f0c2e-1111-4222-8333-944455556666"],
    ["whisperr.user_id", "user_1"],
    ["whisperr.optout", "1"],
    ["whisperr.last_push", JSON.stringify({ userId: "user_1", token: "fcm_tok_a" })],
    ["whisperr.queue.v1", JSON.stringify([])],
    ["whisperr.session", JSON.stringify({ id: "sess_x", last: 0 })],
  ];

  it.each(legacyState)("an upgrade from 0.2.x state (%s) sends no app_installed", async (key, value) => {
    const storage = new MemoryStorage();
    storage.setItem(key, value);
    const w = makeClient({ storage });
    await settle(w);
    expect(names()).not.toContain("app_installed");
    expect(names()).not.toContain("app_updated");
    // The version is recorded silently…
    expect(JSON.parse(storage.getItem("whisperr.app_version")!)).toEqual({ version: "2.4.1", build: "241" });
    await w.close();
  });

  it("after a 0.2.x upgrade, the next real version change sends app_updated", async () => {
    const storage = new MemoryStorage();
    storage.setItem("whisperr.anon_id", "anon_legacy");
    await makeClient({ storage }).close();
    captured = [];

    const w = makeClient({ storage, appVersion: "2.5.0", appBuild: "250" });
    await settle(w);
    expect(names()).toEqual(["app_updated", "app_opened"]);
    await w.close();
  });

  it("without durable storage, only opened / backgrounded are sent", async () => {
    const w = makeClient(); // memory-only
    await settle(w);
    expect(names()).toEqual(["app_opened"]);
    await w.close();
  });

  it("sends app_backgrounded with foreground_ms, flushes, and a warm app_opened on return", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    const w = makeClient({ storage: new MemoryStorage() });
    await settle(w);
    captured = [];

    vi.setSystemTime(new Date("2026-10-05T12:00:42.500Z"));
    __setAppState("inactive"); // iOS passes through inactive: no event of its own
    __setAppState("background");
    await vi.waitFor(() => expect(names()).toEqual(["app_backgrounded"])); // flushed on background
    expect(events()[0].properties).toEqual({ ...FLAT, foreground_ms: 42500 });
    expect(events()[0].occurred_at).toBe("2026-10-05T12:00:42.500Z");

    captured = [];
    __setAppState("active");
    await settle(w);
    expect(names()).toEqual(["app_opened"]);
    expect(events()[0].properties.cold_start).toBe(false);
    await w.close();
  });

  it("a launch into the background is not an open; the first foreground is the cold start", async () => {
    AppState.currentState = "background";
    const w = makeClient();
    await settle(w);
    expect(names()).toEqual([]);

    __setAppState("active");
    await settle(w);
    expect(names()).toEqual(["app_opened"]);
    expect(events()[0].properties.cold_start).toBe(true);
    await w.close();
  });

  it("trackAppLifecycleEvents: false turns automatic events off", async () => {
    const w = makeClient({ storage: new MemoryStorage(), trackAppLifecycleEvents: false });
    await settle(w);
    __setAppState("background");
    __setAppState("active");
    await settle(w);
    expect(names()).toEqual([]);
    await w.close();
  });

  it("an opted-out device sends nothing but still records the version", async () => {
    const storage = new MemoryStorage();
    storage.setItem("whisperr.optout", "1");
    const w = makeClient({ storage });
    await settle(w);
    __setAppState("background");
    await settle(w);
    expect(captured).toHaveLength(0);
    expect(storage.getItem("whisperr.app_version")).not.toBeNull();
    await w.close();
  });

  it("omits app_version / app_build when nothing provides them", async () => {
    const w = makeClient({ appVersion: undefined, appBuild: undefined });
    await settle(w);
    expect(events()[0].properties).not.toHaveProperty("app_version");
    expect(events()[0].properties).not.toHaveProperty("app_build");
    await w.close();
  });

  it("sends timezone_offset_minutes when the runtime has no IANA zone", async () => {
    device.traits = { locale: "de-DE" };
    const w = makeClient();
    await settle(w);
    const props = events()[0].properties;
    expect(props).not.toHaveProperty("timezone");
    expect(Number.isInteger(props.timezone_offset_minutes)).toBe(true);
    await w.close();
  });

  it("reports the Android release version, not the API level", async () => {
    __setPlatform({ OS: "android", Version: 34, constants: { Release: "14" } });
    const w = makeClient();
    await settle(w);
    expect(events()[0].properties).toMatchObject({ platform: "android", os_name: "android", os_version: "14" });
    await w.close();
  });
});
