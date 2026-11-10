import {defineConfig} from "vite"
// Built into the local store's static folder (served with COOP/COEP at /booth/): a measuring page, not the product.
export default defineConfig({base: "/booth/", build: {outDir: process.env.PLAY_OUT, emptyOutDir: true, target: "es2022"}, worker: {format: "es"}})
