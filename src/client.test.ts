import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __listenerCount, __setAppState } from "../test/react-native.js";
import { WhisperrClient } from "./client.js";
import { MemoryStorage } from "./storage.js";
import type { WhisperrError, WhisperrOptions } from "./types.js";

// Device-derived trait defaults (timezone / locale) are environment-dependent,
// so the spec fixtures never pin them (SPEC.md → Reserved trait keys): run with
// them disabled so every identify body is exactly what the scenario supplied.
// device.test.ts covers the defaults themselves.
vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({}),
}));

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
    trackAppLifecycleEvents: false, // lifecycle.test.ts covers automatic events
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

describe("anonymous lane", () => {
  it("sends pre-identify events under anonymous_id and promotes the handle on identify()", async () => {
    const w = makeClient();
    w.track("pricing_viewed");
    await w.flush();

    const anon = batchCalls()[0]!.body.events[0];
    expect(anon.external_user_id).toBeUndefined();
    expect(anon.anonymous_id).toMatch(/^[0-9a-f-]{36}$/); // a bare UUID v4
    expect(w.pendingCount).toBe(0);

    w.identify("user_1", { email: "ada@example.com" });
    await w.flush();
    expect(identifyCalls()[0]!.body.anonymous_id).toBe(anon.anonymous_id);

    // Promotion is claimed once: a later identify does not repeat the handle.
    w.identify("user_1", { traits: { plan: "pro" } });
    await w.flush();
    expect(identifyCalls()[1]!.body.anonymous_id).toBeUndefined();
  });

  it("identify() without earlier anonymous events promotes nothing", async () => {
    const w = makeClient();
    w.identify("user_1");
    await w.flush();
    expect(identifyCalls()[0]!.body).toEqual({ external_user_id: "user_1" });
  });

  it("events still queued at identify() go out under the user", async () => {
    status = 503; // hold the anonymous event in the queue
    const w = makeClient();
    w.track("pricing_viewed");
    await w.flush();
    status = 200;
    captured = [];

    w.identify("user_1");
    await w.flush();
    const ev = batchCalls()[0]!.body.events[0];
    expect(ev.external_user_id).toBe("user_1");
    expect(ev.anonymous_id).toBeUndefined();
    // The anonymous attempt was sent before identify, so the identify promotes it.
    expect(identifyCalls()[0]!.body.anonymous_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("promotes a handle used in an earlier launch when identify() runs before init resolves", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage });
    first.track("pricing_viewed");
    await first.close();
    const anonId = batchCalls()[0]!.body.events[0].anonymous_id;

    captured = [];
    const second = makeClient({ storage });
    second.identify("user_1"); // same tick as construction
    await second.flush();
    expect(identifyCalls()[0]!.body.anonymous_id).toBe(anonId);
  });

  it("keeps a pre-0.3 'anon_' handle and stamps restored pre-identify events with it", async () => {
    const storage = new MemoryStorage();
    storage.setItem("whisperr.anon_id", "anon_legacy-handle");
    storage.setItem(
      "whisperr.queue.v1",
      JSON.stringify([
        {
          kind: "track",
          eventType: "onboarding_started",
          externalUserId: null,
          occurredAt: new Date().toISOString(),
          messageId: "m1",
        },
      ]),
    );
    const w = makeClient({ storage });
    await w.flush();
    expect(batchCalls()[0]!.body.events[0]).toMatchObject({
      anonymous_id: "anon_legacy-handle",
      event_type: "onboarding_started",
    });
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

describe("channel shortcuts", () => {
  it("email shortcut claims neither consent nor verification", async () => {
    const w = makeClient();
    w.identify("user_1", { email: "ada@example.com", phone: "+15551234567" });
    await w.flush();
    expect(identifyCalls()[0]!.body.channels).toEqual([
      { channel: "email", address: "ada@example.com" },
      { channel: "sms", address: "+15551234567", opted_in: true },
    ]);
  });

  it("explicit channels keep the caller's consent and verification", async () => {
    const w = makeClient();
    w.identify("user_1", {
      channels: [{ type: "email", address: "ada@example.com", optedIn: true, verified: true }],
    });
    await w.flush();
    expect(identifyCalls()[0]!.body.channels).toEqual([
      { channel: "email", address: "ada@example.com", opted_in: true, verified: true },
    ]);
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

  it("optOut() also stops screen and push-open capture", async () => {
    const w = makeClient();
    w.identify("user_1");
    await w.flush();
    captured = [];
    w.optOut();
    w.screen("Paywall");
    w.trackPushOpened({ whisperr_message_id: "msg_1" });
    await w.flush();
    expect(captured).toHaveLength(0);
  });

  it("optIn() cannot switch on a client built with disabled: true", async () => {
    const w = makeClient({ disabled: true });
    w.optIn();
    w.identify("user_1");
    w.track("feature_used");
    await w.flush();
    expect(captured).toHaveLength(0);
    expect(w.ready).toBe(false);
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

  it("reset() rotates the anonymous handle so the next person starts fresh", async () => {
    const w = makeClient();
    w.track("pricing_viewed");
    await w.flush();
    const first = batchCalls()[0]!.body.events[0].anonymous_id;
    w.identify("user_1");
    await w.flush();
    captured = [];

    w.reset();
    w.track("pricing_viewed"); // anonymous again, under a new handle
    await w.flush();
    const second = batchCalls()[0]!.body.events[0];
    expect(second.external_user_id).toBeUndefined();
    expect(second.anonymous_id).toBeTruthy();
    expect(second.anonymous_id).not.toBe(first);

    w.identify("user_2");
    await w.flush();
    expect(identifyCalls()[0]!.body).toEqual({ external_user_id: "user_2", anonymous_id: second.anonymous_id });
  });

  it("reset() keeps an earlier visitor's queued events off the next user", async () => {
    status = 503;
    const w = makeClient();
    w.track("pricing_viewed"); // visitor A, held in the queue
    await w.flush();
    const handleA = batchCalls()[0]!.body.events[0].anonymous_id;
    w.reset();
    w.identify("user_2"); // visitor B logs in
    status = 200;
    captured = [];
    await w.flush();

    const ev = batchCalls()[0]!.body.events[0];
    expect(ev.anonymous_id).toBe(handleA);
    expect(ev.external_user_id).toBeUndefined();
  });

  it("reset() clears the persisted last-sent push token so the next login re-sends it", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage });
    first.identify("user_1");
    first.setPushToken("fcm_tok_a");
    await first.flush();
    first.reset(); // logout — must also clear the persisted (user, token) pair
    await first.close();

    captured = [];
    const second = makeClient({ storage });
    await second.flush(); // let init settle (nothing persisted to restore)
    second.identify("user_1");
    second.setPushToken("fcm_tok_a"); // same user+token — must SEND, not dedupe
    await second.flush();

    expect(identifyCalls().map((c) => c.body)).toEqual([
      { external_user_id: "user_1" },
      {
        external_user_id: "user_1",
        channels: [{ channel: "push", address: "fcm_tok_a", opted_in: true }],
      },
    ]);
  });

  it("screen() tracks screen_viewed with the screen name and the common properties", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.screen("Paywall", { plan: "pro" });
    w.screen("   "); // no name — not queued
    await w.flush();

    const events = batchCalls().flatMap((c) => c.body.events);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("screen_viewed");
    expect(events[0].properties).toMatchObject({
      screen_name: "Paywall",
      plan: "pro",
      platform: "ios",
      sdk_name: "whisperr-react-native",
    });
  });
});

describe("push dedupe marks on delivery, not enqueue", () => {
  it("re-sends a token whose registration was dropped (4xx) instead of wedging it", async () => {
    const w = makeClient();
    w.identify("user_1");
    await w.flush();
    captured = [];

    status = 400; // registration rejected — non-retryable
    w.setPushToken("fcm_tok_a");
    await w.flush();
    expect(identifyCalls()).toHaveLength(1); // attempted…
    expect(errors.some((e) => e.type === "dropped")).toBe(true); // …then dropped

    captured = [];
    status = 200; // FCM re-delivers the same token on the next launch/refresh
    w.setPushToken("fcm_tok_a");
    await w.flush();

    // Not a no-op: the dropped registration cleared the mark, so it re-sends.
    expect(identifyCalls().map((c) => c.body)).toEqual([
      {
        external_user_id: "user_1",
        channels: [{ channel: "push", address: "fcm_tok_a", opted_in: true }],
      },
    ]);
  });

  it("clears the mark when a registration is evicted on queue overflow", async () => {
    const w = makeClient({ maxQueueSize: 1 });
    w.identify("user_1");
    await w.flush(); // delivered, queue empty
    captured = [];

    status = 503; // hold everything in the queue
    w.setPushToken("fcm_tok_a"); // registration enqueued (queue size 1)
    w.track("feature_used"); // overflow: the registration op is evicted
    await w.flush();
    expect(errors.some((e) => e.type === "dropped" && e.message.includes("overflow"))).toBe(true);

    captured = [];
    status = 200;
    w.setPushToken("fcm_tok_a"); // same token — must re-send, the mark was cleared
    await w.flush();
    expect(
      identifyCalls().some(
        (c) =>
          JSON.stringify(c.body.channels) ===
          JSON.stringify([{ channel: "push", address: "fcm_tok_a", opted_in: true }]),
      ),
    ).toBe(true);
  });
});
