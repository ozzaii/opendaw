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
