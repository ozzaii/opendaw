import {AudioData} from "@opendaw/lib-dsp"
import {UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {MixdownOptions, NamModel, Sample, SoundfontFile, WclapParameterInfo, WclapPlugin} from "./Api"

export interface ScriptHostProtocol {
    openProject(buffer: ArrayBufferLike, name?: string): void
    // Replays a script's edits onto the open project as one undoable step. `checksum` is the graph the
    // script started from, so the host can refuse when the project changed in the meantime.
    applyUpdates(updates: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>, checksum: Int8Array): void
    hasProject(): Promise<boolean>
    fetchProject(): Promise<{ buffer: ArrayBuffer, name: string }>
    showInfo(headline: string, message: string): Promise<void>
    addSample(data: AudioData, name: string): Promise<Sample>
    listSamples(): Promise<ReadonlyArray<Sample>>
    renderMixdown(buffer: ArrayBufferLike, options: MixdownOptions): Promise<AudioData>
    listSoundfonts(): Promise<ReadonlyArray<SoundfontFile>>
    addSoundfont(buffer: ArrayBuffer, name: string): Promise<SoundfontFile>
    listNamModels(): Promise<ReadonlyArray<NamModel>>
    addNamModel(model: string, name: string): Promise<NamModel>
    listWclaps(): Promise<ReadonlyArray<WclapPlugin>>
    // the parameters the plugin reports once loaded, the automatable ones only
    describeWclap(url: string, clapId: string): Promise<ReadonlyArray<WclapParameterInfo>>
    saveFile(buffer: ArrayBuffer, fileName: string, mimeType: string): Promise<void>
}
