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
export const toM4a = async wav => {
  const base = join(tmpdir(), `bounce-${randomUUID()}`)
  const m4a = `${base}.m4a`
  try {
    await writeFile(`${base}.wav`, wav)
    // One encode under the ceiling: one gain over the whole song, read again (the encoder is not linear), each pass a
    // little more room. Returns the gain it took.
    const under = async (file, coder) => {
      let gainDb = 0
      await encode(`${base}.wav`, file, gainDb, coder)
      for (let pass = 1, peak = await truePeak(file); pass <= 5 && peak > CEILING_DBTP; pass++, peak = await truePeak(file)) {
        gainDb += CEILING_DBTP - 0.1 * pass - peak
        await encode(`${base}.wav`, file, gainDb, coder)
      }
      return gainDb
    }
    // Most bounces sit under the ceiling as they are: only a song the first encode had to turn down tries the others,
    // and the one turned down least is kept, so the phone hears the loudness make judged.
    const first = await under(m4a, CODERS[0])
    if (first >= 0) return {bytes: await readFile(m4a), type: "audio/mp4"}
    const others = CODERS.slice(1).map((coder, i) => ({coder, file: `${base}.${i + 1}.m4a`}))
    try {
      const gains = await Promise.all(others.map(({file, coder}) => under(file, coder)))
      const best = Math.max(...gains)
      return {bytes: await readFile(best > first ? others[gains.indexOf(best)].file : m4a), type: "audio/mp4"}
    } finally {
      await Promise.all(others.map(({file}) => rm(file, {force: true}).catch(() => {})))
    }
  } catch (error) {
    console.warn("[engine] the bounce stays WAV:", String(error?.message ?? error))
    return {bytes: wav, type: "audio/wav"}
  } finally {
    await rm(`${base}.wav`, {force: true}).catch(() => {}); await rm(m4a, {force: true}).catch(() => {})
  }
}
