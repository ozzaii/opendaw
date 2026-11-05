import {AudioData, gainToDb, LoudnessMeter} from "@opendaw/lib-dsp"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {isDefined, isNull, panic, tryCatch} from "@opendaw/lib-std"
import {Api, Loudness, NamModel, Project, Sample, SoundfontFile, WclapParameterInfo, WclapPlugin} from "../Api"
import {ScriptHostProtocol} from "../ScriptHostProtocol"
import {ProjectImpl} from "./ProjectImpl"
import {Guard} from "./Guard"

export class ApiImpl implements Api {
    readonly #protocol: ScriptHostProtocol

    constructor(protocol: ScriptHostProtocol) {this.#protocol = protocol}

    newProject(name?: string): Project {
        const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
        return new ProjectImpl(this.#protocol, skeleton, isDefined(name) ? Guard.string(name, "name") : "Scripted Project")
    }

    hasProject(): Promise<boolean> {return this.#protocol.hasProject()}

    showInfo(headline: string, message: string): Promise<void> {
        return this.#protocol.showInfo(Guard.string(headline, "headline"), Guard.string(message, "message"))
    }

    async getProject(): Promise<Project> {
        const {buffer, name} = await this.#protocol.fetchProject()
        const project = new ProjectImpl(this.#protocol, ProjectSkeleton.decode(buffer), name)
        project.context.startRecording()
        return project
    }

    async addSample(data: AudioData, name: string): Promise<Sample> {
        if (typeof data !== "object" || isNull(data) || !Array.isArray(data.frames)) {
            return panic(new TypeError("addSample: expected AudioData"))
        }
        if (!(data.numberOfFrames > 0)) {return panic(new RangeError("addSample: audio data is empty"))}
        return this.#protocol.addSample(data, Guard.string(name, "name"))
    }

    listSamples(): Promise<ReadonlyArray<Sample>> {return this.#protocol.listSamples()}

    listSoundfonts(): Promise<ReadonlyArray<SoundfontFile>> {return this.#protocol.listSoundfonts()}

    async addSoundfont(data: ArrayBuffer | ArrayBufferView, name: string): Promise<SoundfontFile> {
        const buffer = toArrayBuffer(data, "addSoundfont")
        if (buffer.byteLength === 0) {return panic(new RangeError("addSoundfont: data is empty"))}
        return this.#protocol.addSoundfont(buffer, Guard.string(name, "name"))
    }

    listNamModels(): Promise<ReadonlyArray<NamModel>> {return this.#protocol.listNamModels()}

    async addNamModel(model: string, name: string): Promise<NamModel> {
        const text = Guard.string(model, "model")
        if (tryCatch(() => JSON.parse(text)).status === "failure") {
            return panic(new TypeError("addNamModel: model is not a .nam file (JSON)"))
        }
        return this.#protocol.addNamModel(text, Guard.string(name, "name"))
    }

    listWclaps(): Promise<ReadonlyArray<WclapPlugin>> {return this.#protocol.listWclaps()}

    async describeWclap(plugin: Pick<WclapPlugin, "url" | "clapId">): Promise<ReadonlyArray<WclapParameterInfo>> {
        if (typeof plugin !== "object" || isNull(plugin)) {return panic(new TypeError("describeWclap: expected a WclapPlugin"))}
        return this.#protocol.describeWclap(Guard.string(plugin.url, "plugin.url"), Guard.string(plugin.clapId, "plugin.clapId"))
    }

    measure(audio: AudioData): Loudness {
        if (typeof audio !== "object" || isNull(audio) || !Array.isArray(audio.frames) || audio.frames.length === 0) {
            return panic(new TypeError("measure: expected AudioData"))
        }
        const {sampleRate, numberOfFrames, frames} = audio
        const left = frames[0], right = frames[1] ?? new Float32Array(numberOfFrames) // a mono file is one channel
        const meter = new LoudnessMeter(sampleRate)
        const values = new Float32Array(5)
        const block = Math.max(1, Math.round(sampleRate * 0.1)) // the meter's own 100 ms step
        let shortTermMax = -120.0
        for (let at = 0; at < numberOfFrames; at += block) {
            const end = Math.min(numberOfFrames, at + block)
            meter.process(left.subarray(at, end), right.subarray(at, end))
            meter.fill(values)
            shortTermMax = Math.max(shortTermMax, values[1])
        }
        let sum = 0.0
        for (const channel of frames) {for (let index = 0; index < numberOfFrames; index++) {sum += channel[index] * channel[index]}}
        const rms = Math.sqrt(sum / Math.max(1, numberOfFrames * frames.length))
        return {integrated: values[2], shortTermMax, range: values[3], truePeak: values[4], rms: rms > 1e-6 ? gainToDb(rms) : -120.0}
    }

    async saveFile(data: ArrayBuffer | ArrayBufferView, fileName: string, mimeType?: string): Promise<void> {
        const buffer = toArrayBuffer(data, "saveFile")
        const name = Guard.string(fileName, "fileName").trim()
        if (name.length === 0) {return panic(new RangeError("saveFile: fileName is empty"))}
        if (/[\\/]/.test(name)) {return panic(new RangeError("saveFile: fileName must not contain path separators"))}
        const type = isDefined(mimeType) ? Guard.string(mimeType, "mimeType") : "application/octet-stream"
        return this.#protocol.saveFile(buffer, name, type)
    }
}

const toArrayBuffer = (data: unknown, name: string): ArrayBuffer => {
    if (data instanceof ArrayBuffer) {return data}
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    }
    return panic(new TypeError(`${name}: expected an ArrayBuffer or a typed array`))
}
