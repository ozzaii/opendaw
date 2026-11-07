import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioSendRouting, AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitBox, AuxSendBox, CompressorDeviceBox, TrackBox} from "@opendaw/studio-boxes"
import {silentOwners} from "../src/silent-units"

const song = () => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const lane = (muted: boolean) => {
        boxGraph.beginTransaction()
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.type.setValue(AudioUnitType.Instrument)
            box.mute.setValue(muted)
        })
        boxGraph.endTransaction()
        return unit
    }
    const owners = () => silentOwners(boxGraph).map(UUID.toString)
    return {boxGraph, lane, owners, primaryAudioBusBox}
}

describe("silentOwners", () => {
    it("names a muted lane and what it holds, not a heard one", () => {
        const {boxGraph, lane, owners} = song()
        const muted = lane(true), heard = lane(false)
        boxGraph.beginTransaction()
        const effect = CompressorDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(muted.audioEffects)
        })
        boxGraph.endTransaction()
        expect(owners()).toContain(UUID.toString(muted.address.uuid))
        expect(owners()).toContain(UUID.toString(effect.address.uuid))
        expect(owners()).not.toContain(UUID.toString(heard.address.uuid))
    })
    it("keeps a muted lane another lane's sidechain reads", () => {
        const {boxGraph, lane, owners} = song()
        const source = lane(true), ducked = lane(false)
        boxGraph.beginTransaction()
        CompressorDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(ducked.audioEffects)
            box.sideChain.refer(source)
        })
        boxGraph.endTransaction()
        expect(owners()).not.toContain(UUID.toString(source.address.uuid))
    })
    it("keeps a muted lane whose send taps before the strip, and drops one that taps after", () => {
        const {boxGraph, lane, owners, primaryAudioBusBox} = song()
        const before = lane(true), after = lane(true)
        boxGraph.beginTransaction()
        const send = (unit: AudioUnitBox, routing: AudioSendRouting) => AuxSendBox.create(boxGraph, UUID.generate(), box => {
            box.audioUnit.refer(unit.auxSends)
            box.targetBus.refer(primaryAudioBusBox.input)
            box.routing.setValue(routing)
        })
        send(before, AudioSendRouting.Pre)
        send(after, AudioSendRouting.Post)
        boxGraph.endTransaction()
        expect(owners()).not.toContain(UUID.toString(before.address.uuid))
        expect(owners()).toContain(UUID.toString(after.address.uuid))
    })
    it("keeps a muted lane whose mute automation can lift", () => {
        const {boxGraph, lane, owners} = song()
        const unit = lane(true)
        boxGraph.beginTransaction()
        TrackBox.create(boxGraph, UUID.generate(), box => {
            box.tracks.refer(unit.tracks)
            box.target.refer(unit.mute)
        })
        boxGraph.endTransaction()
        expect(owners()).not.toContain(UUID.toString(unit.address.uuid))
    })
})
