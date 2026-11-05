// Extra Analysis-panel measurements computed on the realtime master output: stereo correlation/width,
// goniometer sample capture, and EBU R128 / ITU-R BS.1770 loudness (lib-dsp). Each is only stepped by the
// processor while its broadcast has subscribers (i.e. the panel/card is visible).


export class StereoAnalyser {
    #corr = 0.0
    #width = 0.0
    #balance = 0.0

    process(left: Float32Array, right: Float32Array, out: Float32Array): void {
        const n = left.length
        let sumLR = 0.0
        let sumLL = 0.0
        let sumRR = 0.0
        let sumMid = 0.0
        let sumSide = 0.0
        for (let i = 0; i < n; i++) {
            const l = left[i]
            const r = right[i]
            sumLR += l * r
            sumLL += l * l
            sumRR += r * r
            const mid = (l + r) * 0.5
            const side = (l - r) * 0.5
            sumMid += mid * mid
            sumSide += side * side
        }
        const corr = sumLL > 1e-12 && sumRR > 1e-12 ? sumLR / Math.sqrt(sumLL * sumRR) : 0.0
        const width = sumMid + sumSide > 1e-12 ? sumSide / (sumMid + sumSide) : 0.0
        const balance = sumLL + sumRR > 1e-12 ? (sumRR - sumLL) / (sumLL + sumRR) : 0.0
        this.#corr += (corr - this.#corr) * 0.1
        this.#width += (width - this.#width) * 0.1
        this.#balance += (balance - this.#balance) * 0.1
        out[0] = this.#corr
        out[1] = this.#width
        out[2] = this.#balance
        out[3] = Math.sqrt(sumMid / Math.max(1, n))
        out[4] = Math.sqrt(sumSide / Math.max(1, n))
    }
}

// Interleaved L/R ring for the goniometer. `out` length is PAIRS * 2.
export class GonioCapture {
    readonly #pairs: number

    #write = 0

    constructor(pairs: number) {this.#pairs = pairs}

    process(left: Float32Array, right: Float32Array, out: Float32Array): void {
        const n = left.length
        for (let i = 0; i < n; i++) {
            const base = this.#write * 2
            out[base] = left[i]
            out[base + 1] = right[i]
            this.#write = (this.#write + 1) % this.#pairs
        }
    }
}


export {LoudnessMeter, TruePeak} from "@opendaw/lib-dsp"
