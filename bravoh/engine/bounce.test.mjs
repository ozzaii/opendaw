// The bounce the phone plays: under the ceiling after the encoder, and left alone when it already is.
import {test} from "node:test"
import assert from "node:assert/strict"
import {execFileSync, spawnSync} from "node:child_process"
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {toM4a} from "./bounce.mjs"

const dir = mkdtempSync(join(tmpdir(), "bounce-test-"))
const floats = gainDb => {
  const file = join(dir, `in-${gainDb}.wav`)
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=997:d=3:r=48000", "-f", "lavfi", "-i", "anoisesrc=d=3:r=48000:a=0.4:seed=1",
    "-filter_complex", `[0][1]amix=normalize=0,volume=${gainDb}dB`, "-ac", "2", "-c:a", "pcm_f32le", file])
  return readFileSync(file)
}
const peakOf = bytes => {
  const file = join(dir, "out.m4a")
  writeFileSync(file, bytes)
  const {stderr} = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], {encoding: "utf8", maxBuffer: 1 << 26})
  return Number(stderr.match(/Peak:\s+(\S+)/g).at(-1).split(/\s+/)[1])
}

test("a mix above 0 dBFS comes out under -1 dBTP", async () => {
  const {bytes, type} = await toM4a(floats(9))
  assert.equal(type, "audio/mp4")
  assert.ok(peakOf(bytes) <= -1, String(peakOf(bytes)))
  assert.ok(peakOf(bytes) > -2, String(peakOf(bytes)))
})

test("a mix under the ceiling keeps its level", async () => {
  const {bytes} = await toM4a(floats(-9))
  assert.ok(peakOf(bytes) > -15 && peakOf(bytes) < -12, String(peakOf(bytes))) // sine at -18 dB + noise, -9 dB
})

// 11-15 (Kaan): one coder. A hot render makes that coder's runs only, under the ceiling, and the answer and the store's
// line name the true peak the file reached.
test("a hot render makes one coder's runs only, and the answer names its true peak", async () => {
  const took = {}
  const {bytes, peakDb, over} = await toM4a(floats(9), took)
  assert.deepEqual(Object.keys(took), ["-q:a 1.5 -aac_pns 0 -aac_is 0"])
  const [mine] = Object.values(took)
  assert.ok(mine.passes >= 1 && mine.gainDb < 0, JSON.stringify(took))
  assert.equal(mine.peakDb, peakDb)
  assert.ok(peakDb <= -1, String(peakDb))
  assert.equal(over, undefined)
  assert.ok(Math.abs(peakOf(bytes) - peakDb) < 0.05, `${peakOf(bytes)} read, ${peakDb} named`)
  const cool = {}
  await toM4a(floats(-9), cool)
  assert.deepEqual(Object.values(cool).map(one => one.passes), [0])
})
