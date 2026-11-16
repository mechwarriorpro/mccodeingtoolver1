import fs from 'node:fs'
import path from 'node:path'
import { userDataDir } from '../config'
import { recall } from '../learn'
import type { AppConfig } from '../../shared/types'

/**
 * The three modes, and what each one changes about a run.
 *
 * All three exist to stop one failure mode: the app knowing something and not
 * using it. AutoSwitch keeps a turn alive; Learning turns study into lessons;
 * Deep Research spends the strongest model to make lessons a weak model can
 * follow. The last two meet in the same store, which is why they live here
 * together — a lesson written by Deep Research is recalled by whatever model is
 * coding next, including a free one on its third switch of the turn.
 */

export type RunMode = 'code' | 'learn' | 'research'

export function runMode(cfg: AppConfig): RunMode {
  // Research outranks learning: when both are on the user is asking for the
  // expensive, exhaustive version, and silently doing the cheap one would be the
  // wrong answer to a deliberate request.
  if (cfg.deepResearch) return 'research'
  if (cfg.learningMode) return 'learn'
  return 'code'
}

/* ------------------------------------------------------------- the research topic */

export interface ResearchState {
  topic: string
  startedAt: number
  /** Files written, so a run that dies can be resumed rather than repeated. */
  notes: { file: string; title: string; updatedAt: number }[]
  /** The model that produced the notes, for the "made by" line. */
  model: string
}

function stateFile(): string {
  return path.join(userDataDir(), 'research.json')
}

export function loadResearch(): ResearchState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as ResearchState
    return raw && typeof raw.topic === 'string' ? raw : null
  } catch {
    return null
  }
}

export function saveResearch(state: ResearchState | null): void {
  try {
    if (!state) {
      fs.rmSync(stateFile(), { force: true })
      return
    }
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    /* the state is a convenience; a read-only profile must not break the turn */
  }
}

/** Where a research run writes what it learned. Inside the project, so it ships with it. */
export function researchDir(workspaceDir: string): string {
  return path.join(workspaceDir || process.cwd(), 'docs', 'research')
}

/* ------------------------------------------------------------------ the prompts */

/**
 * Learning mode: study, do not code.
 *
 * The point of the restriction is that an agent asked to "learn about X" will
 * otherwise start implementing X halfway through, produce a half-finished mod and
 * a thin set of notes. Forbidding edits makes the output usable by the next run.
 */
export function learningPrompt(projectSummary: string): string {
  return `# Learning mode

You are in **learning mode**. The goal of this run is understanding, not code. Nothing you write to a source file
will be kept — so do not write to source files at all.

## What to do

1. Work out what the user actually needs to understand. If the request is vague ("learn about items"), narrow it to
   the specific thing this project needs: *how items are registered and given a model in this Minecraft version*.
2. Go and find out. Use \`search_reference\`, \`read_reference_file\` and \`list_reference_mods\` to read how real mods
   solved it — decompiled reference mods are the most reliable source there is, and they are already on disk.
   Use WebSearch/WebFetch for documentation and changelogs where the local sources are silent.
3. Write the findings down as **lessons**, using \`save_lesson\`. One lesson per fact that would change what a model
   does next time. A lesson is only useful if a model can act on it without rereading your sources:
   - **rule** — the fact, in one sentence, in the imperative. "Register items with DeferredRegister.create(ITEMS, MODID)."
   - **fix** — exactly what to do instead of the wrong thing. Include the code shape.
   - **avoid** — the mistake this prevents. "Do not call new Item() — it is not the registration path any more."
4. Finish with a short summary: what you learned, what you could not confirm, and which lesson ids you wrote.

## Rules

- **Do not modify the project.** No edits to Java, Gradle, JSON or assets. Reading is the whole job.
- Say plainly when something is uncertain or version-dependent. A confident wrong lesson is worse than no lesson,
  because the next model will follow it.
- Prefer facts that are checkable against a decompiled mod over facts that come from memory.
- Do not duplicate a lesson that already exists — recall it first (\`recall_lessons\`) and extend it with \`save_lesson\`
  only if you can make it more accurate.

${projectSummary}`
}

/**
 * Deep research: the strongest model, writing notes a weaker one can follow.
 *
 * The audience is explicitly *not* the user. It is the next model — one that is
 * smaller, faster and cheaper, and that has to produce working code from these
 * notes without doing the research itself. That changes what a good note is:
 * concrete, ordered, and with the failure modes spelled out.
 */
export function researchPrompt(topic: string, projectSummary: string): string {
  return `# Deep research mode

You are doing **deep research** on: **${topic}**

You are running on the strongest model available because the result of this run is not code — it is the set of notes
that a *less capable* model will use to write the code later, without doing any research of its own.

## Who you are writing for

The reader is a smaller, cheaper model — possibly a free one — with the same tools and none of your judgement. It will
read your notes and then edit files directly. So every note must survive being followed literally by something that
cannot fill a gap you left.

That means:

- **Concrete beats correct.** Give the actual import, the actual method signature, the actual file path. "Use the
  registry API" is useless to the reader; \`DeferredRegister.Items ITEMS = DeferredRegister.createItems(MODID)\` is not.
- **Order matters.** Give the steps in the order they must be done, and say which step breaks the build if skipped.
- **Name the traps.** Every API has a wrong way that looks right. Say what the compiler error looks like, so the reader
  can recognise it rather than guess.
- **Version-bound facts must be labelled** with the Minecraft version and loader they apply to. The reader may be on a
  different one and must know that before trusting you.

## What to do

1. Read the project first (\`project_info\`, \`read_file\`) so the notes match its packages, mod id and version.
2. Research it properly: decompiled reference mods via \`search_reference\` / \`read_reference_file\`, then the web for
   docs and changelogs. Verify against the references — a real mod that compiles beats a tutorial.
3. Write the notes to \`docs/research/<slug>.md\` with \`write_file\`. Structure:
   - **What this is** — two sentences.
   - **The exact code** — a complete, compiling snippet with imports.
   - **Step by step** — numbered, with the file each step touches.
   - **Traps** — wrong approach → the error it produces → the right approach.
   - **Version notes** — what differs by version, if anything.
   - **Sources** — the reference mods and URLs you actually used.
4. Distil it into lessons with \`save_lesson\` — one per trap or non-obvious step. These are what the weaker model will
   actually see first; the notes are the detail behind them.
5. Do **not** change the project's source. The deliverable is the notes.

## Honesty

Where you could not confirm something, write "unconfirmed" next to it rather than smoothing it over. A reader that
knows a fact is shaky can go and check it; one that is told everything is certain will not.

${projectSummary}`
}

/** A quick project digest for the mode prompts, without pulling in the whole agent. */
export function briefProject(opts: { dir: string; loader: string; mcVersion: string; modId: string }): string {
  return `## The project

- Directory: \`${opts.dir || '(none open)'}\`
- Loader / version: ${opts.loader || 'unknown'} ${opts.mcVersion || ''}
- Mod id: \`${opts.modId || 'unknown'}\``
}

/** How many lessons a mode is expected to be able to recall, for the UI hint. */
export function recallPreview(query: string): number {
  try {
    return recall(query, { limit: 8 }).length
  } catch {
    return 0
  }
}
