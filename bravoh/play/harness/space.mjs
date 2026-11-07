// Is the Space bus all of what does not repeat? The whole mix twice, then twice with Space muted.
import {open} from "./vm.mjs"
import {writeFileSync} from "node:fs"
const pause = ms => new Promise(d => setTimeout(d, ms))
const b = await open("chromium"), at = 32 * 3840, out = {}
await b.open("&capture=1")
for (let i = 0; i < 200 && !(await b.E("!!document.querySelector('#go')")); i++) await pause(50)
await b.press("#go")
console.log(JSON.stringify(await b.E("window.np.joined")))
out.onBuses = await b.E(`window.np.devices().filter(d => ["Space", "Echo", "Reverse"].includes(d.host)).map(d => d.host + ": " + d.name)`)
await b.E("window.np.play(0)"); await pause(2000); await b.E("window.np.stop()"); await pause(300)
const twice = () => b.E(`(async () => {const one = await window.np.take(${at}); await new Promise(r => setTimeout(r, 1500)); return window.np.nullOf(one, await window.np.take(${at}))})()`)
out.wholeMix = await twice(); console.log("whole mix", JSON.stringify(out.wholeMix))
await b.E(`window.np.mute(["Space"], true)`); await pause(300)
out.spaceMuted = await twice(); console.log("Space muted", JSON.stringify(out.spaceMuted))
console.log(JSON.stringify(out.onBuses))
writeFileSync("results/space.json", JSON.stringify(out, null, 1))
await b.close(); process.exit(0)
