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

// 11-14: a hot 2-minute master took 25.3 s to encode, its other coders waiting for the first coder's last pass.
test("a hot mix tries the other coders beside the first one's passes, and says what each took", async () => {
  const took = {}
  const began = Date.now()
  await toM4a(floats(9), took)
  const wall = Date.now() - began
  const coders = Object.values(took)
  assert.equal(coders.length, 3)
  assert.ok(coders[0].passes >= 1 && coders[0].gainDb < 0, JSON.stringify(took))
  const sum = coders.reduce((all, one) => all + one.encodeMs + one.peakMs, 0)
  assert.ok(wall < sum, `${wall} ms against ${sum} ms one after another: ${JSON.stringify(took)}`)
  const cool = {}
  await toM4a(floats(-9), cool)
  assert.deepEqual(Object.values(cool).map(one => one.passes), [0])
})
