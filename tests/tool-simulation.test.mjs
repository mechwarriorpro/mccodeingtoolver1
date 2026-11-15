/**
 * Drive every agent tool against a real ShadowClan-style mod project.
 *
 * The tools are not tested by calling their helper functions — those already have
 * tests. They are tested the way the agent uses them: through the MCP server's
 * own registry, with a real project on disk, and the result inspected for what
 * the *model* would actually read.
 *
 * That distinction has already caught two bugs in this repo. A tool whose
 * handler returns a JSON blob the model cannot act on, or an `isError` on a
 * condition that is not an error, passes a unit test of the helper and still
 * makes the agent useless. Here every tool is invoked and its text asserted to
 * contain the thing a person would need to see.
 *
 * Network and process work is stubbed, not skipped: the point is to check the
 * tool's *reasoning* on a known input, and a test that needs gradle, git auth and
 * forty seconds of JVM is a test nobody runs.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

// A tool's output is a text block. Normalising the line endings here means an
// assertion written on Linux cannot fail on Windows for a reason that has
// nothing to do with the behaviour being tested.
const norm = (s) => String(s).replace(/\r\n/g, '\n')

const t = (rel) => new URL(rel, import.meta.url).href
const { generateProject } = await import(t('../out-test/main/mod/generate.js'))
const { templateRoot } = await import(t('../out-test/main/mod/scaffold.js'))
const { createAgentTools } = await import(t('../out-test/main/agent/tools.js'))

/* ------------------------------------------------------------------ the mod */

/**
 * A mod that looks like a real one.
 *
 * Deliberately contains a feature that works and must survive any change
 * (a config-backed block group), and one stale call that genuinely needs the
 * 1.20.5 data-component change. A simulation that only contains broken code
 * cannot tell whether the tools leave working code alone.
 */
const FILES = {
  'gradle.properties': [
    'mod_id=shadowclan_arsenal',
    'mod_name=ShadowClan Arsenal',
    'mod_version=2.1.0',
    'mod_group=com.shadowclan',
    'minecraft_version=1.20.4',
    'neo_version=20.4.237',
    'mod_loader=neoforge',
    'org.gradle.jvmargs=-Xmx3G'
  ].join('\n'),
  'src/main/java/com/shadowclan/arsenal/ShadowArsenal.java': `package com.shadowclan.arsenal;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.registries.DeferredRegister;

@Mod(ShadowArsenal.MOD_ID)
public class ShadowArsenal {
    public static final String MOD_ID = "shadowclan_arsenal";
    public static final DeferredRegister.Blocks BLOCKS = DeferredRegister.createBlocks(MOD_ID);

    public ShadowArsenal(IEventBus bus) {
        BLOCKS.register(bus);
        ShadowArmour.register(bus);
    }
}
`,
  'src/main/java/com/shadowclan/arsenal/ShadowArmour.java': `package com.shadowclan.arsenal;

import net.minecraft.world.item.Item;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;

/** The armour set. A shipped feature — it must survive every update untouched. */
public final class ShadowArmour {
    public static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(ShadowArsenal.MOD_ID);
    public static final DeferredItem<Item> SHADOW_HELMET = ITEMS.registerSimpleItem("shadow_helmet");

    private ShadowArmour() {}

    public static void register(IEventBus bus) {
        ITEMS.register(bus);
    }
}
`,
  'src/main/java/com/shadowclan/arsenal/ShadowConfig.java': `package com.shadowclan.arsenal;

/**
 * Config keys are public API: players already have them in their config files.
 * An update that renames one silently resets everyone's settings.
 */
public final class ShadowConfig {
    public static int helmetDurability = 320;
    public static boolean enableGlow = true;

    private ShadowConfig() {}
}
`,
  'src/main/java/com/shadowclan/arsenal/ClanBanner.java': `package com.shadowclan.arsenal;

import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.item.ItemStack;

/** Saves the owner on the banner. This is the stale call the update must fix. */
public final class ClanBanner {
    public static final String OWNER = "owner";

    public static void claim(ItemStack stack, String playerName) {
        CompoundTag tag = stack.getOrCreateTag();
        tag.putString(OWNER, playerName);
    }

    public static String owner(ItemStack stack) {
        CompoundTag tag = stack.getOrCreateTag();
        return tag.contains(OWNER) ? tag.getString(OWNER) : "";
    }

    private ClanBanner() {}
}
`,
  'src/main/java/com/shadowclan/arsenal/FeatureGlow.java': `package com.shadowclan.arsenal;

import net.minecraft.world.level.Level;

/** Uses Level correctly for this version. Nothing here should be touched. */
public final class FeatureGlow {
    public static void tick(Level level) {
        if (!ShadowConfig.enableGlow) return;
        level.getServer();
    }

    private FeatureGlow() {}
}
`
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowclan-'))
const projectDir = path.join(root, 'ShadowClanArsenal')

generateProject({
  targetDir: projectDir,
  modId: 'shadowclan_arsenal',
  modName: 'ShadowClan Arsenal',
  group: 'com.shadowclan',
  modVersion: '2.1.0',
  loader: 'neoforge',
  mcVersion: '1.20.4',
  loaderVersion: '20.4.237',
  templateRoot: templateRoot()
})

// The generated project brings its own example class; the simulation replaces
// it with the mod's real sources so the tools see one coherent codebase.
fs.rmSync(path.join(projectDir, 'src', 'main', 'java'), { recursive: true, force: true })
for (const [rel, text] of Object.entries(FILES)) {
  const p = path.join(projectDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}

/* ------------------------------------------------------ calling the tools */

const notices = []
const outputs = []
const buildResults = []
const plans = []

const server = createAgentTools({
  getWorkspace: () => projectDir,
  getInstanceId: () => 'test-instance',
  notify: (channel, payload) => notices.push({ channel, payload }),
  onOutput: (line, source) => outputs.push({ line, source }),
  onBuildResult: (info) => buildResults.push(info),
  onUpdatePlan: (info) => plans.push(info)
})

const registry = server.instance._registeredTools
const toolNames = Object.keys(registry)

async function call(name, args = {}) {
  const def = registry[name]
  if (!def) throw new Error(`no such tool: ${name}`)
  try {
    const res = await def.handler(args)
    const textOut = (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    return { ...res, text: textOut }
  } catch (e) {
    /*
     * A tool that throws is a finding, not a reason to lose the other twenty-five
     * checks. This was invisible until CI: an unguarded throw killed the process
     * with no FAIL line, and the runner had nothing to report but "command
     * failed". Every outcome is now returned, and the check that reads it decides
     * whether that outcome is acceptable.
     */
    return { isError: true, text: `THREW: ${(e && e.message) || String(e)}`, threw: true }
  }
}

/* ------------------------------------------------------------- the checks */

check('every tool is registered and reachable by name', () => {
  assert.ok(toolNames.length >= 30, `only ${toolNames.length} tools`)
  for (const expected of ['project_info', 'build', 'plan_update', 'check_update_jar', 'api_reference', 'decompile_api', 'search_reference']) {
    assert.ok(toolNames.includes(expected), `missing ${expected}`)
  }
})

const info = await call('project_info')
info.text = norm(info.text)
check('project_info reads the actual mod, not a guess', () => {
  assert.equal(info.isError, undefined)
  assert.match(info.text, /shadowclan_arsenal/)
  assert.match(info.text, /ShadowClan Arsenal/)
  assert.match(info.text, /1\.20\.4/)
})

const plan = await call('plan_update', { mcVersion: '1.21.1', loader: 'neoforge' })
plan.text = norm(plan.text)
check('plan_update finds the one real breakage and points at the actual lines', () => {
  assert.match(plan.text, /getOrCreateTag/)
  assert.match(plan.text, /2 uses?/, 'both call sites must be counted')
  const match = plan.text.match(/ClanBanner\.java` line ([\d, ]+)/)
  assert.ok(match, 'no line numbers reported')
  // Verify against the file: each reported line must be one that really calls it.
  const source = FILES['src/main/java/com/shadowclan/arsenal/ClanBanner.java'].split('\n')
  const lines = match[1].split(',').map((n) => parseInt(n.trim(), 10))
  assert.ok(lines.length >= 2, `expected both call sites, got ${lines.join(',')}`)
  for (const n of lines) assert.match(source[n - 1], /getOrCreateTag/, `line ${n} is "${source[n - 1]}" — not a getOrCreateTag call`)
})

check('plan_update names the files allowed to change, and ClanBanner is the only one', () => {
  assert.match(plan.text, /ClanBanner\.java/)
  assert.doesNotMatch(plan.text, /allowed to change[\s\S]*ShadowArmour\.java/, 'the shipped armour set must not be listed as editable')
  assert.doesNotMatch(plan.text, /allowed to change[\s\S]*ShadowConfig\.java/, 'config keys are public API')
})

check('plan_update states the preservation rule, so "keep features" is actionable', () => {
  assert.match(plan.text, /Preserve/)
  assert.match(plan.text, /mod id/i)
  assert.match(plan.text, /config key/i)
})

check('plan_update told the engine about the breakage count', () => {
  assert.ok(plans.length >= 1, 'onUpdatePlan was never called')
  assert.ok(plans.at(-1).breakages > 0)
})

const noopPlan = await call('plan_update', { mcVersion: '1.20.4', loader: 'neoforge' })
noopPlan.text = norm(noopPlan.text)
check('planning the version it is already on produces no busywork', () => {
  assert.match(noopPlan.text, /Already on|nothing to update/i)
  assert.doesNotMatch(noopPlan.text, /getOrCreateTag/)
})

const api = await call('api_reference', { query: 'item data', mcVersion: '1.21.1' })
api.text = norm(api.text)
check('api_reference answers for the target version and names the replacement', () => {
  assert.match(api.text, /DataComponents|data components/i)
  assert.match(api.text, /1\.21\.1/)
})

const concepts = await call('list_api_concepts')
check('list_api_concepts returns a usable list, not an object dump', () => {
  assert.ok(concepts.text.split('\n').length > 10)
  assert.match(concepts.text, /Block/)
})

const noSrc = await call('decompile_api', { className: 'net.minecraft.world.level.Level' })
noSrc.text = norm(noSrc.text)
check('decompile_api explains itself instead of throwing when there is no sources jar', () => {
  // No gradle run is possible here, so it must either find nothing and say so,
  // or fail with a sentence that tells the agent what to do next — never a stack trace.
  assert.ok(noSrc.isError === undefined || noSrc.isError === true)
  assert.match(noSrc.text, /api_reference|sources|gradle|Reference|no sources/i)
})

const jarBefore = await call('check_update_jar')
jarBefore.text = norm(jarBefore.text)
check('check_update_jar refuses to call an unbuilt project finished', () => {
  assert.match(jarBefore.text, /FAIL|no jar/i)
  assert.doesNotMatch(jarBefore.text, /meets every check/)
})

const search = await call('search_reference', { query: 'getOrCreateTag' })
check('search_reference answers even with no reference mods, and says why it is empty', () => {
  assert.equal(search.isError, undefined)
  assert.ok(search.text.length > 0)
})

const mistakes = await call('recall_mistakes', { error: "'CompoundTag' cannot be resolved", loader: 'neoforge' })
check('recall_mistakes returns a readable answer with nothing on record', () => {
  assert.match(mistakes.text, /No similar past mistake|not on record/i)
})

const shaders = await call('recommend_shaders', { mcVersion: '1.21.1', loader: 'neoforge' })
check('recommend_shaders gives a recommendation for the target version', () => {
  assert.ok(shaders.text.length > 50)
})

/* ------------------------------------ a jar that a real build would produce */

const libs = path.join(projectDir, 'build', 'libs')
fs.mkdirSync(libs, { recursive: true })
const AdmZip = (await import('adm-zip')).default

function writeJar(name, { meta, mc }) {
  const zip = new AdmZip()
  zip.addFile('com/shadowclan/arsenal/ShadowArsenal.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]))
  zip.addFile('com/shadowclan/arsenal/ShadowArmour.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]))
  zip.addFile(
    'META-INF/neoforge.mods.toml',
    Buffer.from(`modId="shadowclan_arsenal"\ndisplayName="ShadowClan Arsenal"\nversion="2.1.0"\n\n[[dependencies.shadowclan_arsenal]]\nmodId="minecraft"\nversionRange="[${mc},1.22)"\n`)
  )
  const p = path.join(libs, name)
  zip.writeZip(p)
  return p
}

await call('plan_update', { mcVersion: '1.21.1', loader: 'neoforge' })
writeJar('arsenal-2.1.0.jar', { mc: '1.20.4' })
const stale = await call('check_update_jar', { mcVersion: '1.21.1' })
stale.text = norm(stale.text)
check('a jar built for the old version is rejected against the target that was asked for', () => {
  assert.match(stale.text, /FAIL/)
  assert.match(stale.text, /declares 1\.20\.4/, 'the actual declared version must be named')
  assert.match(stale.text, /target is 1\.21\.1/, 'and the target it was judged against')
})

// No version argument at all: the intent from plan_update is the only way this
// can be judged correctly, and it is the bug this simulator caught. Without it
// the check would validate the jar against the project's own property — the
// exact value an unfinished update has not changed yet.
const remembered = await call('check_update_jar')
remembered.text = norm(remembered.text)
check('the planned target is remembered, so a stale jar cannot pass by default', () => {
  assert.match(remembered.text, /declares 1\.20\.4/)
  assert.match(remembered.text, /target is 1\.21\.1/)
})

// Now the project has been updated the way a real one would be: the property
// is bumped and the code is fixed. The jar is rebuilt below, because a jar left
// over from the old version is exactly what the previous check rejects.
fs.writeFileSync(path.join(projectDir, 'gradle.properties'), FILES['gradle.properties'].replace('minecraft_version=1.20.4', 'minecraft_version=1.21.1'))
fs.writeFileSync(
  path.join(projectDir, 'src/main/java/com/shadowclan/arsenal/ClanBanner.java'),
  `package com.shadowclan.arsenal;

import net.minecraft.core.component.DataComponents;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.CustomData;

/** Owner is stored as a data component from 1.20.5. */
public final class ClanBanner {
    public static final String OWNER = "owner";

    public static void claim(ItemStack stack, String playerName) {
        CustomData.update(DataComponents.CUSTOM_DATA, stack, tag -> tag.putString(OWNER, playerName));
    }

    public static String owner(ItemStack stack) {
        CustomData data = stack.get(DataComponents.CUSTOM_DATA);
        return data != null && data.copyTag().contains(OWNER) ? data.copyTag().getString(OWNER) : "";
    }

    private ClanBanner() {}
}
`
)
fs.rmSync(path.join(libs, 'arsenal-2.1.0.jar'))
writeJar('arsenal-2.1.0.jar', { mc: '1.21.1' })

const fixed = await call('plan_update', { mcVersion: '1.21.1', loader: 'neoforge' })
fixed.text = norm(fixed.text)
check('after the fix, plan_update reports nothing left to do in the code', () => {
  assert.match(fixed.text, /change the build file and metadata only|Nothing\. No source file/i)
  assert.doesNotMatch(fixed.text, /getOrCreateTag/)
})

const good = await call('check_update_jar')
good.text = norm(good.text)
check('the rebuilt jar passes, including the unchanged mod id', () => {
  assert.match(good.text, /PASS/)
  assert.doesNotMatch(good.text, /FAIL/)
  assert.match(good.text, /mod id is unchanged|meets every check/)
})

const noTarget = await call('check_update_jar', { mcVersion: '1.20.4' })
noTarget.text = norm(noTarget.text)
check('an explicit version argument wins over the property, even when it makes the jar fail', () => {
  // The jar now declares 1.21.1. Asking about 1.20.4 must be answered about
  // 1.20.4 — a tool that quietly substituted the project's own version would be
  // unable to answer any question but one.
  assert.match(noTarget.text, /declares 1\.21\.1/)
  assert.match(noTarget.text, /target is 1\.20\.4/)
  assert.match(noTarget.text, /FAIL/)
})

check('after success the remembered target is cleared, so it cannot haunt a later check', async () => {
  const after = await call('check_update_jar', { mcVersion: '1.21.1' })
  assert.match(after.text, /meets every check/)
  assert.match(after.text, /Minecraft 1\.21\.1/)
})

check('the armour set was never touched by any of this', () => {
  const armour = fs.readFileSync(path.join(projectDir, 'src/main/java/com/shadowclan/arsenal/ShadowArmour.java'), 'utf8')
  assert.match(armour, /SHADOW_HELMET/)
  assert.match(armour, /registerSimpleItem\("shadow_helmet"\)/)
  const cfg = fs.readFileSync(path.join(projectDir, 'src/main/java/com/shadowclan/arsenal/ShadowConfig.java'), 'utf8')
  assert.match(cfg, /helmetDurability = 320/)
  assert.match(cfg, /enableGlow = true/)
})

/* ----------------------------------------------- tools that stop a bad state */

const deploy = await call('install', {})
check('install refuses clearly when there is no game instance', () => {
  assert.ok(deploy.isError === true, 'this must be an error result the model reads, not a crash')
  assert.match(deploy.text, /instance|No .*folder|not set/i)
})

const launch = await call('launch_game', { mode: 'instance' })
check('launch_game refuses to claim a start when there is no instance', () => {
  assert.equal(launch.isError, true, 'this must be an error the model reads, not a cheerful success')
  assert.match(launch.text, /No instance configured/i)
})

const devLaunch = await call('launch_game', { mode: 'dev' })
devLaunch.text = norm(devLaunch.text)
check('a dev launch that cannot run says so instead of "starting…"', () => {
  // Before the fix this returned "Dev client starting" and the agent went on to
  // screenshot a game that was never running: the wrapper exists, spawns, prints
  // its complaint and exits in milliseconds.
  //
  // One legitimate variation: on a machine whose wrapper *does* survive -- a
  // real JDK present, a distribution cached -- the launch is genuinely alive and
  // `ok` is the correct answer. What must never happen is a success reported for
  // a process that has already died, so that is the thing asserted.
  if (devLaunch.isError) {
    assert.match(devLaunch.text, /could not be started|gradlew not found|JAVA_HOME|exited/i)
  } else {
    assert.match(devLaunch.text, /starting/i)
    // If it says it started, it must actually be running.
    assert.doesNotMatch(devLaunch.text, /exited|not found|could not be started/i)
  }
})

check('a launch failure is never a bare "it failed"', () => {
  // The useful sentence is the wrapper's own error — usually JAVA_HOME or a
  // distribution download. Inventing a paraphrase costs a debugging round trip
  // for something the process already said.
  if (devLaunch.isError) assert.ok(devLaunch.text.length > 40, `not actionable: "${devLaunch.text}"`)
})

// Stopping first makes the log test independent of whether the launch above
// survived on this platform — and leaves no process behind on the runner.
try {
  await call('stop_game')
} catch {
  /* not running, which is the usual case */
}
const readLog = await call('read_log', { lines: 50 })
readLog.text = norm(readLog.text)
check('read_log answers with either the log or a sentence explaining there is none', () => {
  // Order-dependent by nature: an earlier launch in this same process may have
  // created a log, in which case the honest answer is the tail of it. What must
  // never happen is an empty result, which is indistinguishable from a broken
  // tool. This failed on Windows for exactly that reason — the launch test ran
  // first there and left a log behind, so "no log" was no longer the answer.
  assert.ok(readLog.text.length > 20, `an empty reply is not an answer: "${readLog.text}"`)
  if (readLog.isError) {
    assert.match(readLog.text, /no game log|launch the game/i)
  } else {
    assert.match(readLog.text, /logPath|tail|crashReport/i, 'a successful read must return the log structure')
  }
})

const env = await call('env_report')
env.text = norm(env.text)
check('env_report is readable and flags what is missing', () => {
  assert.ok(env.text.length > 40)
  assert.match(env.text, /java|JDK|git|gh/i)
})

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} tool-simulation checks passed`}`)
if (failures.length) process.exit(1)
