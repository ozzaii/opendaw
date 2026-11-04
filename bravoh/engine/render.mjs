// Offline render in plain Node: the npm dist's own WASM boot (core-wasm's test path), one engine per render from
// modules compiled once. Bit-identical to the browser's OfflineEngineRenderer (wavdiff, 25 s, max diff 0).
import {readFileSync} from "node:fs"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {instantiateWasmEngine, drainResourceRequests} from "./node_modules/@opendaw/studio-core-wasm/dist/boot.js"
import {DEVICES, COMPOSITES, EFFECT_COMPOSITES, createEngineMemory} from "./node_modules/@opendaw/studio-core-wasm/dist/engine-modules.js"
import {serializeUpdateTasks} from "./node_modules/@opendaw/studio-core-wasm/dist/sync/serialize-update-tasks.js"
import {settleCompensation} from "./node_modules/@opendaw/studio-core-wasm/dist/engine-exports.js"
const QUANTUM = 128
// runaway guard: a render ends here whatever the song says (a 999-bar song, a stuck loop)
const MAX_SECONDS = 15 * 60
const dist = process.env.OPENDAW_WASM_DIST ?? join(dirname(createRequire(import.meta.url).resolve("./node_modules/@opendaw/studio-core-wasm/dist/boot.js")))
let compiled
const modules = async () => compiled ??= {
  engineModule: await WebAssembly.compile(readFileSync(join(dist, "wasm/engine.wasm"))),
  deviceModules: await Promise.all(DEVICES.map(device => WebAssembly.compile(readFileSync(join(dist, device.url.slice(1)))))),
  deviceBoxTypes: DEVICES.map(device => device.boxType), composites: COMPOSITES, effectComposites: EFFECT_COMPOSITES
}
const fieldOf = (box, name) => box[name]?.getValue?.()
// [from, to) in pulses: the loop area when it is on (a phrase), else the song to the end of its last region.
export const spanOf = graph => {
  const timeline = graph.boxes().find(box => box.name === "TimelineBox")
  const loop = timeline?.loopArea
  if (loop?.enabled.getValue() && loop.to.getValue() > loop.from.getValue()) return {from: loop.from.getValue(), to: loop.to.getValue()}
  const end = graph.boxes().filter(box => box.name.endsWith("RegionBox"))
    .reduce((last, box) => Math.max(last, (fieldOf(box, "position") ?? 0) + (fieldOf(box, "duration") ?? 0)), 0)
  return {from: 0, to: end}
}
// samples: (uuidBytes) => Promise<AudioData>; a failed one plays as silence in the engine, so it is reported.
export const render = async (bytes, {sampleRate = 48000, samples}) => {
  const {boxGraph} = ProjectSkeleton.decode(bytes)
  const {from, to} = spanOf(boxGraph)
  if (to <= from) throw new Error("The song has no regions to render.")
  const failed = []
  const memory = createEngineMemory()
  globalThis.sampleRate = sampleRate
  const client = new Proxy({}, {get: (_target, key) =>
    key === "fetchAudio" ? uuid => samples(uuid)
      : key === "log" ? message => {if (String(message).includes("load failed")) failed.push(String(message))}
        : key === "fetchSoundfont" || key === "fetchWclapBundle" || key === "fetchNamWasm" ? () => Promise.reject(new Error("not on this engine yet"))
          : () => {}})
  const {engine} = instantiateWasmEngine(await modules(), memory, sampleRate, client)
  const tasks = new Uint8Array(serializeUpdateTasks(boxGraph.boxes().map(box => ({type: "new", name: box.name, uuid: box.address.uuid, buffer: box.toArrayBuffer()}))))
  new Uint8Array(memory.buffer, engine.input_reserve(tasks.length), tasks.length).set(tasks)
  if (engine.apply_updates(tasks.length) !== 0) throw new Error("The engine refused the song.")
  if (engine.bind() !== 0) throw new Error("The engine could not bind the song.")
  const pending = new Set()
  const drain = () => drainResourceRequests(engine, memory, client, pending, sampleRate, error => failed.push(String(error)))
  drain()
  while (pending.size > 0) {await Promise.all([...pending]); drain()}
  engine.set_metronome_enabled(0)
  engine.set_position(from)
  settleCompensation(engine, sampleRate, from, true, () => engine.render())
  engine.play()
  // big-endian, as openDAW's own offline worker reads it (core-wasm offline-worker.ts EngineStateSchema writer)
  const state = () => new DataView(memory.buffer, engine.engine_state_ptr(), engine.engine_state_len()).getFloat32(0)
  const left = [], right = []
  let last = -Infinity
  for (let quantum = 0; quantum < MAX_SECONDS * sampleRate / QUANTUM; quantum++) {
    engine.render()
    const pointer = engine.output_ptr()
    left.push(new Float32Array(memory.buffer, pointer, QUANTUM).slice())
    right.push(new Float32Array(memory.buffer, pointer + QUANTUM * 4, QUANTUM).slice())
    const position = state()
    if (position >= to || position < last) break
    last = position
  }
  const join = parts => {const out = new Float32Array(parts.length * QUANTUM); parts.forEach((part, index) => out.set(part, index * QUANTUM)); return out}
  return {sampleRate, frames: [join(left), join(right)], from, to, failed}
}
