/* bundles tests/selfcheck.ts so it can run under plain node (the app's own
   tools/preview have no node-ts pipeline; vite is already a dependency). */
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    outDir: "dist-selfcheck",
    emptyOutDir: true,
    minify: false,
    lib: {
      formats: ["es"],
      entry: "tests/selfcheck.ts",
      fileName: () => "selfcheck.js",
    },
  },
});