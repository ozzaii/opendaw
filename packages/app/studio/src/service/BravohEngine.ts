// BRAVOH's engine (github.com/ozzaii/opendaw, branch `bravoh`): the studio app itself executes a program's studio hands
// (bravoh/runtime/preamble.mjs) on one song's room, so every device the studio has plays in BRAVOH's songs. The engine
// host opens it headless as `/#engine=<song key>&token=<engine token>` and calls window.engine.call(method, wire, turn).
// The store (bravoh/engine/server.mjs) keeps the song, its undo marks, the renders and the bounce; this page saves
// nothing itself: its edits reach the store through the room. It never writes UI state boxes into the song.
import {int, Option, UUID} from "@opendaw/lib-std"
import {AudioData, PPQN, ppqn, TimeBase, WavFile} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioBounce, MixdownSection, Project, StudioPreferences, YService} from "@opendaw/studio-core"
import {ScriptHostProtocol} from "@opendaw/studio-scripting"
import {StudioService} from "@/service/StudioService"
import {ScriptAnswers} from "@/service/ScriptAnswers"
import {attachSongSamples, attachSongSoundfonts} from "@/service/BravohBooth"
import {renderLanes, RenderWatch, Superseded} from "@/service/BravohRenders"

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
    const {loopArea, bpm} = ProjectSkeleton.findMandatoryBoxes(graph).timelineBox
    if (loopArea.enabled.getValue() && loopArea.to.getValue() > loopArea.from.getValue()) {
        return {type: "loop", key: "loop", label: "Loop Area", start: loopArea.from.getValue(), end: loopArea.to.getValue(), passes: 1, tail: false}
    }
    // A no-sync region (a stem with no tempo) keeps its length in SECONDS, as the region's adapter converts it: read as
    // pulses, ten 57 s stems ended the song at 0.03 s and the bounce was the 30 s tail alone (6 Nov).
    // shortcut: one tempo for the song, as the facts say it; a tempo track would need the project's tempo map here.
    const lengthOf = (box: any): ppqn => box.timeBase?.getValue?.() === TimeBase.Seconds
        ? PPQN.secondsToPulses(box.duration.getValue(), bpm.getValue()) : (box.duration?.getValue?.() ?? 0)
    const end = graph.boxes().filter(box => box.name.endsWith("RegionBox"))
        .reduce((last: ppqn, box: any) => Math.max(last, (box.position?.getValue?.() ?? 0) + lengthOf(box)), 0)
    return {type: "song", key: "song", label: "Entire song", start: 0, end, passes: 1, tail: true}
}
// A sample or soundfont that does not load plays as silence in the engine, so a render waits for each and refuses
// when one fails: a program must never hear a song with a hole in it as the song.
type Loader = { state: { type: string, reason?: string }, subscribe: (observer: (state: any) => void) => { terminate(): void } }
const loaded = (what: string, loader: Loader, watch: RenderWatch): Promise<void> => {
    const answered = watch.wait(what)
    return new Promise<void>((resolve, reject) => {
        if (loader.state.type === "error") {return reject(new Error(`${what}: ${loader.state.reason}`))}
        const subscription = loader.subscribe(state => {
            if (state.type !== "loaded" && state.type !== "error") {return}
            queueMicrotask(() => subscription?.terminate())
            state.type === "loaded" ? resolve() : reject(new Error(`${what}: ${state.reason}`))
        })
    }).finally(answered)
}
const render = async (service: StudioService, bytes: ArrayBufferLike, sampleRate: int, took: Record<string, number>, watch: RenderWatch): Promise<AudioData> => {
    const began = performance.now()
    const {boxGraph} = ProjectSkeleton.decode(bytes as ArrayBuffer)
    const section = sectionOf(boxGraph)
    if (section.end <= section.start) {throw new Error("The song has no regions to render.")}
    const loads = await Promise.allSettled(boxGraph.boxes().flatMap(box => {
        const uuid = box.address.uuid, id = UUID.toString(uuid)
        return box.name === "AudioFileBox" ? [loaded(`sample ${id}`, service.sampleManager.getOrCreate(uuid) as any, watch)]
            : box.name === "SoundfontFileBox" ? [loaded(`soundfont ${id}`, service.soundfontManager.getOrCreate(uuid) as any, watch)] : []
    }))
    const failed = loads.flatMap(load => load.status === "rejected" ? [String(load.reason?.message ?? load.reason)] : [])
    if (failed.length > 0) {throw new Error(`Some sounds of the song did not load, so the render would be missing them: ${failed.join("; ")}`)}
    took.soundsMs = Math.round(performance.now() - began)
    // the live AudioContext keeps running: an offline render is a worker of its own
    const audio = await ScriptAnswers.renderMixdown(service, bytes, sampleRate, {section, abortSignal: watch.signal, listeners: {wait: watch.wait}})
    took.renderMs = Math.round(performance.now() - began) - took.soundsMs
    if (!section.tail) {return audio}
    // The engine's tail only stops under -72 dBFS: on 6 Nov a tone held at -70.9 ran a 76.8 s song to its 30 s cap.
    const {bpm} = ProjectSkeleton.findMandatoryBoxes(boxGraph).timelineBox
    const song = Math.round(PPQN.pulsesToSeconds(section.end - section.start, bpm.getValue()) * sampleRate)
    return AudioBounce.withRelease(audio, song)
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
type HostCalls = Pick<ScriptHostProtocol, "listSoundfonts" | "addSoundfont" | "listNamModels" | "addNamModel" | "listWclaps" | "describeWclap"> & {
    masterMatch(wire: string, reference: {builtin?: string, sample?: string}): Promise<unknown>
}
// A file the store holds, as the studio's AudioData.
const wavOf = async (path: string): Promise<AudioData> => {
    const response = await store(path)
    if (!response.ok) {throw new Error(`the store answered ${response.status} to ${path}`)}
    return WavFile.decodeFloats(await response.arrayBuffer())
}
const hostCalls = (service: StudioService): HostCalls => ({
    // THE REFERENCE MATCH, on the render of the project in `wire`: a render the store holds costs nothing. Analysis is the
    // fork's Matchering worker (GPL-3.0), and what it answers goes on the Mastering device as a program writes it.
    // shortcut: runs on the page's edit line, so an uncached render holds the song's edits; the mix renders first.
    masterMatch: async (wire, {builtin, sample}) => {
        const {project, sampleRate} = decode(wire)
        const {version} = await answerOf("version")
        const id = await renderOnce(service, project, sampleRate ?? 48_000, false, version)
        const {Matchering} = await import("@opendaw/studio-matchering")
        const name = sample ?? builtin ?? "Balanced"
        const profile = sample !== undefined
            ? await Matchering.analyseReference(await wavOf(`sample?uuid=${sample}`))
            : await Matchering.builtinProfile(Math.max(0, Matchering.BuiltinProfiles.indexOf(name)))
        const match = await Matchering.matchTarget(await wavOf(`renders/${id}`), profile)
        const base64 = (curve: Float64Array) => toBase64(new Uint8Array(Matchering.curveToBytes(curve).buffer))
        return {matchGain: match.gain, finalAmplitude: match.finalAmplitude, midCurve: base64(match.midCurve), sideCurve: base64(match.sideCurve), referenceName: name}
    },
    listSoundfonts: async () => [...await ScriptAnswers.listSoundfonts(service), ...await answerOf("soundfonts")],
    addSoundfont: (buffer, name) => post(`soundfonts?name=${encodeURIComponent(name)}`, buffer),
    listNamModels: () => answerOf("nam"),
    addNamModel: (model, name) => post("nam", JSON.stringify({model, name})),
    listWclaps: () => ScriptAnswers.listWclaps(),
    describeWclap: (url, clapId) => ScriptAnswers.describeWclap(service, url, clapId)
})

// A render the artist is waiting for that is not the bounce (a mute or a solo): the API says so where a program says its turn.
const ARTIST_TURN = "artist"
const lanes = renderLanes({
    version: async () => (await answerOf("version")).version,
    stored: async id => (await store(`renders/${id}?peek=1`)).ok,
    note: what => void post(`renders-note`, JSON.stringify({[what]: 1})).catch(() => {}),
    stuck: error => {
        void post(`renders-note`, JSON.stringify({stuck: error.message})).catch(() => {})
        // What it waited for belongs to this page (a loader, a storage lock), and the next render would wait for it too. A
        // render that only ran long is gone with its worker. The moment is for the failed call's answer to leave; the page
        // comes back joined to its room, and the token left the address on boot.
        if (error.waited.length > 0) {
            setTimeout(() => {
                location.hash = `engine=${key}&token=${token}`
                location.reload()
            }, 500)
        }
    }
})
/** This project rendered once, for everyone who asks while it runs or while the store holds it; its name in the store. */
const renderOnce = async (service: StudioService, bytes: ArrayBufferLike, sampleRate: int, artist: boolean, version: int): Promise<string> => {
    const id = `${UUID.toString(await UUID.sha256(bytes as ArrayBuffer))}-${sampleRate}`
    await lanes.once(id, version, artist, async watch => {
        const took: Record<string, number> = {}
        const audio = await render(service, bytes, sampleRate, took, watch)
        const encoding = performance.now()
        const wav = WavFile.encodeFloats(audio)
        took.wavMs = Math.round(performance.now() - encoding)
        const posting = performance.now()
        await post(`renders/${id}`, wav)
        took.postMs = Math.round(performance.now() - posting)
        await post(`renders-note`, JSON.stringify({took}))
    })
    return id
}

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
    }
}

// RENDERS ANSWER BESIDE THE EDITS: each renders its own copy of the bytes it was given, so an `open` or an `apply` does not
// wait a whole song behind one (11-07: a `studio_open` read 60.4 s). `edit` is the one line edits stand in, for what must read the room.
const renders: Record<string, (service: StudioService, input: any, turn: string, edit: <T>(work: () => Promise<T>) => Promise<T>) => Promise<unknown>> = {
    // a candidate the program built, rendered and never applied; the frames wait in the store for the hand to fetch
    mixdown: async (service, {project, sampleRate}, turn) => {
        const {version} = await answerOf("version")
        return {render: await renderOnce(service, project, sampleRate ?? 48_000, turn === ARTIST_TURN, version)}
    },
    // the song as the phone plays it, kept by the store for the version it was rendered from. A bounce overtaken while it
    // waited renders the song as it now stands: the artist always has one coming.
    bounce: async (service, _input, _turn, edit) => {
        for (; ;) {
            const {bytes, version} = await edit(async () => {
                const song = await roomOf(service)
                if (song === null) {throw noSong()}
                return {version: (await answerOf("version")).version as int, bytes: ProjectSkeleton.encode(song.project.boxGraph)}
            })
            try {
                const id = await renderOnce(service, bytes, 48_000, true, version)
                // the store encodes the render it holds: what the mix holds above 0 dBFS reaches its encoder whole (`bounce.mjs`)
                await post(`bounce?version=${version}&render=${id}`, "")
                return {version}
            } catch (error) {
                if (!(error instanceof Superseded)) {throw error}
            }
        }
    }
}

const ready = Promise.withResolvers<void>()
export const prepareEngine = (): void => {
    let queue: Promise<unknown> = Promise.resolve()
    const edit = <T>(work: () => Promise<T>): Promise<T> => {
        const next = queue.then(() => ready.promise).then(work)
        queue = next.catch(() => {})
        return next
    }
    ;(window as any).engine = {
        ready: ready.promise,
        call: (method: string, wire: string, turn: string): Promise<string> => {
            const rendering = renders[method]
            if (rendering !== undefined) {
                return ready.promise.then(async () => encode(await rendering(service!, decode(wire), String(turn ?? ""), edit)))
            }
            // one edit at a time: two programs never interleave on one song
            return edit(async () => {
                const run = methods[method]
                if (run === undefined) {throw new Error(`no such method: ${method}`)}
                return encode(await run(service!, decode(wire), String(turn ?? "")))
            })
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
