import {execFile} from "node:child_process"
import {randomUUID} from "node:crypto"
import {readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

const CEILING_DBTP = -1
const run = args => new Promise((done, fail) => execFile("ffmpeg", args, {timeout: 120_000, maxBuffer: 64 * 1024 * 1024}, (error, _out, err) => error ? fail(error) : done(err)))
const encode = (wav, m4a, gainDb) => run(["-v", "error", "-y", "-i", wav, "-af", `volume=${gainDb}dB`, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", m4a])
// NaN on silence ("-inf"), which is under any ceiling
const truePeak = async file => Number((await run(["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"])).match(/Peak:\s+(\S+)/g)?.at(-1)?.split(/\s+/)[1])

// The phone's format: AAC in an M4A (the WAV was 19 MB and took a phone 18-40 s to fetch, 11-04). iOS, Safari, Chrome
// and the app shells decode it natively. AAC overshoots what goes in, so the encoded file is what gets measured, and
// one gain over the whole song brings it under the ceiling: the mix stays the mix (a limiter would change it).
// The WAV goes out when ffmpeg cannot run (a dev machine without it): slower, never silent.
export const toM4a = async wav => {
  const base = join(tmpdir(), `bounce-${randomUUID()}`)
  const m4a = `${base}.m4a`
  try {
    await writeFile(`${base}.wav`, wav)
    let gainDb = 0
    await encode(`${base}.wav`, m4a, gainDb)
    // the encoder is not linear (measured on a real song: -2 dB moved the peak 2.8, -2.9 more moved it 3.0), so each
    // result is read again, and each pass asks for a little more room
    for (let pass = 1, peak = await truePeak(m4a); pass <= 5 && peak > CEILING_DBTP; pass++, peak = await truePeak(m4a)) {
      gainDb += CEILING_DBTP - 0.1 * pass - peak
      await encode(`${base}.wav`, m4a, gainDb)
    }
    return {bytes: await readFile(m4a), type: "audio/mp4"}
  } catch (error) {
    console.warn("[engine] the bounce stays WAV:", String(error?.message ?? error))
    return {bytes: wav, type: "audio/wav"}
  } finally {
    await rm(`${base}.wav`, {force: true}).catch(() => {}); await rm(m4a, {force: true}).catch(() => {})
  }
}
