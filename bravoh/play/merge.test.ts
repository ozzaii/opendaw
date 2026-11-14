// node --test over esbuild's bundle (`npm test`): a version's step onto the graph that plays ends as that version, the page's
// own hand kept, and a step the graph cannot take is refused whole so the caller builds the version as a second engine.
import {test} from "node:test"
import assert from "node:assert/strict"
import {BoxGraph} from "@opendaw/lib-box"
import {Option, UUID} from "@opendaw/lib-std"
import {AudioBusBox, AudioUnitBox, BoxIO, StereoToolDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {mergeVersion} from "./merge"

type Graph = BoxGraph<BoxIO.TypeMap>
const copy = (graph: Graph): Graph => {
    const made = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    made.fromArrayBuffer(graph.toArrayBuffer(), false)
    return made
}
const id = (box: {address: {uuid: UUID.Bytes}}) => UUID.toString(box.address.uuid)
// A lane as make writes one: a unit on the master, named by the bus at its input.
const lane = (graph: Graph, name: string) => {
    const {rootBox, primaryAudioBusBox} = ProjectSkeleton.findMandatoryBoxes(graph as any)
    const unit = AudioUnitBox.create(graph, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
    })
    AudioBusBox.create(graph, UUID.generate(), box => {
        box.collection.refer(rootBox.audioBusses)
        box.label.setValue(name)
        box.output.refer(unit.input)
    })
    return unit
}
const unitOf = (graph: Graph, uuid: string) => graph.findBox(UUID.parse(uuid)).unwrap() as AudioUnitBox
const bytes = (graph: Graph) => new Map(graph.boxes().map(box => [id(box), new Uint8Array(box.toArrayBuffer())]))
const hubs = (graph: Graph) => new Map(graph.boxes().map(box => [id(box), box.pointerHub.incoming().length]))

const song = () => {
    const graph = ProjectSkeleton.empty({createOutputMaximizer: true, createDefaultUser: true}).boxGraph
    graph.beginTransaction()
    const kick = lane(graph, "Kick"), bass = lane(graph, "Bass")
    graph.endTransaction()
    return {graph, kick: id(kick), bass: id(bass)}
}

const quick = () => Promise.resolve()

for (const chunk of [256, 1]) test(`a version's step leaves the playing graph as that version, the page's mute and fader kept (chunk ${chunk})`, async () => {
    const {graph: was, kick, bass} = song()
    const now = copy(was)
    now.beginTransaction()
    unitOf(now, kick).volume.setValue(-6)
    lane(now, "Pad")
    unitOf(now, bass).delete()
    now.endTransaction()
    const live = copy(was)
    live.beginTransaction()
    unitOf(live, kick).mute.setValue(true)
    const trim = StereoToolDeviceBox.create(live, UUID.generate(), box => {
        box.label.setValue("Mix trim"); box.host.refer(unitOf(live, kick).audioEffects)
    })
    live.endTransaction()

    const merged = await mergeVersion(was, now, live, chunk, quick)
    assert.ok(merged)
    assert.equal(unitOf(live, kick).volume.getValue(), -6)
    assert.equal(unitOf(live, kick).mute.getValue(), true, "the page's mute stays")
    assert.ok(live.findBox(trim.address.uuid).nonEmpty(), "the page's fader stays")
    assert.ok(live.findBox(UUID.parse(bass)).isEmpty())
    // Every box of the version, byte for byte, but the kick the page muted; nothing of the old version beside it.
    const want = bytes(now), got = bytes(live)
    for (const [uuid, wanted] of want) {
        if (uuid === kick) {continue}
        assert.deepEqual(got.get(uuid), wanted)
    }
    assert.deepEqual([...got.keys()].filter(uuid => !want.has(uuid)), [id(trim)])
    // The hubs the engine's adapters read: as the version's own graph has them, the fader on the kick besides.
    const fresh = hubs(copy(now))
    for (const [uuid, count] of hubs(live)) {if (uuid !== id(trim)) {assert.equal(count, fresh.get(uuid)! + (uuid === kick ? 1 : 0), uuid)}}
})

test("a lane the version takes away takes the page's fader on it too", async () => {
    const {graph: was, kick} = song()
    const now = copy(was)
    now.beginTransaction()
    unitOf(now, kick).delete()
    now.endTransaction()
    const live = copy(was)
    live.beginTransaction()
    const trim = StereoToolDeviceBox.create(live, UUID.generate(), box => {
        box.label.setValue("Mix trim"); box.host.refer(unitOf(live, kick).audioEffects)
    })
    live.endTransaction()
    assert.ok(await mergeVersion(was, now, live, 1, quick))
    assert.ok(live.findBox(trim.address.uuid).isEmpty())
    assert.deepEqual([...bytes(live).keys()].sort(), [...bytes(now).keys()].sort())
})

test("another song's skeleton is no step: refused, the playing graph untouched", async () => {
    const {graph: was} = song()
    const other = song().graph
    const live = copy(was)
    const before = bytes(live)
    assert.equal(await mergeVersion(was, other, live, 256, quick), undefined)
    assert.deepEqual(bytes(live), before)
    assert.equal(live.inTransaction(), false)
})
