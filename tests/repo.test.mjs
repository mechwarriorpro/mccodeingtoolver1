/**
 * "Build on GitHub" on a project that is not a repository yet.
 *
 * The message this replaces, verbatim:
 *
 *   Not a git repository. Create one first (Settings > GitHub).
 *
 * It was wrong twice. The app can create a repository itself, and Settings is
 * where you sign in — not where repositories are made. It appeared for a project
 * made by decompiling a mod, which has real sources and builds fine, and simply
 * has never been pushed anywhere.
 *
 * The other half of the bug: the build read `workspaceDir` while the Build tab
 * showed a different folder. So the tests below cover the decision (create, add a
 * remote, or ready) and the rules that make a first commit of a decompiled tree
 * safe to push.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const out = path.join(process.cwd(), 'out-test', 'main')
const load = (file) => import(pathToFileURL(path.join(out, file)).href)
const repo = await load('build/repo.js')
const config = await load('config.js')

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
const section = (name) => console.log(name)

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mcf-repo-${label}-`))

/* ------------------------------------------------------------------ decisions */

section('a folder with no .git is created, not refused')
const bare = tmp('bare')
check('the state is "no-repo", not an error', () => {
  const r = repo.repoState(bare, null)
  assert.equal(r.state, 'no-repo')
  assert.equal(r.needsInit, true)
})
check('the message says a repository will be created, not that the user must', () => {
  const r = repo.repoState(bare, null)
  assert.match(r.message, /will be created|create one/i)
  assert.ok(!/Settings > GitHub/i.test(r.message), 'never send someone to Settings to run git init')
})
check('it does not claim the folder is unusable', () => {
  assert.ok(repo.repoState(bare, null).message.length > 10)
})

section('a repository without an origin gets one')
const withGit = tmp('withgit')
fs.mkdirSync(path.join(withGit, '.git'))
check('the state is "no-origin"', () => {
  const r = repo.repoState(withGit, [])
  assert.equal(r.state, 'no-origin')
  assert.equal(r.needsInit, true)
})
check('a null remote list (git failed) is treated as no origin, not as ready', () => {
  assert.equal(repo.repoState(withGit, null).state, 'no-origin')
})
check('a repository with an origin is ready and needs no git writes', () => {
  const r = repo.repoState(withGit, ['origin'])
  assert.equal(r.state, 'ready')
  assert.equal(r.needsInit, false)
  assert.equal(r.message, null)
})
check('other remotes do not count as an origin', () => {
  assert.equal(repo.repoState(withGit, ['upstream']).state, 'no-origin')
})
check('a .git file (worktree or submodule) counts as a repository', () => {
  const w = tmp('worktree')
  fs.writeFileSync(path.join(w, '.git'), 'gitdir: /somewhere\n')
  assert.equal(repo.repoState(w, ['origin']).state, 'ready')
})

/* ------------------------------------------------------------------- gitignore */

section('a first commit of a decompiled mod cannot carry the mod itself')
const proj = tmp('proj')
check('the rules hide the reference tree and the jars', () => {
  fs.writeFileSync(path.join(proj, '.gitignore'), '')
  assert.ok(repo.ensureForkGitignore(proj))
  const text = fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')
  assert.match(text, /^reference\/$/m, 'decompiled trees must not be committed')
  assert.match(text, /^\*\.jar$/m, 'the source jar must not be committed')
  assert.match(text, /^\.agent\/$/m)
  assert.match(text, /^build\/$/m)
  assert.match(text, /^\.gradle\/$/m)
})
check('the gradle wrapper jar is re-included after the *.jar rule', () => {
  const text = fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')
  const jar = text.split('\n').indexOf('*.jar')
  const allow = text.split('\n').indexOf('!gradle/wrapper/gradle-wrapper.jar')
  assert.ok(jar >= 0 && allow > jar, 'without the exception every clone loses its wrapper')
})
check('existing rules of the user are kept', () => {
  fs.writeFileSync(path.join(proj, '.gitignore'), 'my-own-rule\n')
  repo.ensureForkGitignore(proj)
  assert.match(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8'), /my-own-rule/)
})
check('running twice adds nothing the second time', () => {
  const before = fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')
  assert.equal(repo.ensureForkGitignore(proj), false)
  assert.equal(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8'), before)
})
check('a missing file is created rather than throwing', () => {
  const fresh = tmp('fresh')
  assert.equal(repo.ensureForkGitignore(fresh), true)
  assert.ok(fs.existsSync(path.join(fresh, '.gitignore')))
})

/* ---------------------------------------------------------------- repo naming */

section('a repo name is suggested from the mod, safely')
check('a normal mod id passes through', () => {
  assert.equal(repo.suggestRepoName('thaumcraft'), 'thaumcraft')
})
check('underscores and digits survive', () => {
  assert.equal(repo.suggestRepoName('thaumcraft_v4_2_3_5'), 'thaumcraft_v4_2_3_5')
})
check('spaces and punctuation become dashes', () => {
  assert.equal(repo.suggestRepoName('Thaum 1.21.1 Mod!'), 'thaum-1.21.1-mod')
})
check('a name that cleans to nothing falls back', () => {
  assert.equal(repo.suggestRepoName('***'), 'minecraft-mod')
})
check('it is never longer than GitHub allows', () => {
  assert.ok(repo.suggestRepoName('a'.repeat(400)).length <= 100)
})

/* -------------------------------------------------------------- active project */

section('builds act on the folder that is open')
const a = tmp('ws-a')
const b = tmp('ws-b')
check('with no activeDir, the workspace is used', () => {
  assert.equal(config.activeProjectDir({ workspaceDir: a, activeDir: '' }), a)
})
check('an open fork wins over the workspace', () => {
  assert.equal(config.activeProjectDir({ workspaceDir: a, activeDir: b }), b)
})
check('a deleted fork falls back instead of failing the build', () => {
  const gone = path.join(os.tmpdir(), 'mcf-repo-does-not-exist-' + Date.now())
  assert.equal(config.activeProjectDir({ workspaceDir: a, activeDir: gone }), a)
})
check('whitespace is not a folder', () => {
  assert.equal(config.activeProjectDir({ workspaceDir: a, activeDir: '   ' }), a)
})

/* --------------------------------------------------------------- the target repo */

section('owner and repo are inferred when they were never set')
const actions = await load('build/actions.js')
check('both empty: the signed-in account and the folder name are used', () => {
  const t = actions.resolveGithubTarget({ owner: '', repo: '', branch: '' }, '/home/x/thaumcraft_v4', 'ShadowClanGaming')
  assert.equal(t.owner, 'ShadowClanGaming')
  assert.equal(t.repo, 'thaumcraft_v4')
  assert.equal(t.inferred, true)
})
check('a set owner and repo are never overridden', () => {
  const t = actions.resolveGithubTarget({ owner: 'me', repo: 'mine', branch: '' }, '/home/x/other', 'someone-else')
  assert.equal(t.owner, 'me')
  assert.equal(t.repo, 'mine')
  assert.equal(t.inferred, false)
})
check('only the missing half is inferred', () => {
  const t = actions.resolveGithubTarget({ owner: '', repo: 'mine', branch: '' }, '/home/x/other', 'me')
  assert.equal(t.owner, 'me')
  assert.equal(t.repo, 'mine')
  assert.equal(t.inferred, true)
})
check('with no login and no settings it reports that, rather than inventing an owner', () => {
  const t = actions.resolveGithubTarget({ owner: '', repo: '', branch: '' }, '/home/x/mod', undefined)
  assert.equal(t.owner, '')
})
check('a folder name that is not a valid repo name is cleaned', () => {
  const t = actions.resolveGithubTarget({ owner: 'me', repo: '', branch: '' }, '/home/x/My Mod (1.21)', 'me')
  assert.equal(t.repo, 'my-mod-1.21')
})

/* ------------------------------------------------------------------- the message */

section('the old refusal cannot come back')
check('runActionsBuild does not demand a repository it could create', () => {
  // This is a source check on purpose: the failure was a `return fail(...)` in a
  // path that is hard to reach in a unit test, and the string is the bug.
  const source = fs.readFileSync(path.join(process.cwd(), 'src/main/build/actions.ts'), 'utf8')
  // The phrase may appear in a comment explaining the history; a `fail(...)`
  // returning it is the bug.
  assert.ok(
    !/fail\([^)]*Not a git repository/.test(source),
    'that message told the user to do what the app can do'
  )
  assert.ok(/ensureForkGitignore\(dir\)/.test(source), 'the first commit must ignore the decompiled tree')
  assert.ok(/git', \['init'/.test(source), 'a missing repository must be created, not reported')
})

for (const d of [bare, withGit, proj]) fs.rmSync(d, { recursive: true, force: true })

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} repository-setup checks passed`}`)
if (failures.length) process.exit(1)
