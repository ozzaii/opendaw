import {defineConfig} from "vite"
// THE BUNDLE BRAVOH'S PAGE LOADS, /play/engine.js, a separate file from this public fork: its source link is built in.
export default defineConfig({
  base: "/play/",
  define: {__SOURCE__: JSON.stringify(process.env.PLAY_SOURCE ?? "https://github.com/ozzaii/opendaw")},
  worker: {format: "es"},
  build: {outDir: process.env.PLAY_OUT, emptyOutDir: true, target: "es2022", lib: {entry: "engine.ts", formats: ["es"], fileName: () => "engine.js"}, rollupOptions: {output: {inlineDynamicImports: false}}}
})
