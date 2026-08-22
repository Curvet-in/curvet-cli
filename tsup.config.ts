import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  // ink is loaded through a dynamic import so the React reconciler is only paid
  // for by people who open the full-screen session. Bundling it would undo that,
  // and it would also be the largest thing in the bundle by far.
  external: ["ink", "react", "react/jsx-runtime"],
  sourcemap: true,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
