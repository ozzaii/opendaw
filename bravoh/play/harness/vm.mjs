// The lab VM's real browsers, one way to talk to both: real Safari through safaridriver, Chromium for Testing over CDP.
// Everything runs on the VM; this Mac only sends commands. The page's tap outputs digital silence and the VM's output is muted.
import {execSync, spawnSync} from "node:child_process"
import {chromium} from "./lib.mjs"
export const KEY = process.env.SONG ?? "gva8kLmC3cZ70OKGagGJmXL2md5EQ6iMEiyBlJLBQ6Q"
export const TOKEN = "native-play-native-play-native-play-local"
export const vm = command => {
  for (let i = 0; ; i++) {
    const r = spawnSync("/Users/ozai/projects/bravoh-lanes/lab-tools/safari/v.sh", [command], {encoding: "utf8"})
    if (r.status === 0 || !/Too many authentication|Connection (closed|reset)/.test(r.stderr) || i > 4) return r.stdout
  }
}
const pause = ms => new Promise(d => setTimeout(d, ms))
const pageUrl = (extra = "") => `http://localhost:7791/booth/#key=${KEY}&token=${TOKEN}&gesture=1${process.env.NOPOLL ? "" : "&measure=1"}${extra}`
const CH = `/Volumes/Lab/np/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

export const safari = async () => {
  const W = "http://127.0.0.1:14444"
  const wd = async (m, path, body) => {const r = await fetch(W + path, {method: m, headers: {"content-type": "application/json"}, body: body ? JSON.stringify(body) : undefined}); const j = await r.json(); if (j.value?.error) throw new Error(`${path} ${j.value.error}: ${String(j.value.message).slice(0, 300)}`); return j.value}
  const made = await wd("POST", "/session", {capabilities: {alwaysMatch: {browserName: "safari"}}})
  const S = `/session/${made.sessionId}`
  await wd("POST", `${S}/timeouts`, {script: 300000})
  return {
    name: "safari", version: made.capabilities.browserVersion,
    open: async extra => {await wd("POST", `${S}/url`, {url: "about:blank"}); await pause(1500); await wd("POST", `${S}/url`, {url: pageUrl(extra)})},
    press: async css => {const e = await wd("POST", `${S}/element`, {using: "css selector", value: css}); await wd("POST", `${S}/element/${Object.values(e)[0]}/click`, {})},
    E: expr => wd("POST", `${S}/execute/async`, {script: `const done = arguments[arguments.length - 1]; Promise.resolve().then(() => ${expr}).then(v => done(v === undefined ? null : v), e => done({error: String(e)}))`, args: []}),
    close: () => wd("DELETE", S).catch(() => {}),
    procs: /com\.apple\.WebKit\.(WebContent|GPU|Networking)|Safari\.app\/Contents\/MacOS\/Safari$|coreaudiod/
  }
}

// Inside the GUI session, or Chrome gets no audio device from an ssh shell. A fresh profile per call: a cold start.
export const chrome = async ({flags = ""} = {}) => {
  vm(`pkill -f "Google Chrome for Testing" ; rm -rf /Volumes/Lab/np/prof; mkdir -p /Volumes/Lab/np/prof; echo admin | sudo -S launchctl asuser 501 sudo -u admin TMPDIR=/Volumes/Lab/np/tmp nohup "${CH}" --headless=new --remote-debugging-port=9222 --user-data-dir=/Volumes/Lab/np/prof --no-first-run --no-default-browser-check ${flags} about:blank >/Volumes/Lab/np/chrome.log 2>&1 &`)
  let browser
  for (let i = 0; i < 40 && !browser; i++) {await pause(500); browser = await chromium.connectOverCDP("http://127.0.0.1:19222").catch(() => undefined)}
  if (!browser) throw new Error("no chromium on the VM")
  const context = browser.contexts()[0]
  let page = context.pages()[0] ?? await context.newPage()
  page.on("pageerror", e => console.log("[pageerror]", e.message.slice(0, 300)))
  return {
    name: "chromium", version: browser.version(),
    open: async extra => {await page.goto("about:blank"); await pause(1500); await page.goto(pageUrl(extra))},
    press: css => page.click(css),
    E: expr => page.evaluate(expr).then(v => v ?? null),
    close: async () => {await browser.close().catch(() => {}); vm(`pkill -f "Google Chrome for Testing"; rm -rf /Volumes/Lab/np/prof`)},
    procs: /Google Chrome for Testing( Helper)?.*(--type=renderer|AudioService|--type=gpu)|MacOS\/Google Chrome for Testing |coreaudiod/
  }
}
export const open = name => name === "safari" ? safari() : chrome()

// CPU seconds and RSS on the VM, by role
export const usage = b => {
  const rows = vm(`ps -axo pid=,rss=,time=,command=`).split("\n").map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(?:(\d+):)?(\d+):(\d+)[.,](\d+)\s+(.*)$/.exec(line); if (!m || !b.procs.test(m[7])) return null
    const c = m[7]
    const role = /coreaudiod/.test(c) ? "coreaudiod" : /WebContent|--type=renderer/.test(c) ? "page" : /GPU|--type=gpu/.test(c) ? "gpu" : /Networking/.test(c) ? "net" : /AudioService/.test(c) ? "audio" : "app"
    return {pid: +m[1], role, rssMB: Math.round(+m[2] / 1024), cpu: (+(m[3] ?? 0)) * 3600 + (+m[4]) * 60 + (+m[5]) + (+`0.${m[6]}`)}
  }).filter(Boolean)
  return rows
}
export const footprint = pid => {const t = vm(`echo admin | sudo -S footprint -p ${pid} 2>/dev/null | grep -E "phys_footprint|Footprint:" | head -3`); return t.trim()}
