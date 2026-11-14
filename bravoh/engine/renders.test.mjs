// One render per state of a song, for every reader of it: the page's lanes (BravohRenders.ts) and the store they fill.
import {test} from "node:test"
import assert from "node:assert/strict"
import {mkdtemp} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import {readdir} from "node:fs/promises"
import {decode, encode} from "../runtime/wire.mjs"
import {renderLanes, RenderStuck, Superseded} from "../../packages/app/studio/src/service/BravohRenders.ts"

const later = () => {
  let go
  const held = new Promise(resolve => {go = resolve})
  return {held, go}
}
const lanesFor = ({version = 1, stored = false} = {}) => {
  const state = {version, notes: []}
  const lanes = renderLanes({version: async () => state.version, stored: async () => stored, note: what => state.notes.push(what)})
  return {state, lanes}
}
// a render that holds its lane until it is let go, and says when it started
const work = started => {
  const {held, go} = later()
  return {go, held, run: async () => {started.push(1); await held}}
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test("every reader of one state of the song shares one render", async () => {
  const {state, lanes} = lanesFor()
  const started = []
  const {go, run} = work(started)
  const readers = [lanes.once("a", 1, false, run), lanes.once("a", 1, false, run), lanes.once("a", 1, true, run)]
  await tick()
  go()
  await Promise.all(readers)
  assert.equal(started.length, 1)
  assert.deepEqual(state.notes, ["shared", "shared"])
})

test("what the store already holds is not rendered again", async () => {
  const {state, lanes} = lanesFor({stored: true})
  const started = []
  await lanes.once("a", 1, false, work(started).run)
  assert.equal(started.length, 0)
  assert.deepEqual(state.notes, ["stored"])
})

test("a render overtaken while it waited is dropped, and its readers told", async () => {
  const {state, lanes} = lanesFor()
  const started = []
  const first = work(started)
  const running = lanes.once("running", 1, false, first.run)
  const waiting = lanes.once("waiting", 1, false, work(started).run)
  await tick()
  state.version = 2
  first.go()
  await running
  await assert.rejects(waiting, Superseded)
  assert.equal(started.length, 1)
  assert.deepEqual(state.notes, ["dropped"])
})

test("a render already running finishes when the song moves on", async () => {
  const {state, lanes} = lanesFor()
  const first = work([])
  const running = lanes.once("running", 1, false, first.run)
  await tick()
  state.version = 2
  first.go()
  await running
})

test("the artist never waits behind make: their render starts beside it, and ahead of what waits", async () => {
  const {lanes} = lanesFor()
  const order = []
  const make = work([])
  const makeRenders = lanes.once("make", 1, false, async () => {order.push("make"); await make.held})
  const desk = lanes.once("desk", 1, false, async () => {order.push("desk")})
  const artist = lanes.once("artist", 1, true, async () => {order.push("artist")})
  await artist
  assert.deepEqual(order, ["make", "artist"], "the artist's started while make's still ran, and the desk's still waits")
  make.go()
  await Promise.all([makeRenders, desk])
  assert.deepEqual(order, ["make", "artist", "desk"])
})

test("two of the artist's take both lanes, and make waits behind them", async () => {
  const {lanes} = lanesFor()
  const order = []
  const one = work([]), two = work([])
  const first = lanes.once("one", 1, true, async () => {order.push("one"); await one.held})
  const second = lanes.once("two", 1, true, async () => {order.push("two"); await two.held})
  const make = lanes.once("make", 1, false, async () => {order.push("make")})
  await tick()
  assert.deepEqual(order, ["one", "two"])
  one.go(); two.go()
  await Promise.all([first, second, make])
  assert.deepEqual(order, ["one", "two", "make"])
})

test("the artist joining a waiting render takes it ahead", async () => {
  const {lanes} = lanesFor()
  const order = []
  const make = work([]), artistHolds = work([])
  const makeRenders = lanes.once("make", 1, false, async () => {order.push("make"); await make.held})
  const artistRenders = lanes.once("artist", 1, true, async () => {order.push("artist"); await artistHolds.held})
  const desk = lanes.once("desk", 1, false, async () => {order.push("desk")})
  const later = lanes.once("later", 1, false, async () => {order.push("later")})
  await tick()
  lanes.once("later", 1, true, async () => {order.push("never")})
  make.go()
  await makeRenders
  await tick()
  assert.deepEqual(order.slice(0, 3), ["make", "artist", "later"], "it went ahead of the desk, which asked first")
  artistHolds.go()
  await Promise.all([artistRenders, desk, later])
  assert.deepEqual(order, ["make", "artist", "later", "desk"])
})

test("a loop never waits behind whole songs, and a loop behind a loop says how long it waited", async () => {
  const {lanes} = lanesFor()
  const order = []
  const song = work([]), bounce = work([]), first = work([])
  const songs = [lanes.once("song", 1, false, async () => {order.push("song"); await song.held}),
    lanes.once("bounce", 1, true, async () => {order.push("bounce"); await bounce.held})]
  const loop = lanes.once("loop", 1, false, async () => {order.push("loop"); await first.held}, true)
  const waited = []
  const next = lanes.once("next", 1, false, async watch => {order.push("next"); waited.push(watch.waitedMs)}, true)
  await tick()
  assert.deepEqual(order, ["song", "bounce", "loop"], "the loop started while both whole songs ran")
  await new Promise(resolve => setTimeout(resolve, 30))
  first.go()
  await Promise.all([loop, next])
  assert.deepEqual(order, ["song", "bounce", "loop", "next"], "the second loop took the loop's lane, not a song's")
  assert.ok(waited[0] >= 30, `it waited ${waited[0]} ms`)
  song.go(); bounce.go()
  await Promise.all(songs)
})

test("a render whose sound never comes fails by name, frees its lane, and stops its work", async () => {
  const stuck = []
  const lanes = renderLanes({version: async () => 1, stored: async () => false, note: () => {}, stuck: error => stuck.push(error), stallMs: 20})
  let signal
  const hung = lanes.once("hung", 1, false, watch => {
    signal = watch.signal
    watch.wait("sample 5c829459")()
    watch.wait("sample fb509fbd")
    return new Promise(() => {})
  })
  const beside = lanes.once("beside", 1, false, async () => {})
  await assert.rejects(hung, error => error instanceof RenderStuck && /waiting for sample fb509fbd/.test(error.message) && !/5c829459/.test(error.message))
  assert.equal(signal.aborted, true)
  await beside
  await lanes.once("after", 1, false, async () => {})
  await tick()
  assert.deepEqual(stuck.map(error => error.waited), [["sample fb509fbd"]])
})

test("while what it waits for keeps arriving, a render is not stuck", async () => {
  const lanes = renderLanes({version: async () => 1, stored: async () => false, note: () => {}, stallMs: 30})
  await lanes.once("slow", 1, false, async watch => {
    for (let at = 0; at < 6; at++) {
      const answered = watch.wait(`sample ${at}`)
      await new Promise(resolve => setTimeout(resolve, 15))
      answered()
    }
  })
})

test("a render that keeps moving is never cut, however long; one that stops moving is ended, naming no wait", async () => {
  const stuck = []
  const lanes = renderLanes({version: async () => 1, stored: async () => false, note: () => {}, stuck: error => stuck.push(error), stallMs: 30})
  // five times the stall clock, moving every 10 ms
  await lanes.once("long", 1, false, async watch => {
    for (let at = 0; at < 15; at++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      watch.moved()
    }
  })
  await assert.rejects(lanes.once("still", 1, false, () => new Promise(() => {})), /nothing moved for .* still rendering/)
  await tick()
  assert.deepEqual(stuck.map(error => error.waited), [[]])
})

test("a failed render answers its readers and leaves the lane free", async () => {
  const {lanes} = lanesFor()
  await assert.rejects(lanes.once("a", 1, false, async () => {throw new Error("no sound")}), /no sound/)
  await lanes.once("a", 1, false, async () => {})
})

test("a render is never refused for the time it stood in line", async () => {
  const lanes = renderLanes({version: async () => 1, stored: async () => false, note: () => {}, stallMs: 30})
  const ahead = lanes.once("ahead", 1, false, async watch => {
    for (let at = 0; at < 8; at++) {await new Promise(resolve => setTimeout(resolve, 10)); watch.moved()}
  })
  // everybody's lane is taken by "ahead" and the artist's takes only the artist's: this one stands in line past the stall clock
  const behind = []
  await Promise.all([ahead, lanes.once("behind", 1, false, async watch => {behind.push(watch.waitedMs)})])
  assert.ok(behind[0] >= 60, `it stood ${behind[0]} ms in line and still rendered`)
})

// THE STORE. A render stays for every reader, the bounce is encoded from the one it holds, and the count says so.
Object.assign(process.env, {ENGINE_TOKEN: "t".repeat(32), ENGINE_DATA: await mkdtemp(join(tmpdir(), "renders-test-"))})
const {server} = await import("./server.mjs")
const base = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/v1/songs`)))
const call = (path, init = {}) => fetch(`${base}/${path}`, {...init, headers: {authorization: `Bearer ${process.env.ENGINE_TOKEN}`}})
const wav = (() => {
  const file = join(process.env.ENGINE_DATA, "tone.wav")
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=997:d=1:r=48000", "-ac", "2", "-c:a", "pcm_f32le", file])
  return readFileSync(file)
})()

test("a render is read by every reader, and counted once", async () => {
  assert.equal((await call("s1/renders/r1?peek=1")).status, 404)
  assert.equal((await call("s1/renders/r1", {method: "POST", body: wav})).status, 200)
  assert.equal((await call("s1/renders/r1?peek=1")).status, 200)
  for (const _reader of [1, 2, 3]) {
    const read = await call("s1/renders/r1")
    assert.equal(read.status, 200)
    assert.equal((await read.arrayBuffer()).byteLength, wav.byteLength)
  }
  await call("s1/renders-note", {method: "POST", body: JSON.stringify({shared: 1, took: {renderMs: 5}})})
  const count = await (await call("s1/renders-stats")).json()
  assert.equal(count.rendered, 1)
  assert.equal(count.shared, 1)
  assert.equal(count.last.renderMs, 5)
})

test("a song keeps its newest renders and no others", async () => {
  for (const id of ["a", "b", "c", "d", "e"]) await call(`s2/renders/${id}`, {method: "POST", body: wav})
  assert.equal((await call("s2/renders/a")).status, 404)
  assert.equal((await call("s2/renders/e?peek=1")).status, 200)
  // reading one keeps it longest
  await call("s2/renders/b?peek=1")
  await call("s2/renders/f", {method: "POST", body: wav})
  assert.equal((await call("s2/renders/b?peek=1")).status, 200)
  assert.equal((await call("s2/renders/c?peek=1")).status, 404)
})

// The two bounces meet on a song not yet open, which once gave each its own Song (`songOf`) and so its own encode.
test("one render is encoded once, whatever versions and readers ask", async () => {
  await call("s3/renders/r1", {method: "POST", body: wav})
  assert.equal((await call("s3/bounce?version=1&render=missing", {method: "POST"})).status, 404)
  const answers = await Promise.all([call("s3/bounce?version=1&render=r1", {method: "POST"}), call("s3/bounce?version=1&render=r1", {method: "POST"})])
  assert.deepEqual(answers.map(answer => answer.status), [200, 200])
  assert.equal((await call("s3/bounce?version=2&render=r1", {method: "POST"})).status, 200)
  assert.equal((await (await call("s3/renders-stats")).json()).encoded, 1)
})

test("a reader that waited for a bounce gets it, however far the song has moved", async () => {
  await call("s4/start", {method: "POST", body: "{}"})
  const song = (await (await call("s4/version")).json()).version
  await call("s4/renders/r1", {method: "POST", body: wav})
  assert.equal((await call(`s4/audio?version=${song}`)).status, 409)
  assert.equal((await call(`s4/bounce?version=${song}&render=r1`, {method: "POST"})).status, 200)
  assert.equal((await call(`s4/audio?version=${song}`)).status, 200)
  // a version the store has no bounce of yet, and one rendered from before the song moved
  assert.equal((await call(`s4/audio?version=${song + 1}`)).status, 409)
  assert.equal((await call(`s4/bounce?version=${song + 2}&render=r1`, {method: "POST"})).status, 200)
  assert.equal((await call(`s4/audio?version=${song + 1}`)).status, 200)
  // asked with no version: the song's own, as before
  assert.equal((await call("s4/audio")).status, 200)
})

// An artist's account erased takes their songs with it (the ethics review's "delete my account", 11-14).
test("a song erased is gone from every door, its undo and files with it, and erasing it again is done too", async () => {
  await call("s9/start", {method: "POST", body: JSON.stringify({name: "gone"})})
  await call("s9/mark", {method: "POST", body: JSON.stringify({turn: "t1"})})
  const added = await call("s9/samples", {method: "POST", body: JSON.stringify({wire: encode({add: {name: "kick", sampleRate: 48_000, frames: [new Float32Array(480)]}})})})
  const {uuid} = decode((await added.json()).wire)
  await call("s9/renders/r1", {method: "POST", body: wav})
  await call("s9/nam", {method: "POST", body: JSON.stringify({model: "{}", name: "amp"})})
  assert.equal((await call("s9/project")).status, 200)
  assert.equal((await call(`s9/sample?uuid=${uuid}`)).status, 200)
  assert.equal((await fetch(`${base}/s9`, {method: "DELETE"})).status, 401)
  assert.equal((await call("s9", {method: "DELETE"})).status, 204)
  for (const door of ["song", "project", "room", `sample?uuid=${uuid}`, "renders/r1?peek=1"]) assert.equal((await call(`s9/${door}`)).status, 404, door)
  assert.equal((await (await call("s9/nam")).json()).some(model => model.name === "amp"), false)
  assert.deepEqual(await (await call("s9/undo", {method: "POST", body: "{}"})).json(), {undone: 0, turns: 0})
  const left = (await Promise.all(["songs", "samples", "nam-songs"].map(dir => readdir(join(process.env.ENGINE_DATA, dir)).catch(() => [])))).flat()
  assert.deepEqual(left.filter(name => name.startsWith("s9")), [])
  assert.equal((await call("s9", {method: "DELETE"})).status, 204)
  server.close()
  server.closeAllConnections()
})
