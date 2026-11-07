import {beforeEach, describe, expect, it, vi} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {GlobalSampleLoaderManager} from "./GlobalSampleLoaderManager"
import {SampleStorage} from "./SampleStorage"
import {Workers} from "../Workers"

const audio = {sampleRate: 48000, numberOfFrames: 4, numberOfChannels: 1, frames: [new Float32Array(4)]}
const meta = {name: "", bpm: 0, duration: 0, sample_rate: 48000, origin: "import"}
const later = <T>() => Promise.withResolvers<T>()
const settle = () => new Promise(resolve => setTimeout(resolve, 1))

describe("GlobalSampleLoaderManager", () => {
    const uuid = UUID.generate()
    const load = vi.fn()
    beforeEach(() => {
        load.mockReset()
        vi.spyOn(SampleStorage, "get").mockReturnValue({load, save: async () => {}} as unknown as SampleStorage)
        vi.spyOn(Workers, "Peak", "get").mockReturnValue({generateAsync: async () => new ArrayBuffer(0)} as any)
    })

    it("answers a loader that joined a load which then failed", async () => {
        const first = later<any>()
        load.mockReturnValueOnce(first.promise).mockResolvedValue([audio, {}, meta])
        const manager = new GlobalSampleLoaderManager({fetch: () => Promise.reject(new Error("not on the engine"))})
        const registration = manager.register(uuid)
        const failing = manager.getOrCreate(uuid)
        registration.terminate()
        await settle()
        const joined = manager.getOrCreate(uuid)
        expect(joined).not.toBe(failing)
        first.reject(new Error("not in storage"))
        await settle()
        expect(failing.state.type).toBe("error")
        expect(joined.state.type).toBe("loaded")
    })

    it("keeps a sample in memory when its box is deleted and made again in one step", async () => {
        load.mockResolvedValue([audio, {}, meta])
        const manager = new GlobalSampleLoaderManager({fetch: () => Promise.reject(new Error("unused"))})
        const registration = manager.register(uuid)
        const loader = manager.getOrCreate(uuid)
        await settle()
        registration.terminate()
        manager.register(uuid)
        await settle()
        expect(manager.getOrCreate(uuid)).toBe(loader)
        expect(load).toHaveBeenCalledTimes(1)
    })

    it("drops a sample nothing uses any more", async () => {
        load.mockResolvedValue([audio, {}, meta])
        const manager = new GlobalSampleLoaderManager({fetch: () => Promise.reject(new Error("unused"))})
        const registration = manager.register(uuid)
        const loader = manager.getOrCreate(uuid)
        await settle()
        registration.terminate()
        await settle()
        expect(manager.getOrCreate(uuid)).not.toBe(loader)
        expect(load).toHaveBeenCalledTimes(2)
    })
})
