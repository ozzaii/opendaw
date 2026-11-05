import {Box, ByteArrayField, Field, PointerTypes, StringField} from "@opendaw/lib-box"
import {WclapParameterBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {WclapParameterAdapters} from "@opendaw/studio-adapters"
import {asInstanceOf, float, int, isDefined, isNull, Nullable, panic} from "@opendaw/lib-std"
import {WclapDevice, WclapParameter, WclapParameterInfo} from "../../Api"
import {Context} from "../Context"
import {Facade} from "../Common"
import {Guard} from "../Guard"

// The fields every WebCLAP device box shares (WclapDeviceBox, WclapInstrumentBox)
export type WclapDeviceBox = Box & {
    readonly label: StringField<PointerTypes>
    readonly url: StringField<PointerTypes>
    readonly clapId: StringField<PointerTypes>
    readonly state: StringField<PointerTypes>
    readonly pluginState: ByteArrayField<PointerTypes>
    readonly parameters: Field<Pointers.Parameter>
}

const DefaultLabel = "WebCLAP"

export class WclapParameterImpl extends Facade<WclapParameterBox> implements WclapParameter {
    static wrap(context: Context, box: WclapParameterBox): WclapParameterImpl {
        return context.facade(box, () => new WclapParameterImpl(context, box))
    }

    declare value: float

    private constructor(context: Context, box: WclapParameterBox) {
        super(context, box)
        this.bind({value: box.value})
    }

    get id(): int {return this.box.clapId.getValue() >>> 0}
    get name(): string {return this.box.label.getValue()}
    get min(): float {return this.box.min.getValue()}
    get max(): float {return this.box.max.getValue()}
    get defaultValue(): float {return this.box.defaultValue.getValue()}
}

// What WclapInstrumentImpl and WclapEffectImpl share. The parameter boxes carry the uuid the studio derives for them
// (WclapParameterAdapters.uuidOf), so a studio loading the plugin later updates these boxes instead of adding its own.
export class WclapSupport implements WclapDevice {
    readonly #context: Context
    readonly #box: WclapDeviceBox

    constructor(context: Context, box: WclapDeviceBox) {
        this.#context = context
        this.#box = box
    }

    get plugin(): Nullable<{ url: string, clapId: string, name: string }> {
        const url = this.#box.url.getValue(), clapId = this.#box.clapId.getValue()
        return url.length === 0 ? null : {url, clapId, name: this.#box.label.getValue()}
    }
    set plugin(plugin: Nullable<{ url: string, clapId: string, name?: string }>) {
        const url = isNull(plugin) ? "" : Guard.string(plugin.url, "plugin.url")
        const clapId = isNull(plugin) ? "" : Guard.string(plugin.clapId, "plugin.clapId")
        if (!isNull(plugin) && (url.length === 0 || clapId.length === 0)) {
            panic(new RangeError("plugin: url and clapId must not be empty"))
        }
        const name = isNull(plugin) || !isDefined(plugin.name) ? null : Guard.string(plugin.name, "plugin.name")
        this.#context.edit(() => {
            if (this.#box.clapId.getValue() !== clapId) {
                this.#box.pluginState.setValue(new Int8Array(0))
                this.#box.state.setValue("")
                this.#parameterBoxes().forEach(box => box.delete())
            }
            this.#box.url.setValue(url)
            this.#box.clapId.setValue(clapId)
            // the device takes its plugin's name, unless it was named
            if (!isNull(name) && this.#box.label.getValue().replace(/\s+\d+$/, "") === DefaultLabel) {
                this.#box.label.setValue(name)
            }
        })
    }

    get state(): Int8Array {return this.#box.pluginState.getValue().slice()}
    set state(bytes: Int8Array) {
        if (!ArrayBuffer.isView(bytes)) {panic(new TypeError("state: expected an Int8Array"))}
        const copy = new Int8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        this.#context.edit(() => {
            this.#box.pluginState.setValue(copy)
            this.#box.state.setValue("")
        })
    }

    get parameters(): ReadonlyArray<WclapParameter> {
        return this.#parameterBoxes().map(box => WclapParameterImpl.wrap(this.#context, box))
    }

    parameter(name: string): Nullable<WclapParameter> {
        const wanted = Guard.string(name, "name")
        return this.parameters.find(parameter => parameter.name === wanted) ?? null
    }

    setParameter(info: WclapParameterInfo, value: float): WclapParameter {
        if (typeof info !== "object" || isNull(info)) {return panic(new TypeError("parameter: expected a WclapParameterInfo"))}
        if (this.#box.url.getValue().length === 0) {return panic("setParameter: the device has no plugin yet")}
        const id = Guard.number(info.id, "parameter.id") >>> 0
        const flags = Guard.number(info.flags ?? 0, "parameter.flags")
        if (!WclapParameterAdapters.isAutomatable({flags})) {
            return panic(new RangeError(`${info.name}: the plugin keeps this parameter to itself (hidden or read-only)`))
        }
        const min = Guard.number(info.min, "parameter.min"), max = Guard.number(info.max, "parameter.max")
        const plain = Guard.number(value, "value")
        if (plain < min || plain > max) {return panic(new RangeError(`${info.name}: ${plain} is outside ${min}..${max}`))}
        const uuid = WclapParameterAdapters.uuidOf(this.#box.address.uuid, id)
        return this.#context.edit(() => {
            const box = this.#context.boxGraph.findBox<WclapParameterBox>(uuid).unwrapOrElse(() =>
                WclapParameterBox.create(this.#context.boxGraph, uuid, box => {
                    box.owner.refer(this.#box.parameters)
                    box.clapId.setValue(id | 0)
                    box.label.setValue(Guard.string(info.name, "parameter.name"))
                    box.module.setValue(typeof info.module === "string" ? info.module : "")
                    box.min.setValue(min)
                    box.max.setValue(max)
                    box.defaultValue.setValue(Guard.number(info.defaultValue, "parameter.defaultValue"))
                    box.flags.setValue(flags | 0)
                }))
            box.value.setValue(plain)
            return WclapParameterImpl.wrap(this.#context, box)
        })
    }

    #parameterBoxes(): ReadonlyArray<WclapParameterBox> {
        return this.#box.parameters.pointerHub.incoming().map(({box}) => asInstanceOf(box, WclapParameterBox))
    }
}
