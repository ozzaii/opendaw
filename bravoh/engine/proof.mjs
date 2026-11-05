// Proof of the engine page (Phase 1): a running store (server.mjs) at BASE and a headless Chrome on its engine page
// (`/#engine=<key>&token=`). BRAVOH's preamble runs here as a program would, its four studio hands routed the way the
// API routes them: open, apply with tasks and mixdown to the page (window.engine.call over CDP), a whole new project
// and samples to the store. Usage: BASE=http://… ENGINE_TOKEN=… [CHROME=google-chrome] [NAM=lstm.nam] [OUT=dir] node dist/proof.mjs
import {spawn, execSync} from "node:child_process"
import {readFile, writeFile} from "node:fs/promises"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, NeuralAmpModelBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Option, UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import {decode, encode} from "../runtime/wire.mjs"
const BASE = process.env.BASE, TOKEN = process.env.ENGINE_TOKEN, OUT = process.env.OUT ?? "."
const key = `p1-${Date.now()}`, auth = {authorization: `Bearer ${TOKEN}`}
const log = (label, value) => console.log(label.padEnd(40), JSON.stringify(value))
const store = (path, init = {}) => fetch(`${BASE}/v1/songs/${key}/${path}`, {...init, headers: auth})
const storeCall = async (method, input) => {
  const response = await store(method, {method: "POST", body: JSON.stringify(input)})
  const answer = await response.json()
  return response.ok ? answer : {failed: method, why: answer.why}
}
// CHROME, headless, no display or sound card: the engine host's own launch
const chrome = spawn(process.env.CHROME ?? "google-chrome", ["--headless=new", "--no-sandbox", "--remote-debugging-port=9223", "--user-data-dir=/tmp/p1-chrome",
  `--unsafely-treat-insecure-origin-as-secure=${BASE}`, "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--mute-audio",
  "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessPermissionPrompt", "about:blank"], {stdio: "ignore"})
process.on("exit", () => chrome.kill("SIGKILL"))
let browser
for (let i = 0; i < 100 && !browser; i++) {
  await new Promise(resolve => setTimeout(resolve, 100))
  browser = await fetch("http://127.0.0.1:9223/json/version").then(r => r.json()).then(v => v.webSocketDebuggerUrl).catch(() => undefined)
}
const socket = new WebSocket(browser)
await new Promise(resolve => socket.onopen = resolve)
let ids = 0
const waiting = new Map(), pageLogs = []
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id) waiting.get(message.id)?.(message)
  else if (message.method === "Runtime.exceptionThrown" || (message.method === "Runtime.consoleAPICalled" && (process.env.VERBOSE || ["error", "warning"].includes(message.params.type))))
  {
    pageLogs.push(JSON.stringify(message.params.exceptionDetails?.exception?.description ?? message.params.args?.map(a => a.value ?? a.description)).slice(0, 300))
    if (process.env.VERBOSE) console.log("[page]", pageLogs.at(-1))
  }
}
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++ids
  waiting.set(id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result))
  socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}))
})
let page // {targetId, sessionId}
const evaluate = async expression => {
  const {result, exceptionDetails} = await cdp("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true}, page.sessionId)
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0]?.replace(/^Error: /, "") ?? exceptionDetails.text)
  return result.value
}
// a fresh browser context per song, as the engine host opens one
const openPage = async () => {
  const t0 = performance.now()
  const {browserContextId} = await cdp("Target.createBrowserContext")
  const {targetId} = await cdp("Target.createTarget", {url: `${BASE}/#engine=${key}&token=${TOKEN}`, browserContextId})
  const {sessionId} = await cdp("Target.attachToTarget", {targetId, flatten: true})
  page = {targetId, sessionId, browserContextId}
  await cdp("Runtime.enable", {}, sessionId)
  for (let i = 0; i < 600; i++) {
    const state = await evaluate(`window.engine ? Promise.race([window.engine.ready.then(() => "ready"), new Promise(r => setTimeout(() => r("wait"), 100))]) : "boot"`).catch(() => "boot")
    if (state === "ready") return Math.round(performance.now() - t0)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error("the engine page never got ready")
}
const callPage = (method, wire, turn) => evaluate(`window.engine.call(${JSON.stringify(method)}, ${JSON.stringify(wire)}, ${JSON.stringify(turn)})`)
const timings = {}
const timed = async (name, work) => {const t = performance.now(); const value = await work(); (timings[name] ??= []).push(Math.round(performance.now() - t)); return value}
// THE HANDS, routed as the API routes them (packages/ai/src/studio/engine.ts)
const answer = async work => {try {return {wire: await work()}} catch (error) {return {failed: true, why: error.message}}}
globalThis.external_studio_open = ({wire}) => answer(() => timed("open", () => callPage("open", wire, globalThis.turn)))
globalThis.external_studio_apply = ({wire}) => decode(wire).project
  ? storeCall("apply", {wire, turn: globalThis.turn})
  : answer(() => timed("apply", () => callPage("apply", wire, globalThis.turn)))
globalThis.external_studio_samples = ({wire}) => storeCall("samples", {wire, turn: globalThis.turn})
globalThis.external_studio_mixdown = ({wire}) => answer(async () => {
  const {render} = decode(await timed("mixdown", () => callPage("mixdown", wire, globalThis.turn)))
  const response = await store(`renders/${render}`)
  if (!response.ok) throw new Error(`render ${render}: ${response.status}`)
  const audio = WavFile.decodeFloats(await response.arrayBuffer())
  if ((await store(`renders/${render}`)).status !== 404) throw new Error("a render was readable twice")
  return encode({sampleRate: audio.sampleRate, frames: audio.frames})
})
await import("../runtime/preamble.mjs")
const levels = audio => {
  let peak = 0, sum = 0, n = 0
  for (const channel of audio.frames) for (const value of channel) {peak = Math.max(peak, Math.abs(value)); sum += value * value; n++}
  return {seconds: +(audio.numberOfFrames / audio.sampleRate).toFixed(2), peakDb: +(20 * Math.log10(peak)).toFixed(1), rmsDb: +(10 * Math.log10(sum / n)).toFixed(1)}
}
const save = async (name, audio) => writeFile(`${OUT}/${name}.wav`, new Uint8Array(WavFile.encodeFloats(audio)))
const units = async () => (await openDAW.getProject()).instrumentUnits.map(unit => `${unit.label}:${unit.instrument?.key}`)
const rss = () => { try { return Number(execSync("ps -o rss= -C chrome | awk '{s+=$1} END {print int(s/1024)}'").toString().trim()) } catch { return null } }
const bar = PPQN.fromSignature(4, 4)

log("page ready (ms, no song yet)", await openPage())
// a. a program-equivalent sequence
globalThis.turn = "t1"
const first = openDAW.newProject("Proof"); first.bpm = 124; await first.openInStudio()
globalThis.turn = "t2"
const library = await openDAW.listSamples()
const pick = word => library.find(sample => new RegExp(word, "i").test(sample.name))
const song = await openDAW.getProject()
const drums = song.addInstrumentUnit("Playfield", {label: "Drums", volume: -3})
const kick = pick("kick"), snare = pick("snare|clap"), hat = pick("hat|hh")
log("library samples (kick/snare/hat)", [library.length, kick?.name, snare?.name, hat?.name])
drums.instrument.addSample(kick, {note: 36}); drums.instrument.addSample(snare, {note: 38}); drums.instrument.addSample(hat, {note: 42})
const beat = drums.noteTracks[0].addRegion({position: 0, duration: 8 * bar, label: "Beat"})
for (let b = 0; b < 8; b++) beat.addEvents([
  {position: b * bar, duration: 240, pitch: 36, velocity: 1}, {position: b * bar + bar / 2, duration: 240, pitch: 36, velocity: 0.9},
  {position: b * bar + bar / 4, duration: 240, pitch: 38, velocity: 0.9}, {position: b * bar + 3 * bar / 4, duration: 240, pitch: 38, velocity: 0.9},
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => ({position: b * bar + i * bar / 8, duration: 120, pitch: 42, velocity: 0.6}))])
const bass = song.addInstrumentUnit("Neon", {label: "Bass", volume: -6})
bass.noteTracks[0].addRegion({position: 0, duration: 8 * bar, label: "Bass"})
  .addEvents([...Array(16)].map((_, i) => ({position: i * bar / 2, duration: bar / 4, pitch: 36 + [0, 0, 3, 5][i % 4], velocity: 0.9})))
const a0 = performance.now()
await song.openInStudio()
log("apply drums + bass (program ms)", Math.round(performance.now() - a0))
log("song after t2 (page)", await units())
log("song after t2 (store facts)", await (await store("song")).json().then(f => ({tracks: f.tracks.map(t => t.name), bars: f.bars, tempo: f.tempo})))
const stale = await openDAW.getProject()
const other = await openDAW.getProject(); other.bpm = 128; await other.openInStudio()
stale.bpm = 90
log("stale edit", await stale.openInStudio().then(() => "applied (WRONG)", error => `threw: ${error.message}`))
const phrase = await openDAW.getProject()
phrase.loop.enabled = true; phrase.loop.from = 0; phrase.loop.to = 8 * bar
const eight = await phrase.mixdown()
await save("a-8bars", eight)
log("8-bar mixdown", {...levels(eight), expected: +(8 * 4 * 60 / 128).toFixed(2), ms: timings.mixdown.at(-1)})
log("GET audio before bounce", await store("audio").then(async r => [r.status, await r.json()]))
const bounced = decode(await timed("bounce", () => callPage("bounce", "{}", "t2")))
const audio = await store("audio")
const m4a = new Uint8Array(await audio.arrayBuffer())
await writeFile(`${OUT}/a-bounce.m4a`, m4a)
log("bounce → GET audio", {version: bounced.version, status: audio.status, type: audio.headers.get("content-type"), kb: Math.round(m4a.length / 1024), ms: timings.bounce.at(-1)})
// b. a Soundfont instrument and a NeuralAmp effect render in the page
globalThis.turn = "t3"
const soundfonts = await fetch("https://assets.opendaw.studio/soundfonts/index.json", {headers: {authorization: `Basic ${btoa("openDAW:prototype")}`}}).then(r => r.json())
const flat = []; const walk = node => {for (const one of node.soundfonts ?? node.files ?? []) flat.push(one); for (const inner of node.folders ?? []) walk(inner)}
Array.isArray(soundfonts) ? soundfonts.forEach(one => flat.push(one)) : walk(soundfonts)
const font = flat.filter(one => one.uuid).sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0]
log("soundfont", {name: font?.name, mb: +((font?.size ?? 0) / 1048576).toFixed(1), of: flat.length})
const keysSong = await openDAW.getProject()
const piano = keysSong.addInstrumentUnit("Soundfont", {label: "Keys", volume: -6})
piano.instrument.file = {uuid: font.uuid, name: font.name}
const amp = piano.addAudioEffect("NeuralAmp", {mix: 1})
piano.noteTracks[0].addRegion({position: 0, duration: 4 * bar, label: "Keys"})
  .addEvents([48, 55, 60, 64].map((pitch, i) => ({position: i * bar, duration: bar, pitch, velocity: 0.8})))
await keysSong.openInStudio()
// the model is chosen in the studio, not through the scripting API: set here as the studio's NAM picker does,
// a NeuralAmpModelBox with the .nam text, as update tasks through the same apply
const nam = await readFile(process.env.NAM ?? "lstm.nam", "utf8")
const {project: bytes} = decode((await external_studio_open({wire: encode({})})).wire)
const graph = new BoxGraph(Option.wrap(BoxIO.create)); graph.fromArrayBuffer(ProjectSkeleton.decode(bytes).boxGraph.toArrayBuffer(), false)
const checksum = graph.checksum(), tasks = []
graph.subscribeToAllUpdatesImmediate({onUpdate: update => tasks.push(
  update.type === "new" ? {type: "new", name: update.name, uuid: update.uuid, buffer: update.settings}
    : update.type === "primitive" ? {type: "update-primitive", address: update.address.decompose(), primitiveType: update.serialization.type, value: update.newValue}
      : {type: "update-pointer", address: update.address.decompose(), target: update.newAddress.unwrapOrNull()?.decompose()})})
graph.beginTransaction()
const device = graph.boxes().find(box => box.name === "NeuralAmpDeviceBox")
const model = NeuralAmpModelBox.create(graph, UUID.generate(), box => {box.label.setValue("lstm"); box.model.setValue(nam)})
device.model.refer(model)
graph.endTransaction()
log("NAM model tasks applied", (await external_studio_apply({wire: encode({tasks, checksum})})).wire ?? "FAILED")
const withAmp = await (await openDAW.getProject()).mixdown()
await save("b-soundfont-nam", withAmp)
const dry = await openDAW.getProject(); dry.findAudioUnit("Keys").audioEffects[0].mix = 0
const withoutAmp = await dry.mixdown()
await save("b-soundfont-dry", withoutAmp)
let diff = 0; for (let i = 0; i < withAmp.frames[0].length; i++) diff = Math.max(diff, Math.abs(withAmp.frames[0][i] - (withoutAmp.frames[0][i] ?? 0)))
log("soundfont + NAM render", {nam: levels(withAmp), dry: levels(withoutAmp), maxDiff: +diff.toFixed(3)})
log("units now", await units())
// c. undo by turn: the snapshot comes back in a new room, the page rejoins
const u0 = performance.now()
log("undo 1 turn", await storeCall("undo", {turns: 1}))
log("after undo (page)", {units: await units(), ms: Math.round(performance.now() - u0)})
// d. the page dies, a new one opens: the song is intact
const before = await units()
await cdp("Target.closeTarget", {targetId: page.targetId}); await cdp("Target.disposeBrowserContext", {browserContextId: page.browserContextId})
log("page reopened (ms)", await openPage())
log("song after reopen intact?", {units: await units(), same: JSON.stringify(await units()) === JSON.stringify(before)})
// e. timings
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
log("timings ms (median of calls)", Object.fromEntries(Object.entries(timings).map(([name, list]) => [name, {median: median(list), n: list.length}])))
log("chrome RSS MB (one song page)", rss())
log("page warnings/errors", pageLogs.slice(0, 15))
chrome.kill(); process.exit(0)
