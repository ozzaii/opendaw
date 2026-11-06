// The song as BRAVOH's phone draws it (@bravoh/shared SongFacts): read through the scripting API's own facades.
import {ApiImpl} from "@opendaw/studio-scripting"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
const PPQ = 960
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
    for (const track of unit.tracks.filter(track => track.type === "notes" || track.type === "audio")) {
      const index = tracks.length
      const audio = track.type === "audio"
      tracks.push({name: unit.label, ...(unit.instrument ? {instrument: unit.instrument.key} : {}), kind: audio ? "audio" : "instrument", fx: unit.audioEffects.map(effect => effect.label), ...(unit.mute ? {muted: true} : {})})
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
