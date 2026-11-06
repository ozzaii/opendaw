// A song's undo by turn: `node --test` after the build bundles it (`npm test`).
import {test} from "node:test"
import assert from "node:assert/strict"
import {mkdtemp} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {Song} from "./song.mjs"

const written = async turns => {
  const song = await Song.open(await mkdtemp(join(tmpdir(), "song-")), "key")
  await song.start("start")
  for (const turn of turns) await song.replace(song.graph.toArrayBuffer(), `after ${turn}`, turn)
  return song
}

// "Revert to here" knows the artist's message ids and nothing of which of them wrote: m2 wrote nothing, and a run with no
// message of its own ("": a woken run) wrote between the others.
test("from: back to before the first of those messages that wrote, and everything after it", async () => {
  const song = await written(["m1", "m3", "", "m4"])
  assert.deepEqual(await song.undo(1, ["m2", "m3", "m4"]), {undone: 3, turns: 3})
  assert.equal(song.name, "after m1")
  assert.deepEqual(await song.undo(1, ["m2", "m3", "m4"]), {undone: 0, turns: 0})
  assert.equal(song.name, "after m1")
  assert.deepEqual(await song.undo(1, ["m1"]), {undone: 1, turns: 1})
  assert.equal(song.name, "start")
})

test("from: a message that wrote nothing takes nothing back", async () => {
  const song = await written(["m1"])
  assert.deepEqual(await song.undo(1, ["elsewhere"]), {undone: 0, turns: 0})
  assert.equal(song.name, "after m1")
})

test("turns: the last ones that wrote, as the Producer's undo asks", async () => {
  const song = await written(["m1", "m2", "m3"])
  assert.deepEqual(await song.undo(2), {undone: 2, turns: 2})
  assert.equal(song.name, "after m1")
})
