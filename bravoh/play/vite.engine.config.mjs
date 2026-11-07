import {defineConfig} from "vite"
// THE BUNDLE BRAVOH'S PAGE LOADS, /play/engine.js, a separate file from this public fork: its source link is built in.
// Not vite's lib mode: that inlines the engine's worklet and wasm as data: URLs, and they do not start from there.
export default defineConfig({
  base: "/play/",
  define: {__SOURCE__: JSON.stringify(process.env.PLAY_SOURCE ?? "https://github.com/ozzaii/opendaw")},
  worker: {format: "es"},
  build: {outDir: process.env.PLAY_OUT, emptyOutDir: true, target: "es2022", assetsInlineLimit: 0, rollupOptions: {
    input: {engine: "engine.ts"}, preserveEntrySignatures: "strict", output: {entryFileNames: "[name].js"}}}
})
