import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __listenerCount, __setAppState } from "../test/react-native.js";
import { WhisperrClient } from "./client.js";
import { MemoryStorage } from "./storage.js";
import type { WhisperrError, WhisperrOptions } from "./types.js";

let captured: Array<{ path: string; body: any }> = [];
let status = 200;
let errors: WhisperrError[] = [];

beforeEach(() => {
  captured = [];
  status = 200;
  errors = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      captured.push({
        path: url.replace("https://api.whisperr.net", ""),
        body: JSON.parse(init.body),
      });
      return { ok: status >= 200 && status < 300, status } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setAppState("active");
});

function makeClient(overrides: Partial<WhisperrOptions> = {}): WhisperrClient {
  return new WhisperrClient({
    apiKey: "wrk_test",
    flushIntervalMs: 0,
    flushOnAppBackground: false,
    maxRetries: 0,
    onError: (e) => errors.push(e),
    ...overrides,
  });
}

function batchCalls() {
  return captured.filter((c) => c.path === "/v1/events/batch");
}
function identifyCalls() {
  return captured.filter((c) => c.path === "/v1/identify");
}

describe("anonymous buffering", () => {
  it("holds pre-identify events and attributes them on identify()", async () => {
    const w = makeClient();
    w.track("app_opened");
    await w.flush();
    expect(batchCalls()).toHaveLength(0); // buffered, not sent
    expect(w.pendingCount).toBe(1);

    w.identify("user_1", { email: "ada@example.com" });
    await w.flush();

    const batch = batchCalls();
    expect(batch).toHaveLength(1);
    expect(batch[0]!.body.events[0].external_user_id).toBe("user_1");
    expect(batch[0]!.body.events[0].event_type).toBe("app_opened");
    expect(identifyCalls()).toHaveLength(1);
    expect(w.pendingCount).toBe(0);
  });
});

describe("persistence", () => {
  it("survives an app restart: queue restores and delivers with a stable $message_id", async () => {
    const storage = new MemoryStorage();

    const first = makeClient({ storage });
    first.identify("user_1");
    await first.flush(); // identify delivers…
    status = 503; // …then the network goes down
    first.track("payment_failed", { amount_cents: 4900 });
    await first.close(); // flush attempt fails; queue persisted
    const attempted = batchCalls();
    expect(attempted.length).toBeGreaterThan(0);
    const originalMessageId = attempted[0]!.body.events[0].context.$message_id;

    captured = [];
    status = 200; // next launch, network is back
    const second = makeClient({ storage });
    await second.flush();

    const delivered = batchCalls();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.body.events[0].event_type).toBe("payment_failed");
    expect(delivered[0]!.body.events[0].context.$message_id).toBe(originalMessageId);
    expect(second.pendingCount).toBe(0);
  });

  it("restores the identified user across launches", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage });
    first.identify("user_1");
    await first.close();

    captured = [];
    const second = makeClient({ storage });
    second.track("app_opened"); // no identify this launch
    await second.flush();

    expect(batchCalls()).toHaveLength(1);
    expect(batchCalls()[0]!.body.events[0].external_user_id).toBe("user_1");
  });

  it("keeps working when the storage adapter throws", async () => {
    const broken = {
      getItem: () => Promise.reject(new Error("disk full")),
      setItem: () => Promise.reject(new Error("disk full")),
      removeItem: () => Promise.reject(new Error("disk full")),
    };
    const w = makeClient({ storage: broken });
    w.identify("user_1");
    w.track("feature_used");
    await w.flush();
    expect(batchCalls()).toHaveLength(1);
  });
});

describe("validation and limits", () => {
  it("drops non-snake_case event types before queueing", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.track("Bad Event");
    w.track("checkout_completed");
    await w.flush();

    expect(errors.some((e) => e.type === "dropped")).toBe(true);
    const events = batchCalls().flatMap((c) => c.body.events);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("checkout_completed");
  });

  it("drops the oldest events on queue overflow", async () => {
    status = 503; // hold everything in the queue
    const w = makeClient({ maxQueueSize: 2 });
    w.identify("user_1");
    await w.flush(); // identify attempt fails and is retained
    captured = [];
    w.track("first_event");
    w.track("second_event"); // overflow: identify op drops out

    expect(w.pendingCount).toBe(2);
    expect(errors.some((e) => e.type === "dropped" && e.message.includes("overflow"))).toBe(true);

    status = 200;
    await w.flush();
    const events = batchCalls().flatMap((c) => c.body.events);
    expect(events.map((e: any) => e.event_type)).toEqual(["first_event", "second_event"]);
  });

  it("attaches library/session context and honors caller context", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.track("feature_used", { source: "test" }, { feature_flag: "beta" });
    await w.flush();

    const ev = batchCalls()[0]!.body.events[0];
    expect(ev.context.library).toEqual({ name: "whisperr-react-native", version: expect.any(String) });
    expect(ev.context.session_id).toMatch(/^sess_/);
    expect(ev.context.os).toBe("ios"); // from the react-native stub
    expect(ev.context.feature_flag).toBe("beta");
    expect(ev.context.$message_id).toBeTruthy();
  });
});

describe("consent", () => {
  it("optOut() clears the queue, persists, and mutes future capture", async () => {
    const storage = new MemoryStorage();
    const w = makeClient({ storage });
    w.identify("user_1");
    w.track("feature_used");
    w.optOut();
    await w.flush();

    expect(captured).toHaveLength(0);
    expect(w.pendingCount).toBe(0);
    expect(w.ready).toBe(false);

    // A later launch stays opted out until optIn().
    const next = makeClient({ storage });
    next.track("feature_used");
    await next.flush();
    expect(captured).toHaveLength(0);

    next.optIn();
    next.identify("user_1");
    next.track("feature_used");
    await next.flush();
    expect(batchCalls()).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("flushes when the app moves to the background", async () => {
    const w = makeClient({ flushOnAppBackground: true });
    w.identify("user_1");
    await w.flush();
    captured = [];
    w.track("feature_used");

    __setAppState("background");
    await vi.waitFor(() => expect(batchCalls()).toHaveLength(1));
    await w.close();
  });

  it("close() flushes, detaches listeners, and makes the client inert", async () => {
    const before = __listenerCount();
    const w = makeClient({ flushOnAppBackground: true });
    expect(__listenerCount()).toBe(before + 1);

    w.identify("user_1");
    w.track("feature_used");
    await w.close();

    expect(batchCalls()).toHaveLength(1);
    expect(__listenerCount()).toBe(before);
    expect(w.ready).toBe(false);

    captured = [];
    w.track("after_close");
    await w.flush();
    expect(captured).toHaveLength(0);
  });

  it("reset() clears identity so later events buffer for the next user", async () => {
    const w = makeClient();
    w.identify("user_1");
    await w.flush();
    captured = [];

    w.reset();
    w.track("app_opened"); // anonymous again
    await w.flush();
    expect(batchCalls()).toHaveLength(0);

    w.identify("user_2");
    await w.flush();
    expect(batchCalls()[0]!.body.events[0].external_user_id).toBe("user_2");
  });

  it("screen() tracks screen_viewed with the screen name", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.screen("Paywall", { plan: "pro" });
    await w.flush();

    const ev = batchCalls()[0]!.body.events[0];
    expect(ev.event_type).toBe("screen_viewed");
    expect(ev.properties).toEqual({ name: "Paywall", plan: "pro" });
  });
});
