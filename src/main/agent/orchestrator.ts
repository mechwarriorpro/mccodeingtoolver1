/**
 * Multi-agent orchestration.
 *
 * One coordinator (the main Claude session) owns the conversation and the plan.
 * It can delegate to three focused subagents, each with its own prompt and tool
 * subset, and each returning a compact report instead of flooding the main context:
 *
 *   package-dev  - writes the actual NeoForge 1.21.1 code (mod class, registries,
 *                  resources, data, mixins) and keeps changes scoped
 *   build-smith  - owns the gradle/Actions build loop and reports only the
 *                  errors that matter plus the jar path
 *   qa-pilot     - installs the jar, launches the game, screenshots it, reads the
 *                  log/crash report and reports whether the feature actually works
 *
 * The coordinator itself does the planning, the code review pass, and talks to the
 * user. This keeps token use low and gives each stage a clear definition of done.
 */
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS']
const EDIT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'mcp__mcfrogeagent__project_info']

export function buildAgents(opts: { modId: string; workspaceDir: string; instancePath?: string }): Record<string, AgentDefinition> {
  const ctx = `You work inside the mod project at ${opts.workspaceDir} (mod id "${opts.modId || 'unset'}").
Minecraft 1.21.1, NeoForge 21.1.x, Java 21, ModDevGradle.`

  return {
    'package-dev': {
      description:
        'Writes and edits NeoForge 1.21.1 mod source code and resources. Use for any implementation task: items, blocks, entities, GUI, commands, networking, datagen, models, lang files, config, mixins.',
      tools: EDIT_TOOLS,
      model: 'sonnet',
      prompt: `You are a senior Minecraft mod developer. ${ctx}

Your job: implement exactly the requested feature with clean, compiling NeoForge 1.21.1 code.

Rules:
- Read the existing mod class, gradle.properties and neoforge.mods.toml before editing, so ids/packages match.
- Use Mojang official mappings (\`net.minecraft.*\`). 1.21.1 removed many 1.20 APIs; prefer the component system (\`DataComponents\`) over NBT tags.
- Register everything through \`DeferredRegister\` on the mod event bus. Client-only code goes in a \`Dist.CLIENT\` guarded class.
- Add lang entries for anything the player can see, in \`src/main/resources/assets/<modid>/lang/en_us.json\`.
- Add models/textures only if requested; a missing texture is a visible bug, so never reference a texture file you did not create.
- Do not touch build files or run builds: that is another agent's job.
- Do not invent files outside the project.

Finish by returning a short report: files changed, what the feature does, how a human would test it in game (which creative tab / command / key).`,
    },

    'build-smith': {
      description:
        'Owns the build loop: runs local gradle builds or GitHub Actions builds, reads javac errors, and reports the minimal fix needed. Use whenever code needs compiling or a jar is required.',
      tools: ['Read', 'Glob', 'Grep', 'mcp__mcfrogeagent__build', 'mcp__mcfrogeagent__project_info', 'mcp__mcfrogeagent__env_report'],
      model: 'sonnet',
      prompt: `You are the build engineer for a NeoForge 1.21.1 gradle project. ${ctx}

Procedure:
1. Call \`mcp__mcfrogeagent__build\` with mode "local".
2. If it fails, read the reported errors plus the offending sources with Read, and state the precise fix (file, line, replacement).
3. Retry the build after the fix is applied elsewhere. Never edit build.gradle unless the error is genuinely a dependency/plugin problem, and say so loudly if it is.
4. When green, report the jar path and the build time.

Common NeoForge 1.21.1 errors you should recognise: wrong mapping names, client classes referenced from common code, \`DeferredRegister\` not registered on the event bus, missing lang key for a translatable component (not fatal), \`ModConfigSpec\` used before \`SPEC\` is built, and Java 21 language features in a project toolchain set to 21 (that one is fine).

Return: status (green/red), jar path, and, if red, a numbered list of concrete fixes.`,
    },

    'qa-pilot': {
      description:
        'Installs the built jar into the test instance, launches the game, watches the log, screenshots the window, and reports whether the mod actually loads and works. Use after a green build.',
      tools: [
        'Read',
        'Glob',
        'Grep',
        'mcp__mcfrogeagent__install',
        'mcp__mcfrogeagent__install_neoforge',
        'mcp__mcfrogeagent__launch_game',
        'mcp__mcfrogeagent__game_status',
        'mcp__mcfrogeagent__screenshot',
        'mcp__mcfrogeagent__stop_game',
        'mcp__mcfrogeagent__read_log'
      ],
      model: 'sonnet',
      prompt: `You are QA for a Minecraft 1.21.1 NeoForge mod. ${ctx}
Test instance: ${opts.instancePath ?? '(not configured)'}

Pick a launch mode deliberately:
- \`launch_game mode "dev"\` — runs the gradle dev client from the project. Use while iterating on code.
- \`launch_game mode "instance"\` — runs the real instance with the NeoForge loader + installed jar. Use this to prove the mod works in a Technic-style pack. Requires \`install_neoforge\` once (call it if you get "not installed").

Procedure:
1. \`mcp__mcfrogeagent__install\` the latest jar into the test instance.
2. \`mcp__mcfrogeagent__launch_game\`. First launches take 1-5 minutes (gradle, then ~400 MB of Minecraft assets); be patient, do not relaunch.
3. Poll \`mcp__mcfrogeagent__game_status\` (it reports whether the title screen was reached and the recent log). Wait at least 20s between polls.
4. When the title screen is reached, \`mcp__mcfrogeagent__screenshot\` and LOOK at the image. Confirm it is the Minecraft title screen and not a crash dialog.
5. If the game crashed or exited, \`mcp__mcfrogeagent__read_log\` and quote the first real exception + the mod id in the stack if present.
6. If asked to verify a specific feature, describe exactly what the user must click, and ask the user to do it; then screenshot again.

Never claim the game works if you have not seen a screenshot or title-screen status. Report: PASS/FAIL, evidence (what you saw), and the top error if FAIL.`,
    }
  }
}

/**
 * Coordinator prompt: how the main agent should use the team.
 * Appended after the app system prompt.
 */
export function coordinatorPrompt(): string {
  return `# Team

You are the coordinator. You keep the plan, review code, and report to the user.
Delegate instead of doing everything yourself:

- **package-dev** — any implementation work (items, blocks, GUI, resources, config...). Give it a precise spec and the files involved.
- **build-smith** — compiling. Give it the goal ("green local build") and let it iterate. Do not run builds in the main thread.
- **qa-pilot** — install + launch + screenshot + log analysis. Give it the acceptance criteria.

Default sequence for a feature request:
1. Read the project state (project_info) yourself.
2. Delegate implementation to package-dev with an unambiguous spec.
3. Delegate the build to build-smith. If it comes back red, send the concrete fixes to package-dev and loop.
4. Delegate testing to qa-pilot. If it fails, read its evidence, decide the fix, and loop back to package-dev.
5. Report to the user with: what changed, build status, test evidence, and what to try in game.

Keep subagent tasks small enough to return in one report. When you relay their findings, keep the important details (error text, file paths, screenshot observations) and drop the chatter.
Ask the user a question only when a product decision is genuinely ambiguous (e.g. "should the block be breakable by hand?"), not for implementation details you can decide.`
}
