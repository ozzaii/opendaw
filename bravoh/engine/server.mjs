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
import {execFile} from "node:child_process"
import {tmpdir} from "node:os"
import {rm} from "node:fs/promises"
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
const TYPES = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".sf2": "application/octet-stream"}
// The booth page (the studio app at the root, it asks for its files from "/"; the slim page at /booth/) and the engine's wasm,
// cross-origin isolated (the engine needs SharedArrayBuffer). No token: no data.
const serveStatic = async (path, response) => {
  const root = path.startsWith("/booth/") || path.startsWith("/wasm/") ? STATIC : join(STATIC, "studio")
  const file = normalize(join(root, path))
  if (!file.startsWith(normalize(root))) return send(response, 404, {why: "no such file"})
  const bytes = await readFile(file.endsWith("/") ? join(file, "index.html") : file).catch(() => null)
  if (!bytes) return send(response, 404, {why: "no such file"})
  response.writeHead(200, {"content-type": TYPES[extname(file) || ".html"] ?? "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin"})
  response.end(bytes)
}
// THE BOUNCE THE WAY THE PLATFORM PLAYS IT: AAC in an M4A, moov first, ~1/12 of the 16-bit WAV (a 64-bar song was
// 19 MB and took a phone 18-40 s to fetch, 11-04). iOS, Safari, Chrome and the app shells decode it natively.
// The WAV goes out when ffmpeg cannot run (a dev machine without it): slower, never silent.
const toM4a = async wav => {
  const base = join(tmpdir(), `bounce-${randomUUID()}`)
  try {
    await writeFile(`${base}.wav`, wav)
    await new Promise((done, fail) => execFile("ffmpeg", ["-v", "error", "-y", "-i", `${base}.wav`, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", `${base}.m4a`], {timeout: 120_000}, error => error ? fail(error) : done()))
    return {bytes: await readFile(`${base}.m4a`), type: "audio/mp4"}
  } catch (error) {
    console.warn("[engine] the bounce stays WAV:", String(error?.message ?? error))
    return {bytes: wav, type: "audio/wav"}
  } finally {
    await rm(`${base}.wav`, {force: true}).catch(() => {}); await rm(`${base}.m4a`, {force: true}).catch(() => {})
  }
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
// THE STUDIO'S OWN LIBRARY (TR-808, 909, LinnDrum, loops, impulse responses): openDAW's public sample index, the one
// its studio app reads (packages/app/studio/src/opendaw-api/OpenSampleAPI.ts, its published credentials). Listed beside
// the song's own files and fetched once per file into ENGINE_DATA/library, so a program and its render play them like
// any sample. Without it every "from the library" sound failed and make searched the web for a kick (11-04).
const LIBRARY = "https://assets.opendaw.studio/samples"
const LIBRARY_AUTH = {headers: {authorization: `Basic ${Buffer.from("openDAW:prototype").toString("base64")}`}}
const libraryDir = join(DATA, "library")
let library
const libraryIndex = () => library ??= fetch(`${LIBRARY}/index.json`, LIBRARY_AUTH)
  .then(response => response.ok ? response.json() : Promise.reject(new Error(`the library index answered ${response.status}`)))
  .then(index => {
    const all = []
    const walk = folder => {
      for (const one of folder.samples ?? []) all.push({uuid: one.uuid, name: one.name, duration: one.duration, bpm: one.bpm ?? 0, sample_rate: one.sample_rate})
      for (const inner of folder.folders ?? []) walk(inner)
    }
    for (const folder of index.folders ?? []) walk(folder)
    return all
  })
  .catch(error => {library = undefined; throw error})
const libraryFile = async uuid => {
  if (!(await libraryIndex()).some(one => one.uuid === uuid)) return null
  const kept = join(libraryDir, `${uuid}.wav`)
  const cached = await readFile(kept).catch(() => null)
  if (cached) return cached
  const response = await fetch(`${LIBRARY}/${uuid}`, LIBRARY_AUTH)
  if (!response.ok) throw new Error(`the library's ${uuid} answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await mkdir(libraryDir, {recursive: true})
  await writeFile(kept, bytes)
  return bytes
}
const sampleBytes = async (key, uuid) =>
  (await readFile(join(samplesDir(key), `${uuid}.wav`)).catch(() => null)) ?? libraryFile(uuid)
const loadSample = key => async uuid => {
  const bytes = await sampleBytes(key, uuidText(uuid))
  if (!bytes) throw new Error(`no sample ${uuidText(uuid)}`)
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
    if (!add) return [...index, ...await libraryIndex().catch(() => [])]
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
  if (request.method === "GET" && !path.startsWith("/v1/")) return serveStatic(path, response)
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
      return room ? send(response, 200, {room, ws: "/rooms"}) : send(response, 404, {why: "no song"})
    }
    if (request.method === "GET" && method === "bounce") {
      const file = await serial(key, async () => (await songOf(key)).bounce(bytes => render(bytes, {samples: loadSample(key)}), toM4a)).catch(() => null)
      if (!file) return send(response, 404, {why: "nothing to play yet"})
      response.writeHead(200, {"content-type": file.type, "content-length": file.bytes.byteLength}); return response.end(file.bytes)
    }
    if (request.method === "GET" && method === "sample") {
      const uuid = new URL(request.url, "http://engine").searchParams.get("uuid") ?? ""
      if (!/^[0-9a-f-]{36}$/.test(uuid)) return send(response, 404, {why: "no such sample"})
      const bytes = await sampleBytes(key, uuid).catch(() => null)
      if (!bytes) return send(response, 404, {why: "no such sample"})
      response.writeHead(200, {"content-type": "audio/wav"}); return response.end(bytes)
    }
    if (request.method !== "POST") return send(response, 405, {why: "POST"})
    const input = JSON.parse((await body(request)) || "{}")
    if (method === "start") return send(response, 200, await serial(key, async () => (await songOf(key)).start(String(input.name ?? "").slice(0, 200))))
    if (method === "undo") return send(response, 200, await serial(key, async () => (await songOf(key)).undo(Number(input.turns ?? 1))))
    const run = methods[method]
    if (!run) return send(response, 404, {why: "no such method"})
    const answer = await serial(key, async () => run(await songOf(key), decode(input.wire ?? "{}"), String(input.turn ?? ""), key))
    send(response, 200, {wire: encode(answer)})
  } catch (error) {
    send(response, 409, {why: String(error?.message ?? error)})
  }
})
// THE ROOM FOR A PAGE OUTSIDE THIS HOST (the booth's Chrome): a websocket on this port, `/rooms/<room>?token=`,
// since a browser's websocket carries no header. The loopback room server itself is never exposed.
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://engine")
  const [, rooms_, room] = url.pathname.split("/")
  if (rooms_ !== "rooms" || !room || url.searchParams.get("token") !== TOKEN) {socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return}
  rooms.join(request, socket, head, room)
})
if (process.argv[1]?.endsWith("server.mjs") || process.env.ENGINE_LISTEN === "1")
  server.listen(Number(process.env.ENGINE_PORT ?? 7790), process.env.ENGINE_HOST ?? "127.0.0.1", () => console.log(`opendaw-engine on ${server.address().address}:${server.address().port}, rooms on ${rooms.url}`))
