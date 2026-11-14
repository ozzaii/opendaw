// One song: its graph, its undo (a snapshot of the song before the first edit of each turn, on disk), and its bytes on
// disk after every change. The engine page edits it through its room; the store only keeps.
import {mkdir, readFile, rename, rm, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {BoxGraph, applyUpdateTasks} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Arrays, Option} from "@opendaw/lib-std"
const graphOf = bytes => {
  const graph = new BoxGraph(Option.wrap(BoxIO.create))
  graph.fromArrayBuffer(ProjectSkeleton.decode(bytes).boxGraph.toArrayBuffer(), false)
  return graph
}
const asBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
// The turn a stamp belongs to: `<turn>#<landing>` is that turn's landing, a stamp with no `#` a turn of its own.
const turnOf = stamp => String(stamp).replace(/#[^#]*$/, "")
export class Song {
  static async open(dir, key) {
    const song = new Song(dir, key)
    const bytes = await readFile(song.path).catch(error => {if (error.code === "ENOENT") return null; throw error})
    if (bytes) {
      const {name} = JSON.parse(await readFile(`${song.path}.json`, "utf8").catch(() => '{"name":""}'))
      song.#attach(graphOf(asBuffer(bytes)), name ?? "")
    }
    song.#history = JSON.parse(await readFile(join(song.#snapshots, "index.json"), "utf8").catch(() => "[]"))
    return song
  }
  #graph = null
  #room = null
  // unique across restarts: a page still in a room of the engine before must never meet a new room of the same name
  #generation = Date.now()
  #history = [] // [{turn, name, file}] oldest first; file null = there was no song before that turn
  name = ""
  // Every change of the graph, from a program's room or the booth page: what a bounce is kept for.
  version = 0
  bounced = null // {version, file} the engine page rendered (server.mjs POST bounce)
  constructor(dir, key) {this.dir = dir; this.path = join(dir, `${key}.od`)}
  get #snapshots() {return `${this.path}.history`}
  #attach(graph, name) {
    this.#graph = graph; this.name = name; this.version++
    this.#room?.close(); this.#room = null; this.#generation++
    // the pages write here through the room (a program's edits, plugin state, migration repairs): all of it is kept
    graph?.subscribeToAllUpdates({onUpdate: () => {this.version++; this.#later()}})
  }
  #timer = null
  #later() {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.#save().catch(error => console.warn(`[engine] ${this.path} not saved:`, error)), 500)
  }
  // The room the pages join, made on first ask for this graph.
  async room(open) {
    if (!this.#graph) return null
    this.#room ??= await open(`${this.path.split("/").pop().replace(/\.od$/, "")}-${this.#generation}`, this.#graph)
    return this.#room.name
  }
  get graph() {return this.#graph}
  /** The room the pages join now, or null. */
  get roomName() {return this.#room?.name ?? null}
  // TO DISK AND OUT OF MEMORY (server.mjs, a song no call has asked for a while and no page is in): its last save done,
  // its room closed. The next ask reads it from disk again (Song.open), as after a restart.
  async close() {
    if (this.#timer) {clearTimeout(this.#timer); this.#timer = null; await this.#save()}
    await this.#saving
    this.#room?.close(); this.#room = null; this.#graph = null
  }
  bytes() {return this.#graph ? ProjectSkeleton.encode(this.#graph) : null}
  // A booth opened before any program wrote a song: an empty one under the booth's title, so the studio is there at once.
  // Not an undo step: there is nothing to take back to. A song that exists is left as it is.
  async start(name) {
    if (this.#graph) return {started: false}
    this.#attach(ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: true}).boxGraph, name ?? "")
    await this.#save()
    return {started: true}
  }
  // UNDO BY TURN: the song as it was before the first edit of a turn, kept once per turn (the engine page asks before
  // its first edit of a turn; a new song asks itself). On disk, so it outlives a restart.
  async mark(turn) {
    if (this.#history.at(-1)?.turn === turn) return {marked: false}
    const bytes = this.bytes()
    const file = bytes ? `${Date.now()}-${this.#history.length}.od` : null
    await mkdir(this.#snapshots, {recursive: true})
    if (file) await writeFile(join(this.#snapshots, file), new Uint8Array(bytes))
    this.#history.push({turn, name: this.name, file})
    await writeFile(join(this.#snapshots, "index.json"), JSON.stringify(this.#history))
    return {marked: true}
  }
  // A whole new song (openDAW.newProject().openInStudio()): the one before comes back on undo.
  async replace(buffer, name, turn) {
    await this.mark(turn)
    const graph = new BoxGraph(Option.wrap(BoxIO.create))
    graph.fromArrayBuffer(buffer, false)
    this.#attach(graph, name ?? "")
    await this.#save()
    return {applied: "new"}
  }
  // ScriptHostProtocol.applyUpdates on the store's own graph (the room carries it to the pages); the engine page applies
  // a program's edits itself, so this is for a caller without a page.
  async apply(tasks, checksum, turn) {
    if (!this.#graph) throw new Error("There is no song in the booth yet: start one with openDAW.newProject().")
    if (!Arrays.equals(this.#graph.checksum(), checksum)) throw new Error("The song changed since this program read it: read it again and redo the change.")
    await this.mark(turn)
    this.#graph.beginTransaction()
    applyUpdateTasks(this.#graph, tasks)
    this.#graph.endTransaction()
    await this.#save()
    return {applied: tasks.length}
  }
  // The last `turns` turns that wrote, taken back: the song as it was before the oldest of them, in a new room.
  // `from` ("Revert to here"): the turns those ones stamp, and every turn after the first of them. It is the store that
  // knows which turns wrote, so the count is worked out here: the caller knows only the artist's message ids.
  // A LANDING IS A STEP, A TURN IS ITS LANDINGS (11-14): BRAVOH stamps each apply `<turn>#<landing>`, so each of make's
  // landings has a snapshot of its own and `from` naming one stamp takes back that landing and what came after it. A turn
  // named by its own id, and `turns`, still take back every landing of it: a run is one step to the artist and the desk.
  async undo(turns = 1, from) {
    const history = this.#history
    let start = history.length
    if (from) start = history.findIndex(({turn}) => from.includes(turn) || from.includes(turnOf(turn)))
    else for (let left = Math.max(1, turns); left > 0 && start > 0; left--) {
      const turn = turnOf(history[start - 1].turn)
      while (start > 0 && turnOf(history[start - 1].turn) === turn) start--
    }
    const taken = start < 0 ? [] : history.splice(start)
    if (taken.length === 0) return {undone: 0, turns: 0}
    const back = taken[0]
    const bytes = back.file ? await readFile(join(this.#snapshots, back.file)) : null
    this.#attach(bytes ? graphOf(asBuffer(bytes)) : null, back.name)
    await this.#save()
    await writeFile(join(this.#snapshots, "index.json"), JSON.stringify(this.#history))
    for (const {file} of taken) if (file) await rm(join(this.#snapshots, file), {force: true})
    return {undone: taken.length, turns: new Set(taken.map(({turn}) => turnOf(turn))).size}
  }
  // ERASED WHOLE (an artist's account erased): no room, no save to come, and nothing of it on disk, its undo included.
  async erase() {
    clearTimeout(this.#timer)
    this.#attach(null, "")
    await this.#save()
    this.#history = []
    await rm(this.#snapshots, {recursive: true, force: true})
  }
  // ONE SAVE AT A TIME PER SONG, each on its own tmp file. The booth page's writes save on a timer beside a
  // program's apply: two saves on one ".tmp" raced, the second rename found it gone (ENOENT, staging 11-04),
  // and the timer's unhandled rejection took the engine and every room with it.
  #saving = Promise.resolve()
  #writes = 0
  #save() {
    const write = async () => {
      await mkdir(this.dir, {recursive: true})
      const bytes = this.bytes()
      // undone back to before the first song: no song on disk either, or a restart would bring it back
      if (!bytes) return Promise.all([rm(this.path, {force: true}), rm(`${this.path}.json`, {force: true})])
      const tmp = `${this.path}.${process.pid}.${++this.#writes}.tmp`
      await writeFile(tmp, new Uint8Array(bytes))
      await rename(tmp, this.path)
      await writeFile(`${this.path}.json`, JSON.stringify({name: this.name}))
    }
    const done = this.#saving.then(write, write)
    this.#saving = done.catch(() => {})
    return done
  }
}
