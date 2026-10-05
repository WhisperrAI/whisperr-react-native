import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

/** Optional peers the SDK reads the app version from (src/app-info.ts). */
const OPTIONAL_PEERS = ["expo-application", "react-native-device-info"];

/**
 * esbuild rewrites `require("x")` in ESM output to its `__require("x")` shim.
 * Metro only bundles dependencies it sees as literal `require("x")` calls, so
 * under Metro the shim would never find the optional peers. Restore the
 * literal calls (Metro runs every module with a `require` in scope) and fail
 * the build if a peer call went missing.
 */
function keepOptionalRequires(file: string): void {
  let code = readFileSync(file, "utf8");
  for (const peer of OPTIONAL_PEERS) {
    code = code.split(`__require("${peer}")`).join(`require("${peer}")`);
    if (!code.includes(`require("${peer}")`)) {
      throw new Error(`${file}: optional peer require("${peer}") is missing from the build`);
    }
  }
  writeFileSync(file, code);
}

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  minify: false, // Metro minifies app bundles; keep the published source debuggable
  sourcemap: true,
  target: "es2020",
  platform: "neutral",
  external: ["react", "react-native", ...OPTIONAL_PEERS],
  onSuccess: async () => {
    keepOptionalRequires("dist/index.js");
    keepOptionalRequires("dist/index.cjs");
  },
});
