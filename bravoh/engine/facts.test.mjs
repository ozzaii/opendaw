// A song's length as the phone draws it, read from the engine's own facts (`facts.mjs`): `node --test` after the
// build bundles it (`npm test`). Each region's start and length are pulses whatever the region's time base.
import {test} from "node:test"
import assert from "node:assert/strict"
import {ApiImpl} from "@opendaw/studio-scripting"
import {factsOf} from "./facts.mjs"
const PPQ = 960

// A stem without a tempo is placed "no-sync": openDAW keeps its length in SECONDS (Api.d.ts, `duration`: "seconds for
// non-synced audio regions"). 11-06: ten 57.3 s stems read as 57 pulses drew an empty booth at "1 bars" while it played.
test("a no-sync stem spans the bars its seconds play", async () => {
  const project = new ApiImpl({}).newProject("Stems")
  project.bpm = 120
  const tape = project.addInstrumentUnit("Tape", {label: "Ride"})
  tape.audioTracks[0].addRegion({uuid: "8f2c6a3e-1d4b-4e8a-9c7f-2b5e6d7a8c90", name: "Ride.wav", duration: 8, bpm: 0, sample_rate: 48000})
  const facts = await factsOf(project.context.boxGraph, "Stems")
  const [region] = facts.regions
  assert.equal(region.start, 0)
  assert.equal(region.length, 16 * PPQ, "8 s at 120 BPM is 16 beats")
  assert.equal(facts.bars, 4)
})
