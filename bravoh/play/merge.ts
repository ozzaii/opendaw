// A NEW VERSION INTO THE GRAPH THAT PLAYS, the way an edit goes in: what changed between the two versions, which the running
// engine takes as edits. A version built as a second engine stalled WebKit's one audio thread while it built the whole song
// there (the full graph's applyUpdates: 0.1 s, then 1.0-1.4 s from the third engine on, measured 11-14 in the lab's Safari
// 26.6), and the sound stayed that late for good. The engine takes each transaction between two quanta on that same thread, so
// the many boxes nothing points at (notes, automation points) go in small transactions a few quanta apart, around one for the rest.
import {ArrayField, Box, BoxGraph, Field, ObjectField, PointerField, PrimitiveField} from "@opendaw/lib-box"
import {ByteArrayInput, UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"

const sameBytes = (a: ArrayBufferLike | ArrayBufferView, b: ArrayBufferLike | ArrayBufferView) => {
    const x = ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a)
    const y = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b)
    if (x.byteLength !== y.byteLength) {return false}
    for (let i = 0; i < x.byteLength; i++) {if (x[i] !== y[i]) {return false}}
    return true
}
const sameValue = (a: unknown, b: unknown) =>
    ArrayBuffer.isView(a) && ArrayBuffer.isView(b) ? sameBytes(a, b) : Object.is(a, b)

// What changed from `was` to `now` goes onto `live`: a field the version did not change keeps what the page set there (a mute).
const carry = (was: Field, now: Field, live: Field): void => {
    if (now.deprecated) {return}
    now.accept({
        visitPrimitiveField: (field: PrimitiveField) => {
            const value = field.getValue()
            if (!sameValue((was as PrimitiveField).getValue(), value)) {(live as PrimitiveField).setValue(value)}
        },
        visitPointerField: (field: PointerField) => {
            const before = (was as PointerField).targetAddress.unwrapOrNull(), after = field.targetAddress.unwrapOrNull()
            if (before === after || (before !== null && after !== null && before.equals(after))) {return}
            (live as PointerField).targetAddress = field.targetAddress
        },
        visitArrayField: (field: ArrayField) => carryAll(was.fields(), field.fields(), live.fields()),
        visitObjectField: (field: ObjectField<any>) => carryAll(was.fields(), field.fields(), live.fields())
    })
}
const carryAll = (was: ReadonlyArray<Field>, now: ReadonlyArray<Field>, live: ReadonlyArray<Field>) =>
    now.forEach((field, index) => carry(was[index], field, live[index]))
// Whether a step moves any pointer of the box: one that does goes in with the rest, where its new target is born.
const repoints = (was: ReadonlyArray<Field>, now: ReadonlyArray<Field>): boolean => now.some((field, index) => !!field.accept({
    visitPointerField: (pointer: PointerField) => {
        const before = (was[index] as PointerField).targetAddress.unwrapOrNull(), after = pointer.targetAddress.unwrapOrNull()
        return !(before === after || (before !== null && after !== null && before.equals(after)))
    },
    visitArrayField: (array: ArrayField) => repoints(was[index].fields(), array.fields()),
    visitObjectField: (object: ObjectField<any>) => repoints(was[index].fields(), object.fields())
}))

const mandatory = (graph: BoxGraph) => {
    const found = ProjectSkeleton.findMandatoryBoxes(graph as any)
    return [found.rootBox, found.timelineBox, found.primaryAudioBusBox, found.primaryAudioUnitBox]
        .map(box => UUID.toString(box.address.uuid)).join()
}

// A box leaves the graph with its own pointers let go first: the graph refuses to unstage one that still points anywhere.
const drop = (boxes: ReadonlyArray<Box>) => {
    for (const box of boxes) {for (const [pointer] of box.outgoingEdges()) {pointer.defer()}}
    for (const box of boxes) {box.unstage()}
}

export type Merged = {created: number, changed: number, deleted: number, transactions: number}

// shortcut: 256 boxes a transaction (a note is ~12 µs of the engine's time in Safari, so ~3 ms) and 12 ms between them; measured
// on one 176-bar song, raise the size if a long step takes too long to land.
const CHUNK = 256
const breathe = () => new Promise<void>(resolve => setTimeout(resolve, 12))

/**
 * The step from version `was` to version `now`, made on `live` (the project that plays, `was` plus the page's own hand). Undefined
 * when it cannot be: another song's skeleton, or a transaction the graph refuses (rolled back), and the caller builds the
 * version as a project of its own from `now`, whatever part of the step went in.
 */
export const mergeVersion = async (was: BoxGraph, now: BoxGraph, live: BoxGraph,
                                   chunk = CHUNK, pause = breathe): Promise<Merged | undefined> => {
    if (mandatory(was) !== mandatory(now)) {return undefined}
    const before = new Map<string, Box>(was.boxes().map(box => [UUID.toString(box.address.uuid), box]))
    const after = new Map<string, Box>(now.boxes().map(box => [UUID.toString(box.address.uuid), box]))
    // A leaf goes in or out alone: nothing points at it, and nothing it points at needs it (a region does: its notes'
    // collection needs an owner; a note does not: a collection may be empty).
    const leaf = (...boxes: ReadonlyArray<Box | undefined>) => boxes.every(box => !box || (box.pointerHub.incoming().length === 0
        && box.outgoingEdges().every(([, address]) => !box.graph.findVertex(address).mapOr(target => target.pointerRules.mandatory, true))))
    const merged: Merged = {created: 0, changed: 0, deleted: 0, transactions: 0}
    // What goes in: leaves first out and last in, around one transaction for everything that holds or moves a pointer.
    // Inside it: the changes, then one drop of all that leaves (the graph unstages a box only once nothing points at it), then the
    // births, whose pointers may name each other.
    const leavesOut: Array<Box> = [], leavesIn: Array<Box> = [], changes: Array<() => void> = [], births: Array<() => void> = []
    const removed = new Set<string>(), leaving: Array<Box> = []
    for (const [id, box] of after) {
        const old = before.get(id)
        const playing = live.findBox(box.address.uuid).unwrapOrNull()
        if (old && playing && old.name === box.name && playing.name === box.name) {
            if (sameBytes(old.toArrayBuffer(), box.toArrayBuffer())) {continue}
            merged.changed++
            const step = () => carryAll(old.fields(), box.fields(), playing.fields())
            if (leaf(old, box) && !repoints(old.fields(), box.fields())) {leavesIn.push(box)} else {changes.push(step)}
            continue
        }
        merged.created++
        if (!old && !playing && leaf(box)) {leavesIn.push(box); continue}
        if (playing) {leaving.push(playing)}
        births.push(() => live.createBox(box.name as any, box.address.uuid, made => made.read(new ByteArrayInput(box.toArrayBuffer()))))
    }
    for (const [id, old] of before) {
        if (after.has(id)) {continue}
        removed.add(id)
        live.findBox(old.address.uuid).ifSome(box => {
            merged.deleted++
            if (leaf(old, box)) {leavesOut.push(box)} else {leaving.push(box)}
        })
    }
    // The page's own boxes (a fader's "Mix trim") on a lane the version took away go with it, in the same drop.
    const core = [...changes, () => drop([...leaving, ...live.boxes().filter(box => {
        const id = UUID.toString(box.address.uuid)
        return !before.has(id) && !after.has(id)
            && box.outgoingEdges().some(([, address]) => removed.has(UUID.toString(address.uuid)))
    })]), ...births]
    const go = (steps: ReadonlyArray<() => void>) => {
        live.beginTransaction()
        try {
            steps.forEach(step => step())
            live.endTransaction()
            merged.transactions++
            return true
        } catch (error) {
            // endTransaction rolls a refused transaction back itself; a throw before it leaves it open.
            if (live.inTransaction()) {live.abortTransaction()}
            console.warn("the version did not go into the playing graph", error)
            return false
        }
    }
    const chunks = <T>(list: ReadonlyArray<T>) => Array.from({length: Math.ceil(list.length / chunk)}, (_, i) => list.slice(i * chunk, (i + 1) * chunk))
    const steps = [
        ...chunks(leavesOut).map(boxes => [() => drop(boxes)]),
        core,
        ...chunks(leavesIn).map(boxes => boxes.map(box => () => {
            const old = before.get(UUID.toString(box.address.uuid))
            if (old) {carryAll(old.fields(), box.fields(), live.findBox(box.address.uuid).unwrap().fields()); return}
            live.createBox(box.name as any, box.address.uuid, made => made.read(new ByteArrayInput(box.toArrayBuffer())))
        }))
    ]
    for (const [index, step] of steps.entries()) {
        if (index > 0) {await pause()}
        if (!go(step)) {return undefined}
    }
    return merged
}
