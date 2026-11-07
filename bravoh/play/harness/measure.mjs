// node measure.mjs <safari|chromium> <load|pass|ms> [label] — one scenario on the VM's real browser, the song's whole page.
import {writeFileSync} from "node:fs"
import {open, usage, footprint} from "./vm.mjs"
const [name, scenario, label = `${name}-${scenario}`] = process.argv.slice(2)
const pause = ms => new Promise(d => setTimeout(d, ms))
const stats = xs => {const s = [...xs].sort((a, b) => a - b); return {n: s.length, min: s[0], median: s[s.length >> 1], max: s.at(-1)}}
const say = (k, v) => console.log(k.padEnd(26), typeof v === "string" ? v : JSON.stringify(v))
const out = {name, scenario, label}
const note = (k, v) => {out[k] = v; say(k, v)}
const b = await open(name)
note("version", b.version)
// the press, then everything the page needs, then the song's first sound on the tap
const load = async extra => {
  const t0 = Date.now()
  await b.open(extra)
  for (let i = 0; i < 200 && !(await b.E("!!document.querySelector('#go')")); i++) await pause(50)
  const script = Date.now() - t0
  await b.press("#go")
  const joined = await Promise.race([b.E("window.np.joined"), pause(150000).then(() => ({hung: true}))])
  if (joined.hung) {out.hangs = (out.hangs ?? 0) + 1; const marks = await b.E("window.np.marks()"); say("JOIN HUNG", marks); return {hung: true, marks}}
  if (joined.failed || joined.error) throw new Error(JSON.stringify(joined))
  if (joined.storeFailed) throw new Error(`NOT CLEAN: ${joined.storeFailed} samples not stored; page says: ${await b.E("document.querySelector('#store-failed')?.textContent")}`)
  const marks = await b.E("window.np.marks()"), samples = await b.E("window.np.samples()")
  const first = await b.E(`(async () => {const q = window.np.now(), w = Date.now(); window.np.play(0); const c = await window.np.crossing(q, -60, true, 15000, 2); return {ms: window.np.stamp(c.quantum) - w, q, press: performance.timeOrigin + window.np.marks().pressed, sound: window.np.stamp(c.quantum)}})()`)
  await pause(3000)
  const stalls = await b.E(`window.np.stalls(${first.q}, 30)`)
  await b.E("window.np.stop()"); await pause(500)
  const res = await b.E(`performance.getEntriesByType("resource").map(r => [r.name.split("/").pop().split("?")[0].slice(0, 40), r.decodedBodySize, Math.round(r.duration)])`)
  return {scriptMs: script, pressToSoundMs: Math.round(first.sound - first.press), playToSoundMs: first.ms, marks, fetched: samples.fetched, sampleMB: +(samples.bytes / 1e6).toFixed(1), failed: samples.failed, firstPlayStalls: stalls, res: extra === "" ? undefined : res}
}
try {
  if (scenario === "load") {
    const shape = process.env.SHAPE ?? "local"
    const cold = await load("")
    note("isolated", await b.E("({coi: crossOriginIsolated, ua: navigator.userAgent})"))
    note(`${shape} cold`, cold)
    note("resources", (await b.E(`performance.getEntriesByType("resource").map(r => [r.name.split("/").pop().split("?")[0].slice(0, 40), r.decodedBodySize, Math.round(r.duration)])`)).filter(r => !/^sample$/.test(r[0])).slice(0, 12))
    note("opfs", await b.E("navigator.storage.estimate().then(e => e.usage / 1e6)"))
    for (let i = 0; i < 3; i++) note(`${shape} warm${i}`, await load(""))
    const plays = []
    for (let i = 0; i < 6; i++) {
      plays.push((await b.E(`(async () => {const q = window.np.now(), w = Date.now(); window.np.play(${i % 2 ? 49 * 3840 : 0}); const c = await window.np.crossing(q, -60, true, 15000, 2); return window.np.stamp(c.quantum) - w})()`)))
      await pause(1500); await b.E("window.np.stop()"); await pause(500)
    }
    note("armed play ms", {...stats(plays), all: plays})
  }
  if (scenario === "pass") {
    const j = await load(process.env.NOPOLL ? "" : "&capture=1")
    note("load", {...j, res: undefined})
    await pause(1000)
    note("context at start", await b.E("window.np.context()"))
    const before = usage(b), q0 = await b.E(`(() => {const q = window.np.now(); ${process.env.NOPOLL ? "" : "window.np.captureStart();"} window.np.play(0); return q})()`)
    const t0 = Date.now(), budget = 128 / 48
    let n = 0, sum = 0, max = 0, over = 0, seen = null, peak = {}
    const hist = new Array(12).fill(0)
    const SECONDS = Number(process.env.SECONDS ?? 216)
    let nextUsage = 0, pos0 = null
    if (process.env.NOPOLL) await pause(SECONDS * 1000)
    while (!process.env.NOPOLL && Date.now() - t0 < SECONDS * 1000) {
      await pause(400)
      const {buffer, index} = await b.E("window.np.perf()")
      if (buffer?.length) {
        let i = seen ?? index
        while (i !== index) {const ms = buffer[i]; n++; sum += ms; if (ms > max) max = ms; if (ms >= budget) over++; hist[Math.min(11, Math.floor(ms / budget * 10))]++; i = (i + 1) % buffer.length}
        seen = index
      }
      if (Date.now() > nextUsage) {nextUsage = Date.now() + 15000; for (const u of usage(b)) peak[u.role] = Math.max(peak[u.role] ?? 0, u.rssMB)}
    }
    const wall = (Date.now() - t0) / 1000, after = usage(b)
    const pageProc = after.filter(u => u.role === "page").sort((a, c) => c.rssMB - a.rssMB)[0]
    note("footprint", footprint(pageProc.pid))
    const byRole = {}
    for (const a of after) {const was = before.find(x => x.pid === a.pid); if (was) {byRole[a.role] = {cpuPct: +(((byRole[a.role]?.cpuPct ?? 0) + (a.cpu - was.cpu) / wall * 100).toFixed(1)), rssMB: Math.max(byRole[a.role]?.rssMB ?? 0, a.rssMB)}}}
    note("usage", byRole); note("peak rss MB", peak)
    const end = await b.E("window.np.now()")
    const clock = await b.E(`({a: window.np.stamp(${q0}), z: window.np.stamp(${end - 1})})`)
    const audio = (end - 1 - q0) * 128 / 48000, real = (clock.z - clock.a) / 1000
    note("clock", {audioSec: +audio.toFixed(3), wallSec: +real.toFixed(3), lostMs: Math.round((real - audio) * 1000)})
    if (!process.env.NOPOLL) note("blocks", {n, avgMs: +(sum / n).toFixed(3), maxMs: +max.toFixed(2), budgetMs: +budget.toFixed(2), avgPct: +(sum / n / budget * 100).toFixed(1), overBudget: over, hist})
    for (const over of [30, 50, 100]) note(`stalls >${over}ms`, (await b.E(`window.np.stalls(${q0}, ${over})`)).map(s => s.ms))
    note("context", await b.E("window.np.context()"))
    note("frames", await b.E("(() => {window.np.stop(); return window.np.captureStop()})()"))
    if (!process.env.NOPOLL) note("sent", await b.E(`window.np.captureSend("http://localhost:7792/?name=${label}")`))
    // the page's main thread busy for a second: does the audio thread notice?
    await b.E(`window.np.play(${49 * 3840})`); await pause(2000)
    const q1 = await b.E("window.np.now()")
    for (let i = 0; i < 5; i++) {await b.E(`(() => {const t = performance.now(); while (performance.now() - t < 1000);})()`); await pause(500)}
    note("main thread busy 1 s x5, stalls >30ms", (await b.E(`window.np.stalls(${q1}, 30)`)).map(s => s.ms))
    await b.E("window.np.stop()")
  }
  if (scenario === "ms") {
    const j = await load("")
    note("load", {...j, res: undefined})
    await b.E(`window.np.play(${49 * 3840})`); await pause(3000)
    const version0 = await b.E("window.np.version()")
    const audible = await b.E("window.np.units().filter(u => !u.mute && (u.name.endsWith(' take') || ['Echo','Space','Reverse'].includes(u.name))).map(u => u.name)")
    note("lanes pressed", audible.length)
    const press = (fn, names, db, above) => b.E(`(async () => {const w = Date.now(), q = window.np.${fn}(${JSON.stringify(names)}, ${!above}); const c = await window.np.crossing(q, ${db}, ${above}, 4000, 4); return c.timeout ? -1 : window.np.stamp(c.quantum) - w})()`)
    const ms = {muteAll: [], unmuteAll: [], solo: [], unsolo: []}
    for (let i = 0; i < 12; i++) {
      await pause(600); ms.muteAll.push(await press("mute", audible, -40, false))
      await pause(300); ms.unmuteAll.push(await press("mute", audible, -40, true))
    }
    const lane = audible.find(n => /Pad|FX/.test(n)) ?? audible[0]
    const soloLevel = async on => b.E(`(async () => {const w = Date.now(), q0 = window.np.now(), before = window.np.levels(q0 - 60, q0).reduce((s, v) => s + v, 0) / 60, q = window.np.solo(${JSON.stringify([lane])}, ${on}); const c = await window.np.crossing(q, before + (${on ? -6 : 6}), ${!on}, 3000, 4); return c.timeout ? -1 : window.np.stamp(c.quantum) - w})()`)
    for (let i = 0; i < 12; i++) {await pause(500); ms.solo.push(await soloLevel(true)); await pause(300); ms.unsolo.push(await soloLevel(false))}
    for (const k of Object.keys(ms)) note(k, {...stats(ms[k]), all: ms[k]})
    note("song version before/after", [version0, await b.E("window.np.version()")])
    note("context", await b.E("window.np.context()"))
    await b.E("window.np.stop()")
  }
} catch (e) {note("FAILED", String(e.message ?? e).slice(0, 500))}
finally {writeFileSync(`results/${label}.json`, JSON.stringify(out, null, 1)); await b.close(); process.exit(0)}
