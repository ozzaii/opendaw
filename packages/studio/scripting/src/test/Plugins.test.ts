import {describe, expect, it} from "vitest"
import {AudioData} from "@opendaw/lib-dsp"
import {UUID} from "@opendaw/lib-std"
import {WclapParameterAdapters} from "@opendaw/studio-adapters"
import {createFixture} from "./Fixture"
import {WclapParameterInfo} from "../Api"

const plugin = {url: "opfs:5b1c", clapId: "org.surge.osc", name: "Surge Osc", vendor: "Surge", features: ["instrument"]}
const cutoff: WclapParameterInfo = {id: 7, name: "Cutoff", module: "Filter", min: 0, max: 1, defaultValue: 0.5, flags: 0}

describe("Plugins", () => {
    it("hosts a WebCLAP instrument and effect with parameters the studio would derive", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Wclap")
        const synth = unit.instrument
        expect([synth.key, synth.plugin, synth.parameters]).toEqual(["Wclap", null, []])
        expect(() => synth.setParameter(cutoff, 0.2)).toThrow()
        synth.plugin = plugin
        expect(synth.plugin).toEqual({url: plugin.url, clapId: plugin.clapId, name: "Surge Osc"})
        const set = synth.setParameter(cutoff, 0.2)
        expect([set.id, set.name, set.value]).toEqual([7, "Cutoff", Math.fround(0.2)])
        expect(synth.setParameter(cutoff, 0.4)).toBe(set) // one box per parameter
        expect(synth.parameters).toEqual([set])
        expect(UUID.toString(UUID.parse(set.uuid))).toBe(UUID.toString(WclapParameterAdapters.uuidOf(UUID.parse(synth.uuid), 7)))
        expect(() => synth.setParameter(cutoff, 2)).toThrow(RangeError)
        expect(() => synth.setParameter({...cutoff, id: 8, flags: 1 << 2}, 0)).toThrow(RangeError)
        synth.state = new Int8Array([1, 2, 3])
        expect(Array.from(synth.state)).toEqual([1, 2, 3])
        synth.plugin = {...plugin, clapId: "org.surge.fx"} // another plugin: its own state and parameters
        expect([synth.parameters.length, synth.state.length]).toEqual([0, 0])
        const effect = unit.addAudioEffect("Wclap")
        effect.plugin = {url: plugin.url, clapId: "org.surge.fx", name: "Surge FX"}
        effect.setParameter({...cutoff, id: 0}, 1)
        expect([effect.key, effect.label, effect.parameter("Cutoff")?.value]).toEqual(["Wclap", "Surge FX", 1])
        expect(unit.audioEffects).toEqual([effect])
    })

    it("sets a neural amp model and drops the model box with its last user", () => {
        const {project} = createFixture()
        const amp = project.output.addAudioEffect("NeuralAmp")
        expect(amp.model).toBeNull()
        const model = {uuid: UUID.toString(UUID.generate()), name: "Plexi", model: "{\"version\":\"0.5.4\"}"}
        amp.model = model
        expect(amp.model).toEqual(model)
        const graph = (project as any).context.boxGraph
        const count = () => graph.boxes().filter((box: any) => box.name === "NeuralAmpModelBox").length
        expect(count()).toBe(1)
        project.output.addAudioEffect("NeuralAmp").model = model
        expect(count()).toBe(1)
        amp.model = null
        expect([amp.model, count()]).toEqual([null, 1])
    })

    it("measures a -23 dBFS stereo tone at -23 LUFS", () => {
        const {api} = createFixture()
        const sampleRate = 48000, seconds = 20
        const audio = AudioData.create(sampleRate, sampleRate * seconds, 2)
        const gain = Math.pow(10, -23 / 20)
        for (let index = 0; index < audio.numberOfFrames; index++) {
            audio.frames[0][index] = audio.frames[1][index] = gain * Math.sin(2 * Math.PI * 997 * index / sampleRate)
        }
        const {integrated, shortTermMax, truePeak, rms, range} = api.measure(audio)
        expect(integrated).toBeCloseTo(-23.0, 1)
        expect(shortTermMax).toBeCloseTo(-23.0, 1)
        expect(truePeak).toBeCloseTo(-23.0, 1)
        expect(rms).toBeCloseTo(-26.0, 1)
        expect(range).toBeLessThan(0.5)
        expect(() => api.measure({} as any)).toThrow(TypeError)
    })
})
