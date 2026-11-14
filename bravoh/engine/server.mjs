// opendaw-engine, the STORE: holds each booth song, its undo by turn, its samples, the song as the phone draws it, and
// what the engine page (the studio app itself, packages/app/studio/src/service/BravohEngine.ts) renders: a program's
// mixdowns and the bounce the phone plays. The page executes a program's studio hands; the store never renders.
// Loopback, one bearer token.
import {createServer} from "node:http"
import {createReadStream, createWriteStream} from "node:fs"
import {mkdir, readFile, stat, writeFile, readdir} from "node:fs/promises"
import {pipeline} from "node:stream/promises"
import {randomUUID} from "node:crypto"
import {join} from "node:path"
import {WavFile} from "@opendaw/lib-dsp"
import {UUID} from "@opendaw/lib-std"
import {decode, encode} from "../runtime/wire.mjs"
import {Song} from "./song.mjs"
import {factsOf} from "./facts.mjs"
import {toM4a} from "./bounce.mjs"
import {clientsIn, openRoom, startRooms} from "./rooms.mjs"
import {extname, normalize} from "node:path"
import {fileURLToPath} from "node:url"
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
  const root = path.startsWith("/booth/") || path.startsWith("/wasm/") || path.startsWith("/play/") ? STATIC : join(STATIC, "studio")
  const file = normalize(join(root, path))
  if (!file.startsWith(normalize(root))) return send(response, 404, {why: "no such file"})
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
// The open itself is what is kept: two calls meeting on a song not yet open each opened their own, and the later
// replaced the earlier with its graph and its room still in use. Renders no longer queue, so calls do meet here.
const asked = new Map() // key -> when a call last asked for that song
const songOf = key => {
  asked.set(key, Date.now())
  if (!songs.has(key)) songs.set(key, Song.open(join(DATA, "songs"), key).catch(error => {songs.delete(key); throw error}))
  return songs.get(key)
}
// A SONG NOBODY USES GOES BACK TO DISK. Every song ever opened kept its graph and its room for the life of the process
// (11-14: 9 MB a song on an 8-lane one in heap-proof.mjs; the store's heap full in 62 minutes). One no call has asked
// for in ten minutes, with no page in its room (a page still there writes through it), is saved and closed; the next
// ask opens it from disk.
const IDLE_MS = 10 * 60_000
setInterval(() => {
  for (const [key, at] of asked)
    if (Date.now() - at > IDLE_MS)
      serial(key, async () => {
        const opened = songs.get(key)
        if (!opened || Date.now() - (asked.get(key) ?? 0) <= IDLE_MS) return
        const song = await opened.catch(() => null)
        if (song && clientsIn(song.roomName) > 1) return
        songs.delete(key); asked.delete(key)
        await song?.close()
      }).catch(error => console.warn(`[engine] ${key} not closed:`, error))
}, 60_000).unref()
const samplesDir = key => join(DATA, "samples", key)
const uuidText = bytes => UUID.toString(bytes)
const sampleIndex = async key => JSON.parse(await readFile(join(samplesDir(key), "index.json"), "utf8").catch(() => "[]"))
// THE STUDIO'S OWN LIBRARY (TR-808, 909, LinnDrum, loops, impulse responses): openDAW's public sample index, the one
// its studio app reads (packages/app/studio/src/opendaw-api/OpenSampleAPI.ts, its published credentials). Listed beside
// the song's own files and fetched once per file into ENGINE_DATA/library, so a program and its render play them like
// any sample. Without it every "from the library" sound failed and make searched the web for a kick (11-04).
const ASSETS = "https://assets.opendaw.studio"
const LIBRARY = `${ASSETS}/samples`
const LIBRARY_AUTH = {headers: {authorization: `Basic ${Buffer.from("openDAW:prototype").toString("base64")}`}}
// OPENDAW'S ASSETS FOR THE PAGES (samples, soundfonts, presets, WCLAPs): their host answers cross-origin only to
// opendaw.studio, so the booth and engine pages read them here (packages/app/studio/src/opendaw-api AssetsRoot).
// A file is fetched once into ENGINE_DATA/assets; an index is fetched fresh, it changes.
const ASSET = /^(samples|soundfonts|presets|wclaps)\/[A-Za-z0-9._-]+$/
const assetsDir = join(DATA, "assets")
const asset = async path => {
  const kept = join(assetsDir, path)
  const fresh = path.endsWith(".json")
  const cached = fresh ? null : await readFile(kept).catch(() => null)
  if (cached) return cached
  const response = await fetch(`${ASSETS}/${path}`, LIBRARY_AUTH)
  if (!response.ok) return null
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!fresh) await mkdir(join(kept, ".."), {recursive: true}).then(() => writeFile(kept, bytes))
  return bytes
}
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
  const bytes = await asset(`samples/${uuid}`)
  if (!bytes) throw new Error(`the library's ${uuid} did not load`)
  return bytes
}
const sampleBytes = async (key, uuid) =>
  (await readFile(join(samplesDir(key), `${uuid}.wav`)).catch(() => null)) ?? libraryFile(uuid)
// WHAT A PROGRAM ADDS BESIDE SAMPLES, kept with its song like its samples: soundfonts (.sf2) and amp models (.nam
// JSON text), each keyed by the SHA-256 of its content as the studio keys an import. The amp models also come from the
// house library, ENGINE_DATA/nam/*.nam, read fresh on every listing.
const contentUuid = async bytes => UUID.toString(await UUID.sha256(new Uint8Array(bytes).buffer))
const soundfontsDir = key => join(DATA, "soundfonts", key)
const soundfontIndex = async key => JSON.parse(await readFile(join(soundfontsDir(key), "index.json"), "utf8").catch(() => "[]"))
const songNamFile = key => join(DATA, "nam-songs", `${key}.json`)
const houseNam = async () => {
  const dir = join(DATA, "nam")
  const files = (await readdir(dir).catch(() => [])).filter(file => file.endsWith(".nam")).sort()
  return Promise.all(files.map(async file => {
    const model = await readFile(join(dir, file), "utf8")
    return {uuid: await contentUuid(Buffer.from(model)), name: file.slice(0, -4), model}
  }))
}
const namModels = async key => [...await houseNam(), ...JSON.parse(await readFile(songNamFile(key), "utf8").catch(() => "[]"))]
const methods = {
  open: async (song) => ({project: song.bytes(), name: song.name}),
  apply: async (song, {project, name, tasks, checksum}, turn) =>
    project ? song.replace(project, name, turn) : song.apply(tasks, checksum, turn),
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
  request.on("end", () => resolve(Buffer.concat(parts)))
  request.on("error", reject)
})
// A RENDER (32-bit float WAV), from the engine page to every reader of it, named by the project it rendered
// (BravohRenders.ts). A song keeps its newest few, each until nobody has read it for half an hour: 83 MB for 128 bars.
const renders = join(DATA, "renders")
await rm(renders, {recursive: true, force: true})
const renderFile = (key, id) => join(renders, `${key}.${id}.wav`)
const RENDERS_KEPT = 4
const RENDER_IDLE_MS = 30 * 60_000
const keptRenders = new Map() // key -> Map(id -> its timer), oldest first
const forget = (key, id) => {
  clearTimeout(keptRenders.get(key)?.get(id))
  keptRenders.get(key)?.delete(id)
  rm(renderFile(key, id), {force: true}).catch(() => {})
}
const keepRender = (key, id) => {
  const kept = keptRenders.get(key) ?? new Map()
  keptRenders.set(key, kept)
  clearTimeout(kept.get(id))
  kept.delete(id)
  kept.set(id, setTimeout(() => forget(key, id), RENDER_IDLE_MS).unref())
  for (const oldest of [...kept.keys()].slice(0, Math.max(0, kept.size - RENDERS_KEPT))) forget(key, oldest)
}
// A SONG'S STEMS, FROM ONE PASS (BravohEngine.ts `stemsOnce`), for the worker that packs them: on disk, one stereo float WAV a
// lane, never in this process (20 lanes of a 4 min song are 2 GB and this container has 6). One set a song; the set goes when
// the worker took it, or after half an hour nobody read it, and all of them when this store restarts.
const stemSets = join(DATA, "stems")
await rm(stemSets, {recursive: true, force: true})
const stemSet = (key, id) => join(stemSets, `${key}.${id}`)
const heldStems = new Map() // key -> {id, done, timer}
const dropStems = key => {
  const held = heldStems.get(key)
  if (!held) return Promise.resolve()
  clearTimeout(held.timer)
  heldStems.delete(key)
  return rm(stemSet(key, held.id), {recursive: true, force: true})
}
const holdStems = async (key, id) => {
  if (heldStems.get(key)?.id !== id) {
    await dropStems(key)
    heldStems.set(key, {id, done: 0})
  }
  const held = heldStems.get(key)
  clearTimeout(held.timer)
  held.timer = setTimeout(() => void dropStems(key), RENDER_IDLE_MS).unref()
  return held
}

// THE COUNT OF RENDERS, per song since this engine started: what proves every reader shares one. `rendered` is counted
// where a render lands; the page says what it spared and what the last one spent (`renders-note`).
const counts = new Map()
const countOf = key => {
  if (!counts.has(key)) counts.set(key, {rendered: 0, shared: 0, stored: 0, dropped: 0, encoded: 0})
  return counts.get(key)
}
// A SONG ERASED WHOLE (DELETE /v1/songs/:key, an artist's account erased): the song and its versions, its undo, its
// samples, soundfonts and amp models, its renders and stems, and all this process holds of it. Nothing there: done all the same.
// What it does not reach: a page the engine host still has open on it (the host's own DELETE closes it, first).
const erase = key => serial(key, async () => {
  await (await songOf(key)).erase()
  songs.delete(key); asked.delete(key)
  counts.delete(key)
  for (const id of [...keptRenders.get(key)?.keys() ?? []]) forget(key, id)
  keptRenders.delete(key)
  await dropStems(key)
  await Promise.all([samplesDir(key), soundfontsDir(key), songNamFile(key)].map(path => rm(path, {recursive: true, force: true})))
})
const send = (response, status, value) => {response.writeHead(status, {"content-type": "application/json"}); response.end(JSON.stringify(value))}
export const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://engine").pathname
  if (request.method === "GET" && path.startsWith("/opendaw-assets/")) {
    const file = ASSET.test(path.slice(16)) ? await asset(path.slice(16)).catch(() => null) : null
    if (!file) return send(response, 404, {why: "no such asset"})
    response.writeHead(200, {"content-type": path.endsWith(".json") ? "application/json" : "application/octet-stream", "content-length": file.byteLength,
      "cross-origin-resource-policy": "same-origin"})
    return response.end(file)
  }
  if (request.method === "GET" && !path.startsWith("/v1/")) return serveStatic(path, response)
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(response, 401, {why: "unauthorized"})
  const [, version, songs, key, method] = new URL(request.url, "http://engine").pathname.split("/")
  if (version !== "v1" || songs !== "songs" || !KEY.test(key ?? "")) return send(response, 404, {why: "no such route"})
  try {
    if (request.method === "DELETE" && method === undefined) {
      await erase(key)
      response.writeHead(204)
      return response.end()
    }
    if (request.method === "GET" && method === "song") {
      const song = await songOf(key)
      return song.graph ? send(response, 200, await factsOf(song.graph, song.name)) : send(response, 404, {why: "no song"})
    }
    if (request.method === "GET" && method === "room") {
      const song = await songOf(key)
      const room = await serial(key, async () => song.room((name, graph) => openRoom(rooms.url, name, graph)))
      return room ? send(response, 200, {room, ws: "/rooms", name: song.name}) : send(response, 404, {why: "no song"})
    }
    // THE SONG'S GRAPH AS IT STANDS, for the engine in the artist's page: bytes, no room, nothing to write back through.
    if (request.method === "GET" && method === "project") {
      const song = await songOf(key)
      const bytes = song.bytes()
      if (!bytes) return send(response, 404, {why: "no song"})
      response.writeHead(200, {"content-type": "application/octet-stream", "content-length": bytes.byteLength, "x-version": String(song.version)})
      return response.end(new Uint8Array(bytes))
    }
    if (request.method === "GET" && method === "version") return send(response, 200, {version: (await songOf(key)).version})
    // THE SONG AS THE PHONE PLAYS IT: the bounce the engine page rendered for this version of the song, or 409 and the
    // version to render (the API asks the engine host to bounce, then comes back).
    if (request.method === "GET" && method === "audio") {
      const song = await songOf(key)
      if (!song.graph) return send(response, 404, {why: "no song"})
      // A reader that waited for a bounce names its version: the song may have moved on while it rendered, and the file it
      // waited for, or a newer one, is what it came for. 11-07: a 248 s song renders in 70 s with versions 20-50 s apart, so
      // no read of the song's version ever found its file and the phone heard nothing new for as long as make worked.
      const named = new URL(request.url, "http://engine").searchParams.get("version")
      const wanted = named === null ? song.version : Number(named)
      if (!(song.bounced?.version >= wanted)) return send(response, 409, {why: "not rendered", version: song.version})
      const {file} = song.bounced
      response.writeHead(200, {"content-type": file.type, "content-length": file.bytes.byteLength}); return response.end(file.bytes)
    }
    if (request.method === "GET" && method === "renders-stats") return send(response, 200, countOf(key))
    if (request.method === "GET" && method === "renders") {
      const id = path.split("/")[5] ?? ""
      if (!KEY.test(id) || !keptRenders.get(key)?.has(id)) return send(response, 404, {why: "no such render"})
      keepRender(key, id)
      if (new URL(request.url, "http://engine").searchParams.has("peek")) return send(response, 200, {kept: true})
      const bytes = await readFile(renderFile(key, id)).catch(() => null)
      if (!bytes) return send(response, 404, {why: "no such render"})
      response.writeHead(200, {"content-type": "audio/wav", "content-length": bytes.byteLength}); return response.end(bytes)
    }
    if (method === "stems") {
      const [, , , , , id = "", file] = path.split("/")
      // How far this song's set has come, whichever it is: the worker has no name for it until it is done.
      if (request.method === "GET" && id === "") return send(response, 200, {done: heldStems.get(key)?.done ?? 0})
      if (!KEY.test(id) || (file !== undefined && !/^\d{1,4}$/.test(file))) return send(response, 404, {why: "no such stems"})
      if (request.method === "DELETE") {
        if (heldStems.get(key)?.id === id) await dropStems(key)
        return send(response, 200, {})
      }
      if (request.method === "GET") {
        if (heldStems.get(key)?.id !== id) return send(response, 404, {why: "no such stems"})
        const known = await stat(join(stemSet(key, id), `${file}.wav`)).catch(() => null)
        if (!known) return send(response, 404, {why: "no such stems"})
        await holdStems(key, id)
        response.writeHead(200, {"content-type": "audio/wav", "content-length": known.size})
        return pipeline(createReadStream(join(stemSet(key, id), `${file}.wav`)), response)
      }
      if (request.method === "POST" && file === undefined) {
        const held = await holdStems(key, id)
        held.done = Number(new URL(request.url, "http://engine").searchParams.get("done")) || held.done
        return send(response, 200, {})
      }
      if (request.method === "POST") {
        await holdStems(key, id)
        await mkdir(stemSet(key, id), {recursive: true})
        await pipeline(request, createWriteStream(join(stemSet(key, id), `${file}.wav`)))
        return send(response, 200, {})
      }
    }
    if (request.method === "GET" && method === "soundfonts") return send(response, 200, await soundfontIndex(key))
    if (request.method === "GET" && method === "soundfont") {
      const uuid = new URL(request.url, "http://engine").searchParams.get("uuid") ?? ""
      const known = /^[0-9a-f-]{36}$/.test(uuid) ? (await soundfontIndex(key)).find(one => one.uuid === uuid) : undefined
      const bytes = known ? await readFile(join(soundfontsDir(key), `${uuid}.sf2`)).catch(() => null) : null
      if (!bytes) return send(response, 404, {why: "no such soundfont"})
      response.writeHead(200, {"content-type": "application/octet-stream", "x-name": encodeURIComponent(known.name)}); return response.end(bytes)
    }
    if (request.method === "GET" && method === "nam") return send(response, 200, await namModels(key))
    if (request.method === "GET" && method === "sample") {
      const uuid = new URL(request.url, "http://engine").searchParams.get("uuid") ?? ""
      if (!/^[0-9a-f-]{36}$/.test(uuid)) return send(response, 404, {why: "no such sample"})
      const bytes = await sampleBytes(key, uuid).catch(() => null)
      if (!bytes) return send(response, 404, {why: "no such sample"})
      response.writeHead(200, {"content-type": "audio/wav", "content-length": bytes.byteLength}); return response.end(bytes)
    }
    if (request.method !== "POST") return send(response, 405, {why: "POST"})
    if (method === "renders") {
      const id = path.split("/")[5] ?? ""
      if (!KEY.test(id)) return send(response, 404, {why: "no such render"})
      await mkdir(renders, {recursive: true})
      await writeFile(renderFile(key, id), await body(request))
      keepRender(key, id)
      countOf(key).rendered++
      return send(response, 200, {render: id})
    }
    if (method === "renders-note") {
      const {took, stuck, ...spared} = JSON.parse((await body(request)).toString("utf8") || "{}")
      if (stuck) console.log(JSON.stringify({event: "engine.stuck", key, why: String(stuck).slice(0, 2000)}))
      const count = countOf(key)
      for (const [what, by] of Object.entries(spared)) if (what in count) count[what] += Number(by) || 0
      if (took) {
        count.last = took
        console.log(JSON.stringify({event: "engine.render", key, ...took}))
      }
      return send(response, 200, {})
    }
    if (method === "bounce") {
      const asked = new URL(request.url, "http://engine").searchParams
      const version = Number(asked.get("version")), render = asked.get("render") ?? ""
      if (!Number.isInteger(version)) return send(response, 400, {why: "version"})
      if (!KEY.test(render) || !keptRenders.get(key)?.has(render)) return send(response, 404, {why: "no such render"})
      const song = await songOf(key)
      // One encode per render: a later version with the same bytes, or a second reader, has the file already.
      if (song.encoded?.render !== render) {
        const began = Date.now()
        const took = {}
        const file = readFile(renderFile(key, render)).then(wav => toM4a(wav, took))
        song.encoded = {render, file}
        file.catch(() => {if (song.encoded?.file === file) song.encoded = null})
        countOf(key).encoded++
        file.then(() => console.log(JSON.stringify({event: "engine.encode", key, encodeMs: Date.now() - began, coders: took})), () => {})
      }
      // a newer bounce than the one kept wins; an older one that arrives late does not replace it
      const keep = file => {if (!(song.bounced?.version > version)) song.bounced = {version, file}}
      // THE EAR DOES NOT WAIT FOR THE PHONE'S FILE (11-14: the encode was 44 s of every 66-87 s bounce, and the ear only
      // re-encodes it to mp3): asked `early`, the store answers once the encode has started, naming the render the ear
      // reads whole (`renders/<id>`), and keeps the phone's file for its version when the encode ends.
      if (asked.get("early") === "1") {
        song.encoded.file.then(keep, () => {})
        return send(response, 200, {version, render})
      }
      keep(await song.encoded.file)
      return send(response, 200, {version})
    }
    if (method === "soundfonts") {
      const name = String(new URL(request.url, "http://engine").searchParams.get("name") ?? "").slice(0, 200)
      const bytes = await body(request)
      // the RIFF header of a soundfont: anything else would only fail later, inside a render
      if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "sfbk") return send(response, 400, {why: "not a soundfont (.sf2)"})
      const uuid = await contentUuid(bytes)
      return send(response, 200, await serial(key, async () => {
        await mkdir(soundfontsDir(key), {recursive: true})
        await writeFile(join(soundfontsDir(key), `${uuid}.sf2`), bytes)
        const index = await soundfontIndex(key)
        const soundfont = {uuid, name: name || uuid}
        await writeFile(join(soundfontsDir(key), "index.json"), JSON.stringify([...index.filter(one => one.uuid !== uuid), soundfont]))
        return soundfont
      }))
    }
    const input = JSON.parse((await body(request)).toString("utf8") || "{}")
    if (method === "nam") {
      const model = String(input.model ?? ""), name = String(input.name ?? "").slice(0, 200)
      try {JSON.parse(model)} catch {return send(response, 400, {why: "not an amp model (.nam JSON)"})}
      const added = {uuid: await contentUuid(Buffer.from(model)), name, model}
      return send(response, 200, await serial(key, async () => {
        const own = JSON.parse(await readFile(songNamFile(key), "utf8").catch(() => "[]"))
        await mkdir(join(DATA, "nam-songs"), {recursive: true})
        await writeFile(songNamFile(key), JSON.stringify([...own.filter(one => one.uuid !== added.uuid), added]))
        return added
      }))
    }
    if (method === "start") return send(response, 200, await serial(key, async () => (await songOf(key)).start(String(input.name ?? "").slice(0, 200))))
    if (method === "mark") return send(response, 200, await serial(key, async () => (await songOf(key)).mark(String(input.turn ?? ""))))
    if (method === "undo") return send(response, 200, await serial(key, async () => (await songOf(key)).undo(Number(input.turns ?? 1), Array.isArray(input.from) ? input.from : undefined)))
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
