// Proof of the preamble: an in-process stand-in for the engine answers the four studio hands as BRAVOH's Code Mode
// (JSON over the wire), then a Producer-shaped program runs against `openDAW`.
import {BoxGraph, BoxEditing, applyUpdateTasks} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Option, Arrays} from "@opendaw/lib-std"
import {decode, encode} from "./wire.mjs"
const engine = {graph: null, editing: null, name: "", steps: 0}
const load = (buffer, skeleton) => {
  const graph = new BoxGraph(Option.wrap(BoxIO.create))
  if (skeleton) graph.fromArrayBuffer(ProjectSkeleton.decode(buffer).boxGraph.toArrayBuffer(), false); else graph.fromArrayBuffer(buffer, false)
  return graph
}
const hands = {
  studio_open: () => ({project: engine.graph ? ProjectSkeleton.encode(engine.graph) : null, name: engine.name}),
  studio_apply: ({project, name, tasks, checksum}) => {
    if (project) {engine.graph = load(project, false); engine.editing = new BoxEditing(engine.graph); engine.name = name ?? ""; return {applied: "new"}}
    if (!Arrays.equals(engine.graph.checksum(), checksum)) throw new Error("The song changed since this program read it: read it again and redo the change.")
    engine.editing.modify(() => applyUpdateTasks(engine.graph, tasks)); engine.steps++
    return {applied: tasks.length}
  },
  studio_mixdown: ({sampleRate = 48000}) => ({sampleRate, frames: [new Float32Array(4), new Float32Array(4)]}),
  studio_samples: () => [],
}
// Code Mode's RPC shape: a JSON round trip each way, a thrown error becomes a failure the preamble reads.
for (const [name, run] of Object.entries(hands))
  globalThis[`external_${name}`] = async input => {
    const args = decode(JSON.parse(JSON.stringify(input)).wire)
    try {return JSON.parse(JSON.stringify({wire: encode(await run(args))}))} catch (error) {return {failed: name, why: error.message}}
  }
const log = (label, value) => console.log(label.padEnd(40), JSON.stringify(value))
// 1. a new song, as a first build would start one
const first = openDAW.newProject("Gece")
first.bpm = 140
await first.openInStudio()
log("new song", {boxes: engine.graph.boxes().length})
// 2. the SKILL.md program
const song = await openDAW.getProject()
const bar = PPQN.fromSignature(song.timeSignature.numerator, song.timeSignature.denominator)
const bass = song.addInstrumentUnit("Neon", {label: "808", volume: -6})
const region = bass.noteTracks[0].addRegion({position: 0, duration: 4 * bar, label: "808"})
region.addEvents([{position: 0, duration: 1440, pitch: 29, velocity: 0.9}, {position: 1920, duration: 960, pitch: 29, velocity: 0.75}])
bass.addAudioEffect("Waveshaper", {mix: 0.4})
const t = performance.now()
await song.openInStudio()
log("build applied (ms, undo steps)", [Math.round(performance.now() - t), engine.steps])
// 3. one undo takes the whole build back
engine.editing.undo()
const after = await openDAW.getProject()
log("after one undo, 808 present?", after.findAudioUnit("808") !== undefined && after.findAudioUnit("808") !== null)
engine.editing.redo()
// 4. a stale edit throws into the program
const stale = await openDAW.getProject()
const other = await openDAW.getProject(); other.bpm = 150; await other.openInStudio()
stale.bpm = 90
log("stale edit", await stale.openInStudio().then(() => "applied (WRONG)", error => `threw: ${error.message}`))
// 5. a candidate: changed locally, rendered, never applied
const candidate = await openDAW.getProject()
candidate.findAudioUnit("808").volume = -20
const audio = await candidate.mixdown()
const live = await openDAW.getProject()
log("candidate render / song untouched", [audio.numberOfChannels, live.findAudioUnit("808").volume])
