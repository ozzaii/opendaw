// ONE RENDER PER STATE OF A SONG, for every reader of it (BravohEngine.ts): make's numbers, the desk's mixdown, the
// bounce the artist plays. A render is named by the project's own bytes, which a program that changed nothing sends back
// exactly as the page holds them (measured 7 Nov on a 128-bar song), so all three are one render. 11-07: one version
// was rendered three times over, 51 s each, and a step of 404 s spent 296 of them in this queue.
//
// Two lanes, one render each: the artist's and everybody's. A press never waits for make's numbers, and make's numbers
// cost the artist nothing. No imports, so `bravoh/engine/renders.test.mjs` runs it in Node.

// external limit: under the host's 170 s for one call, leaving room for the render itself (51 s for 128 bars on the box)
const WAIT_MS = 100_000

export class Superseded extends Error {
    constructor() {super("The song changed while this render waited: read it again and render that.")}
}

export type RenderNote = "shared" | "stored" | "dropped"
type Render = { id: string, version: number, artist: boolean, asked: number, work: () => Promise<void>, answer: PromiseWithResolvers<void> }

export const renderLanes = ({version, stored, note, waitMs = WAIT_MS}: {
    /** The song's version now. */
    version: () => Promise<number>
    /** Whether the store already holds this render. */
    stored: (id: string) => Promise<boolean>
    note: (what: RenderNote) => void
    waitMs?: number
}) => {
    const asked = new Map<string, Render>() // every render not finished, waiting or running: what a second reader joins
    const waiting: Render[] = []
    const busy = {artist: false, everybody: false}
    const run = async (render: Render): Promise<void> => {
        if (await version() !== render.version) {
            note("dropped")
            throw new Superseded()
        }
        if (Date.now() - render.asked > waitMs) {throw new Error("Too many renders of this song are waiting: ask again in a moment.")}
        await render.work()
    }
    const pump = (): void => {
        for (const lane of ["artist", "everybody"] as const) {
            if (busy[lane]) {continue}
            // the artist's first on either lane; everybody's own lane takes the rest in the order they asked
            const next = waiting.find(render => render.artist) ?? (lane === "everybody" ? waiting[0] : undefined)
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
        /** The render called `id`: the one running or waiting, the one the store holds, or `work`, once. */
        once: (id: string, at: number, artist: boolean, work: () => Promise<void>): Promise<void> => {
            const known = asked.get(id)
            if (known !== undefined) {
                note("shared")
                if (artist && !known.artist) {
                    known.artist = true
                    pump()
                }
                return known.answer.promise
            }
            const render: Render = {id, version: at, artist, asked: Date.now(), work, answer: Promise.withResolvers<void>()}
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
