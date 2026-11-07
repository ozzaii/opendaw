// Two real renders of one state: the studio's own #engine= page, as staging renders. The store keeps a render per state, so each round
// restarts the store with its renders cleared; a shared file would prove nothing.
import {chrome, vm, KEY, TOKEN} from "./vm.mjs"
const pause = ms => new Promise(d => setTimeout(d, ms))
for (const label of ["render1", "render2"]) {
  vm(`pkill -f dist/server.mjs; sleep 1; rm -f /Volumes/Lab/np/data/renders/*; /Volumes/Lab/np/up.sh; sleep 2`)
  const b = await chrome()
  await b.goto(`http://localhost:7791/#engine=${KEY}&token=${TOKEN}`)
  for (let i = 0; i < 200 && !(await b.E("!!window.engine")); i++) await pause(250)
  await b.E("window.engine.ready")
  const t0 = Date.now()
  // playwright loses this page once the render starts, though the page lives on: the store's log says when it is done
  await b.E(`void window.engine.call("bounce", JSON.stringify({}), "artist")`).catch(() => {})
  let done = ""; for (let i = 0; i < 90 && !done; i++) {await pause(2000); done = vm(`grep engine.render /Volumes/Lab/np/store.log | tail -1`).trim()}
  console.log(label, done.slice(0, 160), Date.now() - t0, "ms")
  await pause(3000); await b.close()
  console.log(vm(`mkdir -p /Volumes/Lab/np/bounces; f=$(ls -t /Volumes/Lab/np/data/renders/* | head -1); cp "$f" /Volumes/Lab/np/bounces/${label}.wav; ls -la /Volumes/Lab/np/bounces/${label}.wav; md5 -q /Volumes/Lab/np/bounces/${label}.wav; grep -c engine.render /Volumes/Lab/np/store.log`))
}
process.exit(0)
