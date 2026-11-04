import {defineConfig} from "vite"
// built into the engine's static folder; the engine serves it with COOP/COEP at /booth/
export default defineConfig({base: "/booth/", build: {outDir: "../engine/dist/booth", emptyOutDir: true, target: "es2022"}, worker: {format: "es"}})
