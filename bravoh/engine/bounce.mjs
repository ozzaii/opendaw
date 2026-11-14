import {execFile} from "node:child_process"
import {randomUUID} from "node:crypto"
import {readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

const CEILING_DBTP = -1
const run = args => new Promise((done, fail) => execFile("ffmpeg", args, {timeout: 120_000, maxBuffer: 64 * 1024 * 1024}, (error, _out, err) => error ? fail(error) : done(err)))
// ffmpeg's native AAC, one coder: VBR with noise substitution and intensity stereo off. 11-11 two more coders were
// tried beside it on a hot master, the one turned down least kept; 11-14 they won 2 of 12 encodes by 0.1 dB and made a
// hot bounce 40-92 s where this one alone is 21-31 s (the store's engine.encode lines), so they left (Kaan, 11-15).
const CODER = ["-q:a", "1.5", "-aac_pns", "0", "-aac_is", "0"]
const encode = (wav, m4a, gainDb) => run(["-v", "error", "-y", "-i", wav, "-af", `volume=${gainDb}dB`, "-c:a", "aac", ...CODER, "-movflags", "+faststart", m4a])
// NaN on silence ("-inf"), which is under any ceiling
const truePeak = async file => Number((await run(["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"])).match(/Peak:\s+(\S+)/g)?.at(-1)?.split(/\s+/)[1])

// The phone's format: AAC in an M4A (the WAV was 19 MB and took a phone 18-40 s to fetch, 11-04). iOS, Safari, Chrome
// and the app shells decode it natively. Measured 6 Nov on the image's ffmpeg 5.1.9, make's -1.4 dBTP -7.9 LUFS mix:
// the native encoder at CBR 192k or 256k came out at +1.8 to +2.9 dBTP whatever else was off, so the file was never the
// signal make judged. This VBR with noise substitution and intensity stereo off: -1.7 dBTP, -8.0 LUFS, 3.5 MB (2.4).
// A mix that make itself left over the ceiling gets one gain over the whole song, never a limiter.
// The WAV goes out when ffmpeg cannot run (a dev machine without it): slower, never silent.
// `took`: the coder's passes, gain and true peak, and the ms of its encodes and peak reads, for the store's
// `engine.encode` line. The answer names the true peak the file reached: a file its passes left over the ceiling says so
// (`over`), with no other coder to fall back on.
export const toM4a = async (wav, took = {}) => {
  const base = join(tmpdir(), `bounce-${randomUUID()}`)
  const m4a = `${base}.m4a`
  try {
    await writeFile(`${base}.wav`, wav)
    // One encode under the ceiling: one gain over the whole song, read again (the encoder is not linear), each pass a
    // little more room.
    const mine = took[CODER.join(" ")] = {passes: 0, encodeMs: 0, peakMs: 0, gainDb: 0}
    const timed = async (what, work) => {const began = Date.now(); try {return await work()} finally {mine[what] += Date.now() - began}}
    let gainDb = 0
    await timed("encodeMs", () => encode(`${base}.wav`, m4a, gainDb))
    let peak = await timed("peakMs", () => truePeak(m4a))
    for (let pass = 1; pass <= 5 && peak > CEILING_DBTP; pass++) {
      gainDb += CEILING_DBTP - 0.1 * pass - peak
      mine.passes = pass
      await timed("encodeMs", () => encode(`${base}.wav`, m4a, gainDb))
      peak = await timed("peakMs", () => truePeak(m4a))
    }
    mine.gainDb = Math.round(gainDb * 100) / 100
    // NaN is silence, under any ceiling
    const peakDb = Number.isNaN(peak) ? null : Math.round(peak * 100) / 100
    mine.peakDb = peakDb
    const over = peak > CEILING_DBTP
    if (over) {
      mine.over = true
      console.warn(`[engine] the bounce stays over the ceiling: ${peakDb} dBTP after ${mine.passes} passes`)
    }
    return {bytes: await readFile(m4a), type: "audio/mp4", peakDb, ...(over ? {over: true} : {})}
  } catch (error) {
    console.warn("[engine] the bounce stays WAV:", String(error?.message ?? error))
    return {bytes: wav, type: "audio/wav"}
  } finally {
    await rm(`${base}.wav`, {force: true}).catch(() => {}); await rm(m4a, {force: true}).catch(() => {})
  }
}
