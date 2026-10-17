import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __openURL, __setAppState, __setInitialURL, AppState } from "../test/react-native.js";
import { WhisperrClient } from "./client.js";
import { __resetErrorCapture } from "./errors.js";
import { whisperrNavigationTracker } from "./screens.js";
import { errorFingerprint, errorName, linkSignal, redactRoute, sha256Hex, stackFrames } from "./signals.js";
import { MemoryStorage } from "./storage.js";
import type { WhisperrOptions } from "./types.js";

vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({ timezone: "Europe/Berlin", locale: "de-DE" }),
}));

let captured: any[] = [];

type Handler = (error: unknown, isFatal?: boolean) => void;
let globalHandler: Handler;
let previousCalls: Array<[unknown, boolean | undefined]>;

beforeEach(() => {
  captured = [];
  previousCalls = [];
  globalHandler = (error, isFatal) => void previousCalls.push([error, isFatal]);
  (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
    getGlobalHandler: () => globalHandler,
    setGlobalHandler: (h: Handler) => void (globalHandler = h),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      captured.push(...(JSON.parse(init.body).events ?? []));
      return { ok: true, status: 200 } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetErrorCapture();
  __setInitialURL(null);
  AppState.currentState = "active";
  delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
  delete (globalThis as { __DEV__?: boolean }).__DEV__;
  delete (globalThis as { HermesInternal?: unknown }).HermesInternal;
});

function makeClient(overrides: Partial<WhisperrOptions> = {}): WhisperrClient {
  return new WhisperrClient({ apiKey: "wpk_test", flushIntervalMs: 0, maxRetries: 0, appVersion: "2.4.1", ...overrides });
}

async function settle(w: WhisperrClient): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await (w as unknown as { lifecycleChain: Promise<void> }).lifecycleChain;
  await w.flush();
}

/** Lets the launch run without ending the attribution window. */
async function launched(w: WhisperrClient): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await (w as unknown as { lifecycleChain: Promise<void> }).lifecycleChain;
}

const named = (type: string) => captured.filter((e) => e.event_type === type);
const types = () => captured.map((e) => e.event_type);

function errorWithStack(name: string, frames: string[]): Error {
  const error = new Error("do not send me");
  error.name = name;
  error.stack = [`${name}: do not send me`, ...frames.map((f) => `    at ${f} (/app/index.bundle:1:${f.length})`)].join("\n");
  return error;
}

describe("sessions and per-visit counters", () => {
  it("every event carries context.session_id; a cold start starts a new session", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage });
    first.track("cart_viewed");
    await settle(first);
    await first.close();
    const ids = new Set(captured.map((e) => e.context.session_id));
    expect(ids.size).toBe(1);
    const [firstId] = ids;
    expect(firstId).toMatch(/^sess_[0-9a-f-]{36}$/);

    captured = [];
    const second = makeClient({ storage });
    await settle(second);
    expect(captured.length).toBeGreaterThan(0);
    for (const e of captured) expect(e.context.session_id).not.toBe(firstId);
    await second.close();
  });

  it("rolls after 30 idle minutes on either clock (the monotonic one can stop in deep sleep)", async () => {
    const { Session, __setMonotonicClock } = await import("./runtime.js");
    let mono = 0;
    __setMonotonicClock(() => mono);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    try {
      const session = new Session();
      const a = session.current();
      mono += 29 * 60_000;
      vi.setSystemTime(new Date("2026-10-05T12:29:00Z"));
      expect(session.current()).toBe(a);
      // Deep sleep: the wall clock moves 31 minutes, the monotonic one does not.
      vi.setSystemTime(new Date("2026-10-05T13:00:00Z"));
      const b = session.current();
      expect(b).not.toBe(a);
      // The wall clock is set back, but 30 monotonic minutes pass.
      mono += 30 * 60_000;
      vi.setSystemTime(new Date("2026-10-05T12:40:00Z"));
      expect(session.current()).not.toBe(b);
    } finally {
      __setMonotonicClock(() => Date.now());
    }
  });

  it("app_backgrounded counts screens, unique screens, the app's events and errors of the visit", async () => {
    const w = makeClient({ captureErrors: false });
    await settle(w);
    w.screen("Home");
    w.screen("Cart");
    w.screen("Home");
    w.track("cart_viewed");
    w.track("checkout_started");
    w.trackError(new TypeError("x"));
    w.trackError(new TypeError("x")); // deduped, still counted
    __setAppState("background");
    await settle(w);
    const [bg] = named("app_backgrounded");
    expect(bg.properties).toMatchObject({
      session_id: bg.context.session_id,
      screen_count: 3,
      unique_screen_count: 2,
      event_count: 2,
      error_count: 2,
    });
    expect(named("app_error")).toHaveLength(1);

    captured = [];
    __setAppState("active");
    await settle(w);
    __setAppState("background");
    await settle(w);
    expect(named("app_backgrounded")[0].properties).toMatchObject({ screen_count: 0, event_count: 0, error_count: 0 });
    await w.close();
  });
});

describe("launch_source", () => {
  it("holds app_opened up to the window, then sends direct", async () => {
    const w = makeClient({ launchSourceWindowMs: 40 });
    await launched(w);
    expect(named("app_opened")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 60));
    await w.flush();
    expect(named("app_opened")[0].properties).toMatchObject({ cold_start: true, launch_source: "direct" });
    await w.close();
  });

  it("a push tap inside the window resolves it at once, before push_opened, with the message id", async () => {
    const w = makeClient({ launchSourceWindowMs: 60_000 });
    await launched(w);
    w.trackPushOpened({ whisperr_message_id: "msg_1", whisperr_deep_link: "myapp://offers/1" });
    await launched(w);
    await w.flush();
    expect(types()).toEqual(["app_opened", "push_opened"]);
    expect(named("app_opened")[0].properties).toMatchObject({ launch_source: "push", whisperr_message_id: "msg_1" });
    expect(named("app_opened")[0].properties).not.toHaveProperty("link_route");
    await w.close();
  });

  it("the initial URL sets the source of a cold start", async () => {
    __setInitialURL("https://Shop.Example.com:443/orders/12345?utm_source=news&token=secret#x");
    const w = makeClient({ launchSourceWindowMs: 60_000 });
    await launched(w);
    await new Promise((r) => setTimeout(r, 300)); // the link grace
    await w.flush();
    expect(named("app_opened")[0].properties).toMatchObject({
      launch_source: "universal_link",
      link_host: "shop.example.com",
      link_route: "/orders/:id",
      utm_source: "news",
    });
    expect(JSON.stringify(captured)).not.toContain("secret");
    await w.close();
  });

  it("a URL on a warm start counts; one while the app is in use does not", async () => {
    const w = makeClient({ launchSourceWindowMs: 60_000 });
    await settle(w);
    __openURL("myapp://in-app/link"); // already in the foreground
    __setAppState("background");
    await settle(w);
    captured = [];

    __openURL("myapp://home?wsrc=widget"); // arrives just before the foreground
    __setAppState("active");
    await settle(w);
    expect(named("app_opened")[0].properties).toMatchObject({
      cold_start: false,
      launch_source: "widget",
      link_route: "/home",
    });
    await w.close();
  });

  it("going to the background inside the window sends app_opened first, as direct", async () => {
    const w = makeClient({ launchSourceWindowMs: 60_000 });
    await launched(w);
    __setAppState("background");
    await launched(w);
    await w.flush();
    expect(types()).toEqual(["app_opened", "app_backgrounded"]);
    expect(named("app_opened")[0].properties.launch_source).toBe("direct");
    await w.close();
  });

  it("first_after_update marks only the first open after app_updated", async () => {
    const storage = new MemoryStorage();
    const old = makeClient({ storage, appVersion: "1.0.0" });
    await settle(old);
    __setAppState("background");
    await settle(old);
    await old.close();
    captured = [];
    AppState.currentState = "active";

    const w = makeClient({ storage, appVersion: "1.1.0" });
    await settle(w);
    __setAppState("background");
    __setAppState("active");
    await settle(w);
    const opens = named("app_opened").map((e) => e.properties.first_after_update);
    expect(opens).toEqual([true, undefined]);
    await w.close();
  });
});

describe("links", () => {
  it.each([
    ["myapp://magic/Zx9QmT4pLw8KvR2nB7?next=%2Fhome", { source: "deep_link", properties: { link_route: "/magic/:id" } }],
    ["myapp:///settings", { source: "deep_link", properties: { link_route: "/settings" } }],
    ["exp://192.168.1.2:8081/--/lesson/42", { source: "deep_link", properties: { link_route: "/lesson/:id" } }],
    [
      "https://shop.example.com/cart?wmid=msg_e77&utm_source=whisperr",
      {
        source: "email",
        properties: { link_route: "/cart", link_host: "shop.example.com", utm_source: "whisperr", whisperr_message_id: "msg_e77" },
      },
    ],
    ["https://a.example/?wsrc=shortcut", { source: "shortcut", properties: { link_route: "/", link_host: "a.example" } }],
  ])("%s", (url, expected) => expect(linkSignal(url)).toEqual(expected));

  it("is null for something that is not a URL", () => expect(linkSignal("not a url")).toBeNull());

  it("redacts ids", () =>
    expect(redactRoute("/u/3f2c9a1e-8b7d-4c6e-9f00-1a2b3c4d5e6f/p/77/abcdefghijklmnop/ok")).toBe("/u/:id/p/:id/:id/ok"));
});

describe("fingerprints", () => {
  it("sha256 matches node:crypto", () => {
    for (const text of ["", "abc", "TypeError\nfetchOffers", "é✓🚀".repeat(40)]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });

  it("matches the spec vectors", () => {
    expect(errorFingerprint("CartLoadError", ["loadCart", "CartScreen", "renderWithHooks", "commitRoot"])).toBe(
      "0d3722bb489587fd",
    );
    expect(errorFingerprint("TypeError", ["fetchOffers"])).toBe("92321c219d3e65b9");
    expect(errorFingerprint("HTTP_500", [])).toBe("84a5d0525e3659d3");
  });

  it("reads Hermes/V8 and JSC frames without paths, line numbers or the message", () => {
    const v8 = "TypeError: secret\n    at Object.loadCart (/a.js:1:2)\n    at new CartScreen (/a.js:3:4)\n    at /a.js:5:6\n    at x";
    expect(stackFrames(v8)).toEqual(["loadCart", "CartScreen", "?"]);
    expect(stackFrames("loadCart@/a.js:1:2\n@/a.js:3:4\nrender@/a.js:5:6\nmore@/a.js:7:8")).toEqual(["loadCart", "?", "render"]);
  });

  it("names: type only, subclass names, plain objects", () => {
    class CheckoutError extends Error {}
    expect(errorName(new CheckoutError("m"))).toBe("CheckoutError");
    expect(errorName({ name: "HTTP_503" })).toBe("HTTP_503");
    expect(errorName("a string")).toBe("Error");
    expect(errorName({ name: "has spaces and: a message" })).toBe("hasspacesand:amessage");
  });
});

describe("app_error", () => {
  it("chains to the previous global handler, which still runs", async () => {
    const w = makeClient();
    await settle(w);
    const error = errorWithStack("RenderError", ["Offers"]);
    globalHandler(error, false);
    expect(previousCalls).toEqual([[error, false]]);
    await settle(w);
    expect(named("app_error")[0].properties).toMatchObject({ error_kind: "js", fatal: false, error_name: "RenderError" });
    expect(JSON.stringify(captured)).not.toContain("do not send me");
    await w.close();
  });

  it("the previous handler runs even when the SDK's handling throws", async () => {
    const w = makeClient();
    await settle(w);
    const nasty = {
      get name(): string {
        throw new Error("boom");
      },
    };
    expect(() => globalHandler(nasty, true)).not.toThrow();
    expect(previousCalls).toHaveLength(1);
    await w.close();
  });

  it("a handler installed after the SDK is kept; a new client chains to it", async () => {
    const first = makeClient();
    const ours = globalHandler;
    const later: Handler = vi.fn((e, f) => ours(e, f));
    globalHandler = later;
    const second = makeClient();
    globalHandler(new Error("x"), false);
    expect(later).toHaveBeenCalledTimes(1);
    expect(previousCalls).toHaveLength(1);
    await first.close();
    await second.close();
  });

  it("dedupes per fingerprint and caps at 20 per session; error_count keeps the total", async () => {
    const w = makeClient({ captureErrors: false });
    await settle(w);
    w.screen("Checkout");
    for (let i = 0; i < 25; i++) w.trackError(errorWithStack(`E${i}`, ["a"]), { kind: "network" });
    w.trackError(errorWithStack("E0", ["a"]));
    __setAppState("background");
    await settle(w);
    const errors = named("app_error");
    expect(errors).toHaveLength(20);
    expect(errors[0].properties).toMatchObject({
      error_kind: "network",
      fatal: false,
      error_name: "E0",
      screen_name: "Checkout",
      session_id: errors[0].context.session_id,
    });
    expect(errors[0].properties.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(named("app_backgrounded")[0].properties.error_count).toBe(26);
    await w.close();
  });

  it("captureErrors: false leaves the global handler alone; trackError still sends", async () => {
    const before = globalHandler;
    const w = makeClient({ captureErrors: false });
    expect(globalHandler).toBe(before);
    w.trackError(new Error("x"), { screen: "Pay" });
    await settle(w);
    expect(named("app_error")[0].properties).toMatchObject({ error_kind: "handled", screen_name: "Pay" });
    await w.close();
  });

  it("opted out: nothing is sent", async () => {
    const w = makeClient();
    w.optOut();
    w.trackError(new Error("x"));
    await settle(w);
    expect(named("app_error")).toHaveLength(0);
    await w.close();
  });

  it("trackAppLifecycleEvents: false stops automatic capture; trackError still sends", async () => {
    const before = globalHandler;
    const w = makeClient({ trackAppLifecycleEvents: false });
    expect(globalHandler).toBe(before);
    w.trackError(new Error("x"));
    await settle(w);
    expect(types()).toEqual(["app_error"]);
    await w.close();
  });

  it("never touches the Hermes rejection tracker unless asked", async () => {
    const enable = vi.fn();
    (globalThis as { HermesInternal?: unknown }).HermesInternal = { enablePromiseRejectionTracker: enable };
    const w = makeClient();
    expect(enable).not.toHaveBeenCalled();
    await w.close();
  });

  it("captureUnhandledRejections enables the Hermes tracker in release builds only", async () => {
    const enable = vi.fn();
    (globalThis as { HermesInternal?: unknown }).HermesInternal = { enablePromiseRejectionTracker: enable };
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const dev = makeClient({ captureUnhandledRejections: true });
    expect(enable).not.toHaveBeenCalled();
    await dev.close();
    __resetErrorCapture();

    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    const w = makeClient({ captureUnhandledRejections: true });
    expect(enable).toHaveBeenCalledTimes(1);
    await settle(w);
    enable.mock.calls[0]![0].onUnhandled(1, errorWithStack("SyncError", ["sync"]));
    await settle(w);
    expect(named("app_error")[0].properties).toMatchObject({ error_kind: "js", fatal: false, error_name: "SyncError" });
    await w.close();
  });
});

describe("app_crashed", () => {
  it("an unclean shutdown sends app_crashed before the next app_opened", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage, appVersion: "1.4.0" });
    await settle(first);
    first.screen("Checkout");
    const crashedSession = captured[0].context.session_id;
    await first.close(); // ends in the foreground
    captured = [];

    const second = makeClient({ storage, appVersion: "1.4.0" });
    await settle(second);
    expect(types().slice(0, 2)).toEqual(["app_crashed", "app_opened"]);
    expect(named("app_crashed")[0].properties).toMatchObject({
      crash_kind: "abnormal_exit",
      detected_by: "unclean_shutdown",
      crashed_app_version: "1.4.0",
      crashed_session_id: crashedSession,
      crashed_screen_name: "Checkout",
      foreground: true,
    });
    await second.close();
  });

  it("a JS fatal upgrades it to crash / js_fatal", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage });
    await settle(first);
    globalHandler(errorWithStack("CheckoutStateError", ["pay"]), true);
    expect(previousCalls).toHaveLength(1);
    await first.close();
    captured = [];

    const second = makeClient({ storage });
    await settle(second);
    expect(named("app_crashed")[0].properties).toMatchObject({ crash_kind: "crash", detected_by: "js_fatal", foreground: true });
    await second.close();
  });

  it.each(["background", "inactive"] as const)("ending after %s is not a crash", async (state) => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage });
    await settle(first);
    __setAppState(state);
    await settle(first);
    await first.close();
    captured = [];
    AppState.currentState = "active";
    const second = makeClient({ storage });
    await settle(second);
    expect(named("app_crashed")).toHaveLength(0);
    await second.close();
  });

  it("captureErrors: false still reports an unclean shutdown", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage, captureErrors: false });
    await settle(first);
    await first.close();
    captured = [];
    const second = makeClient({ storage, captureErrors: false });
    await settle(second);
    expect(named("app_crashed")[0].properties.detected_by).toBe("unclean_shutdown");
    await second.close();
  });

  it("a fatal error inside the launch window sends the held app_opened first", async () => {
    const w = makeClient({ launchSourceWindowMs: 60_000 });
    await launched(w);
    globalHandler(errorWithStack("BootError", ["boot"]), true);
    await (w as unknown as { drainQueue: () => Promise<void> }).drainQueue();
    expect(types()).toEqual(["app_opened", "app_error"]);
    await w.close();
  });

  it("a debug build never sends app_crashed, and clears the flag", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage });
    await settle(first);
    await first.close();
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    captured = [];
    const second = makeClient({ storage });
    await settle(second);
    expect(named("app_crashed")).toHaveLength(0);
    __setAppState("background");
    await settle(second);
    await second.close();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    const third = makeClient({ storage });
    await settle(third);
    expect(named("app_crashed")).toHaveLength(0);
    await third.close();
  });
});

describe("whisperrNavigationTracker", () => {
  it("sends the focused route once per change, from either ref shape", () => {
    const screen = vi.fn();
    const client = { screen } as unknown as WhisperrClient;
    let route: { name: string } | undefined;
    const direct = whisperrNavigationTracker({ getCurrentRoute: () => route }, { client });
    direct(); // not ready
    route = { name: "Home" };
    direct();
    direct();
    route = { name: "Lesson" };
    direct();
    expect(screen.mock.calls).toEqual([["Home"], ["Lesson"]]);

    const viaCurrent = whisperrNavigationTracker({ current: { getCurrentRoute: () => ({ name: "Cart" }) } }, { client });
    viaCurrent();
    expect(screen).toHaveBeenLastCalledWith("Cart");
  });
});
