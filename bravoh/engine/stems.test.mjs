// The store's half of a song's stems: on disk, one set a song, gone when asked. `npm run build` first: it runs the server as shipped.
import {spawn} from "node:child_process"
import {mkdtemp, readdir, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {after, before, test} from "node:test"
import assert from "node:assert/strict"
const token = "stems-test-stems-test-stems-test-stems", port = 17793, data = await mkdtemp(join(tmpdir(), "stems-"))
let server
const at = path => `http://127.0.0.1:${port}/v1/songs/song1/${path}`
const ask = (path, init = {}) => fetch(at(path), {...init, headers: {authorization: `Bearer ${token}`}})
before(async () => {
  server = spawn(process.execPath, [new URL("./dist/server.mjs", import.meta.url).pathname], {stdio: "ignore", env: {...process.env, ENGINE_TOKEN: token, ENGINE_DATA: data, ENGINE_HOST: "127.0.0.1", ENGINE_PORT: String(port)}})
  for (let i = 0; i < 100; i++) {
    if (await ask("version").then(() => true, () => false)) {return}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
})
after(async () => {
  server.kill()
  await rm(data, {recursive: true, force: true})
})
test("a set holds its files and its progress, a new set replaces it, and DELETE takes it", async () => {
  await ask("stems/a-48000-stems/0", {method: "POST", body: new Uint8Array(1000)})
  await ask("stems/a-48000-stems?done=0.5", {method: "POST", body: ""})
  assert.equal((await (await ask("stems")).json()).done, 0.5)
  assert.equal((await (await ask("stems/a-48000-stems/0")).arrayBuffer()).byteLength, 1000)
  assert.equal((await ask("stems/a-48000-stems/9")).status, 404)
  await ask("stems/b-48000-stems/0", {method: "POST", body: new Uint8Array(10)})
  assert.equal((await ask("stems/a-48000-stems/0")).status, 404)
  assert.deepEqual(await readdir(join(data, "stems")), ["song1.b-48000-stems"])
  await ask("stems/b-48000-stems", {method: "DELETE"})
  assert.deepEqual(await readdir(join(data, "stems")), [])
})
test("a path out of the set is no file", async () => {
  assert.equal((await ask("stems/..%2F..%2Fx/0")).status, 404)
  assert.equal((await ask("stems/a-48000-stems/..%2Fsecret")).status, 404)
})
