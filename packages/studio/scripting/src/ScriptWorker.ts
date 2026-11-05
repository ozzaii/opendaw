import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {AudioData} from "@opendaw/lib-dsp"
import {UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ScriptExecutionContext, ScriptExecutionProtocol} from "./ScriptExecutionProtocol"
import {ScriptRunner} from "./ScriptRunner"
import {ScriptHostProtocol} from "./ScriptHostProtocol"
import {MixdownOptions, NamModel, Sample, SoundfontFile, WclapParameterInfo, WclapPlugin} from "./Api"

const messenger: Messenger = Messenger.for(self)

const hostProtocol = Communicator.sender<ScriptHostProtocol>(messenger.channel("scripting-host"),
    dispatcher => new class implements ScriptHostProtocol {
        openProject(buffer: ArrayBufferLike, name?: string): void {
            dispatcher.dispatchAndForget(this.openProject, buffer, name)
        }
        applyUpdates(updates: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>, checksum: Int8Array): void {
            dispatcher.dispatchAndForget(this.applyUpdates, updates, checksum)
        }
        hasProject(): Promise<boolean> {
            return dispatcher.dispatchAndReturn(this.hasProject)
        }
        fetchProject(): Promise<{ buffer: ArrayBuffer; name: string }> {
            return dispatcher.dispatchAndReturn(this.fetchProject)
        }
        showInfo(headline: string, message: string): Promise<void> {
            return dispatcher.dispatchAndReturn(this.showInfo, headline, message)
        }
        addSample(data: AudioData, name: string): Promise<Sample> {
            return dispatcher.dispatchAndReturn(this.addSample, data, name)
        }
        listSamples(): Promise<ReadonlyArray<Sample>> {
            return dispatcher.dispatchAndReturn(this.listSamples)
        }
        renderMixdown(buffer: ArrayBufferLike, options: MixdownOptions): Promise<AudioData> {
            return dispatcher.dispatchAndReturn(this.renderMixdown, buffer, options)
        }
        saveFile(buffer: ArrayBuffer, fileName: string, mimeType: string): Promise<void> {
            return dispatcher.dispatchAndReturn(this.saveFile, buffer, fileName, mimeType)
        }
        listSoundfonts(): Promise<ReadonlyArray<SoundfontFile>> {
            return dispatcher.dispatchAndReturn(this.listSoundfonts)
        }
        addSoundfont(buffer: ArrayBuffer, name: string): Promise<SoundfontFile> {
            return dispatcher.dispatchAndReturn(this.addSoundfont, buffer, name)
        }
        listNamModels(): Promise<ReadonlyArray<NamModel>> {
            return dispatcher.dispatchAndReturn(this.listNamModels)
        }
        addNamModel(model: string, name: string): Promise<NamModel> {
            return dispatcher.dispatchAndReturn(this.addNamModel, model, name)
        }
        listWclaps(): Promise<ReadonlyArray<WclapPlugin>> {
            return dispatcher.dispatchAndReturn(this.listWclaps)
        }
        describeWclap(url: string, clapId: string): Promise<ReadonlyArray<WclapParameterInfo>> {
            return dispatcher.dispatchAndReturn(this.describeWclap, url, clapId)
        }
    })

Communicator.executor(messenger.channel("scripting-execution"), new class implements ScriptExecutionProtocol {
    readonly #scriptExecutor = new ScriptRunner(hostProtocol)

    executeScript(script: string, context: ScriptExecutionContext): Promise<void> {
        return this.#scriptExecutor.run(script, context)
    }
})
