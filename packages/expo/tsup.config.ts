import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * esbuild rewrites `require("expo-router")` in ESM output to its
 * `__require` shim, which Metro cannot see. Restore the literal call (Metro
 * runs every module with a `require` in scope) and fail if it went missing.
 */
function keepOptionalRequire(file: string): void {
  const code = readFileSync(file, "utf8").split('__require("expo-router")').join('require("expo-router")');
  if (!code.includes('require("expo-router")')) throw new Error(`${file}: require("expo-router") is missing`);
  writeFileSync(file, code);
}

const external = [
  "@whisperr/react-native",
  "expo",
  "expo-application",
  "expo-constants",
  "expo-notifications",
  "expo-router",
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
    onSuccess: async () => {
      keepOptionalRequire("dist/index.mjs");
      keepOptionalRequire("dist/index.js");
    },
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
