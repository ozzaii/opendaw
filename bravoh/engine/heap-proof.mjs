// THE STORE'S MEMORY, PER ATTACH, PER LANDING, PER SONG (11-14: the store died of "JavaScript heap out of memory" 62
// minutes after a start, its renders slowing for half an hour before). In one process, as server.mjs holds them: songs on
// disk in a temp dir, the loopback room server, a page joined to each room the way the booth's Chrome is, and a program's
// landings through the scripting API (every landing takes every unit out and writes the song again, as make's runs do).
// Usage: npm run proof:heap -- [attaches] [landings] [songs]. Prints MB per step and the rooms the room server
// still holds. HEAP_SNAPSHOT=<file> writes one snapshot at the end.
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {writeHeapSnapshot} from "node:v8"
import * as Y from "yjs"
import {WebSocket} from "ws"
import {WebsocketProvider} from "y-websocket"
import {docs} from "y-websocket/bin/utils"
import {ApiImpl} from "@opendaw/studio-scripting"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Song} from "./song.mjs"
import {openRoom, startRooms} from "./rooms.mjs"

const [attaches = 10, landings = 10, songCount = 10] = process.argv.slice(2).map(Number)
const gc = globalThis.gc ?? (() => {throw new Error("run with node --expose-gc")})
const mb = bytes => Math.round(bytes / 1e5) / 10
const settle = () => new Promise(resolve => setTimeout(resolve, 300))
const heap = async () => {
  await settle()
  for (let i = 0; i < 4; i++) gc()
  const {heapUsed, rss} = process.memoryUsage()
  return {heapUsed, rss}
}
const dir = await mkdtemp(join(tmpdir(), "store-heap-"))
const rooms = await startRooms()
const open = (name, graph) => openRoom(rooms.url, name, graph)

// The booth page in a room: its own doc, synced, gone when it leaves.
const pageIn = async name => {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(rooms.url, name, doc, {WebSocketPolyfill: WebSocket})
  await new Promise(resolve => provider.on("sync", synced => synced && resolve()))
  return () => {provider.destroy(); doc.destroy()}
}

// A program on a song: every unit out, then eight lanes of 16 bars of notes, each with an effect: one landing.
const BAR = 3840
const land = async (song, turn) => {
  const pending = []
  const api = new ApiImpl({
    hasProject: async () => song.graph !== null,
    fetchProject: async () => ({buffer: song.bytes(), name: song.name}),
    openProject: (buffer, name) => pending.push(song.replace(buffer, name, turn)),
    applyUpdates: (tasks, checksum) => pending.push(song.apply(tasks, checksum, turn)),
    showInfo: async () => {}
  })
  const project = await api.getProject()
  for (const unit of [...project.audioUnits]) if (unit !== project.output) unit.remove()
  for (let lane = 0; lane < 8; lane++) {
    const unit = project.addInstrumentUnit("Vaporisateur", {label: `Lane ${lane}`})
    unit.addAudioEffect("Revamp")
    unit.noteTracks[0].addRegion({position: 0, duration: 16 * BAR}).addEvents(
      Array.from({length: 64}, (_, i) => ({position: i * 960, duration: 480, pitch: 48 + (i % 12), velocity: 0.8})))
  }
  await project.openInStudio()
  await Promise.all(pending)
}
const newSong = async key => {
  const song = await Song.open(dir, key)
  await song.start("proof")
  await land(song, `${key}-first`)
  return song
}

const report = (what, before, after, n) =>
  console.log(`${what.padEnd(9)} n=${String(n).padStart(3)}  heap +${mb((after.heapUsed - before.heapUsed) / n)} MB each (total +${mb(after.heapUsed - before.heapUsed)})  rss +${mb((after.rss - before.rss) / n)} MB each  rooms held ${docs.size}`)

const one = await newSong("one")
let leave = await pageIn(await one.room(open))
const start = await heap()
console.log(`start     heap ${mb(start.heapUsed)} MB  rss ${mb(start.rss)} MB  rooms held ${docs.size}`)

// PER LANDING: one room, the page in it, the program writes the song again each time.
let before = await heap()
for (let i = 0; i < landings; i++) await land(one, `landing-${i}`)
report("landing", before, await heap(), landings)

// PER ATTACH: an undo (a new room each time, the page following it there), then a landing to have something to undo.
before = await heap()
for (let i = 0; i < attaches; i++) {
  await one.undo(1)
  leave()
  leave = await pageIn(await one.room(open))
  await land(one, `again-${i}`)
}
report("attach", before, await heap(), attaches)

// PER SONG: songs opened the way server.mjs's `songs` map opens them, a page in and out of each, then left alone: what the
// store still holds of a song nobody uses (with `close`, what its idle sweep leaves; without it, the whole song).
const kept = []
before = await heap()
for (let i = 0; i < songCount; i++) {
  const song = await newSong(`song-${i}`)
  const out = await pageIn(await song.room(open))
  out()
  await song.close?.()
  kept.push(song)
}
report("song", before, await heap(), songCount)

if (process.env.HEAP_SNAPSHOT) console.log("snapshot", writeHeapSnapshot(process.env.HEAP_SNAPSHOT))
leave()
await rm(dir, {recursive: true, force: true})
process.exit(0)
