// One song: its graph, its undo (BoxEditing, one step per applied program, each marked with the turn that made it),
// and its bytes on disk after every change.
import {mkdir, readFile, rename, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {BoxGraph, BoxEditing, applyUpdateTasks} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Arrays, Option} from "@opendaw/lib-std"
const graphOf = bytes => {
  const graph = new BoxGraph(Option.wrap(BoxIO.create))
  graph.fromArrayBuffer(ProjectSkeleton.decode(bytes).boxGraph.toArrayBuffer(), false)
  return graph
}
const asBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
export class Song {
  static async open(dir, key) {
    const song = new Song(dir, key)
    const bytes = await readFile(song.path).catch(error => {if (error.code === "ENOENT") return null; throw error})
    if (bytes) {
      const {name} = JSON.parse(await readFile(`${song.path}.json`, "utf8").catch(() => '{"name":""}'))
      song.#attach(graphOf(asBuffer(bytes)), name ?? "")
    }
    return song
  }
  #graph = null
  #room = null
  #generation = 0
  #editing = null
  #steps = []
  name = ""
  constructor(dir, key) {this.dir = dir; this.path = join(dir, `${key}.od`)}
  #attach(graph, name) {
    this.#graph = graph; this.#editing = graph ? new BoxEditing(graph) : null; this.#steps = []; this.name = name
    this.#room?.close(); this.#room = null; this.#generation++
    // the booth page writes too (plugin state, migration repairs): those land in this graph and are kept
    graph?.subscribeToAllUpdates({onUpdate: () => this.#later()})
  }
  #timer = null
  #later() {clearTimeout(this.#timer); this.#timer = setTimeout(() => void this.#save(), 500)}
  // The room the booth page joins, made on first ask for this graph.
  async room(open) {
    if (!this.#graph) return null
    this.#room ??= await open(`${this.path.split("/").pop().replace(/\.od$/, "")}-${this.#generation}`, this.#graph)
    return this.#room.name
  }
  get graph() {return this.#graph}
  bytes() {return this.#graph ? ProjectSkeleton.encode(this.#graph) : null}
  // A booth opened before any program wrote a song: an empty one under the booth's title, so the studio is there at once.
  // Not an undo step: there is nothing to take back to. A song that exists is left as it is.
  async start(name) {
    if (this.#graph) return {started: false}
    this.#attach(ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: true}).boxGraph, name ?? "")
    await this.#save()
    return {started: true}
  }
  // A whole new song (openDAW.newProject().openInStudio()): the one before is kept beside it and comes back on undo.
  async replace(buffer, name, turn) {
    const before = this.bytes()
    if (before) await writeFile(join(this.dir, `${this.path.split("/").pop()}.${Date.now()}.before`), new Uint8Array(before))
    const graph = new BoxGraph(Option.wrap(BoxIO.create))
    graph.fromArrayBuffer(buffer, false)
    this.#attach(graph, name ?? "")
    this.#steps.push({turn, before, name: this.name})
    await this.#save()
    return {applied: "new"}
  }
  // ScriptHostProtocol.applyUpdates: refused when the song moved since the program read it.
  async apply(tasks, checksum, turn) {
    if (!this.#graph) throw new Error("There is no song in the booth yet: start one with openDAW.newProject().")
    if (!Arrays.equals(this.#graph.checksum(), checksum)) throw new Error("The song changed since this program read it: read it again and redo the change.")
    this.#editing.modify(() => applyUpdateTasks(this.#graph, tasks))
    this.#steps.push({turn})
    await this.#save()
    return {applied: tasks.length}
  }
  // The edits of the last `turns` turns that wrote, newest first.
  async undo(turns = 1) {
    const taken = new Set()
    let undone = 0
    while (this.#steps.length > 0) {
      const step = this.#steps.at(-1)
      if (!taken.has(step.turn) && taken.size >= turns) break
      taken.add(step.turn)
      this.#steps.pop()
      if ("before" in step) {
        const restored = step.before ? graphOf(step.before) : null
        const steps = this.#steps
        this.#attach(restored, step.name)
        this.#steps = restored ? [] : steps
        undone++
        break
      }
      this.#editing.undo()
      undone++
    }
    await this.#save()
    return {undone, turns: taken.size}
  }
  async #save() {
    await mkdir(this.dir, {recursive: true})
    const bytes = this.bytes()
    if (!bytes) return
    await writeFile(`${this.path}.tmp`, new Uint8Array(bytes))
    await rename(`${this.path}.tmp`, this.path)
    await writeFile(`${this.path}.json`, JSON.stringify({name: this.name}))
  }
}
