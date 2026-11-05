// BRAVOH's engine (github.com/ozzaii/opendaw, branch `bravoh`): the studio app itself executes a program's studio hands
// (bravoh/runtime/preamble.mjs) on one song's room, so every device the studio has plays in BRAVOH's songs. The engine
// host opens it headless as `/#engine=<song key>&token=<engine token>` and calls window.engine.call(method, wire, turn).
// The store (bravoh/engine/server.mjs) keeps the song, its undo marks, the renders and the bounce; this page saves
// nothing itself: its edits reach the store through the room. It never writes UI state boxes into the song.
import {int, Option, UUID} from "@opendaw/lib-std"
import {AudioData, ppqn, WavFile} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {MixdownSection, Project, StudioPreferences, YService} from "@opendaw/studio-core"
import {ScriptHostProtocol} from "@opendaw/studio-scripting"
import {StudioService} from "@/service/StudioService"
import {ScriptAnswers} from "@/service/ScriptAnswers"
import {attachSongSamples, attachSongSoundfonts} from "@/service/BravohBooth"

// Read once, at the first line of main.ts: the app's router rewrites the location while it boots.
const asked = new URLSearchParams(location.hash.slice(1))
export const isEngine = (): boolean => asked.has("engine")
const key = asked.get("engine") ?? "", token = asked.get("token") ?? ""

// THE WIRE (bravoh/runtime/wire.mjs): JSON with typed arrays, buffers and bigints as base64.
const TYPES: Record<string, any> = {Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array}
const toBase64 = (bytes: Uint8Array): string => {
    let text = ""
    for (let at = 0; at < bytes.length; at += 0x8000) {text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))}
    return btoa(text)
}
const encode = (value: unknown): string => JSON.stringify(value, (_key, item) =>
    ArrayBuffer.isView(item) ? {$t: item.constructor.name, $b: toBase64(new Uint8Array(item.buffer, item.byteOffset, item.byteLength))}
        : item instanceof ArrayBuffer || item instanceof SharedArrayBuffer ? {$t: "ArrayBuffer", $b: toBase64(new Uint8Array(item))}
            : typeof item === "bigint" ? {$t: "BigInt", $b: item.toString()} : item)
const decode = (text: string): any => JSON.parse(text, (_key, item) => {
    if (item === null || typeof item !== "object" || typeof item.$t !== "string") {return item}
    if (item.$t === "BigInt") {return BigInt(item.$b)}
    const buffer = Uint8Array.from(atob(item.$b), char => char.charCodeAt(0)).buffer
    if (item.$t === "ArrayBuffer") {return buffer}
    if (!(item.$t in TYPES)) {throw new TypeError(`wire: unknown type ${item.$t}`)}
    return new TYPES[item.$t](buffer)
})

const store = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`/v1/songs/${key}/${path}`, {...init, headers: {authorization: `Bearer ${token}`}})
const answerOf = async (path: string, init?: RequestInit): Promise<any> => {
    const response = await store(path, init)
    const answer = await response.json().catch(() => ({}))
    if (!response.ok) {throw new Error(String(answer.why ?? `the store answered ${response.status} to ${path}`))}
    return answer
}
const post = (path: string, body: BodyInit): Promise<any> => answerOf(path, {method: "POST", body})

// THE SONG'S ROOM, joined on the first call that needs it and joined again whenever the store rotated it (a new song,
// an undo). Checked at every call: the store answers in a millisecond on its own host.
type Room = { name: string, title: string, project: Project, leave: () => void }
let room: Room | null = null
let marked: string | null = null // the turn the store last kept a snapshot for, from this page
const roomOf = async (service: StudioService): Promise<Room | null> => {
    const response = await store("room")
    if (response.status === 404) {
        room?.leave()
        room = null
        return null
    }
    if (!response.ok) {throw new Error(`the store's room answered ${response.status}`)}
    const {room: name, ws, name: title} = await response.json()
    if (room?.name === name) {return room}
    room?.leave()
    room = null
    marked = null
    const url = new URL(ws, location.href.replace(/^http/, "ws")).href
    const {project, provider} = await YService.getOrCreateRoom(Option.None, service, name, {url, params: {token}, user: false})
    room = {name, title: title ?? "", project, leave: () => {project.terminate(); provider.destroy()}}
    return room
}
const noSong = () => new Error("There is no song in the booth yet: start one with openDAW.newProject().")

// What a render covers, as the studio's own mixdown sections (MixdownSection.collect) have it: the loop area when it is
// on, exactly (a phrase), else the whole song with its tail.
const sectionOf = (graph: BoxGraph): MixdownSection => {
    const {loopArea} = ProjectSkeleton.findMandatoryBoxes(graph).timelineBox
    if (loopArea.enabled.getValue() && loopArea.to.getValue() > loopArea.from.getValue()) {
        return {type: "loop", key: "loop", label: "Loop Area", start: loopArea.from.getValue(), end: loopArea.to.getValue(), passes: 1, tail: false}
    }
    const end = graph.boxes().filter(box => box.name.endsWith("RegionBox"))
        .reduce((last: ppqn, box: any) => Math.max(last, (box.position?.getValue?.() ?? 0) + (box.duration?.getValue?.() ?? 0)), 0)
    return {type: "song", key: "song", label: "Entire song", start: 0, end, passes: 1, tail: true}
}
// A sample or soundfont that does not load plays as silence in the engine, so a render waits for each and refuses
// when one fails: a program must never hear a song with a hole in it as the song.
type Loader = { state: { type: string, reason?: string }, subscribe: (observer: (state: any) => void) => { terminate(): void } }
const loaded = (what: string, loader: Loader): Promise<void> => new Promise((resolve, reject) => {
    if (loader.state.type === "error") {return reject(new Error(`${what}: ${loader.state.reason}`))}
    const subscription = loader.subscribe(state => {
        if (state.type !== "loaded" && state.type !== "error") {return}
        queueMicrotask(() => subscription?.terminate())
        state.type === "loaded" ? resolve() : reject(new Error(`${what}: ${state.reason}`))
    })
})
const render = async (service: StudioService, bytes: ArrayBufferLike, sampleRate: int): Promise<AudioData> => {
    const {boxGraph} = ProjectSkeleton.decode(bytes as ArrayBuffer)
    const section = sectionOf(boxGraph)
    if (section.end <= section.start) {throw new Error("The song has no regions to render.")}
    const loads = await Promise.allSettled(boxGraph.boxes().flatMap(box => {
        const uuid = box.address.uuid, id = UUID.toString(uuid)
        return box.name === "AudioFileBox" ? [loaded(`sample ${id}`, service.sampleManager.getOrCreate(uuid) as any)]
            : box.name === "SoundfontFileBox" ? [loaded(`soundfont ${id}`, service.soundfontManager.getOrCreate(uuid) as any)] : []
    }))
    const failed = loads.flatMap(load => load.status === "rejected" ? [String(load.reason?.message ?? load.reason)] : [])
    if (failed.length > 0) {throw new Error(`Some sounds of the song did not load, so the render would be missing them: ${failed.join("; ")}`)}
    // the live AudioContext keeps running: an offline render is a worker of its own
    return ScriptAnswers.renderMixdown(service, bytes, sampleRate, {section})
}
// 16-bit stereo WAV, a quarter of the float file, for a phone's data
const pcm16 = ({sampleRate, frames, numberOfFrames}: AudioData): Uint8Array => {
    const channels = frames.length, data = numberOfFrames * channels * 2
    const view = new DataView(new ArrayBuffer(44 + data))
    const text = (at: int, word: string) => [...word].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)))
    text(0, "RIFF"); view.setUint32(4, 36 + data, true); text(8, "WAVE"); text(12, "fmt ")
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true)
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true)
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, data, true)
    for (let index = 0, at = 44; index < numberOfFrames; index++) {
        for (let channel = 0; channel < channels; channel++, at += 2) {
            view.setInt16(at, Math.round(Math.max(-1, Math.min(1, frames[channel][index])) * 32767), true)
        }
    }
    return new Uint8Array(view.buffer)
}
// shortcut: polled (20 ms, 2 s at most); a store answer that waits for the room's update if the poll ever shows
const reached = async (before: int): Promise<void> => {
    for (const end = Date.now() + 2000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) {
        if ((await answerOf("version")).version !== before) {return}
    }
    console.warn("[engine] the store did not see the edit within 2 s")
}

// A SCRIPT'S OTHER HOST CALLS: the studio's catalogues as the code editor answers them, and what a program adds kept by
// the store with the song (this page keeps nothing, and a booth page plays the same song)
type HostCalls = Pick<ScriptHostProtocol, "listSoundfonts" | "addSoundfont" | "listNamModels" | "addNamModel" | "listWclaps" | "describeWclap">
const hostCalls = (service: StudioService): HostCalls => ({
    listSoundfonts: async () => [...await ScriptAnswers.listSoundfonts(service), ...await answerOf("soundfonts")],
    addSoundfont: (buffer, name) => post(`soundfonts?name=${encodeURIComponent(name)}`, buffer),
    listNamModels: () => answerOf("nam"),
    addNamModel: (model, name) => post("nam", JSON.stringify({model, name})),
    listWclaps: () => ScriptAnswers.listWclaps(),
    describeWclap: (url, clapId) => ScriptAnswers.describeWclap(service, url, clapId)
})

const methods: Record<string, (service: StudioService, input: any, turn: string) => Promise<unknown>> = {
    host: async (service, {call, args}) => {
        const calls = hostCalls(service)
        if (!Object.hasOwn(calls, call)) {throw new Error(`no such host call: ${call}`)}
        return (calls[call as keyof HostCalls] as (...args: ReadonlyArray<unknown>) => Promise<unknown>)(...(args ?? []))
    },
    open: async service => {
        const song = await roomOf(service)
        return song === null ? {project: null, name: ""} : {project: ProjectSkeleton.encode(song.project.boxGraph), name: song.title}
    },
    // the store keeps the song as it was before the first edit of a turn (`mark`): undo by turn goes back to it
    apply: async (service, {tasks, checksum}, turn) => {
        const song = await roomOf(service)
        if (song === null) {throw noSong()}
        const stale = new Error("The song changed since this program read it: read it again and redo the change.")
        if (!ScriptAnswers.isCurrent(song.project, checksum)) {throw stale}
        if (marked !== turn) {
            await post("mark", JSON.stringify({turn}))
            marked = turn
        }
        const {version} = await answerOf("version")
        if (!ScriptAnswers.applyUpdates(song.project, tasks, checksum)) {throw stale}
        if (tasks.length > 0) {await reached(version)}
        return {applied: tasks.length}
    },
    // a candidate the program built, rendered and never applied; the frames wait in the store for the hand to fetch
    mixdown: async (service, {project, sampleRate}) => {
        const audio = await render(service, project, sampleRate ?? 48_000)
        const id = UUID.toString(UUID.generate())
        await post(`renders/${id}`, WavFile.encodeFloats(audio))
        return {render: id}
    },
    // the song as the phone plays it, kept by the store for the version it was rendered from
    bounce: async service => {
        const song = await roomOf(service)
        if (song === null) {throw noSong()}
        const {version} = await answerOf("version")
        const audio = await render(service, ProjectSkeleton.encode(song.project.boxGraph), 48_000)
        await post(`bounce?version=${version}`, pcm16(audio) as BodyInit)
        return {version}
    }
}

const ready = Promise.withResolvers<void>()
export const prepareEngine = (): void => {
    let queue: Promise<unknown> = Promise.resolve()
    ;(window as any).engine = {
        ready: ready.promise,
        // one call at a time: two programs never interleave on one song
        call: (method: string, wire: string, turn: string): Promise<string> => {
            const next = queue.then(() => ready.promise).then(async () => {
                const run = methods[method]
                if (run === undefined) {throw new Error(`no such method: ${method}`)}
                return encode(await run(service!, decode(wire), String(turn ?? "")))
            })
            queue = next.catch(() => {})
            return next
        }
    }
    history.replaceState(null, "", location.pathname) // the token never stays in the address
    localStorage.setItem("opendaw-suppress-unload-guard", "1")
    Object.assign(StudioPreferences.settings.visibility, {"offer-studio-tour": false, "toasts": false})
}
let service: StudioService | undefined
export const startEngine = (booted: StudioService): void => {
    service = booted
    attachSongSamples(service, store)
    attachSongSoundfonts(service, store)
    // joined at once when there is a song; a song made later is joined on the call that needs it
    roomOf(service).catch(error => console.warn("[engine] first join:", error)).finally(() => ready.resolve())
}
