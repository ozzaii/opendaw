// The booth page: joins a song's room on the engine, plays it on openDAW's own realtime engine, and answers the host
// (services/booth) through window.booth. Its sound leaves by the page's own output, which the host streams.
import {Option, panic} from "@opendaw/lib-std"
import {AnimationFrame} from "@opendaw/lib-dom"
import {WavFile} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {BpmDetector, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioWorklets, GlobalSampleLoaderManager, GlobalSoundfontLoaderManager, Project, SampleService, SoundfontService, Workers, YSync} from "@opendaw/studio-core"
import WorkersUrl from "@opendaw/studio-core/workers-main.js?worker&url"
import {WasmEngine} from "@opendaw/studio-core-wasm"
import WasmProcessorUrl from "@opendaw/studio-core-wasm/wasm-processor.js?url"
import WasmOfflineWorkerUrl from "@opendaw/studio-core-wasm/wasm-offline-worker.js?worker&url"
import * as Y from "yjs"
import {WebsocketProvider} from "y-websocket"
// #key=<song>&token=<engine token>: the fragment never reaches a server log.
const hash = new URLSearchParams(location.hash.slice(1))
history.replaceState(null, "", location.pathname)
const key = hash.get("key") ?? panic("no song key"), token = hash.get("token") ?? panic("no token")
const engine = (path: string) => fetch(`/v1/songs/${key}/${path}`, {headers: {authorization: `Bearer ${token}`}})
let project: Project | null = null
let analyser: AnalyserNode | null = null
const failed: string[] = []
const join = async () => {
    // A booth opened before the first program wrote a song waits for it (a 404 is "no song yet").
    let answer = await engine("room")
    for (let waited = 0; answer.status === 404 && waited < 600; waited++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        answer = await engine("room")
    }
    if (!answer.ok) return panic(`no room: ${answer.status}`)
    const {room, ws} = await answer.json()
    AnimationFrame.start(window)
    await Workers.install(WorkersUrl)
    const audioContext = new AudioContext({sampleRate: 48000, latencyHint: "playback"})
    WasmEngine.install({processorUrl: WasmProcessorUrl, offlineWorkerUrl: WasmOfflineWorkerUrl, wasmUrl: ""})
    if (!await WasmEngine.ensureReady(audioContext)) return panic("the engine did not start")
    const samples = new GlobalSampleLoaderManager({fetch: async uuid => {
        const id = [...uuid].map((byte, index) => ([4, 6, 8, 10].includes(index) ? "-" : "") + (byte & 0xff).toString(16).padStart(2, "0")).join("")
        const response = await fetch(`/v1/songs/${key}/sample?uuid=${id}`, {headers: {authorization: `Bearer ${token}`}})
        if (!response.ok) {failed.push(id); return panic(`sample ${id} is missing`)}
        const audio = WavFile.decodeFloats(await response.arrayBuffer())
        return [audio, {name: id, bpm: 0, duration: audio.numberOfFrames / audio.sampleRate, sample_rate: audio.sampleRate, origin: "import"}] as any
    }})
    const env = {audioContext, audioWorklets: new AudioWorklets(audioContext), sampleManager: samples,
        soundfontManager: new GlobalSoundfontLoaderManager({fetch: async () => panic("no soundfonts yet")}),
        sampleService: new SampleService(audioContext, BpmDetector.Unknown), soundfontService: new SoundfontService()}
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(new URL(ws, location.href.replace(/^http/, "ws")).href, room, doc, {params: {token}})
    await new Promise<void>(resolve => provider.on("sync", (synced: boolean) => {if (synced) resolve()}))
    const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    const sync = await YSync.joinRoom({boxGraph, boxes: doc.getMap("boxes")})
    project = Project.fromSkeleton(env as any, {boxGraph, mandatoryBoxes: ProjectSkeleton.findMandatoryBoxes(boxGraph)}, false)
    project.own(sync)
    project.attachLiveSync(sync)
    // a restarted worklet is a new node: the tap follows it (engine.md §2)
    const tap = (worklet: AudioNode) => {analyser = audioContext.createAnalyser(); analyser.fftSize = 2048; worklet.connect(analyser)}
    tap(project.startAudioWorklet({unload: async () => {}, load: worklet => tap(worklet)}))
    await project.engine.isReady()
    if (audioContext.state !== "running") await audioContext.resume()
    return {room, boxes: boxGraph.boxes().length, isolated: crossOriginIsolated}
}
const level = () => {
    if (!analyser) return 0
    const buffer = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buffer)
    return Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length)
}
;(window as any).booth = {
    joined: join(),
    play: (from?: number) => {if (from !== undefined) project!.engine.setPosition(from); project!.engine.play()},
    stop: () => project!.engine.stop(true),
    names: () => project?.boxGraph.boxes().map(box => box.name).join(","),
    seek: (position: number) => project!.engine.setPosition(position),
    // The transport as the phone draws it (BRAVOH's boothState.transport): bars from 1, the loop as [from, to).
    transport: () => {
        if (!project) return undefined
        const timeline = project.timelineBox, signature = timeline.signature
        const bar = Math.floor(960 * 4 / signature.denominator.getValue()) * signature.nominator.getValue()
        const loop = timeline.loopArea, on = loop.enabled.getValue() && loop.to.getValue() > loop.from.getValue()
        const from = on ? Math.floor(loop.from.getValue() / bar) + 1 : 1
        const end = on ? loop.to.getValue() : timeline.durationInPulses.getValue()
        return {playing: project.engine.isPlaying.getValue(), from, to: Math.max(from + 1, Math.ceil(end / bar) + 1),
            bar: Math.round((project.engine.position.getValue() / bar + 1) * 1000) / 1000, at: Date.now()}
    },
    // The artist's hand: the head to `bar` (from 1), then play or stop.
    move: (ask: {playing?: boolean, bar?: number}) => {
        if (!project) return false
        const signature = project.timelineBox.signature
        const bar = Math.floor(960 * 4 / signature.denominator.getValue()) * signature.nominator.getValue()
        if (ask.bar !== undefined) project.engine.setPosition(Math.max(0, Math.round((ask.bar - 1) * bar)))
        if (ask.playing === true) project.engine.play()
        if (ask.playing === false) project.engine.stop(false)
        return true
    },
    state: () => ({playing: project?.engine.isPlaying.getValue() ?? false, position: project?.engine.position.getValue() ?? 0,
        bpm: project?.engine.bpm.getValue() ?? 0, level: level(), failed, units: project?.boxGraph.boxes().filter(box => box.name === "AudioUnitBox").length ?? 0})
}
