// Proof of the live booth: a program writes the song through the engine, the booth page (headless Chromium) joins
// its room and plays it, a second program's edit reaches the playing page, and one undo takes it back out.
import {server} from "./server.mjs"
const {chromium} = await import(process.env.PLAYWRIGHT ?? "playwright-core")
const token = process.env.ENGINE_TOKEN
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`, key = `booth-${Date.now()}`
const base = `${origin}/v1/songs/${key}`, auth = {authorization: `Bearer ${token}`}
const post = async (method, input) => {
  const response = await fetch(`${base}/${method}`, {method: "POST", headers: auth, body: JSON.stringify(input)})
  const answer = await response.json()
  return response.ok ? answer : {failed: method, why: answer.why}
}
for (const name of ["open", "apply", "mixdown", "samples"]) globalThis[`external_studio_${name}`] = ({wire}) => post(name, {wire, turn: globalThis.turn})
await import("../runtime/preamble.mjs")
const log = (label, value) => console.log(label.padEnd(34), JSON.stringify(value))
const bar = PPQN.fromSignature(4, 4)
globalThis.turn = "t1"
const first = openDAW.newProject("Booth"); first.bpm = 120; await first.openInStudio()
const song = await openDAW.getProject()
const bass = song.addInstrumentUnit("Vaporisateur", {label: "Bass", volume: -6})
bass.noteTracks[0].addRegion({position: 0, duration: 8 * bar}).addEvents([...Array(16)].map((_, index) => ({position: index * bar / 2, duration: bar / 4, pitch: 36 + (index % 4) * 3, velocity: 0.9})))
await song.openInStudio()
const browser = await chromium.launch({executablePath: process.env.CHROME, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"]})
const page = await browser.newPage()
page.on("pageerror", error => console.log("[pageerror]", error.message))
page.on("console", message => {if (message.type() === "error") console.log("[page]", message.text().slice(0, 200))})
const t0 = Date.now()
await page.goto(`${origin}/booth/#key=${key}&token=${token}`)
log("page joined", {...await page.evaluate(() => window.booth.joined), ms: Date.now() - t0})
await page.evaluate(() => window.booth.play(0))
await page.waitForTimeout(1500)
log("playing", await page.evaluate(() => window.booth.state()))
log("transport (bars)", await page.evaluate(() => window.booth.transport()))
await page.evaluate(() => window.booth.move({bar: 5}))
await page.waitForTimeout(300)
log("moved to bar 5", await page.evaluate(() => window.booth.transport()))
globalThis.turn = "t2"
const edit = await openDAW.getProject()
const keys = edit.addInstrumentUnit("Tubular", {label: "Keys", volume: -12})
keys.noteTracks[0].addRegion({position: 0, duration: 8 * bar}).addEvents([60, 63, 67].map(pitch => ({position: 0, duration: 8 * bar, pitch, velocity: 0.6})))
const before = await page.evaluate(() => window.booth.state().units)
const heard = page.waitForFunction(units => window.booth.state().units > units, before, {polling: "raf", timeout: 5000})
const e0 = performance.now()
await edit.openInStudio()
await heard
log("edit heard in the page (ms)", Math.round(performance.now() - e0))
await page.waitForTimeout(800)
log("still playing, with keys", await page.evaluate(() => window.booth.state()))
const u0 = performance.now()
log("undo t2", await (await fetch(`${base}/undo`, {method: "POST", headers: auth, body: JSON.stringify({turns: 1})})).json())
await page.waitForFunction(() => window.booth.state().units <= 3, null, {polling: 2, timeout: 5000}).catch(() => {})
log("after undo in the page", {...await page.evaluate(() => window.booth.state()), ms: Math.round(performance.now() - u0)})
await browser.close(); server.close(); process.exit(0)
