import { defineConfig } from "tsup";

const external = [
  "@whisperr/react-native",
  "expo",
  "expo-constants",
  "expo-notifications",
  "react",
  "react-native",
  /^expo\//,
];

export default defineConfig([
  // The runtime helpers, loaded by Metro.
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "es2020",
    platform: "neutral",
    external,
  },
  // The config plugin, loaded by Node at prebuild (CommonJS).
  {
    entry: { index: "plugin/src/index.ts" },
    outDir: "plugin/build",
    format: ["cjs"],
    outExtension: () => ({ js: ".js" }),
    dts: true,
    clean: true,
    target: "node18",
    platform: "node",
    external,
  },
]);
