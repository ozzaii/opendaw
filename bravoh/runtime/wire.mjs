// The studio's values on a JSON wire: typed arrays, buffers and bigints travel as base64.
const TYPES = {Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array}
const bytesOf = view => Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64")
const isBuffer = value => value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
export const encode = value => JSON.stringify(value, (_key, item) => {
  if (ArrayBuffer.isView(item)) return {$t: item.constructor.name, $b: bytesOf(item)}
  if (isBuffer(item)) return {$t: "ArrayBuffer", $b: Buffer.from(item).toString("base64")}
  if (typeof item === "bigint") return {$t: "BigInt", $b: item.toString()}
  return item
})
export const decode = text => JSON.parse(text, (_key, item) => {
  if (item === null || typeof item !== "object" || typeof item.$t !== "string") return item
  if (item.$t === "BigInt") return BigInt(item.$b)
  const bytes = Buffer.from(item.$b, "base64")
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  if (item.$t === "ArrayBuffer") return buffer
  const Type = TYPES[item.$t]
  if (!Type) throw new TypeError(`wire: unknown type ${item.$t}`)
  return new Type(buffer)
})
// A mixdown BRAVOH left in the room, the program's working directory, as a 32-bit float WAV: read once, then removed.
// 11-11: on the wire it was 104 MB of base64 for a 3:24 song, and each such answer stood ~87 s before the next hand.
export const fromRoom = async file => {
  const {readFile, rm} = await import("node:fs/promises")
  const bytes = await readFile(file)
  await rm(file, {force: true}).catch(() => {})
  let channels = 0, sampleRate = 0
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString("ascii", at, at + 4), size = bytes.readUInt32LE(at + 4), body = at + 8
    if (id === "fmt ") {channels = bytes.readUInt16LE(body + 2); sampleRate = bytes.readUInt32LE(body + 4)}
    if (id === "data" && channels > 0) {
      const count = Math.floor(Math.min(size, bytes.length - body) / 4 / channels), start = bytes.byteOffset + body
      const samples = new Float32Array(bytes.buffer.slice(start, start + count * channels * 4))
      const frames = Array.from({length: channels}, (_, c) => {
        const channel = new Float32Array(count)
        for (let i = 0; i < count; i++) channel[i] = samples[i * channels + c]
        return channel
      })
      return {sampleRate, frames}
    }
    at = body + size + (size & 1)
  }
  throw new Error(`the mixdown ${file} holds no audio`)
}
