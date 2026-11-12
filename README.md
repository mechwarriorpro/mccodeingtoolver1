# MC Forge Agent

A desktop AI coding tool for **Fabric, Forge and NeoForge** mods, for **Minecraft 1.2.5 through
the latest release**. It is an external app (not a mod) that can:

- **see the game** — captures the Minecraft window and feeds the screenshot to a vision model
- **record and analyse gameplay** — a clip of up to 30 seconds, then a vision model explains what happened on screen
- **write and edit mod code** — a Claude agent with file tools, scoped to your mod project
- **build the jar locally** — `./gradlew build` with the JDK your version needs
- **build the jar on GitHub** — commits, pushes, runs Actions, downloads the artifact
- **install into an instance** — Technic pack, Prism/MultiMC folder, or any game dir
- **relaunch and test** — dev client or a real client, log watching, crash reports, screenshots
- **learn from its mistakes** — every build error is fingerprinted, and repeats come back with the fix that worked

Built on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), so it uses your Claude Code
setup and API key.

---

## What it actually does

| Capability | How |
|---|---|
| New mod project | Pick **Fabric / Forge / NeoForge** and any Minecraft version from **1.2.5 up**. Uses the vendored official NeoForge 1.21.1 MDK when it matches; otherwise generates the build files for that version's toolchain (Loom, ModDevGradle, ForgeGradle 6/5/3/2) with the right Java level, metadata file and starter source |
| Version catalog | Live from Mojang, Fabric, NeoForge and Forge, cached for 24 h. New Minecraft versions appear without an app update. Refresh from the New Project dialog |
| Auto-update | The installed app checks this repo's GitHub releases, downloads in the background and installs on restart. Settings → Updates |
| Edit a reference mod | Turn a decompiled reference into a real buildable Gradle project ("Make editable copy"), edit it in-app, and let the agent build/run it. Forks live outside your project and never compile into your jar |
| Gameplay clips | Record up to 30 s of gameplay as frames, then a vision model reports what happened, what looks broken (pink textures, missing lang keys, bad models, crashes) and which resource/code to fix. The agent can record and analyse clips itself |
| Lessons | Build errors and crashes are fingerprinted (file names, line numbers and paths are stripped, so the same mistake in another class matches). Repeats are recalled before the agent guesses, and the best are injected into its prompt. Editable and deletable in the Lessons tab |
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

1. **A JDK** — Temurin or Microsoft OpenJDK. **21** for Minecraft 1.20.5+, **17** for 1.18–1.20.4, **8** for older
   versions. The app probes the version and picks the right one; the decompiler needs 17+.
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

> **Use v0.3.0 or newer.** v0.1.1 fixed a crash where 0.1.0 could not start
> (`ERR_REQUIRE_ESM`: the main process was CommonJS while the Claude Agent SDK is ESM-only).
> v0.2.0 added in-app GitHub sign-in and the reference-mod decompiler; v0.2.1 fixed the
> decompiler picking a Java it could not run.
> **v0.3.0** adds Fabric/Forge/NeoForge and Minecraft 1.2.5→latest, self-update, editable
> reference forks, 30-second gameplay clips with vision analysis, and lessons from past errors.
>
> From 0.3.0 on, the app updates itself: once you have it installed, new versions arrive
> through GitHub releases without downloading the installer again.

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

1. **Settings → Model** — choose a provider and paste its key. It stays in the main process; the
   renderer only ever sees a masked value. **You do not need to pay to try this** — see
   [Free models](#free-models-no-card-needed) below.
2. **New project** — pick a loader (Fabric, Forge or NeoForge), a Minecraft version (1.2.5 → latest;
   the list is refreshed from Mojang, Fabric and Forge), then a folder, name, mod id (e.g. `rubytools`)
   and package (e.g. `com.you.rubytools`). That generates a real, buildable project for that version.
3. **Settings → Game** — `Scan Technic` finds your packs under `%APPDATA%\.technic\modpacks`, or
   `Add folder` for Prism/MultiMC/vanilla.
4. **Settings → GitHub** — **Sign in with GitHub** (a code appears; type it at
   github.com/login/device), then owner/repo/branch and `Create repo & push`.
5. Ask for a feature.

### Free models (no card needed)

The agent is a client for the **Anthropic Messages API**, not for Anthropic's servers. Anywhere that
speaks that protocol works, so Settings → Model can point the same agent at free models. The tools,
the build loop and the screenshots all behave identically; only the model behind them changes.

| Provider | Model to start with | Cost | Needs a card? |
| --- | --- | --- | --- |
| **Z.ai** | `glm-4.7-flash` | free tier | no |
| **OpenRouter** | `qwen/qwen3-coder:free` (coding) or `nvidia/nemotron-3.5-super-vl:free` (vision) | free tier | no |
| **Ollama** | `qwen3-coder` | free forever, local | no — no account at all |
| Anthropic | Claude Sonnet 4.5 | paid | yes |

- **Refresh free models** asks OpenRouter for its current `:free` roster, because that list rotates.
  **Test connection** does a real round trip, so a bad key fails in Settings rather than mid-edit.
- Each model is labelled with what it can do. A model **without tool calling cannot edit files** — the
  app says so instead of letting a run fail halfway. **Vision** is only needed for clips and screenshots.
- Vision has its own picker: keep a free vision model for clip analysis while the agent writes code
  with something else.
- Free tiers are rate limited. OpenRouter is roughly **20 requests/minute and 50/day**, which a long
  build-fix loop can exhaust; the app reports 429s plainly. Z.ai's Flash models are free but throttled.
  Ollama has no limits at all, but quality depends on your hardware and the model you pull.
- The Anthropic key path is untouched. Switching back to Anthropic restores the original behaviour, and
  a key belonging to one provider is never sent to another (the agent clears `ANTHROPIC_API_KEY` for
  third parties and uses a bearer token instead).

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
    prompt.ts        system prompt, with per-loader/per-version rules and the learned lessons
    tools.ts         in-process MCP tools: project_info, build, install, launch, screenshot, clip, lessons, ...
  build/
    gradle.ts        local gradlew build, javac error extraction
    actions.ts       GitHub commit/push/workflow/artifact pipeline
  game/
    neoforge.ts      official installer (--install-client), loader status
    client.ts        direct NeoForge launch (version json, assets, libraries)
    mojang.ts        vanilla metadata, asset and library downloads
    launcher.ts      gradle runClient, log watching, title-screen detection
    capture.ts       window screenshots (PowerShell/user32, screencapture, ImageMagick)
    clip.ts          30 s gameplay frame recorder + vision analysis
    technic.ts       Technic instance discovery and pack export
  mod/
    generate.ts      project generator for any loader/version (delegates per era)
    scaffold.ts      vendored-template helpers, mod id/package validation
    fork.ts          turns a decompiled reference mod into an editable project
    jar.ts           jar metadata (neoforge.mods.toml) and mods-folder install
  versions/
    catalog.ts       live Minecraft/loader version catalog (24 h cache, offline fallbacks)
    eras.ts          per-era build files, metadata, Java level and starter source
  update.ts          electron-updater wiring for GitHub releases
  learn.ts           mistake fingerprints, lessons and the error index
template/neoforge-1.21.1/   vendored official MDK
tests/                      offline tests for scaffold, build parsing, jar install
```

## Tests

```bash
npm test          # version catalog, project generation, clips, lessons, scaffold, build parsing (no JDK needed)
npm run typecheck # main + renderer
```

New projects for 1.21.1 NeoForge use the unmodified official MDK build script. Every other
combination gets a generated build file for its era, which the tests check for the right plugin,
Java level, loader version property and metadata file.

## Live chat

The conversation updates as it happens: your message appears the moment you press send, the reply
streams token by token, tool calls and their results appear inline, and the last few build or game
log lines are shown under the reply while a build runs. Nothing needs a refresh, and nothing is lost
if a stream is interrupted — the app writes each completed block to the stored message, so the final
transcript is complete even when the live text was cut short.

## Notes & limits

- The app needs the Electron binary to run; if `npm install` cannot download it (offline / blocked
  CDN), building the installer fails even though the code is fine.
- **Direct client launch is 1.21.1 NeoForge only.** Other versions build and install fine (the jar
  works in a normal launcher), but the built-in launcher and loader installer still target 1.21.1.
  Use `runClient` from the Build tab, or your own launcher, for other versions.
- **1.7 and older have no Gradle build.** The New Project dialog still generates the project (with
  the right `mcmod.info`/FML layout) so you can write and read code, but it is marked *reference
  only* and the app will not promise a build for it.
- A generated project is only as good as the era table: a brand-new Minecraft version that changes
  the build toolchain again will be generated with the closest known era until the app updates.
  Both the version list and the app itself update without a reinstall.
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
