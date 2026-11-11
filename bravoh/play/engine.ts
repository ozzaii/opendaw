// THE SONG IN THE ARTIST'S PAGE: the engine bundle BRAVOH's page loads from /play/engine.js, never imports. AGPL-3.0, this fork.
// The page gives it doors (it holds no token of the store's) and a context born in a press; it answers Play and M/S in place.
import {Option, UUID} from "@opendaw/lib-std"
import {AnimationFrame} from "@opendaw/lib-dom"
import {WavFile} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, StereoToolDeviceBox} from "@opendaw/studio-boxes"
import {BpmDetector, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioWorklets, GlobalSampleLoaderManager, GlobalSoundfontLoaderManager, Project, SampleService, SoundfontService, Workers} from "@opendaw/studio-core"
import WorkersUrl from "@opendaw/studio-core/workers-main.js?worker&url"
import {WasmEngine} from "@opendaw/studio-core-wasm"
import WasmProcessorUrl from "@opendaw/studio-core-wasm/wasm-processor.js?url"
import WasmOfflineWorkerUrl from "@opendaw/studio-core-wasm/wasm-offline-worker.js?worker&url"

declare const __SOURCE__: string
export const source = __SOURCE__

export type Sounds = {files: number, done: number, bytes: number, known: number}
export type Doors = {project: () => Promise<Response>, sample: (uuid: string) => Promise<Response>}
// What this page cannot play yet: a song holding one is the bounce's (amp models, plug-ins and soundfonts live behind the store).
const NOT_HERE = /NeuralAmp|Wclap|Soundfont/
const PPQN_BEAT = 960

let workers: Promise<unknown> | undefined
const failures: string[] = []
const files = new Map<string, {got: number, size: number}>()

export const openSong = async (doors: Doors, onSounds: (sounds: Sounds) => void) => {
    workers ??= Workers.install(WorkersUrl)
    await workers
    AnimationFrame.start(window)
    const say = (fileCount: number, done: number) => onSounds({files: fileCount, done,
        bytes: [...files.values()].reduce((sum, one) => sum + one.got, 0), known: [...files.values()].reduce((sum, one) => sum + one.size, 0)})
    let total = 0, finished = 0
    const manager = new GlobalSampleLoaderManager({fetch: async uuid => {
        const id = UUID.toString(uuid)
        const answer = await doors.sample(id)
        if (!answer.ok || !answer.body) {throw new Error(`sample ${id}: ${answer.status}`)}
        const seen = {got: 0, size: Number(answer.headers.get("content-length") ?? 0)}
        files.set(id, seen)
        const parts: Uint8Array[] = []
        const reader = answer.body.getReader()
        for (let part = await reader.read(); !part.done; part = await reader.read()) {
            parts.push(part.value); seen.got += part.value.byteLength
            say(total, finished)
        }
        const bytes = new Uint8Array(seen.got)
        let at = 0
        for (const part of parts) {bytes.set(part, at); at += part.byteLength}
        const audio = WavFile.decodeFloats(bytes.buffer)
        return [audio, {name: id, bpm: 0, duration: audio.numberOfFrames / audio.sampleRate, sample_rate: audio.sampleRate, origin: "import"}] as any
    }})
    // One version of the song: its graph and every sound under it on this device. Throws what stopped it, for the page's fallback.
    const prepare = async () => {
        const answer = await doors.project()
        if (!answer.ok) {throw new Error(`project: ${answer.status}`)}
        const version = Number(answer.headers.get("x-version"))
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        graph.fromArrayBuffer(ProjectSkeleton.decode(await answer.arrayBuffer()).boxGraph.toArrayBuffer(), false)
        const unplayable = graph.boxes().find(box => NOT_HERE.test(box.name))
        if (unplayable) {throw new Error(`not in the page yet: ${unplayable.name}`)}
        const ids = graph.boxes().filter(box => box.name === "AudioFileBox").map(box => box.address.uuid)
        total = ids.length; finished = 0; failures.length = 0
        await Promise.all(ids.map(uuid => new Promise<void>(resolve => {
            const loader = manager.getOrCreate(uuid)
            const subscription = loader.subscribe(state => {
                if (state.type !== "loaded" && state.type !== "error") {return}
                if (state.type === "error") {failures.push(`${UUID.toString(uuid)}: ${state.reason}`)}
                finished++; say(total, finished)
                queueMicrotask(() => subscription.terminate()); resolve()
            })
        })))
        if (failures.length) {throw new Error(`${failures.length} of ${total} sounds could not be stored: ${failures[0]}`)}
        return {graph, version}
    }
    let ready = await prepare()
    let project: Project | undefined
    let engineContext: AudioContext | undefined
    let worklet: AudioWorkletNode | undefined
    const stage = async () => {
        const context = engineContext!
        const next = Project.fromSkeleton({audioContext: context, audioWorklets: new AudioWorklets(context), sampleManager: manager,
            soundfontManager: new GlobalSoundfontLoaderManager({fetch: async () => {throw new Error("no soundfonts here")}}),
            sampleService: new SampleService(context, BpmDetector.Unknown), soundfontService: new SoundfontService()} as any,
            {boxGraph: ready.graph as any, mandatoryBoxes: ProjectSkeleton.findMandatoryBoxes(ready.graph as any)}, false)
        const node = next.startAudioWorklet({unload: async () => {}, load: () => {throw new Error("the engine restarted")}})
        node.connect(context.destination)
        await next.engine.isReady()
        return {next, node}
    }
    const unitNamed = () => {
        const named = new Map<string, any>()
        for (const box of project!.boxGraph.boxes()) {
            if (box.name !== "AudioUnitBox") {continue}
            const unit = box as any, label = unit.input.pointerHub.incoming().at(0)?.box.label?.getValue?.()
            if (label) {named.set(label, unit)}
        }
        return named
    }
    return {
        version: () => ready.version,
        // In the press: the context the page made there, resumed. Everything after this is a parameter.
        arm: async (context: AudioContext) => {
            engineContext = context
            WasmEngine.install({processorUrl: WasmProcessorUrl, offlineWorkerUrl: WasmOfflineWorkerUrl, wasmUrl: ""})
            if (!await WasmEngine.ensureReady(context)) {throw new Error("the engine did not start")}
            const {next, node} = await stage()
            project = next; worklet = node
        },
        // A stop and a play in one tick start the reverb's LFO where a render does (research/native-play): the file and this are one sound.
        play: (beat: number) => {
            project!.engine.stop(true)
            project!.engine.setPosition(Math.round(beat * PPQN_BEAT))
            project!.engine.play()
        },
        pause: () => project!.engine.stop(true),
        seek: (beat: number) => project!.engine.setPosition(Math.round(beat * PPQN_BEAT)),
        beat: () => project!.engine.position.getValue() / PPQN_BEAT,
        // The artist's hand, never written anywhere: this graph is the page's own copy.
        silence: (lanes: ReadonlyArray<{name: string, silent: boolean}>) => {
            const units = unitNamed()
            project!.boxGraph.beginTransaction()
            for (const lane of lanes) {units.get(lane.name)?.mute.setValue(lane.silent)}
            project!.boxGraph.endTransaction()
        },
        // A lane's level as the song keeps it: the "Mix trim" StereoTool the mix table adds (BRAVOH `mixTable`), moved here
        // by the same number, added where the lane has none. This graph is the page's own copy: nothing is written.
        level: (name: string, db: number) => {
            const unit = unitNamed().get(name)
            if (!unit) {return}
            const effects: any[] = unit.audioEffects.pointerHub.incoming().map((pointer: any) => pointer.box)
            project!.boxGraph.beginTransaction()
            const trim = effects.find(box => box.name === "StereoToolDeviceBox" && String(box.label.getValue()).startsWith("Mix trim"))
                ?? StereoToolDeviceBox.create(project!.boxGraph as any, UUID.generate(), box => {
                    box.label.setValue("Mix trim"); box.index.setValue(effects.length); box.host.refer(unit.audioEffects)
                })
            trim.volume.setValue(Math.max(-72, Math.min(12, db)))
            project!.boxGraph.endTransaction()
        },
        // A new version: its sounds fetched first, the old one plays until the swap. Answers whether this page has it.
        update: async () => {
            ready = await prepare()
            if (!engineContext) {return}
            const {next, node} = await stage()
            const was = project!, wasNode = worklet!
            const at = was.engine.position.getValue(), playing = was.engine.isPlaying.getValue()
            project = next; worklet = node
            next.engine.setPosition(at)
            if (playing) {next.engine.play()}
            wasNode.disconnect(); was.engine.stop(true); was.terminate()
        }
    }
}
export type EngineSong = Awaited<ReturnType<typeof openSong>>
