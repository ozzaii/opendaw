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

// Each of make's landings is stamped `<turn>#<landing>` (BRAVOH's `studio_apply`), so each is a step of its own.
test("landings: one landing of a run of three goes back alone, and the run is still one turn", async () => {
  const song = await written(["m1", "m2#1", "m2#2", "m2#3"])
  assert.deepEqual(await song.undo(1, ["m2#3"]), {undone: 1, turns: 1})
  assert.equal(song.name, "after m2#2")
  // the Producer's undo and "Revert to here" by the message take the rest of the run, never m1
  assert.deepEqual(await song.undo(1), {undone: 2, turns: 1})
  assert.equal(song.name, "after m1")
  const again = await written(["m1", "m2#1", "m2#2"])
  assert.deepEqual(await again.undo(1, ["m2"]), {undone: 2, turns: 1})
  assert.equal(again.name, "after m1")
})

// THE STORE LETS GO (11-14: its heap full 62 minutes after a start). A room nobody is in is forgotten by the room server;
// before, every room a replace or an undo opened stayed for the life of the process.
test("rooms: each attach's room goes once its clients leave", async () => {
  const {openRoom, startRooms, clientsIn} = await import("./rooms.mjs")
  const {docs} = await import("y-websocket/bin/utils")
  const rooms = await startRooms()
  const song = await written(["m1"])
  const names = []
  for (const turn of ["m2", "m3", "m4"]) {
    await song.replace(song.graph.toArrayBuffer(), turn, turn)
    names.push(await song.room((name, graph) => openRoom(rooms.url, name, graph)))
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(clientsIn(names.at(-1)), 1)
  assert.deepEqual(names.slice(0, -1).map(name => docs.has(name)), [false, false])
  await song.close()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(docs.has(names.at(-1)), false)
  rooms.server.close()
})

test("close: the song is saved and let go, and opens from disk as it was", async () => {
  const song = await written(["m1", "m2"])
  const checksum = [...song.graph.checksum()]
  await song.close()
  assert.equal(song.graph, null)
  const again = await Song.open(song.dir, "key")
  assert.deepEqual([...again.graph.checksum()], checksum)
  assert.equal(again.name, "after m2")
  assert.deepEqual(await again.undo(1), {undone: 1, turns: 1})
})
