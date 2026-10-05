/** A controllable expo-constants fake for tests (aliased in vitest.config.ts). */

export enum ExecutionEnvironment {
  Bare = "bare",
  Standalone = "standalone",
  StoreClient = "storeClient",
}

const Constants = {
  executionEnvironment: ExecutionEnvironment.Standalone as ExecutionEnvironment,
  expoConfig: { extra: { eas: { projectId: "proj-123" } } } as { extra?: Record<string, unknown> } | null,
  easConfig: null as { projectId?: string } | null,
};

export default Constants;
