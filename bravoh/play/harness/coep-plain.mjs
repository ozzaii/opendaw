// What a page that is crossOriginIsolated loses: real third-party resources the product shows today, loaded inside the isolated page.
import {open} from "./vm.mjs"
const name = process.argv[2]
const b = await open(name)
await (b.goto ?? b.url)("http://localhost:7792/")
console.log(name, b.version, JSON.stringify(await b.E("({coi: crossOriginIsolated})")))
const probe = (tag, src, attrs = "") => b.E(`new Promise(done => {const e = document.createElement(${JSON.stringify(tag)}); const t = setTimeout(() => done("timeout"), 12000); e.onload = () => {clearTimeout(t); done("load")}; e.onerror = () => {clearTimeout(t); done("error")}; ${attrs}; e.${tag === "link" ? "href" : "src"} = ${JSON.stringify(src)}; document.body.append(e)})`)
const row = async (label, p) => console.log(label.padEnd(34), await p)
await row("img i.ytimg.com", probe("img", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"))
await row("img i.scdn.co (Spotify art)", probe("img", "https://i.scdn.co/image/ab67616d0000b273e8b066f70c206551210d902b"))
await row("img crossorigin ytimg", probe("img", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "e.crossOrigin = 'anonymous'"))
await row("css fonts.googleapis.com", probe("link", "https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap", "e.rel = 'stylesheet'"))
await row("audio/video from studio.bravoh.ai", probe("img", "https://studio.bravoh.ai/favicon.ico"))
// an iframe's load event fires either way: a blocked one holds no frames of its own and shows the browser's error document
const frame = await b.E(`new Promise(done => {const e = document.createElement("iframe"); e.src = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"; e.width = 400; e.height = 225; e.id = "yt"; const t = setTimeout(() => done("timeout"), 12000); e.onload = () => {clearTimeout(t); setTimeout(() => done({load: true, innerFrames: e.contentWindow.length}), 2500)}; document.body.append(e)})`)
console.log("iframe youtube-nocookie".padEnd(34), JSON.stringify(frame))
await b.close(); process.exit(0)
