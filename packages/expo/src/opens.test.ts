import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "@whisperr/react-native";
import { AppState } from "../../../test/react-native.js";
import {
  __receive,
  __tap,
  DEFAULT_ACTION_IDENTIFIER,
  fake,
  type NotificationResponse,
} from "../test/expo-notifications.js";
import {
  __resetHandledNotifications,
  deepLinkToHref,
  subscribeToWhisperrNotificationOpens,
  subscribeToWhisperrNotificationReceipts,
  type WhisperrNotificationOpen,
} from "./opens.js";

let events: any[] = [];

beforeEach(() => {
  fake.reset();
  __resetHandledNotifications();
  events = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/v1/events/batch")) events.push(...JSON.parse(init.body).events);
      return { ok: true, status: 200 } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  AppState.currentState = "active";
});

function makeClient(): WhisperrClient {
  const client = new WhisperrClient({
    apiKey: "wrk_test",
    flushIntervalMs: 0,
    flushOnAppBackground: false,
    trackAppLifecycleEvents: false,
    maxRetries: 0,
  });
  client.identify("user_1");
  return client;
}

function response(id: string, data: Record<string, unknown>, action = DEFAULT_ACTION_IDENTIFIER): NotificationResponse {
  return { actionIdentifier: action, notification: { request: { identifier: id, content: { data } } } };
}

async function settle(client: WhisperrClient): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  await client.flush();
}

function pushOpens(): any[] {
  return events.filter((e) => e.event_type === "push_opened");
}

describe("subscribeToWhisperrNotificationOpens", () => {
  it("handles the tap that launched the app (cold start)", async () => {
    fake.lastResponse = response("n1", { whisperr_message_id: "msg_1", whisperr_deep_link: "myapp://offers/annual" });
    const client = makeClient();
    const opens: WhisperrNotificationOpen[] = [];
    const stop = subscribeToWhisperrNotificationOpens((o) => opens.push(o), { client });
    await settle(client);

    expect(opens.map(({ messageId, deepLink }) => ({ messageId, deepLink }))).toEqual([
      { messageId: "msg_1", deepLink: "myapp://offers/annual" },
    ]);
    expect(opens[0]?.response.notification.request.identifier).toBe("n1");
    expect(pushOpens()).toHaveLength(1);
    expect(pushOpens()[0].properties).toMatchObject({
      whisperr_message_id: "msg_1",
      deep_link: "myapp://offers/annual",
    });
    stop();
  });

  it("handles taps while running, once per notification, and ignores other pushes", async () => {
    const client = makeClient();
    const opens: WhisperrNotificationOpen[] = [];
    const stop = subscribeToWhisperrNotificationOpens((o) => opens.push(o), { client });
    await settle(client);

    __tap(response("n2", { whisperr_message_id: "msg_2" }));
    __tap(response("n2", { whisperr_message_id: "msg_2" }));
    __tap(response("n3", { campaign: "other-provider" }));
    __tap(response("n4", { whisperr_message_id: "msg_4" }, "com.apple.UNNotificationDismissActionIdentifier"));
    await settle(client);

    expect(opens.map((o) => o.messageId)).toEqual(["msg_2"]);
    expect(pushOpens().map((e) => e.properties.whisperr_message_id)).toEqual(["msg_2"]);
    stop();
  });

  it("does not route the same cold-start tap twice when the hook remounts", async () => {
    fake.lastResponse = response("n1", { whisperr_message_id: "msg_1" });
    const client = makeClient();
    const opens: string[] = [];
    subscribeToWhisperrNotificationOpens((o) => opens.push(o.messageId), { client })();
    await settle(client);
    subscribeToWhisperrNotificationOpens((o) => opens.push(o.messageId), { client });
    await settle(client);
    expect(opens).toEqual(["msg_1"]);
  });

  it("still returns the deep link without a client", async () => {
    const opens: WhisperrNotificationOpen[] = [];
    const stop = subscribeToWhisperrNotificationOpens((o) => opens.push(o), { client: null });
    __tap(response("n5", { whisperr_message_id: "msg_5", deep_link: "/offers" }));
    expect(opens.map((o) => o.deepLink)).toEqual(["/offers"]);
    stop();
  });

  it("stops listening after unsubscribe", async () => {
    const client = makeClient();
    const opens: string[] = [];
    subscribeToWhisperrNotificationOpens((o) => opens.push(o.messageId), { client })();
    __tap(response("n6", { whisperr_message_id: "msg_6" }));
    expect(opens).toEqual([]);
  });
});

describe("push contract v2: action_id, cold_start, and the stale cold-start response", () => {
  it("the launch tap is a cold start with the default action; it is cleared after handling", async () => {
    fake.lastResponse = response("n1", { whisperr_message_id: "msg_1" });
    const client = makeClient();
    const stop = subscribeToWhisperrNotificationOpens(() => {}, { client });
    await settle(client);
    expect(pushOpens()[0].properties).toMatchObject({ action_id: "default", cold_start: true });
    expect(fake.clearCalls).toBe(1);
    expect(fake.lastResponse).toBeNull();
    stop();
  });

  it("a tap while running is not a cold start; a button tap sends its action id", async () => {
    const client = makeClient();
    const opens: WhisperrNotificationOpen[] = [];
    const stop = subscribeToWhisperrNotificationOpens((o) => opens.push(o), { client });
    await settle(client);
    __tap(response("n2", { whisperr_message_id: "msg_2" }, "claim_offer"));
    await settle(client);
    expect(pushOpens()[0].properties).toMatchObject({ action_id: "claim_offer", cold_start: false });
    expect(opens[0]?.actionId).toBe("claim_offer");
    stop();
  });

  it("does not clear another provider's response, or when clearLastResponse is false", async () => {
    fake.lastResponse = response("n3", { campaign: "other-provider" });
    const client = makeClient();
    subscribeToWhisperrNotificationOpens(() => {}, { client })();
    await settle(client);
    expect(fake.clearCalls).toBe(0);

    __resetHandledNotifications();
    fake.lastResponse = response("n4", { whisperr_message_id: "msg_4" });
    subscribeToWhisperrNotificationOpens(() => {}, { client, clearLastResponse: false })();
    await settle(client);
    expect(fake.clearCalls).toBe(0);
  });

  it("routes one message once, also when it arrives under two notification ids", async () => {
    const client = makeClient();
    const opens: string[] = [];
    const stop = subscribeToWhisperrNotificationOpens((o) => opens.push(o.messageId), { client });
    await settle(client);
    __tap(response("n5", { whisperr_message_id: "msg_5" }));
    __tap(response("n5-copy", { whisperr_message_id: "msg_5" }));
    await settle(client);
    expect(opens).toEqual(["msg_5"]);
    stop();
  });
});

describe("subscribeToWhisperrNotificationReceipts", () => {
  function notification(id: string, data: Record<string, unknown>) {
    return { request: { identifier: id, content: { data } } };
  }

  it("sends push_received once per Whisperr message that arrives in the foreground", async () => {
    // push_received is an automatic event: it needs the automatic events on.
    const client = new WhisperrClient({
      apiKey: "wrk_test",
      flushIntervalMs: 0,
      flushOnAppBackground: false,
      maxRetries: 0,
    });
    client.identify("user_1");
    const stop = subscribeToWhisperrNotificationReceipts({ client });
    __receive(notification("n1", { whisperr_message_id: "msg_1" }));
    __receive(notification("n1", { whisperr_message_id: "msg_1" }));
    __receive(notification("n2", { campaign: "other-provider" }));
    AppState.currentState = "background";
    __receive(notification("n3", { whisperr_message_id: "msg_3" }));
    await settle(client);
    const received = events.filter((e) => e.event_type === "push_received");
    expect(received.map((e) => e.properties)).toEqual([
      expect.objectContaining({ whisperr_message_id: "msg_1", foreground: true, source: "foreground" }),
    ]);
    stop();
    AppState.currentState = "active";
    __receive(notification("n4", { whisperr_message_id: "msg_4" }));
    await settle(client);
    expect(events.filter((e) => e.event_type === "push_received")).toHaveLength(1);
  });

  it("sends nothing while the automatic events are off", async () => {
    const client = makeClient(); // trackAppLifecycleEvents: false
    const stop = subscribeToWhisperrNotificationReceipts({ client });
    __receive(notification("n1", { whisperr_message_id: "msg_1" }));
    await settle(client);
    expect(events.filter((e) => e.event_type === "push_received")).toEqual([]);
    stop();
  });
});

describe("deepLinkToHref", () => {
  it("turns custom-scheme and web links into router paths", () => {
    expect(deepLinkToHref("myapp://offers/annual?plan=pro#top")).toBe("/offers/annual?plan=pro#top");
    expect(deepLinkToHref("myapp://home")).toBe("/home");
    expect(deepLinkToHref("myapp://")).toBe("/");
    expect(deepLinkToHref("https://example.com/offers/annual?x=1")).toBe("/offers/annual?x=1");
    expect(deepLinkToHref("https://example.com")).toBe("/");
    expect(deepLinkToHref("/settings")).toBe("/settings");
  });

  it("accepts only the app's scheme when given", () => {
    expect(deepLinkToHref("myapp://offers", "myapp")).toBe("/offers");
    expect(deepLinkToHref("other://offers", "myapp")).toBeNull();
    expect(deepLinkToHref("https://evil.example/x", "myapp")).toBeNull();
  });

  it("rejects what is not a link", () => {
    expect(deepLinkToHref("")).toBeNull();
    expect(deepLinkToHref("offers/annual")).toBeNull();
    expect(deepLinkToHref("javascript:alert(1)")).toBeNull();
  });
});
