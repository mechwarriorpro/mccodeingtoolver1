/**
 * Updating an outdated mod without breaking it.
 *
 * The two ways this goes wrong are opposite and equally common: doing too much
 * (rewriting features that were fine) and doing too little (bumping a version
 * number and claiming it ported). Both come from treating every crossed version
 * boundary as if it changed everything, so the tests are mostly about what the
 * plan decides to leave alone.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'

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

const out = new URL('../out-test/main/mod/update-plan.js', import.meta.url).href
const up = await import(out)

const file = (rel, text) => ({ rel, text })

/* ------------------------------------------------------------ version math */

check('1.10 is newer than 1.9, which string comparison gets wrong', () => {
  assert.equal(up.compareVersions('1.10', '1.9'), 1)
  assert.equal(up.compareVersions('1.21.1', '1.21.1'), 0)
  assert.equal(up.compareVersions('1.20.4', '1.21'), -1)
})

/* ------------------------------------------------------- which boundaries */

check('a patch bump inside one era crosses no boundaries at all', () => {
  const b = up.crossedBoundaries({ mcVersion: '1.21.1', loader: 'neoforge' }, { mcVersion: '1.21.4', loader: 'neoforge' })
  assert.deepEqual(b, [], 'nothing changed between these that can break a mod')
})

check('1.20.4 → 1.20.5 crosses the data-component cliff', () => {
  const b = up.crossedBoundaries({ mcVersion: '1.20.4', loader: 'neoforge' }, { mcVersion: '1.20.5', loader: 'neoforge' })
  assert.ok(b.some((x) => x.id === 'data-components-1.20.5'))
  assert.ok(b.some((x) => x.id === 'java-21'), 'and drags Java 21 with it')
})

check('1.16.5 → 1.17 crosses the naming change', () => {
  const b = up.crossedBoundaries({ mcVersion: '1.16.5', loader: 'forge' }, { mcVersion: '1.17', loader: 'forge' })
  assert.ok(b.some((x) => x.id === 'mcp-to-mojmap'))
})

check('a long jump reports every boundary it spans', () => {
  const b = up.crossedBoundaries({ mcVersion: '1.12.2', loader: 'forge' }, { mcVersion: '1.21.1', loader: 'neoforge' })
  const ids = b.map((x) => x.id)
  for (const expected of ['legacy-to-flattening', 'mcp-to-mojmap', 'registry-events-1.19.3', 'data-components-1.20.5', 'java-21']) {
    assert.ok(ids.includes(expected), `missing ${expected}`)
  }
})

check('crossing a boundary backwards still names it, and the plan says downgrade', () => {
  const plan = up.planUpdate({ from: { mcVersion: '1.21.1', loader: 'neoforge' }, to: { mcVersion: '1.16.5', loader: 'neoforge' }, files: [] })
  assert.equal(plan.downgrade, true)
  assert.match(plan.summary, /older than|reverse/i)
})

/* --------------------------------------- the point: features are preserved */

const CLEAN_MOD = [
  file('com/x/SmallMod.java', `
package com.x;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.item.Item;
public class SmallMod {
  public void register() { /* adds a block and three items */ }
}`),
  file('com/x/Feature.java', `
package com.x;
import net.minecraft.world.level.Level;
public class Feature {
  public void tick(Level level) { level.getServer(); }
}`)
]

check('a mod that does not use anything removed is told to change only the build', () => {
  const plan = up.planUpdate({
    from: { mcVersion: '1.21.1', loader: 'neoforge' },
    to: { mcVersion: '1.21.4', loader: 'neoforge' },
    files: CLEAN_MOD
  })
  assert.equal(plan.breaking.length, 0)
  assert.equal(plan.buildOnly, true)
  assert.equal(plan.filesTouched.length, 0, 'no source file should be opened')
  assert.match(plan.summary, /leave the mod alone/i)
})

check('the plan always states what must be preserved, in concrete terms', () => {
  const plan = up.planUpdate({ from: { mcVersion: '1.20.1', loader: 'forge' }, to: { mcVersion: '1.21.1', loader: 'neoforge' }, files: CLEAN_MOD })
  const text = plan.preserve.join(' ')
  assert.match(text, /[Ee]very feature/)
  assert.match(text, /mod id/i)
  assert.match(text, /reformat/i, 'formatting churn is a real way to lose a diff')
})

check('an already-current project is not given busywork', () => {
  const plan = up.planUpdate({ from: { mcVersion: '1.21.1', loader: 'neoforge' }, to: { mcVersion: '1.21.1', loader: 'neoforge' }, files: CLEAN_MOD })
  assert.equal(plan.upToDate, true)
  assert.equal(plan.boundaries.length, 0)
  assert.equal(plan.mechanical.length, 0)
})

/* ------------------------------------------- finding the real work, only */

check('getOrCreateTag is found when 1.20.5 is crossed', () => {
  const files = [...CLEAN_MOD, file('com/x/Data.java', `
package com.x;
public class Data {
  void save(ItemStack stack) {
    stack.getOrCreateTag().putString("owner", "steve");
  }
}`)]
  const plan = up.planUpdate({ from: { mcVersion: '1.20.4', loader: 'neoforge' }, to: { mcVersion: '1.20.5', loader: 'neoforge' }, files })
  const hit = plan.breaking.find((b) => b.symbol.includes('getOrCreateTag'))
  assert.ok(hit, 'the removed method has to be found')
  assert.equal(hit.files[0].rel, 'com/x/Data.java')
  assert.deepEqual(hit.files[0].lines, [5], 'and located precisely, not just named')
  assert.deepEqual(plan.filesTouched, ['com/x/Data.java'], 'only the file with the problem')
})

check('the same call is left alone when 1.20.5 is not crossed', () => {
  const files = [file('com/x/Data.java', 'class Data { void s(ItemStack st) { st.getOrCreateTag(); } }')]
  const plan = up.planUpdate({ from: { mcVersion: '1.20.1', loader: 'forge' }, to: { mcVersion: '1.20.4', loader: 'forge' }, files })
  assert.deepEqual(plan.breaking, [], '1.20.4 still has getOrCreateTag — flagging it would be a false positive')
  assert.equal(plan.buildOnly, true)
})

check('World is flagged only across the naming boundary', () => {
  const files = [file('com/x/W.java', 'import net.minecraft.world.World;\nclass W { World world; }')]
  const crosses = up.planUpdate({ from: { mcVersion: '1.16.5', loader: 'forge' }, to: { mcVersion: '1.17', loader: 'forge' }, files })
  assert.ok(crosses.breaking.some((b) => b.symbol === 'World'))
  const doesNot = up.planUpdate({ from: { mcVersion: '1.21.1', loader: 'neoforge' }, to: { mcVersion: '1.21.4', loader: 'neoforge' }, files })
  assert.ok(!doesNot.breaking.some((b) => b.symbol === 'World'), 'Level exists there; nothing to do')
})

check('a registry event is flagged across 1.19.3 and not before it', () => {
  const files = [file('com/x/R.java', '@SubscribeEvent public void on(RegistryEvent.Register<Item> e) {}')]
  const after = up.planUpdate({ from: { mcVersion: '1.19.2', loader: 'forge' }, to: { mcVersion: '1.19.3', loader: 'forge' }, files })
  assert.ok(after.breaking.some((b) => b.symbol === 'RegistryEvent'))
  const before = up.planUpdate({ from: { mcVersion: '1.18.2', loader: 'forge' }, to: { mcVersion: '1.19.2', loader: 'forge' }, files })
  assert.deepEqual(before.breaking, [])
})

check('a loader swap catches the packages that will not exist', () => {
  const files = [file('com/x/I.java', 'import net.minecraftforge.registries.DeferredRegister;')]
  const plan = up.planUpdate({ from: { mcVersion: '1.20.1', loader: 'forge' }, to: { mcVersion: '1.21.1', loader: 'neoforge' }, files })
  assert.ok(plan.breaking.some((b) => b.symbol === 'net.minecraftforge.*'))
})

check('nothing is scanned when no boundary is crossed, even with scary-looking code', () => {
  const files = [file('com/x/Legacy.java', 'GameRegistry.register(x); st.getOrCreateTag(); RegistryEvent e;')]
  const plan = up.planUpdate({ from: { mcVersion: '1.21.1', loader: 'neoforge' }, to: { mcVersion: '1.21.4', loader: 'neoforge' }, files })
  assert.deepEqual(plan.breaking, [], 'code that is already dead for other reasons is not this update\'s business')
})

check('a downgrade is never called build-only', () => {
  const plan = up.planUpdate({ from: { mcVersion: '1.21.1', loader: 'neoforge' }, to: { mcVersion: '1.20.1', loader: 'neoforge' }, files: CLEAN_MOD })
  assert.equal(plan.buildOnly, false, 'going backwards can remove APIs that do not come back')
})

/* --------------------------------------------------------- jar criteria */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcf-jar-'))

function makeJar(name, opts = {}) {
  const zip = new AdmZip()
  if (opts.classes !== false) zip.addFile('com/x/SmallMod.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]))
  if (opts.toml) zip.addFile(opts.toml.path, Buffer.from(opts.toml.text))
  if (opts.fabric) zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(opts.fabric)))
  const p = path.join(tmp, name)
  zip.writeZip(p)
  return p
}

check('a jar with no metadata is rejected: it would install and never load', () => {
  const jar = makeJar('bare.jar', { classes: true })
  const r = up.checkUpdatedJar(jar, { mcVersion: '1.21.1', loader: 'neoforge' })
  assert.equal(r.ok, false)
  assert.ok(r.checks.some((c) => c.name.includes('metadata') && !c.ok))
})

check('the right metadata for the wrong loader is rejected', () => {
  const jar = makeJar('wrongmeta.jar', { classes: true, toml: { path: 'META-INF/mods.toml', text: 'modId="x"' } })
  const r = up.checkUpdatedJar(jar, { mcVersion: '1.21.1', loader: 'neoforge' })
  assert.equal(r.ok, false, 'neoforge.mods.toml is what NeoForge reads')
})

check('a jar declaring the old Minecraft version is rejected', () => {
  const jar = makeJar('oldmc.jar', {
    classes: true,
    toml: {
      path: 'META-INF/neoforge.mods.toml',
      text: 'modId="x"\n[[dependencies.x]]\nmodId="minecraft"\nversionRange="[1.20.1,1.21)"\n'
    }
  })
  const r = up.checkUpdatedJar(jar, { mcVersion: '1.21.1', loader: 'neoforge' })
  assert.equal(r.ok, false)
  assert.ok(r.checks.some((c) => c.name.includes('Minecraft version') && !c.ok))
})

check('a correct jar passes every check', () => {
  const jar = makeJar('good.jar', {
    classes: true,
    toml: {
      path: 'META-INF/neoforge.mods.toml',
      text: 'modId="smallmod"\n[[dependencies.smallmod]]\nmodId="minecraft"\nversionRange="[1.21.1,1.22)"\n'
    }
  })
  const r = up.checkUpdatedJar(jar, { mcVersion: '1.21.1', loader: 'neoforge' }, { expectedModId: 'smallmod' })
  assert.equal(r.ok, true, r.summary)
  assert.match(r.summary, /meets every check/)
})

check('a renamed mod id is caught, because it breaks existing worlds', () => {
  const jar = makeJar('renamed.jar', {
    classes: true,
    toml: { path: 'META-INF/neoforge.mods.toml', text: 'modId="newid"\nmodId="minecraft"\nversionRange="[1.21.1,1.22)"\n' }
  })
  const r = up.checkUpdatedJar(jar, { mcVersion: '1.21.1', loader: 'neoforge' }, { expectedModId: 'oldid' })
  assert.equal(r.ok, false)
  assert.ok(r.checks.some((c) => c.name.includes('mod id') && !c.ok))
})

check('a missing jar is a failure, not an empty success', () => {
  const r = up.checkUpdatedJar(null, { mcVersion: '1.21.1', loader: 'neoforge' })
  assert.equal(r.ok, false)
  assert.match(r.summary, /no jar/i)
})

check('fabric metadata is read for fabric, including its Minecraft range', () => {
  const jar = makeJar('fab.jar', { classes: true, fabric: { id: 'fabmod', depends: { minecraft: '>=1.21.1' } } })
  const r = up.checkUpdatedJar(jar, { mcVersion: '1.21.1', loader: 'fabric' }, { expectedModId: 'fabmod' })
  assert.equal(r.ok, true, r.summary)
})

check('a corrupt mixin config fails the jar, because it crashes at load', () => {
  const jar = makeJar('mixin.jar', {
    classes: true,
    fabric: { id: 'm', depends: { minecraft: '1.21.1' } }
  })
  const zip = new AdmZip(jar)
  zip.addFile('m.mixins.json', Buffer.from('{ not json'))
  zip.writeZip(jar)
  const r = up.checkUpdatedJar(jar, { mcVersion: '1.21.1', loader: 'fabric' })
  assert.equal(r.ok, false)
  assert.ok(r.checks.some((c) => c.name.includes('mixin') && !c.ok))
})

/* ---------------------------------------------- should the turn continue? */

check('a failing build is never "done"', () => {
  const v = up.completionVerdict({ buildOk: false, jar: null, remainingBreakages: 0, resumes: 0, maxResumes: 3 })
  assert.equal(v.done, false)
  assert.match(v.resumePrompt, /compiler error/i)
})

check('a jar that fails its checks is not done, and the checks are quoted back', () => {
  const jar = { ok: false, checks: [{ name: 'metadata matches neoforge', ok: false, detail: 'no neoforge.mods.toml' }], summary: '' }
  const v = up.completionVerdict({ buildOk: true, jar, remainingBreakages: 0, resumes: 0, maxResumes: 3 })
  assert.equal(v.done, false)
  assert.match(v.resumePrompt, /metadata matches neoforge/)
})

check('known breakages left in the code mean not done, even with a green build', () => {
  const v = up.completionVerdict({ buildOk: true, jar: null, remainingBreakages: 2, resumes: 1, maxResumes: 3 })
  assert.equal(v.done, false)
  assert.match(v.reason, /2 known breakage/)
})

check('green build and a good jar is done, and stops the loop', () => {
  const jar = { ok: true, checks: [], summary: '' }
  const v = up.completionVerdict({ buildOk: true, jar, remainingBreakages: 0, resumes: 0, maxResumes: 3 })
  assert.equal(v.done, true)
})

check('nothing built yet is not done, however confidently the model says so', () => {
  const v = up.completionVerdict({ buildOk: null, jar: null, remainingBreakages: 0, resumes: 0, maxResumes: 3 })
  assert.equal(v.done, false)
  assert.match(v.reason, /nothing has been built yet/i)
})

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} update-plan checks passed`}`)
if (failures.length) process.exit(1)
