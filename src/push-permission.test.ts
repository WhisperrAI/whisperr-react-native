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
let status = 200;

beforeEach(() => {
  identifies = [];
  status = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/v1/identify")) identifies.push(JSON.parse(init.body));
      return { ok: status < 300, status } as Response;
    }),
  );
});

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
  it("sends the status as the push_permission trait, once", async () => {
    const storage = new MemoryStorage();
    const w = makeClient({ storage });
    w.identify("user_1");
    w.setPushPermission("granted");
    w.setPushPermission("granted");
    await settle(w);
    await w.close();
    expect(identifies.slice(1)).toEqual([{ external_user_id: "user_1", traits: { push_permission: "granted" } }]);

    // Every-launch reports stay a no-op after a restart.
    const again = makeClient({ storage });
    again.identify("user_1");
    again.setPushPermission("granted");
    await settle(again);
    await again.close();
    expect(identifies.filter((b) => b.traits?.push_permission)).toHaveLength(1);
  });

  it("denied opts the registered token out and holds it; granted registers it again", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.setPushToken({ token: EXPO });
    w.setPushPermission("granted");
    await settle(w);
    identifies = [];

    w.setPushPermission("denied");
    await settle(w);
    expect(identifies).toEqual([
      {
        external_user_id: "user_1",
        traits: { push_permission: "denied" },
        channels: [{ channel: "push", address: EXPO, opted_in: false }],
      },
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
        traits: { push_permission: "provisional" },
        channels: [{ channel: "push", address: EXPO, opted_in: true, kind: "expo", platform: "ios" }],
      },
    ]);
  });

  it("before identify(), the status rides on the next identify; the caller's trait wins", async () => {
    const w = makeClient();
    w.setPushPermission("denied");
    await settle(w);
    w.identify("user_1");
    w.identify("user_2", { traits: { push_permission: "custom" } });
    await settle(w);
    expect(identifies[0]).toEqual({ external_user_id: "user_1", traits: { push_permission: "denied" } });
    expect(identifies[1].traits).toEqual({ push_permission: "custom" });
  });

  it("after reset(), the next user gets the device's status", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.setPushPermission("granted");
    await settle(w);
    w.reset();
    w.identify("user_2");
    await settle(w);
    expect(identifies.at(-1)).toEqual({ external_user_id: "user_2", traits: { push_permission: "granted" } });
  });

  it("a report the server rejected is sent again on the next report", async () => {
    const w = makeClient();
    w.identify("user_1");
    await settle(w);
    status = 400;
    w.setPushPermission("granted");
    await settle(w);
    status = 200;
    identifies = [];
    w.setPushPermission("granted");
    await settle(w);
    expect(identifies).toEqual([{ external_user_id: "user_1", traits: { push_permission: "granted" } }]);
  });

  it("ignores an unknown status", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.setPushPermission("maybe" as never);
    await settle(w);
    expect(identifies).toHaveLength(1);
  });
});
