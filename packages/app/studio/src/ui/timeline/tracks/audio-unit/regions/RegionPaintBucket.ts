import {colorScheme} from "@opendaw/studio-enums"

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
    }, selected: boolean, forceMute: boolean): RegionPaintBucket => {
        if (colorScheme() === "jet") return jet(mute || forceMute, selected)
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

    // BRAVOH's booth: every region in the room's ink, notes as light, the selection the one pink (JET NIGHT).
    const ink = (alpha: number) => `oklch(0.985 0.002 350 / ${alpha})`
    const jet = (muted: boolean, selected: boolean): RegionPaintBucket => ({
        labelColor: selected ? "oklch(0.14 0.04 350)" : "oklch(0.735 0.005 350)",
        labelBackground: selected ? "oklch(0.71 0.19 350 / 0.85)" : ink(0.08),
        contentColor: ink(muted ? 0.3 : 0.85),
        contentBackground: selected ? "oklch(0.71 0.19 350 / 0.08)" : ink(0.04),
        loopStrokeColor: ink(0.14)
    })
}
