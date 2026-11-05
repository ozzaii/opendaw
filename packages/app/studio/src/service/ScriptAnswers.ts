import {Arrays, DefaultObservableValue, int, Option} from "@opendaw/lib-std"
import {applyUpdateTasks, UpdateTask} from "@opendaw/lib-box"
import {AudioData} from "@opendaw/lib-dsp"
import {BoxIO} from "@opendaw/studio-boxes"
import {MixdownSection, OfflineEngineRenderer, Project, ProjectEnv} from "@opendaw/studio-core"

// The studio's own answers to a script's host calls (ScriptHostProtocol), shared by the code editor and any other
// host of a script (BRAVOH's engine page): the edit behind its checksum guard, and the offline mixdown of the bytes.
export namespace ScriptAnswers {
    // whether the project is still the one the script read
    export const isCurrent = (project: Project, checksum: Int8Array): boolean =>
        Arrays.equals(project.boxGraph.checksum(), checksum)

    // false, and nothing applied, when the project changed since the script read it
    export const applyUpdates = (project: Project,
                                 updates: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>,
                                 checksum: Int8Array): boolean => {
        if (!isCurrent(project, checksum)) {return false}
        project.editing.modify(() => applyUpdateTasks(project.boxGraph, updates))
        return true
    }

    // On a copy of its own, so the live project and its engine are never touched. Without a section, the whole song.
    export const renderMixdown = async (env: ProjectEnv, buffer: ArrayBufferLike, sampleRate: int = 48_000, {section, progress, abortSignal}: {
        section?: MixdownSection, progress?: DefaultObservableValue<number>, abortSignal?: AbortSignal
    } = {}): Promise<AudioData> => {
        const project = Project.load(env, buffer as ArrayBuffer)
        progress ??= new DefaultObservableValue(0.0)
        try {
            return await (section === undefined
                ? OfflineEngineRenderer.start(project, Option.None, progress, abortSignal, sampleRate)
                : OfflineEngineRenderer.renderSection(project, Option.None, section, progress, abortSignal, sampleRate))
        } finally {
            project.terminate()
        }
    }
}
