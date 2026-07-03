import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  minify: false, // Metro minifies app bundles; keep the published source debuggable
  sourcemap: true,
  target: "es2020",
  platform: "neutral",
  external: ["react", "react-native"],
});
