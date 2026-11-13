/**
 * Shared assertion helpers. Each failing check is echoed to stdout AND, inside
 * GitHub Actions, as its own annotation, because annotation *messages* are
 * truncated to their first line while the per-check lines remain readable.
 */
import fs from 'node:fs'

let failures = 0

export function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`)
    return true
  }
  failures++
  const text = String(detail ?? '').replace(/\r?\n/g, ' ').slice(0, 300)
  console.log(`  FAIL ${name}${detail ? `\n       ${text}` : ''}`)
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error file=tests,title=${name.replace(/[%:]/g, ' ').slice(0, 200)}::${text.replace(/%/g, '%25')}`)
  }
  return false
}

export function section(name) {
  console.log(name)
}

export function finish(label) {
  if (failures) fs.writeFileSync(new URL('../test-failures.txt', import.meta.url), `${failures} failing check(s) in ${label}\n`)
  console.log(failures ? `\n${failures} check(s) failed` : `\nall ${label} checks passed`)
  process.exit(failures ? 1 : 0)
}
