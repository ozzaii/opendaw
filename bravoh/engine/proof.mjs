// Proof of the engine: the runtime's preamble talks to this server over HTTP the way BRAVOH's hands will, a
// Producer-shaped program builds a song, renders a phrase for real, and one undo takes the build back.
import {server} from "./server.mjs"
const token = process.env.ENGINE_TOKEN
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}/v1/songs/proof-${Date.now()}`
const post = async (method, input) => {
  const response = await fetch(`${base}/${method}`, {method: "POST", headers: {authorization: `Bearer ${token}`}, body: JSON.stringify(input)})
  const answer = await response.json()
  return response.ok ? answer : {failed: method, why: answer.why}
}
for (const name of ["open", "apply", "mixdown", "samples"])
  globalThis[`external_studio_${name}`] = ({wire}) => post(name, {wire, turn: globalThis.turn})
await import("../runtime/preamble.mjs")
const log = (label, value) => console.log(label.padEnd(36), JSON.stringify(value))
globalThis.turn = "t1"
const first = openDAW.newProject("Gece")
first.bpm = 140
await first.openInStudio()
globalThis.turn = "t2"
const song = await openDAW.getProject()
const bar = PPQN.fromSignature(4, 4)
const bass = song.addInstrumentUnit("Vaporisateur", {label: "Bass", volume: -6})
bass.noteTracks[0].addRegion({position: 0, duration: 4 * bar, label: "Bass"}).addEvents(
  [0, 1, 2, 3].map(index => ({position: index * bar, duration: 1440, pitch: 41 - index * 2, velocity: 0.9})))
const keys = song.addInstrumentUnit("Tubular", {label: "Keys", volume: -10})
keys.noteTracks[0].addRegion({position: 0, duration: 4 * bar}).addEvents([53, 56, 60].map(pitch => ({position: 0, duration: 4 * bar, pitch, velocity: 0.6})))
await song.openInStudio()
log("song as the phone draws it", await (await fetch(`${base}/song`, {headers: {authorization: `Bearer ${token}`}})).json().then(facts => ({tracks: facts.tracks.map(track => track.name), bars: facts.bars, tempo: facts.tempo, notes: facts.regions.map(region => region.notes?.length)})))
const phrase = await openDAW.getProject()
phrase.loop.enabled = true; phrase.loop.from = 0; phrase.loop.to = 2 * bar
const t = performance.now()
const audio = await phrase.mixdown()
const ms = performance.now() - t
let peak = 0; for (const channel of audio.frames) for (const value of channel) peak = Math.max(peak, Math.abs(value))
log("2-bar phrase render", {seconds: +(audio.numberOfFrames / audio.sampleRate).toFixed(2), expected: +(2 * 4 * 60 / 140).toFixed(2), ms: Math.round(ms), peak: +peak.toFixed(3)})
const full = await (await openDAW.getProject()).mixdown()
log("whole song render seconds", +(full.numberOfFrames / full.sampleRate).toFixed(2))
const {writeFile} = await import("node:fs/promises")
await writeFile("dist/proof.wav", new Uint8Array(WavFile.encodeFloats(full)))
log("undo turn t2", await (await fetch(`${base}/undo`, {method: "POST", headers: {authorization: `Bearer ${token}`}, body: JSON.stringify({turns: 1})})).json())
log("after undo", (await openDAW.getProject()).instrumentUnits.map(unit => unit.label))
server.close()
