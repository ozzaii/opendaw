// ONE RENDER PER STATE OF A SONG, for every reader of it (BravohEngine.ts): make's numbers, the desk's mixdown, the
// bounce the artist plays. A render is named by the project's own bytes, which a program that changed nothing sends back
// exactly as the page holds them (measured 7 Nov on a 128-bar song), so all three are one render. 11-07: one version
// was rendered three times over, 51 s each, and a step of 404 s spent 296 of them in this queue.
//
// Three lanes, one render each: the artist's, everybody's, and the loop's. A press never waits for make's numbers, and
// make's numbers cost the artist nothing. A loop area (a phrase, seconds of work) never waits behind a whole song: 11-14 a
// 2.3 s loop render waited 25.9 s and 45.8 s in everybody's lane. No imports, so `bravoh/engine/renders.test.mjs` runs it in Node.

// A RENDER IS ENDED ONLY WHEN IT STOPPED MOVING, never for how long it took or stood in line (11-14: 205 lines in 7 days
// ended renders by a total clock that counted the line). Moving: a sound it waits for arrives, or the engine reports
// progress (`watch.moved`). The time in line is no one's clock: the render ahead is moving or is ended by its own.
// external limit: how long nothing may move. The sounds of a render took 8.9 s at most in 655 renders (11-07).
const STALL_MS = 60_000

export class RenderStuck extends Error {
    readonly waited: ReadonlyArray<string>
    constructor(waited: ReadonlyArray<string>, seconds: number) {
        super(`The render stopped: nothing moved for ${seconds} s, ${waited.length > 0 ? `waiting for ${waited.join(", ")}` : "still rendering"}: nothing was rendered. Ask again.`)
        this.waited = waited
    }
}
/** What a render tells the lane while it runs, and what stops it. */
export type RenderWatch = {
    signal: AbortSignal, wait: (what: string) => () => void, /** the engine moved: restarts the stall clock */ moved: () => void,
    /** asked to started */ waitedMs: number
}

export class Superseded extends Error {
    constructor() {super("The song changed while this render waited: read it again and render that.")}
}

export type RenderNote = "shared" | "stored" | "dropped"
type Render = { id: string, version: number, artist: boolean, loop: boolean, asked: number, work: (watch: RenderWatch) => Promise<void>, answer: PromiseWithResolvers<void> }

export const renderLanes = ({version, stored, note, stuck = () => {}, stallMs = STALL_MS}: {
    /** The song's version now. */
    version: () => Promise<number>
    /** Whether the store already holds this render. */
    stored: (id: string) => Promise<boolean>
    note: (what: RenderNote) => void
    /** A render that could not finish, after its readers were told. */
    stuck?: (error: RenderStuck) => void
    stallMs?: number
}) => {
    const asked = new Map<string, Render>() // every render not finished, waiting or running: what a second reader joins
    const waiting: Render[] = []
    const busy = {loop: false, artist: false, everybody: false}
    // The lane is the render's until it answers or this clock runs out, whichever is first: what it waited for may never answer.
    const watched = async (render: Render): Promise<void> => {
        const stop = new AbortController()
        const waits = new Set<string>()
        let clock: ReturnType<typeof setTimeout> | undefined
        const arm = () => {
            clearTimeout(clock)
            clock = setTimeout(() => stop.abort(new RenderStuck([...waits], Math.round(stallMs / 1000))), stallMs)
        }
        const stopped = new Promise<never>((_, fail) => stop.signal.addEventListener("abort", () => fail(stop.signal.reason), {once: true}))
        arm()
        try {
            await Promise.race([stopped, render.work({
                signal: stop.signal,
                waitedMs: Date.now() - render.asked,
                moved: arm,
                wait: what => {
                    waits.add(what)
                    arm()
                    return () => {
                        waits.delete(what)
                        arm()
                    }
                }
            })])
        } catch (error) {
            if (error instanceof RenderStuck) {queueMicrotask(() => stuck(error))}
            throw error
        } finally {
            clearTimeout(clock)
        }
    }
    const run = async (render: Render): Promise<void> => {
        if (await version() !== render.version) {
            note("dropped")
            throw new Superseded()
        }
        await watched(render)
    }
    const pump = (): void => {
        for (const lane of ["loop", "artist", "everybody"] as const) {
            if (busy[lane]) {continue}
            // the artist's first on every lane; the loop's lane takes loops alone, everybody's the rest in the order they asked
            const next = lane === "loop"
                ? waiting.find(render => render.loop && render.artist) ?? waiting.find(render => render.loop)
                : waiting.find(render => render.artist) ?? (lane === "everybody" ? waiting[0] : undefined)
            if (next === undefined) {continue}
            waiting.splice(waiting.indexOf(next), 1)
            busy[lane] = true
            run(next).then(next.answer.resolve, next.answer.reject).finally(() => {
                busy[lane] = false
                asked.delete(next.id)
                pump()
            })
        }
    }
    return {
        /** The render called `id`: the one running or waiting, the one the store holds, or `work`, once. `loop`: it renders a loop area. */
        once: (id: string, at: number, artist: boolean, work: (watch: RenderWatch) => Promise<void>, loop = false): Promise<void> => {
            const known = asked.get(id)
            if (known !== undefined) {
                note("shared")
                if (artist && !known.artist) {
                    known.artist = true
                    pump()
                }
                return known.answer.promise
            }
            const render: Render = {id, version: at, artist, loop, asked: Date.now(), work, answer: Promise.withResolvers<void>()}
            asked.set(id, render)
            stored(id).then(held => {
                if (held) {
                    note("stored")
                    asked.delete(id)
                    render.answer.resolve()
                    return
                }
                waiting.push(render)
                pump()
            }).catch(error => {
                asked.delete(id)
                render.answer.reject(error)
            })
            return render.answer.promise
        }
    }
}
