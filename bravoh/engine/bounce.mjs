import {execFile} from "node:child_process"
import {randomUUID} from "node:crypto"
import {readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

const CEILING_DBTP = -1
const run = args => new Promise((done, fail) => execFile("ffmpeg", args, {timeout: 120_000, maxBuffer: 64 * 1024 * 1024}, (error, _out, err) => error ? fail(error) : done(err)))
// ffmpeg's native AAC three ways: each overshoots a song's true peak by its own amount on its own material (BRAVOH
// 11-11, five masters at -1.3 dBTP: DnB +3.2 VBR / +0.9 CBR / -0.0 CBR with IS; garage -1.1 / -1.2 / +2.7).
const CODERS = [["-q:a", "1.5", "-aac_pns", "0", "-aac_is", "0"], ["-b:a", "256k", "-aac_pns", "0", "-aac_is", "0"], ["-b:a", "256k"]]
const encode = (wav, m4a, gainDb, coder = CODERS[0]) => run(["-v", "error", "-y", "-i", wav, "-af", `volume=${gainDb}dB`, "-c:a", "aac", ...coder, "-movflags", "+faststart", m4a])
// NaN on silence ("-inf"), which is under any ceiling
const truePeak = async file => Number((await run(["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"])).match(/Peak:\s+(\S+)/g)?.at(-1)?.split(/\s+/)[1])

// The phone's format: AAC in an M4A (the WAV was 19 MB and took a phone 18-40 s to fetch, 11-04). iOS, Safari, Chrome
// and the app shells decode it natively. Measured 6 Nov on the image's ffmpeg 5.1.9, make's -1.4 dBTP -7.9 LUFS mix:
// the native encoder at CBR 192k or 256k came out at +1.8 to +2.9 dBTP whatever else was off, so the file was never the
// signal make judged. This VBR with noise substitution and intensity stereo off: -1.7 dBTP, -8.0 LUFS, 3.5 MB (2.4).
// A mix that make itself left over the ceiling gets one gain over the whole song, never a limiter.
// The WAV goes out when ffmpeg cannot run (a dev machine without it): slower, never silent.
// `took`: each coder's passes and gain, and the ms of its encodes and peak reads, for the store's `engine.encode` line.
export const toM4a = async (wav, took = {}) => {
  const base = join(tmpdir(), `bounce-${randomUUID()}`)
  const m4a = `${base}.m4a`
  try {
    await writeFile(`${base}.wav`, wav)
    // One encode under the ceiling: one gain over the whole song, read again (the encoder is not linear), each pass a
    // little more room. Returns the gain it took. `over` is told the moment the first read is over the ceiling.
    const under = async (file, coder, over = () => {}) => {
      const mine = took[coder.join(" ")] = {passes: 0, encodeMs: 0, peakMs: 0, gainDb: 0}
      const timed = async (what, work) => {const began = Date.now(); try {return await work()} finally {mine[what] += Date.now() - began}}
      let gainDb = 0
      await timed("encodeMs", () => encode(`${base}.wav`, file, gainDb, coder))
      let peak = await timed("peakMs", () => truePeak(file))
      if (peak > CEILING_DBTP) over()
      for (let pass = 1; pass <= 5 && peak > CEILING_DBTP; pass++) {
        gainDb += CEILING_DBTP - 0.1 * pass - peak
        mine.passes = pass
        await timed("encodeMs", () => encode(`${base}.wav`, file, gainDb, coder))
        peak = await timed("peakMs", () => truePeak(file))
      }
      mine.gainDb = Math.round(gainDb * 100) / 100
      return gainDb
    }
    // Most bounces sit under the ceiling as they are: only a song the first encode had to turn down tries the others, and
    // the one turned down least is kept, so the phone hears the loudness make judged. The others start the moment the first
    // read is over the ceiling, beside the first coder's own passes, not after them: 11-14, a hot 2-minute master took
    // 25.3 s to encode, 78% of a press's wait for its file.
    const others = CODERS.slice(1).map((coder, i) => ({coder, file: `${base}.${i + 1}.m4a`}))
    let started
    const startOthers = () => {started ??= Promise.all(others.map(({file, coder}) => under(file, coder)))}
    try {
      const first = await under(m4a, CODERS[0], startOthers)
      if (first >= 0) return {bytes: await readFile(m4a), type: "audio/mp4"}
      startOthers()
      const gains = await started
      const best = Math.max(...gains)
      return {bytes: await readFile(best > first ? others[gains.indexOf(best)].file : m4a), type: "audio/mp4"}
    } finally {
      await started?.catch(() => {})
      await Promise.all(others.map(({file}) => rm(file, {force: true}).catch(() => {})))
    }
  } catch (error) {
    console.warn("[engine] the bounce stays WAV:", String(error?.message ?? error))
    return {bytes: wav, type: "audio/wav"}
  } finally {
    await rm(`${base}.wav`, {force: true}).catch(() => {}); await rm(m4a, {force: true}).catch(() => {})
  }
}
