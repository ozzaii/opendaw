import {Arrays, DefaultObservableValue, int, Option, UUID} from "@opendaw/lib-std"
import {applyUpdateTasks, UpdateTask} from "@opendaw/lib-box"
import {AudioData} from "@opendaw/lib-dsp"
import {BoxIO, WclapDeviceBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitFactory, ExportConfiguration, InstrumentFactories, ProjectSkeleton, TrackType, WclapParamInfo, WclapParameterAdapters} from "@opendaw/studio-adapters"
import {MixdownSection, OfflineEngineListeners, OfflineEngineRenderer, Project, ProjectEnv, RenderQuantum, WclapStorage, Workers} from "@opendaw/studio-core"
import {NamModel, SoundfontFile, WclapParameterInfo, WclapPlugin} from "@opendaw/studio-scripting"
import {WclapCatalog} from "@/opendaw-api"
import {StudioService} from "@/service/StudioService"

// The studio's own answers to a script's host calls (ScriptHostProtocol), shared by the code editor and any other
// host of a script (BRAVOH's engine page): the edit behind its checksum guard, and the offline mixdown of the bytes.
export namespace ScriptAnswers {
    // whether the project is still the one the script read
    export const isCurrent = (project: Project, checksum: Int8Array): boolean =>
        Arrays.equals(project.boxGraph.checksum(), checksum)

    // false, and nothing applied, when the project changed since the script read it
    export const applyUpdates = (project: Project,
                                 updates: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>,
                                 checksum: Int8Array): boolean => {
        if (!isCurrent(project, checksum)) {return false}
        project.editing.modify(() => applyUpdateTasks(project.boxGraph, updates))
        return true
    }

    // On a copy of its own, so the live project and its engine are never touched. Without a section, the whole song.
    export const renderMixdown = async (env: ProjectEnv, buffer: ArrayBufferLike, sampleRate: int = 48_000, {section, progress, abortSignal, listeners}: {
        section?: MixdownSection, progress?: DefaultObservableValue<number>, abortSignal?: AbortSignal, listeners?: OfflineEngineListeners
    } = {}): Promise<AudioData> => {
        const project = Project.load(env, buffer as ArrayBuffer)
        progress ??= new DefaultObservableValue(0.0)
        try {
            return await (section === undefined
                ? OfflineEngineRenderer.start(project, Option.None, progress, abortSignal, sampleRate, listeners)
                : OfflineEngineRenderer.renderSection(project, Option.None, section, progress, abortSignal, sampleRate, listeners))
        } finally {
            project.terminate()
        }
    }

    export type Stem = { name: string, kind: "lane" | "return" | "mix" }
    export type Stems = { audio: AudioData, stems: ReadonlyArray<Stem>, muted: ReadonlyArray<string>, groups: ReadonlyArray<string> }
    // ONE PASS, EVERY LANE: the engine's own stem export taps each unit after its fader inside the mixdown it runs anyway, delay
    // compensated to the master (crates/engine/src/lib.rs `stem_compensation`), so the graph that plays is the graph that is
    // tapped: a side-chain still ducks and a send still reaches its return. The output unit is one more tap: the mix itself.
    // A group is left out: its tap holds the lanes that have their own file, and a pack that adds up twice lines up with nothing.
    export const renderStems = async (env: ProjectEnv, buffer: ArrayBufferLike, sampleRate: int, section: MixdownSection, {progress, abortSignal, listeners}: {
        progress?: DefaultObservableValue<number>, abortSignal?: AbortSignal, listeners?: OfflineEngineListeners
    } = {}): Promise<Stems> => {
        const project = Project.load(env, buffer as ArrayBuffer)
        try {
            const units = project.rootBoxAdapter.audioUnits.adapters()
            const label = (unit: typeof units[number]) => unit.input.label.unwrapOrElse(unit.type)
            const heard = units.filter(unit => unit.isOutput || (unit.type !== AudioUnitType.Bus && !unit.box.mute.getValue()))
            const configuration: ExportConfiguration = {
                stems: Object.fromEntries(heard.map(unit => [UUID.toString(unit.uuid), {
                    includeAudioEffects: true, includeSends: true, useInstrumentOutput: false, fileName: label(unit)
                }]))
            }
            const audio = await OfflineEngineRenderer.renderSection(project, Option.wrap(configuration), section,
                progress ?? new DefaultObservableValue(0.0), abortSignal, sampleRate, listeners)
            return {
                audio,
                stems: heard.map(unit => ({name: label(unit), kind: unit.isOutput ? "mix" : unit.type === AudioUnitType.Aux ? "return" : "lane"})),
                muted: units.filter(unit => !unit.isOutput && unit.box.mute.getValue()).map(label),
                groups: units.filter(unit => !unit.isOutput && unit.type === AudioUnitType.Bus).map(label)
            }
        } finally {
            project.terminate()
        }
    }

    // stock and imported soundfonts
    export const listSoundfonts = async (service: StudioService): Promise<ReadonlyArray<SoundfontFile>> =>
        (await service.soundfontService.list()).map(({uuid, name}) => ({uuid, name}))

    export const addSoundfont = async (service: StudioService, buffer: ArrayBuffer, name: string): Promise<SoundfontFile> => {
        const {uuid} = await service.soundfontService.importFile({name, arrayBuffer: buffer})
        return {uuid, name}
    }

    // The amp models a script added, beside the studio's other files: OPFS `nam/<uuid>.json`, keyed by content like the
    // studio's NAM picker keys its model boxes
    const NamFolder = "nam"
    export const listNamModels = async (): Promise<ReadonlyArray<NamModel>> => {
        const entries = await Workers.Opfs.list(NamFolder).catch(() => [])
        return Promise.all(entries.filter(entry => entry.kind === "file").map(async ({name}) =>
            JSON.parse(new TextDecoder().decode(await Workers.Opfs.read(`${NamFolder}/${name}`))) as NamModel))
    }

    export const addNamModel = async (model: string, name: string): Promise<NamModel> => {
        const added: NamModel = {uuid: await namUuid(model), name, model}
        await Workers.Opfs.write(`${NamFolder}/${added.uuid}.json`, new TextEncoder().encode(JSON.stringify(added)))
        return added
    }

    export const namUuid = async (model: string): Promise<string> =>
        UUID.toString(await UUID.sha256(new TextEncoder().encode(model).buffer as ArrayBuffer))

    // every plugin of every bundle in the studio's catalogue, addressed the way a device stores its bundle (the
    // bundle's id: the studio loads it from its own storage, else from where the catalogue publishes it)
    export const listWclaps = async (): Promise<ReadonlyArray<WclapPlugin>> =>
        (await WclapCatalog.get().all()).flatMap(entry => entry.plugins.map(({clapId, name, vendor, features}) =>
            ({url: WclapStorage.urlOf(entry.uuid), clapId, name, vendor, features})))

    // What a plugin reports once loaded: a song holding only the plugin plays a moment in an offline engine of its own
    export const describeWclap = async (env: ProjectEnv, url: string, clapId: string,
                                        timeoutMs: int = 30_000): Promise<ReadonlyArray<WclapParameterInfo>> => {
        const plugin = (await listWclaps()).find(plugin => plugin.url === url && plugin.clapId === clapId)
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
        boxGraph.beginTransaction()
        const device = plugin?.features.includes("instrument") ?? false
            ? InstrumentFactories.Wclap.create(boxGraph,
                AudioUnitFactory.create(skeleton, AudioUnitType.Instrument,
                    AudioUnitFactory.trackTypeToCapture(boxGraph, TrackType.Notes)).input, "WebCLAP", InstrumentFactories.Wclap.defaultIcon)
            : WclapDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.index.setValue(0)
                box.host.refer(primaryAudioUnitBox.audioEffects)
            })
        device.url.setValue(url)
        device.clapId.setValue(clapId)
        boxGraph.endTransaction()
        const project = Project.load(env, ProjectSkeleton.encode(boxGraph) as ArrayBuffer)
        const reported = Promise.withResolvers<ReadonlyArray<WclapParamInfo>>()
        const timeout = setTimeout(() => reported.reject(new Error(`${clapId} reported no parameters within ${timeoutMs / 1000} s`)), timeoutMs)
        const renderer = await OfflineEngineRenderer.create(project, Option.None, 48_000, undefined, {
            wclapParams: (_uuid, params) => reported.resolve(params),
            wclapStatus: (_uuid, {state, message}) => {
                if (state === "failed") {reported.reject(new Error(`${clapId} did not load: ${message}`))}
            }
        })
        try {
            await renderer.play()
            // the engine loads the plugin while it runs: step it until the plugin has spoken
            let spoken = false
            reported.promise.finally(() => spoken = true).catch(() => {})
            while (!spoken) {await renderer.step(RenderQuantum * 8)}
            return (await reported.promise).filter(WclapParameterAdapters.isAutomatable)
                .map(({id, name, module, min, max, defaultValue, flags}) => ({id, name, module, min, max, defaultValue, flags}))
        } finally {
            clearTimeout(timeout)
            renderer.terminate()
            project.terminate()
        }
    }
}
