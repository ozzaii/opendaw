// Which lane does not repeat itself? One lane alone, the same 14 s twice on one page; what is left when the takes are subtracted.
import {open} from "./vm.mjs"
import {writeFileSync} from "node:fs"
const pause = ms => new Promise(d => setTimeout(d, ms))
const b = await open(process.argv[2] ?? "chromium"), BAR = Number(process.argv[3] ?? 33)
const out = {bar: BAR, lanes: {}}
await b.open("&capture=1")
for (let i = 0; i < 200 && !(await b.E("!!document.querySelector('#go')")); i++) await pause(50)
await b.press("#go")
const joined = await b.E("window.np.joined"); console.log(JSON.stringify(joined))
if (joined.storeFailed) process.exit(1)
out.devices = await b.E("(() => {const c = {}; for (const d of window.np.devices()) c[d.name] = (c[d.name] ?? 0) + 1; return c})()")
out.freeRunning = await b.E("window.np.devices().filter(d => d.code || /Lfo/.test(d.name)).map(d => ({name: d.name, host: d.host, label: d.label, sync: d.sync, code: (d.code || '').slice(0, 300)}))")
console.log(JSON.stringify(out.devices)); console.log(JSON.stringify(out.freeRunning).slice(0, 1500))
const all = await b.E("window.np.units().map(u => ({name: u.name, mute: u.mute}))")
console.log("units", all.length)
const lanes = all.filter(u => !u.mute && u.name).map(u => u.name)
await b.E("window.np.play(0)"); await pause(2000); await b.E("window.np.stop()"); await pause(300)
for (const lane of lanes) {
  await b.E(`window.np.solo(${JSON.stringify([lane])}, true)`); await pause(200)
  const r = await b.E(`(async () => {
    const at = ${BAR - 1} * 3840
    const one = await window.np.take(at); await new Promise(r => setTimeout(r, 1500)); const two = await window.np.take(at)
    return window.np.nullOf(one, two)})()`).catch(e => ({error: String(e).slice(0, 200)}))
  await b.E(`window.np.solo(${JSON.stringify([lane])}, false)`); await pause(1500)
  out.lanes[lane] = r; console.log(lane.padEnd(24), JSON.stringify(r))
}
writeFileSync("results/lanes.json", JSON.stringify(out, null, 1))
await b.close(); process.exit(0)
