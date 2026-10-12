/** A controllable expo-application fake for tests (aliased in vitest.config.ts). */

export type PushNotificationServiceEnvironment = "development" | "production" | null;

export const fakeApplication = {
  applicationId: "com.example.app" as string | null,
  pushEnvironment: "development" as PushNotificationServiceEnvironment,
  pushEnvironmentError: null as Error | null,
  reset() {
    this.applicationId = "com.example.app";
    this.pushEnvironment = "development";
    this.pushEnvironmentError = null;
  },
};

// A live binding, like the native constant.
export let applicationId: string | null = fakeApplication.applicationId;

/** Test hook: set what `applicationId` reports. */
export function __setApplicationId(id: string | null): void {
  fakeApplication.applicationId = id;
  applicationId = id;
}

export async function getIosPushNotificationServiceEnvironmentAsync(): Promise<PushNotificationServiceEnvironment> {
  if (fakeApplication.pushEnvironmentError) throw fakeApplication.pushEnvironmentError;
  return fakeApplication.pushEnvironment;
}
