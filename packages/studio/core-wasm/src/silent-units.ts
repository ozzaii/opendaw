// A LANE NOBODY CAN HEAR DOES NOT RUN. A muted unit's instrument and effects cost the same as a heard one's, and a take
// keeps its muted instrument twin beside it (11-07: 19% of one song's render was Autotune on muted vocals). The nodes stay
// in the graph, because their latency still sets every other lane's compensation: taking the units out moved a 143 s
// song by -29 dB. Only their `process` is skipped, and their output buffers stay at the zeros a muted strip writes.
// Whatever can still reach the mix keeps running: a sidechain or anything else pointing in, a send before the strip, a Sink,
// a mute that automation can lift.
import {isInstanceOf, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioSendRouting, AudioUnitType} from "@opendaw/studio-enums"
import {AudioSinkDeviceBox, AudioUnitBox, AuxSendBox} from "@opendaw/studio-boxes"

/** Every box a node of an inaudible unit may be owned by: the unit and all it holds. */
export const silentOwners = (graph: BoxGraph): ReadonlyArray<UUID.Bytes> => graph.boxes().flatMap(unit => {
    if (!isInstanceOf(unit, AudioUnitBox) || !unit.mute.getValue() || unit.type.getValue() !== AudioUnitType.Instrument
        || unit.mute.pointerHub.nonEmpty()) {return []}
    const {boxes, pointers} = graph.dependenciesOf(unit)
    const held = new Set<unknown>(boxes).add(unit)
    if ([...pointers].some(pointer => !held.has(pointer.box))) {return []}
    if ([...boxes].some(box => isInstanceOf(box, AudioUnitBox) || isInstanceOf(box, AudioSinkDeviceBox)
        || (isInstanceOf(box, AuxSendBox) && box.routing.getValue() === AudioSendRouting.Pre))) {return []}
    return [unit, ...boxes].map(box => box.address.uuid)
})
