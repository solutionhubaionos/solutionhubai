// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  vite: {
    optimizeDeps: {
      // @napi-rs/canvas is a native Node addon used only by the server-side chart
      // rasteriser (src/lib/documents/chart-image.ts). The client dependency scanner
      // still follows the server-fn dynamic imports, and pre-bundling it fails on the
      // .node binary, which leaves every optimized-dep request hanging and the page
      // never hydrating.
      exclude: [
        "@napi-rs/canvas",
        "@napi-rs/canvas-linux-x64-gnu",
        "@napi-rs/canvas-linux-x64-musl",
        "@napi-rs/canvas-linux-arm64-gnu",
        "@napi-rs/canvas-linux-arm64-musl",
        "@napi-rs/canvas-darwin-arm64",
        "@napi-rs/canvas-darwin-x64",
        "@napi-rs/canvas-win32-x64-msvc",
      ],
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
