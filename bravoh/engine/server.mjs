// opendaw-engine: holds each booth song and answers the four ScriptHostProtocol hands of BRAVOH's programs
// (bravoh/runtime/preamble.mjs), plus undo and the song as the phone draws it. Loopback, one bearer token.
import {createServer} from "node:http"
import {mkdir, readFile, writeFile, readdir} from "node:fs/promises"
import {randomUUID} from "node:crypto"
import {join} from "node:path"
import {WavFile} from "@opendaw/lib-dsp"
import {UUID} from "@opendaw/lib-std"
import {decode, encode} from "../runtime/wire.mjs"
import {Song} from "./song.mjs"
import {render} from "./render.mjs"
import {factsOf} from "./facts.mjs"
import {openRoom, startRooms} from "./rooms.mjs"
import {extname, normalize} from "node:path"
import {fileURLToPath} from "node:url"
const TOKEN = process.env.ENGINE_TOKEN ?? ""
if (TOKEN.length < 32) throw new Error("ENGINE_TOKEN must be at least 32 characters")
const DATA = process.env.ENGINE_DATA ?? "./data"
const KEY = /^[A-Za-z0-9_-]{1,80}$/
// external limit: a request body larger than this is refused (a long vocal as float32 stereo is ~50 MB a minute)
const MAX_BODY = 256 * 1024 * 1024
const songs = new Map()
// the room server: loopback only, the conductor and the booth page are its only clients
const rooms = await startRooms(Number(process.env.ENGINE_ROOM_PORT ?? 0))
const STATIC = process.env.ENGINE_STATIC ?? fileURLToPath(new URL(".", import.meta.url))
const TYPES = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json"}
// The booth page and the engine's wasm, cross-origin isolated (the engine needs SharedArrayBuffer). No token: no data.
const serveStatic = async (path, response) => {
  const file = normalize(join(STATIC, path))
  if (!file.startsWith(normalize(STATIC))) return send(response, 404, {why: "no such file"})
  const bytes = await readFile(file.endsWith("/") ? join(file, "index.html") : file).catch(() => null)
  if (!bytes) return send(response, 404, {why: "no such file"})
  response.writeHead(200, {"content-type": TYPES[extname(file) || ".html"] ?? "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin"})
  response.end(bytes)
}
const queues = new Map()
// One song's calls run one after another, so two programs never interleave on one graph.
const serial = (key, work) => {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work)
  queues.set(key, next.catch(() => {}))
  return next
}
const songOf = async key => {
  if (!songs.has(key)) songs.set(key, await Song.open(join(DATA, "songs"), key))
  return songs.get(key)
}
const samplesDir = key => join(DATA, "samples", key)
const uuidText = bytes => UUID.toString(bytes)
const sampleIndex = async key => JSON.parse(await readFile(join(samplesDir(key), "index.json"), "utf8").catch(() => "[]"))
const loadSample = key => async uuid => {
  const bytes = await readFile(join(samplesDir(key), `${uuidText(uuid)}.wav`))
  return WavFile.decodeFloats(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}
const methods = {
  open: async (song) => ({project: song.bytes(), name: song.name}),
  apply: async (song, {project, name, tasks, checksum}, turn) =>
    project ? song.replace(project, name, turn) : song.apply(tasks, checksum, turn),
  mixdown: async (song, {project, sampleRate}, _turn, key) => {
    const out = await render(project, {sampleRate, samples: loadSample(key)})
    if (out.failed.length > 0) throw new Error(`Some sounds of the song did not load, so the render would be missing them: ${out.failed.join("; ")}`)
    return {sampleRate: out.sampleRate, frames: out.frames}
  },
  samples: async (_song, {add}, _turn, key) => {
    const index = await sampleIndex(key)
    if (!add) return index
    const uuid = randomUUID()
    const frames = add.frames.length
    const length = add.frames[0]?.length ?? 0
    await mkdir(samplesDir(key), {recursive: true})
    await writeFile(join(samplesDir(key), `${uuid}.wav`), new Uint8Array(WavFile.encodeFloats({sampleRate: add.sampleRate, numberOfFrames: length, numberOfChannels: frames, frames: add.frames})))
    const sample = {uuid, name: String(add.name), duration: length / add.sampleRate, bpm: 0, sample_rate: add.sampleRate}
    await writeFile(join(samplesDir(key), "index.json"), JSON.stringify([...index, sample]))
    return sample
  }
}
const body = request => new Promise((resolve, reject) => {
  const parts = []
  let size = 0
  request.on("data", part => {size += part.length; if (size > MAX_BODY) {reject(new Error("too large")); request.destroy()} else parts.push(part)})
  request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")))
  request.on("error", reject)
})
const send = (response, status, value) => {response.writeHead(status, {"content-type": "application/json"}); response.end(JSON.stringify(value))}
export const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://engine").pathname
  if (request.method === "GET" && (path.startsWith("/booth/") || path.startsWith("/wasm/"))) return serveStatic(path, response)
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(response, 401, {why: "unauthorized"})
  const [, version, songs, key, method] = new URL(request.url, "http://engine").pathname.split("/")
  if (version !== "v1" || songs !== "songs" || !KEY.test(key ?? "")) return send(response, 404, {why: "no such route"})
  try {
    if (request.method === "GET" && method === "song") {
      const song = await songOf(key)
      return song.graph ? send(response, 200, await factsOf(song.graph, song.name)) : send(response, 404, {why: "no song"})
    }
    if (request.method === "GET" && method === "room") {
      const room = await serial(key, async () => (await songOf(key)).room((name, graph) => openRoom(rooms.url, name, graph)))
      return room ? send(response, 200, {room, ws: rooms.url}) : send(response, 404, {why: "no song"})
    }
    if (request.method === "GET" && method === "sample") {
      const uuid = new URL(request.url, "http://engine").searchParams.get("uuid") ?? ""
      if (!/^[0-9a-f-]{36}$/.test(uuid)) return send(response, 404, {why: "no such sample"})
      const bytes = await readFile(join(samplesDir(key), `${uuid}.wav`)).catch(() => null)
      if (!bytes) return send(response, 404, {why: "no such sample"})
      response.writeHead(200, {"content-type": "audio/wav"}); return response.end(bytes)
    }
    if (request.method !== "POST") return send(response, 405, {why: "POST"})
    const input = JSON.parse((await body(request)) || "{}")
    if (method === "undo") return send(response, 200, await serial(key, async () => (await songOf(key)).undo(Number(input.turns ?? 1))))
    const run = methods[method]
    if (!run) return send(response, 404, {why: "no such method"})
    const answer = await serial(key, async () => run(await songOf(key), decode(input.wire ?? "{}"), String(input.turn ?? ""), key))
    send(response, 200, {wire: encode(answer)})
  } catch (error) {
    send(response, 409, {why: String(error?.message ?? error)})
  }
})
if (process.argv[1]?.endsWith("server.mjs") || process.env.ENGINE_LISTEN === "1")
  server.listen(Number(process.env.ENGINE_PORT ?? 7790), process.env.ENGINE_HOST ?? "127.0.0.1", () => console.log(`opendaw-engine on ${server.address().address}:${server.address().port}, rooms on ${rooms.url}`))
