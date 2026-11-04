// BRAVOH's booth (github.com/ozzaii/opendaw, branch `bravoh`): the studio app joins one song's room on the
// BRAVOH engine (bravoh/engine), plays it, and answers the booth host through window.booth. The phone sees this
// page as video and hears it as audio; no input comes back. Opened as `/studio/#booth=<song key>&token=<engine token>`.
import {Option, Progress, UUID} from "@opendaw/lib-std"
import {WavFile} from "@opendaw/lib-dsp"
import {StudioPreferences, YService} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"

// Read once, at the first line of main.ts: the app's router rewrites the location while it boots.
const asked = new URLSearchParams(location.hash.slice(1))
export const isBooth = (): boolean => asked.has("booth")

// The studio as a camera: no tour, toasts, hints or history buttons; the playhead followed. Set on the live settings,
// which the studio already read from storage before main.ts ran. window.booth is there at once, so the host can await
// `joined` while the engine is still loading.
const joined = Promise.withResolvers<unknown>()
export const prepareBooth = (): void => {
    ;(window as any).booth = {joined: joined.promise}
    history.replaceState(null, "", location.pathname) // the token never stays in the address
    localStorage.setItem("opendaw-suppress-unload-guard", "1")
    const {visibility, timeline, appearance} = StudioPreferences.settings
    Object.assign(visibility, {"visible-help-hints": false, "enable-history-buttons": false, "base-frequency": false,
        "toasts": false, "show-output-track": false, "offer-studio-tour": false})
    Object.assign(timeline, {markers: false, tempo: false, signature: false, clips: false, "follow-cursor": true})
    Object.assign(appearance, {"clamp-to-60fps": false})
    // only the song on camera: no studio header or footer, no panel title, no tool row, no create buttons
    // (prefix selectors: the studio's class names carry a build-made suffix)
    document.head.append(Object.assign(document.createElement("style"), {textContent: `
        .ground > [class^="Header"], .ground > footer, .ground > .room-status,
        [class^="PanelPlaceholder"] > header, [class^="TracksFooter"], .create-buttons {display: none !important}
        [class^="TimelineHeader"] > * {visibility: hidden}`}))
}

export const joinBooth = (service: StudioService): void => {join(service).then(joined.resolve, joined.reject)}
const join = async (service: StudioService): Promise<unknown> => {
    const key = asked.get("booth") ?? "", token = asked.get("token") ?? ""
    const engine = (path: string) => fetch(`/v1/songs/${key}/${path}`, {headers: {authorization: `Bearer ${token}`}})
    // the song's own samples are the engine's: asked after the cloud, where a stock sample is found
    service.chainedSampleProvider.attachPeer({
        fetch: async (uuid: UUID.Bytes, _progress: Progress.Handler) => {
            const response = await engine(`sample?uuid=${UUID.toString(uuid)}`)
            if (!response.ok) {throw new Error(`sample ${UUID.toString(uuid)} is not on the engine`)}
            const audio = WavFile.decodeFloats(await response.arrayBuffer())
            return [audio, {name: UUID.toString(uuid), bpm: 0, duration: audio.numberOfFrames / audio.sampleRate,
                sample_rate: audio.sampleRate, origin: "import"}] as any
        }
    })
    // a booth opened before the first program wrote a song waits for it (404 is "no song yet")
    let answer = await engine("room")
    for (let waited = 0; answer.status === 404 && waited < 600; waited++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        answer = await engine("room")
    }
    if (!answer.ok) {throw new Error(`no room: ${answer.status}`)}
    const {room, ws} = await answer.json()
    const url = new URL(ws, location.href.replace(/^http/, "ws")).href
    const {project} = await YService.getOrCreateRoom(Option.None, service, room, {url, params: {token}})
    service.projectProfileService.setProject(project, room)
    service.switchScreen("booth")
    const facade = project.engine
    await facade.isReady()
    if (service.audioContext.state !== "running") {await service.audioContext.resume()}
    // THE SONG LOOPS WHOLE when it sets no loop of its own, here in the page, never written into the song.
    // shortcut: the jump lands on the next frame after the end (<= 16 ms late); the engine's own loop if that is ever heard
    facade.position.subscribe(owner => {
        if (project.timelineBox.loopArea.enabled.getValue() || !facade.isPlaying.getValue()) {return}
        const end = songEnd()
        if (end > 0 && owner.getValue() >= end) {facade.setPosition(0)}
    })
    const barOf = () => {
        const signature = project.timelineBox.signature
        return Math.floor(960 * 4 / signature.denominator.getValue()) * signature.nominator.getValue()
    }
    const songEnd = () => {
        const end = project.boxGraph.boxes().filter(box => box.name.endsWith("RegionBox"))
            .reduce((last, box: any) => Math.max(last, (box.position?.getValue?.() ?? 0) + (box.duration?.getValue?.() ?? 0)), 0)
        return Math.ceil(end / barOf()) * barOf()
    }
    // the whole song in view, up to 16 bars (a longer one is followed by the playhead), and its tracks sharing the
    // height (a track's own height is in the song; this is the default under it, so the song is never written)
    let fitted = -1, rows = -1
    const fit = () => {
        const end = Math.min(Math.max(songEnd(), 4 * barOf()), 16 * barOf())
        if (end !== fitted) {service.timeline.range.showUnitInterval(0, end); fitted = end}
        const tracks = project.boxGraph.boxes().filter(box => box.name === "TrackBox").length
        if (tracks !== rows) {
            rows = tracks
            const height = Math.max(56, Math.min(240, Math.floor((innerHeight - 96) / Math.max(1, tracks))))
            document.documentElement.style.setProperty("--track-height", `${height}px`)
        }
    }
    fit()
    setInterval(fit, 1000) // shortcut: polled, not subscribed to the graph; a box-graph update hook if 1 s ever shows
    Object.assign((window as any).booth, {
        play: (from?: number) => {if (from !== undefined) {facade.setPosition(from)} facade.play()},
        stop: () => facade.stop(true),
        seek: (position: number) => facade.setPosition(position),
        // the transport as the phone draws it (BRAVOH boothState.transport): bars from 1, the loop as [from, to)
        transport: () => {
            const bar = barOf(), loop = project.timelineBox.loopArea
            const on = loop.enabled.getValue() && loop.to.getValue() > loop.from.getValue()
            const from = on ? Math.floor(loop.from.getValue() / bar) + 1 : 1
            const end = on ? loop.to.getValue() : songEnd()
            return {playing: facade.isPlaying.getValue(), from, to: Math.max(from + 1, Math.ceil(end / bar) + 1),
                bar: Math.round((facade.position.getValue() / bar + 1) * 1000) / 1000, at: Date.now()}
        },
        move: (request: { playing?: boolean, bar?: number }) => {
            if (request.bar !== undefined) {facade.setPosition(Math.max(0, Math.round((request.bar - 1) * barOf())))}
            if (request.playing === true) {facade.play()}
            if (request.playing === false) {facade.stop(false)}
            return true
        },
        state: () => ({playing: facade.isPlaying.getValue(), position: facade.position.getValue(),
            bpm: facade.bpm.getValue(), units: project.boxGraph.boxes().filter(box => box.name === "AudioUnitBox").length})
    })
    return {room}
}
