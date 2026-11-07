// A song as the phone draws it, read from the engine's own facts (`facts.mjs`): `node --test` after the build bundles
// it (`npm test`). Each region's start and length are pulses whatever the region's time base.
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

// make's own opening (research/make-b4/solo): a low-pass that stands dark for 24 bars, opens on a curve, then holds.
test("a lane carries its level and its curves as they play", async () => {
  const project = new ApiImpl({}).newProject("Curves")
  project.bpm = 120
  const bar = 4 * PPQ
  const bass = project.addInstrumentUnit("Vaporisateur", {label: "Bass", volume: -6.26})
  bass.noteTracks[0].addRegion({position: 0, duration: 32 * bar})
  const eq = bass.addAudioEffect("Revamp", {lowPass: {enabled: true, frequency: 20000, order: 1}})
  bass.addValueTrack(eq, "lowPass.frequency").addRegion({position: 0, duration: 40 * bar}).addEvents([
    {position: 0, value: 0.3},
    {position: 24 * bar, value: 0.3},
    {position: 31 * bar, value: 1, interpolation: {type: "curve", slope: 0.7}}
  ])
  bass.addValueTrack(bass, "volume").addRegion({position: 4 * bar, duration: 8 * bar}).addEvents([
    {position: 2 * bar, value: 0.2, interpolation: {type: "none"}},
    {position: 6 * bar, value: 0.9}
  ])
  project.addInstrumentUnit("Vaporisateur", {label: "Lead"}).noteTracks[0].addRegion({position: 0, duration: bar})
  const {tracks} = await factsOf(project.context.boxGraph, "Curves")
  assert.equal(tracks[0].volumeDb, -6.3)
  assert.equal(tracks[1].automation, undefined, "a lane with no curve carries nothing")
  const [filter, level] = tracks[0].automation
  assert.equal(filter.parameter, "lowPass.frequency")
  assert.equal(filter.device, eq.label)
  assert.equal(filter.points, 3)
  // A point's `interpolation` is how it moves to the NEXT one, so a curve set on the last point (as make writes) bends nothing.
  assert.deepEqual(filter.curve, [
    {at: 0, value: 0.3},
    {at: 24 * bar, value: 0.3},
    {at: 31 * bar, value: 1},
    {at: 40 * bar, value: 1}
  ], "the last point holds to the region's end")
  assert.equal(level.device, undefined, "the mixer's own curve names no device")
  assert.deepEqual(level.curve, [
    {at: 4 * bar, value: 0.2},
    {at: 6 * bar, value: 0.2},
    {at: 10 * bar, value: 0.2},
    {at: 10 * bar, value: 0.9},
    {at: 12 * bar, value: 0.9}
  ], "before its first point the lane stands there; none is a step")
})

// The bend's direction is the one thing a reader can't recover from the points' ends: read it against openDAW's own.
test("a curved move bends the way it plays", async () => {
  const project = new ApiImpl({}).newProject("Bend")
  const bar = 4 * PPQ
  const pad = project.addInstrumentUnit("Vaporisateur", {label: "Pad"})
  pad.noteTracks[0].addRegion({position: 0, duration: 8 * bar})
  pad.addValueTrack(pad.instrument, "cutoff").addRegion({position: 0, duration: 8 * bar}).addEvents([
    {position: 0, value: 0, interpolation: {type: "curve", slope: 0.8}},
    {position: 8 * bar, value: 1}
  ])
  const {tracks} = await factsOf(project.context.boxGraph, "Bend")
  const {curve, device} = tracks[0].automation[0]
  assert.equal(device, "Vaporisateur", "an instrument goes by its key: its label is the unit's")
  assert.equal(curve.length, 13)
  const middle = curve[6]
  assert.equal(middle.at, 4 * bar)
  assert.equal(middle.value, 0.8, "a slope is the value it has reached halfway")
})

test("a looped curve plays again each pass, a muted region plays no curve", async () => {
  const project = new ApiImpl({}).newProject("Loop")
  const bar = 4 * PPQ
  const pad = project.addInstrumentUnit("Vaporisateur", {label: "Pad"})
  pad.noteTracks[0].addRegion({position: 0, duration: 8 * bar})
  const lane = pad.addValueTrack(pad.instrument, "cutoff")
  lane.addRegion({position: 0, duration: 4 * bar, loopDuration: 2 * bar}).addEvents([{position: 0, value: 0}, {position: 2 * bar, value: 1}])
  lane.addRegion({position: 4 * bar, duration: 4 * bar, mute: true}).addEvents([{position: 0, value: 0.5}])
  const {tracks} = await factsOf(project.context.boxGraph, "Loop")
  assert.deepEqual(tracks[0].automation[0].curve.map(({at, value}) => [at / bar, value]), [[0, 0], [2, 1], [2, 0], [4, 1]])
})
