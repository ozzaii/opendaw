import {asInstanceOf, StringMapping, Terminable, Terminator, UUID, ValueMapping} from "@opendaw/lib-std"
import {Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {WclapParameterBox} from "@opendaw/studio-boxes"
import {ParameterAdapterSet} from "../ParameterAdapterSet"
import {WclapParamInfo} from "../protocols"

const IS_STEPPED = 1 << 0 // CLAP_PARAM_IS_STEPPED

// Keeps a parameter adapter per `WclapParameterBox` child of a WebCLAP device, shared by the effect and instrument
export namespace WclapParameterAdapters {
    const IS_HIDDEN = 1 << 2
    const IS_READONLY = 1 << 3

    // the parameters a device keeps a box for: what a user or a script can set and automate
    export const isAutomatable = ({flags}: Pick<WclapParamInfo, "flags">): boolean => (flags & (IS_HIDDEN | IS_READONLY)) === 0

    // every client derives the same uuid, so engines reporting at once in a live room create one box. The last
    // byte is always flipped, else clap id 0 would hand out the device's own uuid.
    export const uuidOf = (deviceUuid: UUID.Bytes, clapId: number): UUID.Bytes => {
        const bytes = new Uint8Array(deviceUuid)
        new DataView(bytes.buffer).setUint32(0, new DataView(bytes.buffer).getUint32(0) ^ clapId)
        bytes[15] ^= 0xA5
        return bytes
    }

    export const subscribe = (parametric: ParameterAdapterSet, parameters: Field<Pointers.Parameter>): Terminable => {
        const ranges = new Terminator()
        return Terminable.many(ranges, parameters.pointerHub.catchupAndSubscribe({
            onAdded: ({box}) => {
                const paramBox = asInstanceOf(box, WclapParameterBox)
                const {valueMapping, stringMapping} = mappings(paramBox)
                const adapter = parametric.createParameter(paramBox.value, valueMapping, stringMapping,
                    paramBox.label.getValue(), undefined, paramBox.defaultValue.getValue())
                const update = () => {
                    const {valueMapping, stringMapping} = mappings(paramBox)
                    adapter.updateMappings(valueMapping, stringMapping)
                }
                ranges.ownAll(paramBox.min.subscribe(update), paramBox.max.subscribe(update), paramBox.flags.subscribe(update))
            },
            onRemoved: ({box}) => parametric.removeParameter(asInstanceOf(box, WclapParameterBox).value.address)
        }))
    }

    const mappings = (paramBox: WclapParameterBox): { valueMapping: ValueMapping<number>, stringMapping: StringMapping<number> } => {
        const min = paramBox.min.getValue()
        const max = paramBox.max.getValue()
        const stepped = (paramBox.flags.getValue() & IS_STEPPED) !== 0
        return {
            valueMapping: stepped ? ValueMapping.linearInteger(min, max) : ValueMapping.linear(min, max),
            stringMapping: StringMapping.numeric({unit: "", fractionDigits: stepped ? 0 : 2})
        }
    }
}
