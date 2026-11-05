import {colorScheme, jewelHue} from "@opendaw/studio-enums"

export interface RegionPaintBucket {
    labelColor: string
    labelBackground: string
    contentColor: string
    contentBackground: string
    loopStrokeColor: string
}

export namespace RegionPaintBucket {
    export const create = ({hue, mute}: {
        hue: number,
        mute: boolean
    }, selected: boolean, forceMute: boolean, unitIndex: number = 0): RegionPaintBucket => {
        if (colorScheme() === "jet") return jet(jewelHue(unitIndex), mute || forceMute, selected)
        const saturationFactor = mute || forceMute ? 0.05 : 1.0
        const fullSat = 100 * saturationFactor
        const normSat = 75 * saturationFactor
        const lessSat = 60 * saturationFactor
        const labelColor = selected ? `hsl(${hue}, ${normSat}%, 10%)` : `hsl(${hue}, ${normSat}%, 68%)`
        const labelBackground = selected ? `hsla(${hue}, ${fullSat}%, 60%, 0.85)` : `hsla(${hue}, ${lessSat}%, 60%, 0.28)`
        const contentColor = `hsl(${hue}, ${normSat}%, 55%)`
        const contentBackground = selected ? `hsla(${hue}, ${normSat}%, 60%, 0.12)` : `hsla(${hue}, ${normSat}%, 60%, 0.07)`
        const loopStrokeColor = `hsl(${hue}, ${normSat}%, 58%)`
        return {labelColor, labelBackground, contentColor, contentBackground, loopStrokeColor}
    }

    // BRAVOH's booth (JET NIGHT): a region is a quiet tint of its unit's jewel and its notes that jewel as light; the
    // selection is the one pink.
    const jet = (hue: number, muted: boolean, selected: boolean): RegionPaintBucket => {
        const jewel = (alpha: number) => `oklch(0.71 0.19 ${hue} / ${muted ? alpha / 3 : alpha})`
        return {
            labelColor: selected ? "oklch(0.14 0.04 350)" : `oklch(0.84 0.07 ${hue})`,
            labelBackground: selected ? "oklch(0.71 0.19 350 / 0.85)" : jewel(0.14),
            contentColor: `oklch(0.9 0.07 ${hue} / ${muted ? 0.3 : 0.92})`,
            contentBackground: selected ? "oklch(0.71 0.19 350 / 0.1)" : jewel(0.07),
            loopStrokeColor: jewel(0.3)
        }
    }
}
