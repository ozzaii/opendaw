// The song as BRAVOH's phone draws it (@bravoh/shared SongFacts): read through the scripting API's own facades.
import {ApiImpl} from "@opendaw/studio-scripting"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Curve} from "@opendaw/lib-std"
const PPQ = 960
// A curved move is told as straight pieces, so whoever reads `curve` draws what plays without the slope's formula.
const CURVE_PIECES = 12
const point = (at, value) => ({at: Math.round(at), value: Math.round(value * 1e4) / 1e4})
// One pass of a region's points, from its start to `length`, as it plays: before its first point a lane stands at that
// value and after its last it holds it (lib-dsp `ValueEvent.valueAt`); `none` holds up to the next point, a step.
const passOf = (events, length) => {
  const pass = []
  events.forEach((event, index) => {
    if (index === 0 && event.position > 0) pass.push(point(0, event.value))
    pass.push(point(event.position, event.value))
    const next = events[index + 1]
    if (!next) {
      if (event.position < length) pass.push(point(length, event.value))
      return
    }
    const {type, slope} = event.interpolation
    if (type === "none") pass.push(point(next.position, event.value))
    if (type === "curve") for (let piece = 1; piece < CURVE_PIECES; piece++) {
      const x = piece / CURVE_PIECES
      pass.push(point(event.position + (next.position - event.position) * x, event.value + (next.value - event.value) * Curve.normalizedAt(x, slope)))
    }
  })
  return pass
}
// shortcut: a looped pass the region's edge cuts ends at its last point inside; no make run has looped a curve yet.
const curveOf = lane => lane.regions.filter(region => !region.mute).flatMap(region => {
  const loop = region.loopDuration > 0 ? region.loopDuration : region.duration
  const pass = passOf(region.events, loop), curve = []
  for (let at = -region.loopOffset; at < region.duration; at += loop)
    for (const {at: inPass, value} of pass)
      if (at + inPass >= 0 && at + inPass <= region.duration) curve.push({at: region.position + at + inPass, value})
  return curve
})
// A unit's curves as they stand: `value` is the 0..1 stored along the knob's own taper, never its units. An instrument's
// `label` is the unit's, so it goes by its key, as `instrument` does; the mixer's own (volume, panning) names no device.
const automationOf = unit => unit.valueTracks.map(lane => {
  const device = lane.target === unit ? undefined : lane.target === unit.instrument ? unit.instrument.key : lane.target.label
  return {
    parameter: lane.parameter,
    points: lane.regions.reduce((sum, region) => sum + region.events.length, 0),
    ...(device ? {device} : {}),
    curve: curveOf(lane)
  }
})
// A lane's MIDI effects, each with the few knobs that say what it does to the notes: a swing is a Zeitgeist whose `amount`
// is where the off-step lands in its pair of `duration` pulses (11-14: the Producer told the artist it could find no swing
// in a song whose four lanes carried 0.61, because these facts held no MIDI effect).
const MIDI_KNOBS = {
  Zeitgeist: effect => ({amount: effect.groove.amount, duration: effect.groove.duration}),
  Pitch: effect => ({octaves: effect.octaves, semiTones: effect.semiTones, cents: effect.cents}),
  Velocity: effect => ({offset: effect.offset, randomAmount: effect.randomAmount, magnetStrength: effect.magnetStrength, mix: effect.mix}),
  Arpeggio: effect => ({mode: effect.mode, octaves: effect.octaves, rate: effect.rate, gate: effect.gate}),
  NoteFilter: effect => ({min: effect.min, max: effect.max})
}
const midiOf = unit => unit.midiEffects.map(effect => ({
  name: effect.label || effect.key,
  kind: "midi",
  type: effect.key,
  ...(effect.enabled === false ? {on: false} : {}),
  params: Object.entries(MIDI_KNOBS[effect.key]?.(effect) ?? {}).map(([name, value]) => ({name, value: Math.round(value * 1e4) / 1e4}))
}))
export const factsOf = async (graph, title) => {
  const buffer = ProjectSkeleton.encode(graph)
  const api = new ApiImpl({hasProject: async () => true, fetchProject: async () => ({buffer, name: title ?? ""})})
  const song = await api.getProject()
  const {numerator, denominator} = song.timeSignature
  const bar = Math.floor(PPQ * 4 / denominator) * numerator
  const tracks = [], regions = []
  let end = 0
  // A stem with no tempo plays "no-sync" and keeps its length in SECONDS (the scripting API's `duration`); read as pulses,
  // ten 57 s stems drew an empty booth at "1 bars" while it played (Francesco, 6 Nov). The drawing is in pulses.
  // shortcut: one tempo for the whole song, as `tempo` below says it; a tempo track would need the tempo map here.
  const pulses = region => region.playback === "no-sync" ? Math.round(region.duration * song.bpm / 60 * PPQ) : region.duration
  for (const unit of song.instrumentUnits) {
    // The curves and MIDI effects are the unit's, so they stand on its first lane alone: on each they would count twice.
    let automation = automationOf(unit), midiFx = midiOf(unit)
    for (const track of unit.tracks.filter(track => track.type === "notes" || track.type === "audio")) {
      const index = tracks.length
      const audio = track.type === "audio"
      tracks.push({name: unit.label, ...(unit.instrument ? {instrument: unit.instrument.key} : {}), kind: audio ? "audio" : "instrument", fx: unit.audioEffects.map(effect => effect.label), volumeDb: Math.round(unit.volume * 10) / 10, ...(unit.mute ? {muted: true} : {}), ...(automation.length ? {automation} : {}), ...(midiFx.length ? {midiFx} : {})})
      automation = []
      midiFx = []
      for (const region of track.regions) {
        const length = pulses(region)
        end = Math.max(end, region.position + length)
        const base = {id: region.uuid, track: index, start: region.position, length, ...(region.label ? {name: region.label} : {})}
        if (audio) {regions.push({...base, kind: "audio", sample: region.sample?.name}); continue}
        // a looped region plays its events again every loopDuration, shifted by loopOffset
        const notes = []
        const loop = region.loopDuration > 0 ? region.loopDuration : region.duration
        for (let at = -region.loopOffset; at < region.duration; at += loop)
          for (const note of region.events) {
            const position = at + note.position
            if (position >= 0 && position < region.duration && note.position < loop)
              notes.push({at: position, pitch: note.pitch, velocity: Math.round(note.velocity * 127), length: note.duration})
          }
        regions.push({...base, kind: "midi", notes})
      }
    }
  }
  return {...(title ? {title} : {}), tracks, regions, bars: Math.ceil(end / bar), tempo: Math.round(song.bpm * 100) / 100, signature: `${numerator}/${denominator}`}
}
