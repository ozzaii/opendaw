// Proof of plug-in parity in the scripting API: a running store (server.mjs) at BASE and a headless Chrome on its engine
// page. A program picks a soundfont, an amp model and two WebCLAP plugins from the studio's own lists, sets parameters,
// renders in the page and measures the mixdown with openDAW.measure. Run with the fork's preamble (runtime build:fork):
// BASE=http://… ENGINE_TOKEN=… NAM=wavenet.nam OUT=dir node --import ../runtime/dist/preamble.mjs proof-plugins.mjs
import {spawn} from "node:child_process"
import {readFile, writeFile} from "node:fs/promises"
import {decode, encode} from "../runtime/wire.mjs"
const BASE = process.env.BASE, TOKEN = process.env.ENGINE_TOKEN, OUT = process.env.OUT ?? "."
const key = `pp-${Date.now()}`, auth = {authorization: `Bearer ${TOKEN}`}
const log = (label, value) => console.log(label.padEnd(34), JSON.stringify(value))
const store = (path, init = {}) => fetch(`${BASE}/v1/songs/${key}/${path}`, {...init, headers: auth})
const storeCall = async (method, input) => {
  const response = await store(method, {method: "POST", body: JSON.stringify(input)})
  const answer = await response.json()
  return response.ok ? answer : {failed: method, why: answer.why}
}
const chrome = spawn(process.env.CHROME ?? "google-chrome", ["--headless=new", "--no-sandbox", "--remote-debugging-port=9224", "--user-data-dir=/tmp/pp-chrome",
  `--unsafely-treat-insecure-origin-as-secure=${BASE}`, "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--mute-audio",
  "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessPermissionPrompt", "about:blank"], {stdio: "ignore"})
process.on("exit", () => chrome.kill("SIGKILL"))
let browser
for (let i = 0; i < 100 && !browser; i++) {
  await new Promise(resolve => setTimeout(resolve, 100))
  browser = await fetch("http://127.0.0.1:9224/json/version").then(r => r.json()).then(v => v.webSocketDebuggerUrl).catch(() => undefined)
}
const socket = new WebSocket(browser)
await new Promise(resolve => socket.onopen = resolve)
let ids = 0
const waiting = new Map(), pageLogs = []
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id) waiting.get(message.id)?.(message)
  else if (message.method === "Runtime.exceptionThrown" || (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)))
    pageLogs.push(JSON.stringify(message.params.exceptionDetails?.exception?.description ?? message.params.args?.map(a => a.value ?? a.description)).slice(0, 300))
}
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++ids
  waiting.set(id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result))
  socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}))
})
let page
const evaluate = async expression => {
  const {result, exceptionDetails} = await cdp("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true}, page.sessionId)
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0]?.replace(/^Error: /, "") ?? exceptionDetails.text)
  return result.value
}
const {browserContextId} = await cdp("Target.createBrowserContext")
const {targetId} = await cdp("Target.createTarget", {url: `${BASE}/#engine=${key}&token=${TOKEN}`, browserContextId})
page = {targetId, sessionId: (await cdp("Target.attachToTarget", {targetId, flatten: true})).sessionId}
await cdp("Runtime.enable", {}, page.sessionId)
for (let i = 0; ; i++) {
  if (i > 600) throw new Error("the engine page never got ready")
  const state = await evaluate(`window.engine ? Promise.race([window.engine.ready.then(() => "ready"), new Promise(r => setTimeout(() => r("wait"), 100))]) : "boot"`).catch(() => "boot")
  if (state === "ready") break
  await new Promise(resolve => setTimeout(resolve, 100))
}
// THE HANDS, routed as the API routes them, plus studio_host to the page
const callPage = (method, wire, turn) => evaluate(`window.engine.call(${JSON.stringify(method)}, ${JSON.stringify(wire)}, ${JSON.stringify(turn)})`)
const answer = async work => {try {return {wire: await work()}} catch (error) {return {failed: true, why: error.message}}}
globalThis.external_studio_open = ({wire}) => answer(() => callPage("open", wire, globalThis.turn))
globalThis.external_studio_apply = ({wire}) => decode(wire).project
  ? storeCall("apply", {wire, turn: globalThis.turn})
  : answer(() => callPage("apply", wire, globalThis.turn))
globalThis.external_studio_samples = ({wire}) => storeCall("samples", {wire, turn: globalThis.turn})
globalThis.external_studio_host = ({wire}) => answer(() => callPage("host", wire, globalThis.turn))
globalThis.external_studio_mixdown = ({wire}) => answer(async () => {
  const {render} = decode(await callPage("mixdown", wire, globalThis.turn))
  const response = await store(`renders/${render}`)
  if (!response.ok) throw new Error(`render ${render}: ${response.status}`)
  const audio = WavFile.decodeFloats(await response.arrayBuffer())
  return encode({sampleRate: audio.sampleRate, frames: audio.frames})
})
const timed = async (label, work) => {const t = performance.now(); const value = await work(); log(`${label} (ms)`, Math.round(performance.now() - t)); return value}
const maxDiff = (a, b) => {let d = 0; for (let c = 0; c < a.frames.length; c++) for (let i = 0; i < a.numberOfFrames; i++) d = Math.max(d, Math.abs(a.frames[c][i] - (b.frames[c]?.[i] ?? 0))); return +d.toFixed(4)}
const bar = PPQN.fromSignature(4, 4)

// THE PROGRAM, as BRAVOH's make would write it
globalThis.turn = "t1"
const first = openDAW.newProject("Plugin parity"); first.bpm = 110; await first.openInStudio()
globalThis.turn = "t2"
const fonts = await timed("listSoundfonts", () => openDAW.listSoundfonts())
const font = fonts.find(one => /piano/i.test(one.name)) ?? fonts[0]
log("soundfonts (count, picked)", [fonts.length, font?.name])
await openDAW.addNamModel(await readFile(process.env.NAM ?? "wavenet.nam", "utf8"), "WaveNet Crunch")
const models = await openDAW.listNamModels()
const model = models.find(one => /crunch/i.test(one.name))
log("amp models (names, picked kB)", [models.map(one => one.name), Math.round(model.model.length / 1024)])
const plugins = await timed("listWclaps", () => openDAW.listWclaps())
log("wclaps", plugins.map(one => `${one.name} [${one.features.slice(0, 2).join(",")}]`))
const instrument = plugins.find(one => one.features.includes("instrument") && one.features.includes("synthesizer")) ?? plugins.find(one => one.features.includes("instrument"))
const effect = plugins.find(one => !one.features.includes("instrument") && /delay|chorus|reverb/i.test(`${one.name} ${one.features}`)) ?? plugins.find(one => !one.features.includes("instrument"))
const instrumentParams = await timed(`describeWclap ${instrument.name}`, () => openDAW.describeWclap(instrument))
const effectParams = await timed(`describeWclap ${effect.name}`, () => openDAW.describeWclap(effect))
log("parameters (instrument, effect)", [instrumentParams.length, effectParams.length])
// two continuous parameters each, moved well off their defaults
const twoOf = params => params.filter(one => (one.flags & 1) === 0 && one.max > one.min).slice(0, 2)
  .map(info => ({info, value: info.defaultValue > (info.min + info.max) / 2 ? info.min + 0.2 * (info.max - info.min) : info.min + 0.8 * (info.max - info.min)}))
const synthSet = twoOf(instrumentParams), effectSet = twoOf(effectParams)
log("instrument params set", synthSet.map(({info, value}) => `${info.name}: ${info.defaultValue} -> ${+value.toFixed(3)}`))
log("effect params set", effectSet.map(({info, value}) => `${info.name}: ${info.defaultValue} -> ${+value.toFixed(3)}`))

const song = await openDAW.getProject()
const keys = song.addInstrumentUnit("Soundfont", {label: "Keys", volume: -8})
keys.instrument.file = font
keys.addAudioEffect("NeuralAmp", {mix: 1}).model = model
keys.noteTracks[0].addRegion({position: 0, duration: 8 * bar, label: "Keys"})
  .addEvents([0, 1, 2, 3, 4, 5, 6, 7].flatMap(b => [48, 52, 55].map(pitch => ({position: b * bar, duration: bar, pitch: pitch + [0, 5, 7, 3][b % 4], velocity: 0.8}))))
const synth = song.addInstrumentUnit("Wclap", {label: "Synth", volume: -10})
synth.instrument.plugin = instrument
synthSet.forEach(({info, value}) => synth.instrument.setParameter(info, value))
const fx = synth.addAudioEffect("Wclap")
fx.plugin = effect
effectSet.forEach(({info, value}) => fx.setParameter(info, value))
synth.noteTracks[0].addRegion({position: 0, duration: 8 * bar, label: "Synth"})
  .addEvents([...Array(32)].map((_, i) => ({position: i * bar / 4, duration: bar / 8, pitch: 60 + [0, 7, 12, 3][i % 4], velocity: 0.9})))
await timed("apply song", () => song.openInStudio())
const kept = await openDAW.getProject()
log("song (page)", kept.instrumentUnits.map(unit => `${unit.label}:${unit.instrument.key}+${unit.audioEffects.map(e => e.key).join("+")}`))
log("kept parameters (instrument, effect)", [kept.findAudioUnit("Synth").instrument.parameters.map(p => `${p.name}=${+p.value.toFixed(3)}`),
  kept.findAudioUnit("Synth").audioEffects[0].parameters.map(p => `${p.name}=${+p.value.toFixed(3)}`)])
const mix = await timed("mixdown", () => kept.mixdown())
await writeFile(`${OUT}/plugins-mix.wav`, new Uint8Array(WavFile.encodeFloats(mix)))
log("measure(mixdown)", openDAW.measure(mix))
// what each part does to the sound: candidates rendered and never applied
const without = async change => {const candidate = await openDAW.getProject(); change(candidate); return maxDiff(mix, await candidate.mixdown())}
log("diff: effect params at defaults", await without(c => effectSet.forEach(({info}) => c.findAudioUnit("Synth").audioEffects[0].setParameter(info, info.defaultValue))))
log("diff: instrument params at defaults", await without(c => synthSet.forEach(({info}) => c.findAudioUnit("Synth").instrument.setParameter(info, info.defaultValue))))
log("diff: amp model removed", await without(c => c.findAudioUnit("Keys").audioEffects[0].model = null))
log("diff: synth muted", await without(c => c.findAudioUnit("Synth").mute = true))
log("page warnings/errors", pageLogs.slice(0, 12))
chrome.kill(); process.exit(0)
