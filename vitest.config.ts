import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // react-native ships Flow-typed sources Node can't parse; tests run
    // against a stub with a controllable AppState.
    alias: {
      "react-native": fileURLToPath(new URL("./test/react-native.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
