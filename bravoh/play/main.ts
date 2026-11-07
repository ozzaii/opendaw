// A MEASURING PAGE, not the product: joins a song's room on the engine and plays it on openDAW's realtime engine in this
// browser, with a tap after the engine so a script reads what it sent to the output. Opened at /booth/#key=&token=.
import {Option, panic, UUID} from "@opendaw/lib-std"
import {AnimationFrame} from "@opendaw/lib-dom"
import {WavFile} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, AudioFileBox, AudioRegionBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {BpmDetector, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioWorklets, GlobalSampleLoaderManager, GlobalSoundfontLoaderManager, Project, SampleService, SoundfontService, Workers, YSync} from "@opendaw/studio-core"
import WorkersUrl from "@opendaw/studio-core/workers-main.js?worker&url"
import {WasmEngine} from "@opendaw/studio-core-wasm"
import WasmProcessorUrl from "@opendaw/studio-core-wasm/wasm-processor.js?url"
import WasmOfflineWorkerUrl from "@opendaw/studio-core-wasm/wasm-offline-worker.js?worker&url"
import * as Y from "yjs"
import {WebsocketProvider} from "y-websocket"

const hash = new URLSearchParams(location.hash.slice(1))
history.replaceState(null, "", location.pathname)
const key = hash.get("key") ?? panic("no song key"), token = hash.get("token") ?? panic("no token")
const latencyHint = (hash.get("latency") ?? "playback") as AudioContextLatencyCategory
const store = (path: string, init: RequestInit = {}) => fetch(`/v1/songs/${key}/${path}`, {...init, headers: {authorization: `Bearer ${token}`}})

const marks: Record<string, number> = {}
const mark = (name: string) => {marks[name] ??= Math.round(performance.now())}
const samples = {bytes: 0, fetched: 0, fetchMs: 0, decodeMs: 0, failed: [] as string[]}

const QUANTUM = 128
const METER = 48_000 / QUANTUM * 900 // 15 minutes of one level per quantum
// shared with the tap: how many quanta it has seen, one level per quantum, and the frames when capturing
const counter = new Int32Array(new SharedArrayBuffer(16)) // 0 quanta, 1 capturing, 2 frames captured
const meter = new Float32Array(new SharedArrayBuffer(METER * 4))
const stamps = new Float64Array(new SharedArrayBuffer(METER * 8)) // the wall clock when each quantum ran
const MAX_CAPTURE = 48_000 * 2 * 330
let capture: Float32Array | null = null
const TAP = `class Tap extends AudioWorkletProcessor {
  constructor(o) { super(); const p = o.processorOptions; this.c = new Int32Array(p.counter); this.m = new Float32Array(p.meter); this.s = new Float64Array(p.stamps); this.p = p.pcm ? new Float32Array(p.pcm) : null }
  process(inputs) {
    const l = inputs[0][0], r = inputs[0][1] ?? l, q = this.c[0]
    this.s[q % this.s.length] = Date.now()
    if (l) {
      let sum = 0
      for (let i = 0; i < l.length; i++) sum += l[i] * l[i] + r[i] * r[i]
      this.m[q % this.m.length] = Math.sqrt(sum / (2 * l.length))
      if (this.p && Atomics.load(this.c, 1) === 1) {
        let w = this.c[2] * 2
        for (let i = 0; i < l.length && w + 1 < this.p.length; i++) { this.p[w++] = l[i]; this.p[w++] = r[i] }
        Atomics.store(this.c, 2, w / 2)
      }
    } else this.m[q % this.m.length] = 0
    Atomics.store(this.c, 0, q + 1)
    return true
  }
}
registerProcessor("np-tap", Tap)`

let project: Project | null = null, sync: YSync<BoxIO.TypeMap> | null = null, audioContext: AudioContext | null = null
let manager: GlobalSampleLoaderManager | null = null
let layer: ReturnType<YSync<BoxIO.TypeMap>["createLayer"]> | null = null
let provider: WebsocketProvider | null = null
const idOf = (bytes: UUID.Bytes) => UUID.toString(bytes)

const fileIds = () => project!.boxGraph.boxes().filter(box => box.name === "AudioFileBox").map(box => box.address.uuid)
const allLoaded = (ids: ReadonlyArray<UUID.Bytes>) => Promise.allSettled(ids.map(uuid => new Promise<void>((resolve, reject) => {
    const loader = manager!.getOrCreate(uuid)
    const subscription = loader.subscribe(state => {
        if (state.type === "loaded") {queueMicrotask(() => subscription?.terminate()); resolve()}
        if (state.type === "error") {samples.failed.push(`${idOf(uuid)}: ${state.reason}`); queueMicrotask(() => subscription?.terminate()); reject(new Error(state.reason))}
    })
})))

// A browser with autoplay rules (Safari): the context is born and resumed inside the press, as the product's Play would.
const pressed = hash.get("gesture") ? new Promise<void>(resolve => {
    const button = Object.assign(document.createElement("button"), {id: "go", textContent: "go"})
    button.onclick = () => {
        audioContext = new AudioContext({sampleRate: 48_000, latencyHint})
        audioContext.resume()
        mark("pressed")
        resolve()
    }
    document.body.append(button)
}) : Promise.resolve()

const join = async () => {
    mark("script")
    await pressed
    const answer = await store("room")
    if (!answer.ok) {return panic(`no room: ${answer.status}`)}
    const {room, ws} = await answer.json()
    AnimationFrame.start(window)
    await Workers.install(WorkersUrl)
    audioContext ??= new AudioContext({sampleRate: 48_000, latencyHint})
    WasmEngine.install({processorUrl: WasmProcessorUrl, offlineWorkerUrl: WasmOfflineWorkerUrl, wasmUrl: ""})
    if (!await WasmEngine.ensureReady(audioContext)) {return panic("the engine did not start")}
    mark("engineCompiled")
    await audioContext.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], {type: "text/javascript"})))
    manager = new GlobalSampleLoaderManager({fetch: async uuid => {
        const id = UUID.toString(uuid), began = performance.now()
        const response = await store(`sample?uuid=${id}`)
        if (!response.ok) {return panic(`sample ${id} is missing`)}
        const buffer = await response.arrayBuffer()
        const decoding = performance.now()
        samples.bytes += buffer.byteLength; samples.fetched++; samples.fetchMs += decoding - began
        const audio = WavFile.decodeFloats(buffer)
        samples.decodeMs += performance.now() - decoding
        return [audio, {name: id, bpm: 0, duration: audio.numberOfFrames / audio.sampleRate, sample_rate: audio.sampleRate, origin: "import"}] as any
    }})
    const env = {audioContext, audioWorklets: new AudioWorklets(audioContext), sampleManager: manager,
        soundfontManager: new GlobalSoundfontLoaderManager({fetch: async () => panic("no soundfonts in this spike")}),
        sampleService: new SampleService(audioContext, BpmDetector.Unknown), soundfontService: new SoundfontService()}
    const doc = new Y.Doc()
    provider = new WebsocketProvider(new URL(ws, location.href.replace(/^http/, "ws")).href, room, doc, {params: {token}})
    await new Promise<void>(resolve => provider!.on("sync", (synced: boolean) => {if (synced) resolve()}))
    mark("roomSynced")
    const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    sync = await YSync.joinRoom({boxGraph, boxes: doc.getMap("boxes")})
    project = Project.fromSkeleton(env as any, {boxGraph, mandatoryBoxes: ProjectSkeleton.findMandatoryBoxes(boxGraph)}, false)
    project.own(sync)
    project.attachLiveSync(sync)
    layer = sync.createLayer("take")
    mark("projectBuilt")
    const worklet = project.startAudioWorklet({unload: async () => {}, load: () => panic("the engine restarted")})
    const pcm = hash.get("capture") ? (capture = new Float32Array(new SharedArrayBuffer(MAX_CAPTURE * 4))).buffer : null
    const tap = new AudioWorkletNode(audioContext, "np-tap", {numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: {counter: counter.buffer, meter: meter.buffer, stamps: stamps.buffer, pcm}})
    worklet.connect(tap, 0)
    tap.connect(audioContext.destination) // its output is silence: a node nobody pulls does not run
    await project.engine.isReady()
    if (hash.get("measure")) {(project.engine.preferences.settings as any).debug.dspLoadMeasurement = true}
    mark("engineReady")
    if (audioContext.state !== "running") {await audioContext.resume()}
    mark("contextRunning")
    await allLoaded(fileIds())
    mark("samplesLoaded")
    // A sample that could not be stored plays as silence with the transport running: say so on the page.
    if (samples.failed.length > 0) {
        console.error("sample store failed", samples.failed)
        const banner = Object.assign(document.createElement("p"), {id: "store-failed", role: "alert",
            textContent: `${samples.failed.length} of ${fileIds().length} sounds could not be stored; they will not play.`})
        document.body.prepend(banner)
    }
    return {room, boxes: boxGraph.boxes().length, isolated: crossOriginIsolated, files: fileIds().length, storeFailed: samples.failed.length}
}

const unitsOf = () => project!.boxGraph.boxes().filter(box => box.name === "AudioUnitBox") as any[]
const nameOf = (unit: any) => unit.input.pointerHub.incoming().at(0)?.box.label?.getValue?.() ?? ""
const unitNamed = (name: string) => unitsOf().find(unit => nameOf(unit) === name) ?? panic(`no unit ${name}`)
const inLayer = (work: () => void) => layer!.run(() => {
    project!.boxGraph.beginTransaction()
    work()
    project!.boxGraph.endTransaction()
})

const levelDb = (value: number) => value > 0 ? 20 * Math.log10(value) : -200

;(window as any).np = {
    joined: join().catch(error => ({failed: String(error?.stack ?? error)})),
    marks: () => marks,
    samples: () => samples,
    context: () => {
        const stats = (audioContext as any)?.playbackStats
        return {state: audioContext?.state, sampleRate: audioContext?.sampleRate, baseLatency: audioContext?.baseLatency, outputLatency: audioContext?.outputLatency,
            stats: stats ? {fallbackFrames: stats.fallbackFramesEvents, underrunEvents: stats.underrunEvents, underrunDuration: stats.underrunDuration, totalDuration: stats.totalDuration, averageLatency: stats.averageLatency, minimumLatency: stats.minimumLatency, maximumLatency: stats.maximumLatency} : null}
    },
    now: () => Atomics.load(counter, 0),
    play: (from?: number) => {if (from !== undefined) {project!.engine.setPosition(from)} project!.engine.play()},
    stop: () => project!.engine.stop(true),
    seek: (position: number) => project!.engine.setPosition(position),
    position: () => project!.engine.position.getValue(),
    playing: () => project!.engine.isPlaying.getValue(),
    cpu: () => project!.engine.cpuLoad.getValue(),
    perf: () => ({buffer: Array.from(project!.engine.perfBuffer), index: project!.engine.perfIndex}),
    loading: () => project!.engine.queryLoadingComplete(),
    units: () => unitsOf().map(unit => ({name: nameOf(unit), mute: unit.mute.getValue(), solo: unit.solo.getValue(), volume: unit.volume.getValue(), type: unit.type?.getValue?.(), id: idOf(unit.address.uuid)})),
    // THE ARTIST'S HAND, in a layer that stays on this client: never written into the song
    mute: (names: string[], on: boolean) => {inLayer(() => names.forEach(name => unitNamed(name).mute.setValue(on))); return Atomics.load(counter, 0)},
    solo: (names: string[], on: boolean) => {inLayer(() => names.forEach(name => unitNamed(name).solo.setValue(on))); return Atomics.load(counter, 0)},
    // the same write outside a layer, to see what it does to the song
    muteInSong: (name: string, on: boolean) => {project!.boxGraph.beginTransaction(); unitNamed(name).mute.setValue(on); project!.boxGraph.endTransaction()},
    version: async () => (await (await store("version")).json()).version,
    // the first quantum at or after `from` whose level crosses `db`, waited for up to `timeout` ms
    crossing: async (from: number, db: number, above: boolean, timeout = 5000, hold = 8) => {
        const end = performance.now() + timeout
        let q = from, run = 0
        while (performance.now() < end) {
            const upTo = Atomics.load(counter, 0)
            for (; q < upTo; q++) {
                const crossed = above ? levelDb(meter[q % METER]) > db : levelDb(meter[q % METER]) < db
                run = crossed ? run + 1 : 0
                if (run >= hold) {return {quantum: q - hold + 1, quanta: q - hold + 1 - from, ms: (q - hold + 1 - from) * QUANTUM / 48}}
            }
            await new Promise(resolve => setTimeout(resolve, 1))
        }
        return {timeout: true, last: levelDb(meter[(q - 1) % METER])}
    },
    stamp: (q: number) => stamps[q % METER],
    // every pause of the audio thread at or after quantum `from`: longer than `over` ms between two quanta
    stalls: (from: number, over = 100) => {
        const out: Array<{q: number, ms: number, at: number}> = [], to = Atomics.load(counter, 0)
        for (let q = from + 1; q < to; q++) {
            const gap = stamps[q % METER] - stamps[(q - 1) % METER]
            if (gap > over) {out.push({q, ms: gap, at: stamps[q % METER]})}
        }
        return out
    },
    levels: (from: number, to: number) => Array.from(meter.subarray(from, to)).map(value => Math.round(levelDb(value) * 10) / 10),
    captureStart: () => {Atomics.store(counter, 2, 0); Atomics.store(counter, 1, 1)},
    captureStop: () => {Atomics.store(counter, 1, 0); return Atomics.load(counter, 2)},
    // Sent to the harness: COEP lets a CORS POST out.
    captureSend: async (url: string) => {
        const frames = Atomics.load(counter, 2)
        const copy = new Float32Array(frames * 2); copy.set(capture!.subarray(0, frames * 2))
        return (await fetch(url, {method: "POST", body: copy})).text()
    },
    // One take of what the tap heard from `at` for 14 s, and what two takes leave when subtracted: same-page repeatability.
    take: async (at: number) => {
        Atomics.store(counter, 2, 0); Atomics.store(counter, 1, 1)
        project!.engine.play(); project!.engine.setPosition(at)
        await new Promise(resolve => setTimeout(resolve, 14_000))
        project!.engine.stop(true)
        Atomics.store(counter, 1, 0)
        return capture!.slice(0, Atomics.load(counter, 2) * 2)
    },
    nullOf: (one: Float32Array, two: Float32Array) => {
        const rms = (x: Float32Array, y: Float32Array | null, from: number, n: number, lag: number) => {let s = 0; for (let i = from; i < from + n; i++) {const d = x[i] - (y ? y[i + lag] : 0); s += d * d} return Math.sqrt(s / n)}
        const from = 48_000 * 4, n = 48_000 * 2 * 8
        let best = Infinity, lag = 0
        for (let k = -96; k <= 96; k++) {const r = rms(one, two, from, 48_000, k * 256); if (r < best) {best = r; lag = k * 256}}
        const signal = rms(one, null, from, n, 0), left = rms(one, two, from, n, lag)
        return {signalDb: Math.round(levelDb(signal) * 10) / 10, leftDb: Math.round(levelDb(left) * 10) / 10, nullDb: signal > 0 ? Math.round((levelDb(left) - levelDb(signal)) * 10) / 10 : null, lagFrames: lag / 2}
    },
    memory: async () => {
        const measured = await (performance as any).measureUserAgentSpecificMemory?.().catch((error: any) => ({error: String(error)}))
        return {measured: measured?.bytes, heap: (performance as any).memory?.usedJSHeapSize}
    },
    // WHAT A PROGRAM'S EDIT DOES, from a second page in the room: a region on `lane` from `bar` for `bars`, of a file this
    // song knows or a new one the store holds. Answers the wall clock of the commit.
    addRegion: (lane: string, bar: number, bars: number, fileId?: string, label = "new") => {
        const graph = project!.boxGraph
        const unit = unitNamed(lane)
        const track = unit.tracks.pointerHub.incoming().map((one: any) => one.box).find((box: any) => box.name === "TrackBox")
        const like = track.regions.pointerHub.incoming().map((one: any) => one.box).find((box: any) => box.name === "AudioRegionBox")
        if (!like) {return panic(`${lane} has no audio region to copy`)}
        graph.beginTransaction()
        const file = fileId
            ? AudioFileBox.create(graph as any, UUID.parse(fileId), box => {
                const old = like.file.targetVertex.unwrap().box
                box.startInSeconds.setValue(old.startInSeconds.getValue()); box.endInSeconds.setValue(old.endInSeconds.getValue())
                box.fileName.setValue(label)
            })
            : like.file.targetVertex.unwrap().box
        const events = ValueEventCollectionBox.create(graph as any, UUID.generate())
        // a no-sync stem keeps its length in seconds, in the song's one tempo (144 here)
        const position = bar * 3840, length = /second/i.test(String(like.timeBase.getValue())) ? bars * 4 * 60 / project!.engine.bpm.getValue() : bars * 3840
        AudioRegionBox.create(graph as any, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.file.refer(file as any)
            box.events.refer(events.owners)
            box.playback.setValue(like.playback.getValue())
            box.timeBase.setValue(like.timeBase.getValue())
            box.position.setValue(position)
            box.duration.setValue(length)
            box.loopOffset.setValue(like.loopOffset.getValue())
            box.loopDuration.setValue(like.loopDuration.getValue())
            box.gain.setValue(like.gain.getValue())
            box.label.setValue(label)
            if (like.playMode.nonEmpty()) {box.playMode.refer(like.playMode.targetVertex.unwrap())}
        })
        graph.endTransaction()
        return Date.now()
    },
    regionDump: (lane: string) => {
        const unit = unitNamed(lane)
        const tracks = unit.tracks.pointerHub.incoming().map((one: any) => one.box)
        return tracks.flatMap((track: any) => track.regions.pointerHub.incoming().map((one: any) => {
            const box = one.box
            return {name: box.name, label: box.label?.getValue?.(), position: box.position.getValue(), duration: box.duration.getValue(), mute: box.mute?.getValue?.(),
                timeBase: box.timeBase?.getValue?.(), playback: box.playback?.getValue?.(), file: box.file ? idOf(box.file.targetVertex.unwrap().box.address.uuid) : undefined, loopDuration: box.loopDuration?.getValue?.()}
        }))
    },
    devices: () => project!.boxGraph.boxes().filter(box => /DeviceBox|Lfo|Modulation/.test(box.name)).map((box: any) => {
        const host = box.host?.targetVertex?.unwrapOrNull?.()?.box
        return {name: box.name, label: box.label?.getValue?.(), on: box.enabled?.getValue?.(), host: host ? nameOf(host) : undefined, code: box.code?.getValue?.()?.slice?.(0, 1500), rate: box.rate?.getValue?.(), phase: box.phase?.getValue?.(), sync: box.sync?.getValue?.()}
    }),
    files: () => fileIds().map(idOf),
    names: () => [...new Set(project!.boxGraph.boxes().map(box => box.name))],
    wallClock: () => Date.now(),
    disconnect: () => provider?.disconnect()
}
