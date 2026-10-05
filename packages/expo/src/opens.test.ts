import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "@whisperr/react-native";
import { __tap, DEFAULT_ACTION_IDENTIFIER, fake, type NotificationResponse } from "../test/expo-notifications.js";
import {
  __resetHandledNotifications,
  deepLinkToHref,
  subscribeToWhisperrNotificationOpens,
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

afterEach(() => vi.unstubAllGlobals());

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
