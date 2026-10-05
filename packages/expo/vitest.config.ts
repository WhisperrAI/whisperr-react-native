import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // The core SDK from this repo, and its react-native stub.
      "@whisperr/react-native": root("../../src/index.ts"),
      "react-native": root("../../test/react-native.ts"),
      // Native modules: controllable fakes.
      "expo-notifications": root("./test/expo-notifications.ts"),
      "expo-constants": root("./test/expo-constants.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "plugin/src/**/*.test.ts"],
  },
});
