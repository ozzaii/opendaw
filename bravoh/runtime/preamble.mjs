// Loaded with `node --import` before a BRAVOH Code Mode program: `openDAW` is the studio's own scripting API, its host
// is the program's own hands (external_studio_*), so the program is the script.
import {ApiImpl, ScriptGlobals} from "@opendaw/studio-scripting"
import {AudioData} from "@opendaw/lib-dsp"
import {decode, encode, fromRoom} from "./wire.mjs"
const hand = async (name, input) => {
  const call = globalThis[`external_${name}`]
  if (typeof call !== "function") throw new Error("The booth is not open on this turn: the studio's song cannot be reached from this program.")
  const answer = await call({say: "the booth", wire: encode(input)})
  if (answer?.failed || answer?.refused) throw new Error(String(answer.why ?? answer.refused))
  return decode(answer.wire)
}
const asked = (call, ...args) => hand("studio_host", {call, args})
const pending = []
const host = {
  openProject(buffer, name) {pending.push(hand("studio_apply", {project: buffer, name}))},
  applyUpdates(tasks, checksum) {pending.push(hand("studio_apply", {tasks, checksum}))},
  hasProject: async () => (await hand("studio_open", {})).project !== null,
  fetchProject: async () => {
    const {project, name} = await hand("studio_open", {})
    if (project === null) throw new Error("There is no song in the booth yet: start one with openDAW.newProject().")
    return {buffer: project, name}
  },
  showInfo: async (headline, message) => console.log(`${headline}: ${message}`),
  addSample: (data, name) => hand("studio_samples", {add: {name, sampleRate: data.sampleRate, frames: [...data.frames]}}),
  listSamples: () => hand("studio_samples", {}),
  renderMixdown: async (buffer, options) => {
    const answer = await hand("studio_mixdown", {project: buffer, sampleRate: options?.sampleRate})
    // a file of the room since 11-11 (BRAVOH's `studio-plumbing.ts`); frames on the wire from an older host or `mixNumbers`
    const {sampleRate, frames} = answer.file ? await fromRoom(answer.file) : answer
    const audio = AudioData.create(sampleRate, frames[0]?.length ?? 0, frames.length)
    frames.forEach((channel, index) => audio.frames[index].set(channel))
    return audio
  },
  saveFile: async (buffer, fileName) => (await import("node:fs/promises")).writeFile(fileName, new Uint8Array(buffer)),
  // the studio's catalogues and what a program adds to them: answered by the song's openDAW page (ScriptAnswers)
  listSoundfonts: () => asked("listSoundfonts"),
  addSoundfont: (buffer, name) => asked("addSoundfont", buffer, name),
  listNamModels: () => asked("listNamModels"),
  addNamModel: (model, name) => asked("addNamModel", model, name),
  listWclaps: () => asked("listWclaps"),
  describeWclap: (url, clapId) => asked("describeWclap", url, clapId)
}
// openInStudio() answers the host's apply, so a song changed underneath (a checksum refusal) throws into the program.
const applying = project => {
  const open = project.openInStudio.bind(project)
  project.openInStudio = async () => {
    const before = pending.length
    open()
    if (pending.length > before) await pending.splice(before).pop()
  }
  return project
}
const api = new ApiImpl(host)
const fetch = api.getProject.bind(api), make = api.newProject.bind(api)
api.getProject = async () => applying(await fetch())
api.newProject = name => applying(make(name))
Object.assign(globalThis, ScriptGlobals.create(api, {sampleRate: 48000, baseFrequency: 440}))
