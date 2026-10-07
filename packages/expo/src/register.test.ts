import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "@whisperr/react-native";
import { __setAppState, __setPlatform } from "../../../test/react-native.js";
import Constants, { ExecutionEnvironment } from "../test/expo-constants.js";
import { __rotateDeviceToken, fake, IosAuthorizationStatus, perm } from "../test/expo-notifications.js";
import { registerForPushNotifications, stopPushNotificationUpdates, toPermissionStatus } from "./register.js";

const EXPO = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

let identifies: any[] = [];
let events: any[] = [];

beforeEach(() => {
  fake.reset();
  identifies = [];
  events = [];
  __setPlatform({ OS: "ios", Version: "18.2" });
  Constants.executionEnvironment = ExecutionEnvironment.Standalone;
  Constants.expoConfig = { extra: { eas: { projectId: "proj-123" } } };
  Constants.easConfig = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/v1/identify")) identifies.push(JSON.parse(init.body));
      if (url.endsWith("/v1/events/batch")) events.push(...JSON.parse(init.body).events);
      return { ok: true, status: 200 } as Response;
    }),
  );
});

afterEach(() => {
  stopPushNotificationUpdates();
  vi.unstubAllGlobals();
});

/** A started client with a known user (the app's Whisperr.init + login). */
async function makeClient(): Promise<WhisperrClient> {
  const client = new WhisperrClient({
    apiKey: "wrk_test",
    flushIntervalMs: 0,
    flushOnAppBackground: false,
    trackAppLifecycleEvents: false,
    maxRetries: 0,
  });
  client.identify("user_1", { traits: { timezone: "Europe/Berlin", locale: "de-DE" } });
  await settle(client);
  return client;
}

async function settle(client: WhisperrClient): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  await client.flush();
}

/** The identify bodies after the first (the test's own identify). */
function reports(): any[] {
  return identifies.slice(1);
}

/** The push_permission_changed events sent, as { status, previous_status? }. */
function permissionEvents(): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.event_type === "push_permission_changed")
    .map(({ properties: { status, previous_status } }) => ({
      status,
      ...(previous_status ? { previous_status } : {}),
    }));
}

describe("registerForPushNotifications", () => {
  it("asks, then sends the permission and the Expo token with kind expo", async () => {
    const client = await makeClient();
    const result = await registerForPushNotifications({ client });
    await settle(client);

    expect(result).toEqual({ status: "granted", token: EXPO });
    expect(fake.requestCalls).toEqual([{ ios: { allowAlert: true, allowBadge: true, allowSound: true } }]);
    expect(fake.tokenCalls).toEqual([{ projectId: "proj-123" }]);
    expect(permissionEvents()).toEqual([{ status: "authorized" }]);
    expect(reports()).toEqual([
      {
        external_user_id: "user_1",
        channels: [{ channel: "push", address: EXPO, opted_in: true, kind: "expo", platform: "ios" }],
      },
    ]);
  });

  it("does not prompt when requestPermission is false", async () => {
    const client = await makeClient();
    const result = await registerForPushNotifications({ client, requestPermission: false });
    await settle(client);
    expect(result).toEqual({ status: "undetermined", token: null, reason: "permission_undetermined" });
    expect(fake.requestCalls).toHaveLength(0);
    expect(fake.tokenCalls).toHaveLength(0);
    expect(permissionEvents()).toEqual([{ status: "not_determined" }]);
    expect(reports()).toEqual([]);
  });

  it("reports a denial and asks for no token", async () => {
    fake.permissions = perm("denied", { canAskAgain: false });
    const client = await makeClient();
    const result = await registerForPushNotifications({ client });
    await settle(client);
    expect(result).toEqual({ status: "denied", token: null, reason: "permission_denied" });
    expect(fake.requestCalls).toHaveLength(0);
    expect(permissionEvents()).toEqual([{ status: "denied" }]);
    expect(reports()).toEqual([]);
  });

  it("creates the Android channel before the prompt (Android 13+)", async () => {
    __setPlatform({ OS: "android", Version: 34, constants: { Release: "14" } });
    const client = await makeClient();
    await registerForPushNotifications({ client });
    expect(fake.channels).toEqual([{ id: "default", config: { name: "Default", importance: 5 } }]);

    fake.channels = [];
    await registerForPushNotifications({ client, androidChannel: false });
    expect(fake.channels).toEqual([]);
  });

  it("returns expo_go_android in Expo Go on Android, without a token request", async () => {
    __setPlatform({ OS: "android", Version: 34, constants: { Release: "14" } });
    Constants.executionEnvironment = ExecutionEnvironment.StoreClient;
    const client = await makeClient();
    const result = await registerForPushNotifications({ client });
    expect(result).toEqual({ status: "granted", token: null, reason: "expo_go_android" });
    expect(fake.tokenCalls).toHaveLength(0);
  });

  it("returns missing_project_id when no EAS project id is known", async () => {
    Constants.expoConfig = { extra: {} };
    const client = await makeClient();
    const result = await registerForPushNotifications({ client });
    expect(result).toEqual({ status: "granted", token: null, reason: "missing_project_id" });

    const explicit = await registerForPushNotifications({ client, projectId: "proj-explicit" });
    expect(explicit.token).toBe(EXPO);
    expect(fake.tokenCalls).toEqual([{ projectId: "proj-explicit" }]);
  });

  it("never throws when the OS gives no token", async () => {
    fake.tokenError = new Error("simulator");
    const client = await makeClient();
    const result = await registerForPushNotifications({ client });
    expect(result).toMatchObject({ status: "granted", token: null, reason: "token_unavailable" });
  });

  it("returns not_initialized without a client", async () => {
    expect(await registerForPushNotifications()).toEqual({
      status: "undetermined",
      token: null,
      reason: "not_initialized",
    });
  });

  it("re-checks the permission on foreground: off in Settings opts the token out, on again re-registers it", async () => {
    const client = await makeClient();
    await registerForPushNotifications({ client });
    await settle(client);
    identifies = identifies.slice(0, 1);

    fake.permissions = perm("denied", { ios: IosAuthorizationStatus.DENIED });
    __setAppState("active");
    await settle(client);
    expect(reports()).toEqual([
      { external_user_id: "user_1", channels: [{ channel: "push", address: EXPO, opted_in: false }] },
    ]);

    identifies = identifies.slice(0, 1);
    fake.permissions = perm("granted", { ios: IosAuthorizationStatus.AUTHORIZED });
    __setAppState("background");
    __setAppState("active");
    await settle(client);
    expect(reports()).toEqual([
      {
        external_user_id: "user_1",
        channels: [{ channel: "push", address: EXPO, opted_in: true, kind: "expo", platform: "ios" }],
      },
    ]);
    expect(permissionEvents()).toEqual([
      { status: "authorized" },
      { status: "denied", previous_status: "authorized" },
      { status: "authorized", previous_status: "denied" },
    ]);
  });

  it("gets a token when the user turns notifications on later", async () => {
    fake.permissions = perm("denied", { canAskAgain: false });
    const client = await makeClient();
    await registerForPushNotifications({ client });
    expect(fake.tokenCalls).toHaveLength(0);

    fake.permissions = perm("granted");
    __setAppState("active");
    await settle(client);
    expect(fake.tokenCalls).toHaveLength(1);
    expect(reports().at(-1)?.channels?.[0]).toMatchObject({ address: EXPO, kind: "expo" });
  });

  it("fetches a new Expo token when the device token rotates", async () => {
    const client = await makeClient();
    await registerForPushNotifications({ client });
    await settle(client);
    expect(fake.tokenCalls).toHaveLength(1); // the request's own device-token event is not a rotation

    fake.expoToken = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
    __rotateDeviceToken("device-token-2");
    await settle(client);
    expect(fake.tokenCalls).toHaveLength(2);
    expect(reports().at(-1)?.channels).toEqual([
      { channel: "push", address: EXPO, opted_in: false },
      {
        channel: "push",
        address: "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]",
        opted_in: true,
        kind: "expo",
        platform: "ios",
      },
    ]);
  });

  it("stops watching on stopPushNotificationUpdates()", async () => {
    const client = await makeClient();
    await registerForPushNotifications({ client });
    stopPushNotificationUpdates();
    fake.permissions = perm("denied");
    __setAppState("active");
    await settle(client);
    expect(permissionEvents().some((e) => e.status === "denied")).toBe(false);
  });
});

describe("toPermissionStatus", () => {
  it("maps iOS authorization states", () => {
    expect(toPermissionStatus(perm("granted", { ios: IosAuthorizationStatus.PROVISIONAL }) as never)).toBe("provisional");
    expect(toPermissionStatus(perm("granted", { ios: IosAuthorizationStatus.EPHEMERAL }) as never)).toBe("granted");
    expect(toPermissionStatus(perm("denied", { ios: IosAuthorizationStatus.DENIED }) as never)).toBe("denied");
    expect(toPermissionStatus(perm("undetermined", { ios: IosAuthorizationStatus.NOT_DETERMINED }) as never)).toBe(
      "undetermined",
    );
  });

  it("maps Android states", () => {
    expect(toPermissionStatus(perm("granted") as never)).toBe("granted");
    expect(toPermissionStatus(perm("denied") as never)).toBe("denied");
    expect(toPermissionStatus(perm("undetermined") as never)).toBe("undetermined");
  });
});
