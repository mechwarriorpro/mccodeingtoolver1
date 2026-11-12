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
| GitHub sign-in | In-app OAuth device flow (`ABCD-1234` at github.com/login/device); no GitHub CLI required. A personal access token works too |
| GitHub build | Token-authenticated REST: commit → push → dispatch `build.yml` → poll the run → download the artifact |
| Technic install | Writes into `.technic/modpacks/<pack>/mods`; can export a Technic-spec pack zip |
| Loader install | Official NeoForge installer, headless: `--install-client <dir>` |
| Launch + test | `runClient` (dev) or direct Java launch of `neoforge-<ver>.json` (real instance) |
| Reference mods | Download any mod's release jar, decompile it with Vineflower, and let the agent read/grep it under `reference/`. Not compiled into your mod |
| Autonomy | **Review** (edits auto, shell asks), **Ask** (everything asks, agent asks you when unsure), **Auto** (unattended) |

---

## Requirements (on the Windows machine)

1. **JDK 21** — Temurin or Microsoft OpenJDK (`java -version` must say 21). Also runs the decompiler.
2. **Git** — <https://git-scm.com>. The app pushes with a stored token; Git itself must be installed.
3. An **Anthropic API key** (`sk-ant-…`)
4. **Node.js 20+** — only if you build from source; the installer bundles the runtime.

The **GitHub CLI is optional**. Sign in from inside the app instead: Settings → GitHub →
**Sign in with GitHub**, then type the shown code at <https://github.com/login/device>. The token is
kept in the app's user-data folder (not in the project, not in `.git/config`) and can be revoked from
Settings or from GitHub's settings at any time.

## Get the .exe

### Easiest: download the built installer

**[Latest release →](https://github.com/mechwarriorpro/mccodeingtoolver1/releases/latest)** — grab
`MC.Forge.Agent-Setup-<version>.exe` (~102 MB, unsigned).

> **Use v0.2.1 or newer.** v0.1.1 fixed a crash where 0.1.0 could not start
> (`ERR_REQUIRE_ESM`: the main process was CommonJS while the Claude Agent SDK is ESM-only).
> v0.2.0 adds in-app GitHub sign-in and the reference-mod decompiler.

The `Build Windows installer` workflow compiles it on a `windows-latest` runner, because
`electron-builder` must download the Electron binary (~115 MB) — from Electron's GitHub
release CDN, which some networks block. Every push also attaches a
`MC-Forge-Agent-windows` artifact to the Actions run.

### Build it yourself

```powershell
git clone https://github.com/mechwarriorpro/mccodeingtoolver1.git
cd mccodeingtoolver1
npm install
npm run dist:win          # compiles the app, then packages the NSIS installer
```

Output: `release/MC Forge Agent-Setup-<version>.exe`

`npm run dev` runs it without packaging. `npm run pack:win` is the same as `dist:win`.

If packaging fails with `Application entry file out\main\index.js is missing`, the app was not
compiled first — run `npm run build` (both scripts above already do).

### Cutting a new release

```powershell
git tag v0.1.1
git push origin v0.1.1
```

Bump `version` in `package.json` to match the tag first — the tag build stamps `package.json`
from the tag name too, and the final step fails the run if the published `.exe` name does not
contain the tag's version. The workflow builds on the tag, attaches the `.exe` to the GitHub
release, and verifies the asset exists before finishing.

## First run

1. **Settings → Model** — paste your API key. It stays in the main process; the renderer only ever
   sees a masked value.
2. **New mod** — pick a folder, name, mod id (e.g. `rubytools`), package (e.g. `com.you.rubytools`).
   That generates a real, buildable 1.21.1 project.
3. **Settings → Game** — `Scan Technic` finds your packs under `%APPDATA%\.technic\modpacks`, or
   `Add folder` for Prism/MultiMC/vanilla.
4. **Settings → GitHub** — **Sign in with GitHub** (a code appears; type it at
   github.com/login/device), then owner/repo/branch and `Create repo & push`.
5. Ask for a feature.

### Reference mods (read how other mods do it)

The **References** tab in the right rail turns another mod into reading material for the agent:

- **Add from GitHub releases** — paste `owner/repo`, pick a release and jar, press *Add & decompile*.
  The mod jar is chosen automatically (sources/javadoc/installer jars are skipped).
- **Add a jar from disk…** — for a mod you already downloaded.
- **Use as reference** copies the decompiled tree to `<project>/reference/<slug>/`, which is
  git-ignored and **not** compiled into your mod. The agent then gets `search_reference`,
  `list_reference_mods` and `reference_status`, and can search it like any other source.
- The **Search decompiled sources** box finds a symbol across every reference and opens the file.

Vineflower is downloaded once (~1.6 MB) into the app's data folder and verified against a pinned
SHA-256; Maven Central is used if GitHub's release CDN is blocked. Point Settings → Model → *Decompiler
jar* at CFR or another decompiler to use that instead.

Decompiled code belongs to whoever wrote it — check the licence shown next to each reference before
copying more than an API shape.

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
- GitHub builds need a Git install; the GitHub CLI is optional (the app signs in itself).

## Troubleshooting

### `UnsupportedClassVersionError … class file version 61.0 … up to 52.0`

A Java 8 is being used for the decompiler. Vineflower needs **Java 17+**, and a
Java 8 left in `JAVA_HOME` or on `PATH` (Technic's launcher ships one) fails before
it can decompile anything.

The app now version-checks every candidate by running `java -version` and skips
anything too old, so in most cases this fixes itself. Settings → Model shows
exactly which java is used for the game and which for the decompiler. If both say
"not found", install Temurin 21 (<https://adoptium.net>) and press **Check**.
`javaw.exe` is never used, because it prints nothing.
