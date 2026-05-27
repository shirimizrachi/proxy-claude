import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  sourcemap: false,
  clean: true,
  removeNodeProtocol: false,
  banner: { js: "#!/usr/bin/env node" },
});
