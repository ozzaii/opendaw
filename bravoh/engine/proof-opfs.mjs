// A READ OF THE STUDIO'S STORAGE ALWAYS ANSWERS (packages/lib/fusion/src/opfs/OpfsWorker.ts, the note on #opening). Only a
// browser shows it: Node keeps the file handle alive by itself (measured), so no unit test of this file can fail. The real
// worker code, a song's worth of files read at once, a garbage collection in the window. Before the fix it wedged within
// 9 rounds on Chrome 157 and on Chrome for Testing. `CHROME=<binary> PLAYWRIGHT=<playwright-core> npm run proof:opfs`
import {createServer} from "node:http"
import {build} from "esbuild"
const {chromium} = await import(process.env.PLAYWRIGHT ?? "playwright-core")
const ROUNDS = 40, FILES = 84
const {outputFiles: [bundle]} = await build({
  bundle: true, write: false, format: "esm", platform: "browser", absWorkingDir: new URL(".", import.meta.url).pathname,
  stdin: {resolveDir: new URL(".", import.meta.url).pathname, contents: `
    import {Communicator, Messenger} from "@opendaw/lib-runtime"
    import {OpfsWorker} from "../../packages/lib/fusion/src/opfs/OpfsWorker.ts"
    const {port1, port2} = new MessageChannel()
    OpfsWorker.init(Messenger.for(port1))
    const opfs = Communicator.sender(Messenger.for(port2).channel("opfs"), router => new class {
      write(path, data) {return router.dispatchAndReturn(this.write, path, data)}
      read(path) {return router.dispatchAndReturn(this.read, path)}
    })
    const paths = Array.from({length: ${FILES}}, (_, at) => "samples/" + (at % 28) + "/" + at)
    for (const path of paths) await opfs.write(path, new Uint8Array(200_000))
    for (let round = 0; round < ${ROUNDS}; round++) {
      const reads = Promise.all(paths.map(path => opfs.read(path))).then(() => "read")
      for (let times = 0; times < 3; times++) {
        await new Promise(resolve => setTimeout(resolve, 3))
        self.gc()
      }
      if (await Promise.race([reads, new Promise(resolve => setTimeout(resolve, 20_000, "stuck"))]) === "stuck") {
        postMessage({stuck: round})
        close()
      }
    }
    postMessage({rounds: ${ROUNDS}})`}
})
const server = createServer((request, response) => {
  response.writeHead(200, {"content-type": request.url === "/worker.js" ? "text/javascript" : "text/html"})
  response.end(request.url === "/worker.js" ? bundle.text : "<!doctype html>")
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const browser = await chromium.launch({executablePath: process.env.CHROME, args: ["--no-sandbox", "--mute-audio", "--js-flags=--expose-gc"]})
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${server.address().port}/`)
const answer = await page.evaluate(() => new Promise((resolve, reject) => {
  const worker = new Worker("/worker.js", {type: "module"})
  worker.onmessage = ({data}) => resolve(data)
  worker.onerror = ({message}) => reject(new Error(message))
}))
await browser.close()
server.close()
console.log(JSON.stringify(answer))
if (answer.stuck !== undefined) {
  console.error(`a read never answered in round ${answer.stuck}`)
  process.exit(1)
}
