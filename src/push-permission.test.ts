import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import { isExpoPushToken, normalizePushToken } from "./push.js";
import { MemoryStorage } from "./storage.js";
import type { WhisperrOptions } from "./types.js";

// Device trait defaults are environment-dependent; pin them off so identify
// bodies are exactly what each test supplies.
vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({}),
}));

const APNS = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const EXPO = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

let identifies: any[] = [];
let events: any[] = [];
let status = 200;

beforeEach(() => {
  identifies = [];
  events = [];
  status = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (status >= 300) return { ok: false, status } as Response;
      const body = JSON.parse(init.body);
      if (url.endsWith("/v1/identify")) identifies.push(body);
      if (url.endsWith("/v1/events/batch")) events.push(...body.events);
      return { ok: true, status } as Response;
    }),
  );
});

/** The push_permission_changed events sent, as { status, previous_status? }. */
function permissionEvents(): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.event_type === "push_permission_changed")
    .map(({ properties: { status, previous_status } }) => ({
      status,
      ...(previous_status ? { previous_status } : {}),
    }));
}

afterEach(() => vi.unstubAllGlobals());

function makeClient(overrides: Partial<WhisperrOptions> = {}): WhisperrClient {
  return new WhisperrClient({
    apiKey: "wrk_test",
    flushIntervalMs: 0,
    flushOnAppBackground: false,
    trackAppLifecycleEvents: false,
    maxRetries: 0,
    ...overrides,
  });
}

/** setPushPermission waits for init; give it a tick, then deliver. */
async function settle(w: WhisperrClient): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await w.flush();
}

describe("normalizePushToken", () => {
  it("keeps a bare string bare: the server infers the kind", () => {
    expect(normalizePushToken(` ${EXPO} `)).toEqual({ token: EXPO });
    expect(normalizePushToken("  ")).toBeNull();
  });

  it("object form: an Expo token gets kind expo, platform defaults to Platform.OS", () => {
    expect(normalizePushToken({ token: EXPO })).toEqual({ token: EXPO, kind: "expo", platform: "ios" });
    expect(normalizePushToken({ token: "fcm_tok", kind: "fcm", platform: "android" })).toEqual({
      token: "fcm_tok",
      kind: "fcm",
      platform: "android",
    });
    expect(normalizePushToken({ token: APNS, kind: "apns", pushEnv: "sandbox" })).toEqual({
      token: APNS,
      kind: "apns",
      platform: "ios",
      pushEnv: "sandbox",
    });
  });

  it("object form: never guesses a non-Expo kind, and drops unknown values", () => {
    expect(normalizePushToken({ token: APNS })).toEqual({ token: APNS, platform: "ios" });
    expect(
      normalizePushToken({ token: "t", kind: "gcm" as never, platform: "symbian" as never, pushEnv: "debug" as never }),
    ).toEqual({ token: "t", platform: "ios" });
  });

  it("maps expo-notifications token objects", () => {
    expect(normalizePushToken({ type: "expo", data: EXPO })).toEqual({ token: EXPO, kind: "expo", platform: "ios" });
    expect(normalizePushToken({ type: "ios", data: APNS })).toEqual({ token: APNS, kind: "apns", platform: "ios" });
    expect(normalizePushToken({ type: "android", data: "fcm_tok" })).toEqual({
      token: "fcm_tok",
      kind: "fcm",
      platform: "android",
    });
    expect(normalizePushToken({ type: "web", data: { endpoint: "https://x" } })).toBeNull();
  });

  it("detects Expo tokens exactly like the server", () => {
    expect(isExpoPushToken("ExponentPushToken[abc]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abc]")).toBe(true);
    expect(isExpoPushToken("ExponentPushToken")).toBe(false);
    expect(isExpoPushToken(APNS)).toBe(false);
  });
});

describe("setPushToken with metadata", () => {
  it("sends kind and platform for an Expo token object", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.setPushToken({ type: "expo", data: EXPO });
    await settle(w);
    expect(identifies[1]).toEqual({
      external_user_id: "user_1",
      channels: [{ channel: "push", address: EXPO, opted_in: true, kind: "expo", platform: "ios" }],
    });
  });

  it("carries metadata on a token buffered before identify()", async () => {
    const w = makeClient();
    w.setPushToken({ token: APNS, kind: "apns", pushEnv: "production" });
    w.identify("user_1");
    await settle(w);
    expect(identifies[0].channels).toEqual([
      { channel: "push", address: APNS, opted_in: true, kind: "apns", platform: "ios", push_env: "production" },
    ]);
  });

  it("accepts the object form in identify({ pushToken })", async () => {
    const w = makeClient();
    w.identify("user_1", { pushToken: { token: "fcm_tok", kind: "fcm", platform: "android" } });
    await settle(w);
    expect(identifies[0].channels).toEqual([
      { channel: "push", address: "fcm_tok", opted_in: true, kind: "fcm", platform: "android" },
    ]);
  });

  it("re-sends a known token once when metadata arrives; a bare token never downgrades it", async () => {
    const w = makeClient();
    w.identify("user_1");
    await settle(w);
    for (const token of [EXPO, { token: EXPO }, EXPO, { token: EXPO }]) {
      w.setPushToken(token);
      await settle(w);
    }
    expect(identifies.slice(1)).toEqual([
      { external_user_id: "user_1", channels: [{ channel: "push", address: EXPO, opted_in: true }] },
      {
        external_user_id: "user_1",
        channels: [{ channel: "push", address: EXPO, opted_in: true, kind: "expo", platform: "ios" }],
      },
    ]);
  });

  it("keeps the metadata dedupe across a restart", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage });
    first.identify("user_1");
    first.setPushToken({ token: EXPO });
    await settle(first);
    await first.close();

    const second = makeClient({ storage });
    second.identify("user_1");
    second.setPushToken({ token: EXPO });
    await settle(second);
    await second.close();
    const pushBodies = identifies.filter((b) => b.channels);
    expect(pushBodies).toHaveLength(1);
  });
});

describe("setPushPermission", () => {
  it("sends push_permission_changed with the spec status names, never a trait", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.setPushPermission("undetermined");
    w.setPushPermission("granted");
    w.setPushPermission("granted");
    await settle(w);
    expect(permissionEvents()).toEqual([
      { status: "not_determined" },
      { status: "authorized", previous_status: "not_determined" },
    ]);
    const event = events.find((e) => e.event_type === "push_permission_changed");
    expect(event.external_user_id).toBe("user_1");
    expect(event.properties).toMatchObject({ platform: "ios", sdk_name: "whisperr-react-native" });
    expect(identifies).toEqual([{ external_user_id: "user_1" }]);
  });

  it("before identify(), the event goes out under the anonymous handle", async () => {
    const w = makeClient();
    w.setPushPermission("denied");
    await settle(w);
    expect(permissionEvents()).toEqual([{ status: "denied" }]);
    expect(events[0].external_user_id).toBeUndefined();
    expect(events[0].anonymous_id).toBeTruthy();
    w.identify("user_1");
    await settle(w);
    expect(identifies[0].traits).toBeUndefined();
  });

  it("denied opts the registered token out and holds it; provisional registers it again", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.setPushToken({ token: EXPO });
    w.setPushPermission("granted");
    await settle(w);
    identifies = [];

    w.setPushPermission("denied");
    await settle(w);
    expect(identifies).toEqual([
      { external_user_id: "user_1", channels: [{ channel: "push", address: EXPO, opted_in: false }] },
    ]);

    // Every-launch token wiring while notifications are off: nothing is sent.
    identifies = [];
    w.setPushToken({ token: EXPO });
    w.identify("user_1", { traits: { plan: "pro" } });
    await settle(w);
    expect(identifies).toEqual([{ external_user_id: "user_1", traits: { plan: "pro" } }]);

    identifies = [];
    w.setPushPermission("provisional");
    await settle(w);
    expect(identifies).toEqual([
      {
        external_user_id: "user_1",
        channels: [{ channel: "push", address: EXPO, opted_in: true, kind: "expo", platform: "ios" }],
      },
    ]);
    expect(permissionEvents().slice(1)).toEqual([
      { status: "denied", previous_status: "authorized" },
      { status: "provisional", previous_status: "denied" },
    ]);
  });

  it("reset() forgets the sent status but keeps the device's denied permission", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.setPushPermission("denied");
    await settle(w);
    w.reset();
    w.identify("user_2");
    w.setPushToken("fcm_tok_a"); // held: notifications are still off on this device
    w.setPushPermission("denied");
    await settle(w);
    expect(permissionEvents()).toEqual([{ status: "denied" }, { status: "denied" }]);
    expect(identifies.filter((b) => b.channels)).toEqual([]);
  });

  it("an upgrade from 0.4.x sends the stored status once, and keeps its denied gate", async () => {
    const storage = new MemoryStorage();
    storage.setItem("whisperr.user_id", "user_1");
    storage.setItem("whisperr.push_permission", JSON.stringify({ status: "denied", sentFor: "user_1" }));
    const w = makeClient({ storage });
    w.setPushToken("fcm_tok_a");
    await settle(w);
    expect(identifies).toEqual([]); // held back by the stored denied permission

    w.setPushPermission("denied");
    w.setPushPermission("denied");
    await settle(w);
    await w.close();
    expect(permissionEvents()).toEqual([{ status: "denied" }]);

    const again = makeClient({ storage });
    again.setPushPermission("denied");
    await settle(again);
    expect(permissionEvents()).toHaveLength(1);
  });

  it("an event the server rejected is sent again on the next report, with the status before it", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.setPushPermission("granted");
    await settle(w);
    status = 400;
    w.setPushPermission("denied");
    await settle(w);
    status = 200;
    w.setPushPermission("denied");
    await settle(w);
    expect(permissionEvents()).toEqual([{ status: "authorized" }, { status: "denied", previous_status: "authorized" }]);
  });

  it("ignores an unknown status", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.setPushPermission("maybe" as never);
    await settle(w);
    expect(identifies).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe("optOut() opts this device's push token out on the server", () => {
  async function registered(storage = new MemoryStorage()): Promise<WhisperrClient> {
    const w = makeClient({ storage });
    w.identify("user_1");
    w.setPushToken("fcm_tok_a");
    await settle(w);
    identifies = [];
    return w;
  }
  const OPT_OUT = { external_user_id: "user_1", channels: [{ channel: "push", address: "fcm_tok_a", opted_in: false }] };

  it("retries the opt-out while opted out and delivers it after a restart", async () => {
    const storage = new MemoryStorage();
    const w = await registered(storage);
    status = 503;
    w.optOut();
    w.optOut(); // a second call keeps the queued opt-out
    w.track("feature_used");
    await settle(w);
    await w.close();
    expect(identifies).toEqual([]);

    status = 200;
    const next = makeClient({ storage });
    next.identify("user_1");
    next.track("feature_used");
    await settle(next);
    expect(identifies).toEqual([OPT_OUT]);
    expect(events).toEqual([]);
  });

  it("is not lost when optOut() runs while a batch is in flight", async () => {
    const w = await registered();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        if (url.endsWith("/v1/events/batch")) await gate;
        if (url.endsWith("/v1/identify")) identifies.push(JSON.parse(init.body));
        return { ok: true, status: 200 } as Response;
      }),
    );
    w.track("feature_used");
    const inFlight = w.flush();
    await new Promise((r) => setTimeout(r, 0));
    w.optOut();
    release();
    await inFlight;
    await w.flush();
    expect(identifies).toEqual([OPT_OUT]);
  });
});
