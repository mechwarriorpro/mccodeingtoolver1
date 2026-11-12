# MC Forge Agent

A desktop AI coding tool for **Minecraft 1.21.1 / NeoForge** mods. It is an external app (not a mod)
that can:

- **see the game** — captures the Minecraft window and feeds the screenshot to a vision model
- **write and edit mod code** — a Claude agent with file tools, scoped to your mod project
- **build the jar locally** — `./gradlew build` with your JDK 21
- **build the jar on GitHub** — commits, pushes, runs Actions, downloads the artifact
- **install into an instance** — Technic pack, Prism/MultiMC folder, or any game dir
- **relaunch and test** — dev client or a real NeoForge client, log watching, crash reports, screenshots

Built on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), so it uses your Claude Code
setup and API key.

---

## What it actually does

| Capability | How |
|---|---|
| New mod project | Vendors the official **NeoForge 1.21.1 ModDevGradle MDK**; rewrites mod id, package, author, version and generates a compiling mod class, config and lang file |
| Code changes | Claude Code file tools (`Read/Write/Edit/Grep/Glob`) with a ModForge-specific system prompt |
| Multi-agent | Coordinator delegates to `package-dev`, `build-smith`, and `qa-pilot` subagents |
| Vision | `screenshot` tool grabs the Minecraft window (PowerShell/`user32` on Windows) and returns a PNG to the model |
| Local build | `gradlew build --console=plain`; javac errors are parsed out and fed back |
| GitHub build | `gh` CLI: commit → push → `gh workflow run` → `gh run watch` → `gh run download` |
| Technic install | Writes into `.technic/modpacks/<pack>/mods`; can export a Technic-spec pack zip |
| Loader install | Official NeoForge installer, headless: `--install-client <dir>` |
| Launch + test | `runClient` (dev) or direct Java launch of `neoforge-<ver>.json` (real instance) |
| Autonomy | **Review** (edits auto, shell asks), **Ask** (everything asks, agent asks you when unsure), **Auto** (unattended) |

---

## Requirements (on the Windows machine)

1. **Node.js 20+** (build only)
2. **JDK 21** — Temurin or Microsoft OpenJDK (`java -version` must say 21)
3. **GitHub CLI** — install from <https://cli.github.com>, then `gh auth login`
4. An **Anthropic API key** (`sk-ant-…`)

## Build the .exe

```powershell
git clone <this repo>
cd mccodeingtoolver1
npm install
npm run dist:win
```

Output: `release/MC Forge Agent-Setup-0.1.0.exe`

`npm run dev` runs it without packaging (needs the Electron binary, which `npm install` fetches).

## First run

1. **Settings → Model** — paste your API key. It stays in the main process; the renderer only ever
   sees a masked value.
2. **New mod** — pick a folder, name, mod id (e.g. `rubytools`), package (e.g. `com.you.rubytools`).
   That generates a real, buildable 1.21.1 project.
3. **Settings → Game** — `Scan Technic` finds your packs under `%APPDATA%\.technic\modpacks`, or
   `Add folder` for Prism/MultiMC/vanilla.
4. **Settings → GitHub** — owner/repo/branch, then `Create repo & push`.
5. Ask for a feature.

---

## The Permission model — three modes

| Mode | File edits | Shell / build | When to use |
|---|---|---|---|
| **Review** (default) | auto | auto for read-only, asks for the rest | watch the diffs, approve risky commands |
| **Ask** | auto | **always asks** | you want to approve every step, and the agent stops to ask you when a design decision is unclear |
| **Auto** | auto | auto | long unattended runs (budget cap applies) |

`Ask` is the mode you asked for: the agent proceeds on things it is sure about and raises a question
only when it is genuinely unsure. In `Review`/`Ask` the app shows an approval dialog with the exact tool
input before anything runs.

Budget: `Settings → Model → Per-run budget` stops a runaway run (default $5).

---

## Technic: how 1.21.1 actually works

Technic's classic `bin/modpack.jar` slot only loads **Forge up to 1.12.2**. For 1.21.1 NeoForge packs,
Technic installs the loader from the platform pack settings, and the pack folder is a normal game dir.

So the app does this instead:

1. `Install NeoForge` writes the loader into `<instance>/.minecraft` using the official installer.
2. `Install jar` puts your built jar in `<instance>/mods`.
3. `Launch instance` starts `neoforge-<ver>` directly with Java — no launcher needed — so the agent
   can actually run and screenshot the pack.
4. `Export Technic pack` produces a zip with `mods/`, `config/` and a `README-plan.txt` describing the
   loader version, ready to upload as a platform pack build.

---

## Project layout

```
src/main/
  agent/
    engine.ts        Claude Agent SDK session, permissions, streaming
    orchestrator.ts  coordinator + package-dev / build-smith / qa-pilot subagents
    prompt.ts        ModForge system prompt (NeoForge 1.21.1 rules)
    tools.ts         in-process MCP tools: project_info, build, install, launch, screenshot, ...
  build/
    gradle.ts        local gradlew build, javac error extraction
    actions.ts       GitHub commit/push/workflow/artifact pipeline
  game/
    neoforge.ts      official installer (--install-client), loader status
    client.ts        direct NeoForge launch (version json, assets, libraries)
    mojang.ts        vanilla 1.21.1 metadata, asset and library downloads
    launcher.ts      gradle runClient, log watching, title-screen detection
    capture.ts       window screenshots (PowerShell/user32, screencapture, ImageMagick)
    technic.ts       Technic instance discovery and pack export
  mod/
    scaffold.ts      NeoForge 1.21.1 project generator
    jar.ts           jar metadata (neoforge.mods.toml) and mods-folder install
template/neoforge-1.21.1/   vendored official MDK
tests/                      offline tests for scaffold, build parsing, jar install
```

## Tests

```bash
npm test          # scaffold + build parsing + jar install (no JDK needed)
npm run typecheck # main + renderer
```

The generated Java is also parsed with a Java grammar in CI-style checks; the generated project uses
the unmodified official MDK build script, so it compiles with `./gradlew build`.

## Notes & limits

- The app needs the Electron binary to run; if `npm install` cannot download it (offline / blocked
  CDN), building the installer fails even though the code is fine.
- Direct client launch expects a legitimate Minecraft 1.21.1 install (it downloads the official
  client jar and assets on first run, ~400 MB).
- Screenshots on Windows use `PrintWindow` via PowerShell; if Minecraft is fullscreen-exclusive,
  switch to windowed/borderless in the app settings.
- `gh` must be on `PATH` for GitHub builds.
