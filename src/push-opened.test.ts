import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPushOpened } from "./autocapture.js";
import { WhisperrClient } from "./client.js";
import { MemoryStorage } from "./storage.js";
import type { WhisperrOptions, WhisperrStorage } from "./types.js";

let captured: Array<{ path: string; body: any }> = [];

beforeEach(() => {
  captured = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      captured.push({ path: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
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

/** trackPushOpened defers to init; give it a tick, then deliver. */
async function settle(w: WhisperrClient): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await w.flush();
}

function pushOpens(): any[] {
  return captured
    .filter((c) => c.path === "/v1/events/batch")
    .flatMap((c) => c.body.events)
    .filter((e: any) => e.event_type === "push_opened");
}

describe("extractPushOpened", () => {
  it("reads the data map itself", () => {
    expect(extractPushOpened({ whisperr_message_id: "msg_1", deep_link: "app://offer" })).toEqual({
      messageId: "msg_1",
      deepLink: "app://offer",
    });
  });

  it("reads a Firebase RemoteMessage (.data)", () => {
    expect(extractPushOpened({ messageId: "fcm-1", data: { whisperr_message_id: "msg_2" } })).toEqual({
      messageId: "msg_2",
    });
  });

  it("reads an expo-notifications response (content.data, or the native trigger payload)", () => {
    const response = (data: object, trigger: object = {}) => ({
      actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
      notification: { request: { content: { data }, trigger } },
    });
    expect(extractPushOpened(response({ whisperr_message_id: "msg_3" }))?.messageId).toBe("msg_3");
    expect(extractPushOpened(response({}, { payload: { whisperr_message_id: "msg_4" } }))?.messageId).toBe("msg_4");
    expect(
      extractPushOpened(response({}, { remoteMessage: { data: { whisperr_message_id: "msg_5" } } }))?.messageId,
    ).toBe("msg_5");
  });

  it("reads a OneSignal notification (.additionalData)", () => {
    expect(extractPushOpened({ additionalData: { whisperr_message_id: "msg_6" } })?.messageId).toBe("msg_6");
  });

  it("ignores pushes that did not come from Whisperr", () => {
    expect(extractPushOpened({ data: { campaign: "x" } })).toBeUndefined();
    expect(extractPushOpened({ whisperr_message_id: "  " })).toBeUndefined();
    expect(extractPushOpened(null)).toBeUndefined();
    expect(extractPushOpened("msg_1")).toBeUndefined();
  });
});

describe("trackPushOpened", () => {
  it("sends push_opened with the message id and deep link", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.trackPushOpened({ data: { whisperr_message_id: "msg_1", deep_link: "app://offer" } });
    await settle(w);

    const opens = pushOpens();
    expect(opens).toHaveLength(1);
    expect(opens[0].external_user_id).toBe("user_1");
    expect(opens[0].properties).toEqual({ whisperr_message_id: "msg_1", deep_link: "app://offer" });
  });

  it("reports each message once per launch (cold-start getter + listener)", async () => {
    const w = makeClient();
    w.identify("user_1");
    w.trackPushOpened({ whisperr_message_id: "msg_1" });
    w.trackPushOpened({ whisperr_message_id: "msg_1" });
    await settle(w);
    w.trackPushOpened({ whisperr_message_id: "msg_1" });
    await settle(w);
    expect(pushOpens()).toHaveLength(1);
  });

  it("does not re-report a message after a restart", async () => {
    const storage = new MemoryStorage();
    const first = makeClient({ storage });
    first.identify("user_1");
    first.trackPushOpened({ whisperr_message_id: "msg_1" });
    await settle(first);
    await first.close();

    const second = makeClient({ storage });
    // getLastNotificationResponseAsync() answers the same tap again on this launch.
    second.trackPushOpened({ whisperr_message_id: "msg_1" });
    second.trackPushOpened({ whisperr_message_id: "msg_2" });
    await settle(second);
    expect(pushOpens().map((e) => e.properties.whisperr_message_id)).toEqual(["msg_1", "msg_2"]);
    await second.close();
  });

  it("before identify(), the open is sent under the anonymous handle", async () => {
    const w = makeClient();
    w.trackPushOpened({ whisperr_message_id: "msg_1" });
    await settle(w);
    expect(pushOpens()[0].anonymous_id).toBeTruthy();
    expect(pushOpens()[0].external_user_id).toBeUndefined();
  });

  it("marks the id as reported only after the event is in the durable queue", async () => {
    const writes: string[] = [];
    const inner = new MemoryStorage();
    const storage: WhisperrStorage = {
      getItem: (k) => inner.getItem(k),
      removeItem: (k) => inner.removeItem(k),
      setItem: (k, v) => {
        if (k === "whisperr.queue.v1" && v.includes("push_opened")) writes.push("queue");
        if (k === "whisperr.push_opened") writes.push("id");
        inner.setItem(k, v);
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as Response)); // keep it queued
    const w = makeClient({ storage });
    w.identify("user_1");
    w.trackPushOpened({ whisperr_message_id: "msg_1" });
    await settle(w);
    await w.close();

    expect(writes[0]).toBe("queue");
    expect(writes).toContain("id");
  });
});
