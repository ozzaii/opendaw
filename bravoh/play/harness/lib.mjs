import {createRequire} from "node:module"
import {execSync} from "node:child_process"
const require = createRequire("/Users/ozai/projects/bravoh-lanes/opendaw-spike/sdk/")
export const {chromium} = require("playwright-core")
export const CHROME = "/Users/ozai/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
export const ORIGIN = "http://127.0.0.1:7791"
export const TOKEN = "native-play-native-play-native-play-local"
export const KEY = process.env.SONG ?? "gva8kLmC3cZ70OKGagGJmXL2md5EQ6iMEiyBlJLBQ6Q"
// --mute-audio: Kaan's Mac stays silent. Never a headless WebKit here.
export const ARGS = ["--mute-audio", "--autoplay-policy=no-user-gesture-required", "--enable-features=SharedArrayBuffer"]
export const launch = (extra = {}) => chromium.launch({executablePath: CHROME, headless: true, args: ["--headless=new", ...ARGS], ...extra})
export const url = (hash = "") => `${ORIGIN}/booth/#key=${KEY}&token=${TOKEN}${hash}`
export const say = (label, value) => console.log(label.padEnd(30), typeof value === "string" ? value : JSON.stringify(value))
export const procs = pidMatch => execSync(`ps -axo pid=,pcpu=,rss=,command= | grep -- '${pidMatch}' | grep -v grep || true`).toString()
