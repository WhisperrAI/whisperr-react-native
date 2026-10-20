import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAppState, AppState } from "../test/react-native.js";
import { WhisperrClient } from "./client.js";
import { MemoryStorage } from "./storage.js";
import type { PushPermissionStatus, WhisperrOptions } from "./types.js";

// Device trait defaults are environment-dependent; pin them off.
vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({}),
}));

let events: any[] = [];
let identifies: any[] = [];
/** What the fake OS reports; `reads` counts the reads. */
let os: PushPermissionStatus | undefined;
let reads = 0;
const clients: WhisperrClient[] = [];

const reader = async (): Promise<PushPermissionStatus | undefined> => {
  reads += 1;
  return os;
};

beforeEach(() => {
  events = [];
  identifies = [];
  os = "granted";
  reads = 0;
  AppState.currentState = "active";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/v1/events/batch")) events.push(...body.events);
      if (url.endsWith("/v1/identify")) identifies.push(body);
      return { ok: true, status: 200 } as Response;
    }),
  );
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  AppState.currentState = "active";
  vi.unstubAllGlobals();
});

function make(overrides: Partial<WhisperrOptions> = {}): WhisperrClient {
  const c = new WhisperrClient({
    apiKey: "wpk_test",
    flushIntervalMs: 0,
    flushOnAppBackground: false,
    trackAppLifecycleEvents: false,
    maxRetries: 0,
    pushPermissionReader: reader,
    ...overrides,
  });
  clients.push(c);
  return c;
}

async function settle(w: WhisperrClient): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await w.flush();
}

function permissionEvents(): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.event_type === "push_permission_changed")
    .map(({ properties: { status, previous_status } }) => ({
      status,
      ...(previous_status ? { previous_status } : {}),
    }));
}

describe("automatic push permission", () => {
  it("reports the OS permission at start without any app call", async () => {
    const w = make();
    await settle(w);
    expect(reads).toBe(1);
    expect(permissionEvents()).toEqual([{ status: "authorized" }]);
  });

  it("reads again when the app becomes active and reports only a change", async () => {
    const w = make();
    await settle(w);
    __setAppState("background");
    __setAppState("active");
    await settle(w);
    expect(reads).toBe(2);
    expect(permissionEvents()).toEqual([{ status: "authorized" }]); // unchanged: nothing new

    os = "denied"; // turned off in Settings
    __setAppState("background");
    __setAppState("active");
    await settle(w);
    expect(permissionEvents()).toEqual([{ status: "authorized" }, { status: "denied", previous_status: "authorized" }]);
  });

  it("reports the answer to the app's own prompt (iOS: inactive → active)", async () => {
    os = "undetermined";
    const w = make();
    await settle(w);
    os = "provisional";
    __setAppState("inactive"); // the system alert
    __setAppState("active"); // the alert closed
    await settle(w);
    expect(permissionEvents()).toEqual([
      { status: "not_determined" },
      { status: "provisional", previous_status: "not_determined" },
    ]);
  });

  it("a manual setPushPermission() stands until the OS setting changes", async () => {
    const storage = new MemoryStorage();
    const w = make({ storage });
    await settle(w);
    w.setPushPermission("denied"); // e.g. the app's own notifications switch
    await settle(w);
    __setAppState("background");
    __setAppState("active");
    await settle(w);
    expect(permissionEvents()).toEqual([{ status: "authorized" }, { status: "denied", previous_status: "authorized" }]);

    // Also across a restart.
    await w.close();
    const again = make({ storage });
    await settle(again);
    expect(permissionEvents()).toHaveLength(2);

    os = "provisional"; // the OS setting changed: it reports
    __setAppState("background");
    __setAppState("active");
    await settle(again);
    expect(permissionEvents().at(-1)).toEqual({ status: "provisional", previous_status: "denied" });
  });

  it("refreshPushPermission() reads now and reports the OS value", async () => {
    const w = make({ automaticPushPermission: false });
    w.setPushPermission("denied");
    await settle(w);
    await expect(w.refreshPushPermission()).resolves.toBe("granted");
    await settle(w);
    expect(permissionEvents()).toEqual([{ status: "denied" }, { status: "authorized", previous_status: "denied" }]);
  });

  it("automaticPushPermission: false reads nothing", async () => {
    const w = make({ automaticPushPermission: false });
    await settle(w);
    __setAppState("background");
    __setAppState("active");
    await settle(w);
    expect(reads).toBe(0);
    expect(permissionEvents()).toEqual([]);
  });

  it("does not read while opted out", async () => {
    const storage = new MemoryStorage();
    await storage.setItem("whisperr.optout", "1");
    const w = make({ storage });
    await settle(w);
    __setAppState("background");
    __setAppState("active");
    await settle(w);
    expect(reads).toBe(0);
    await expect(w.refreshPushPermission()).resolves.toBeNull();
  });

  it("after reset() the next user gets a fresh report", async () => {
    const w = make();
    w.identify("user_1");
    await settle(w);
    w.reset();
    await settle(w);
    const sent = events.filter((e) => e.event_type === "push_permission_changed");
    expect(sent).toHaveLength(2);
    expect(sent[0].external_user_id).toBe("user_1");
    expect(sent[1].external_user_id).toBeUndefined();
    expect(sent[1].properties.status).toBe("authorized");
  });

  it("a launch in the background reads on the first move to active", async () => {
    AppState.currentState = "background";
    const w = make();
    await settle(w);
    expect(reads).toBe(0);
    __setAppState("active");
    await settle(w);
    expect(reads).toBe(1);
    expect(permissionEvents()).toEqual([{ status: "authorized" }]);
  });

  it("a reader that fails or cannot tell sends nothing", async () => {
    const w = make({
      pushPermissionReader: () => {
        throw new Error("boom");
      },
    });
    await settle(w);
    await expect(w.refreshPushPermission()).resolves.toBeNull();
    const v = make({ pushPermissionReader: () => null });
    await settle(v);
    expect(permissionEvents()).toEqual([]);
  });

  it("without a reader or installed peer it reads nothing", async () => {
    const w = make({ pushPermissionReader: undefined });
    await settle(w);
    await expect(w.refreshPushPermission()).resolves.toBeNull();
    expect(permissionEvents()).toEqual([]);
  });
});
