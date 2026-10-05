/** A controllable expo-notifications fake for tests (aliased in vitest.config.ts). */

export enum IosAuthorizationStatus {
  NOT_DETERMINED = 0,
  DENIED = 1,
  AUTHORIZED = 2,
  PROVISIONAL = 3,
  EPHEMERAL = 4,
}

export enum AndroidImportance {
  UNKNOWN = 0,
  UNSPECIFIED = 1,
  NONE = 2,
  MIN = 3,
  LOW = 4,
  DEFAULT = 5,
  HIGH = 6,
  MAX = 7,
}

export const DEFAULT_ACTION_IDENTIFIER = "expo.modules.notifications.actions.DEFAULT";

export interface NotificationPermissionsStatus {
  status: "granted" | "denied" | "undetermined";
  granted: boolean;
  canAskAgain: boolean;
  expires: "never";
  ios?: { status: IosAuthorizationStatus };
}
export type IosNotificationPermissionsRequest = Record<string, boolean>;
export interface NotificationResponse {
  actionIdentifier: string;
  notification: { request: { identifier: string; content: { data: Record<string, unknown> } } };
}

type Listener<T> = (value: T) => void;

export const fake = {
  permissions: perm("undetermined"),
  /** What the prompt answers. */
  afterRequest: perm("granted"),
  requestCalls: [] as unknown[],
  channels: [] as Array<{ id: string; config: unknown }>,
  expoToken: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]",
  tokenError: null as Error | null,
  tokenCalls: [] as unknown[],
  lastResponse: null as NotificationResponse | null,
  responseListeners: new Set<Listener<NotificationResponse>>(),
  tokenListeners: new Set<Listener<{ type: string; data: unknown }>>(),
  reset() {
    this.permissions = perm("undetermined");
    this.afterRequest = perm("granted");
    this.requestCalls = [];
    this.channels = [];
    this.expoToken = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
    this.tokenError = null;
    this.tokenCalls = [];
    this.lastResponse = null;
    this.responseListeners.clear();
    this.tokenListeners.clear();
  },
};

/** A permission response; `ios` adds the iOS authorization status. */
export function perm(
  status: "granted" | "denied" | "undetermined",
  opts: { canAskAgain?: boolean; ios?: IosAuthorizationStatus } = {},
): NotificationPermissionsStatus {
  return {
    status,
    granted: status === "granted",
    canAskAgain: opts.canAskAgain ?? status !== "denied",
    expires: "never",
    ...(opts.ios !== undefined ? { ios: { status: opts.ios } } : {}),
  };
}

export async function getPermissionsAsync(): Promise<NotificationPermissionsStatus> {
  return fake.permissions;
}

export async function requestPermissionsAsync(request?: unknown): Promise<NotificationPermissionsStatus> {
  fake.requestCalls.push(request);
  fake.permissions = fake.afterRequest;
  return fake.permissions;
}

export async function setNotificationChannelAsync(id: string, config: unknown): Promise<null> {
  fake.channels.push({ id, config });
  return null;
}

export async function getExpoPushTokenAsync(options?: unknown): Promise<{ type: "expo"; data: string }> {
  fake.tokenCalls.push(options);
  if (fake.tokenError) throw fake.tokenError;
  // Like the native module: a token request also reports the device token.
  for (const l of [...fake.tokenListeners]) l({ type: "ios", data: "device-token-1" });
  return { type: "expo", data: fake.expoToken };
}

export function addPushTokenListener(listener: Listener<{ type: string; data: unknown }>) {
  fake.tokenListeners.add(listener);
  return { remove: () => void fake.tokenListeners.delete(listener) };
}

export async function getLastNotificationResponseAsync(): Promise<NotificationResponse | null> {
  return fake.lastResponse;
}

export function addNotificationResponseReceivedListener(listener: Listener<NotificationResponse>) {
  fake.responseListeners.add(listener);
  return { remove: () => void fake.responseListeners.delete(listener) };
}

/** Test hook: the user taps a notification while the app runs. */
export function __tap(response: NotificationResponse): void {
  for (const l of [...fake.responseListeners]) l(response);
}

/** Test hook: the OS rotates the device token. */
export function __rotateDeviceToken(data: string): void {
  for (const l of [...fake.tokenListeners]) l({ type: "ios", data });
}
