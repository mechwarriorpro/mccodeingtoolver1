import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Layout checks that can run without a browser.
 *
 * The bug being guarded against is specific and reproducible: ten tabs in a
 * single non-wrapping flex row ran past the right edge of the window, and there
 * was no way to reach the last ones — the strip did not scroll, and a window
 * cannot be resized beyond the monitor. These checks encode the properties that
 * made that possible, so it cannot quietly come back when a tab is added.
 */

const root = process.cwd()
const renderer = path.join(root, 'src', 'renderer', 'src')
const css = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8')
const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8')

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    console.log(`  FAIL ${name}`)
    console.log(`       ${e.message}`)
    process.exitCode = 1
  }
}

/** The rule body for a selector, so the checks read the real declarations. */
function rule(selector) {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')
  const m = css.match(re)
  return m ? m[1] : null
}

console.log('the tab strip cannot hide a tab')

check('the strip wraps instead of running off the edge', () => {
  const body = rule('.rail-tabs')
  assert.ok(body, 'no .rail-tabs rule')
  assert.match(body, /flex-wrap:\s*wrap/)
})

check('the strip scrolls if the window is too short to show it all', () => {
  const body = rule('.rail-tabs')
  assert.match(body, /max-height:/)
  assert.match(body, /overflow-y:\s*auto/)
})

check('the tab strip is not allowed to shrink away', () => {
  assert.match(rule('.rail-tabs'), /flex-shrink:\s*0/)
})

check('the outer row that held the tabs no longer forces one line', () => {
  // The old rule was `display:flex` with no wrap, which is exactly what pushed
  // tabs past the edge.
  assert.doesNotMatch(rule('.rail-tabs'), /display:\s*flex;(?![^}]*flex-wrap)/)
})

check('no media query hides a panel with display:none', () => {
  // "Responsive" that deletes a pane is the same bug as an off-screen tab: the
  // content exists but the user cannot reach it. The narrow layout must stack
  // the panes, not remove them.
  // Strip comments first: prose about `display: none` is not a declaration, and
  // matching it would make this check fail on its own explanation.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const media = [...bare.matchAll(/@media[^{]*\{([\s\S]*?)\n\}/g)].map((m) => m[1])
  assert.ok(media.length > 0, 'no media queries found')
  for (const block of media) {
    for (const rule of block.split('}')) {
      if (!/display:\s*none/.test(rule)) continue
      const selector = (rule.match(/^\s*([^{]+)\{/) ?? [])[1] ?? ''
      // Resizers and decorations may be hidden; panes may not.
      assert.ok(
        /resizer|divider|handle/.test(selector),
        `a media query hides "${selector.trim()}" — a stacked layout must move panels, not delete them`
      )
    }
  }
})

check('a narrow window falls back to a stacked layout', () => {
  assert.match(css, /@media\s*\(max-width:\s*900px\)/)
  const block = css.slice(css.indexOf('@media (max-width: 900px)'))
  assert.match(block, /\.main\s*\{[^}]*grid-template-columns:\s*1fr/)
  assert.match(block, /\.rail\s*\{[^}]*width:\s*100%/)
})

console.log('\npanes can be resized, within the window')

check('both dividers exist and are draggable', () => {
  const resizers = app.match(/className="resizer"/g) ?? []
  assert.equal(resizers.length, 2, `expected 2 resizers, found ${resizers.length}`)
})

check('the rail width is persisted between launches', () => {
  assert.match(app, /localStorage\.setItem\('railWidth'/)
  assert.match(app, /localStorage\.getItem\('railWidth'\)/)
})

check('dragging is clamped so a pane cannot leave the window', () => {
  // The rail: never wider than the window minus room for the chat.
  assert.match(app, /Math\.max\(320, window\.innerWidth - 360\)/)
  // The sidebar: same idea on the other side.
  assert.match(app, /Math\.max\(220, window\.innerWidth - 420\)/)
})

check('the chat column has a floor so it cannot be squeezed to nothing', () => {
  const body = rule('.main')
  assert.match(body, /minmax\(320px,\s*1fr\)/)
})

check('a resize in progress does not select text in either pane', () => {
  assert.match(css, /body\.resizing\s*\{\s*cursor:\s*col-resize;\s*user-select:\s*none;/)
})

console.log('\nevery panel is reachable')

check('all tabs are defined in one catalogue', () => {
  assert.match(app, /const TAB_GROUPS/)
})

check('every rail tab id has a tab in the catalogue', () => {
  const unionMatch = app.match(/type RailTab =([\s\S]*?)\n\n/)
  assert.ok(unionMatch, 'could not find the RailTab union')
  const union = unionMatch[1]
  const declared = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  assert.ok(declared.length >= 10, `only ${declared.length} tabs declared`)
  for (const id of declared) {
    assert.ok(
      new RegExp(`id:\\s*'${id}'`).test(app),
      `tab "${id}" is in the union but not in TAB_GROUPS, so it has no button`
    )
  }
})

check('the catalogue has no tab that the union does not know', () => {
  const unionMatch = app.match(/type RailTab =([\s\S]*?)\n\n/)
  const union = unionMatch[1]
  for (const m of app.matchAll(/id:\s*'([a-z]+)'/g)) {
    assert.ok(union.includes(`'${m[1]}'`), `TAB_GROUPS has "${m[1]}" which is not a RailTab`)
  }
})

check('no group has more than four tabs, so a group cannot overflow a row', () => {
  for (const group of app.matchAll(/\{\s*label:\s*'[^']+',\s*tabs:\s*\[([\s\S]*?)\]\s*\}/g)) {
    const count = (group[1].match(/id:\s*'/g) ?? []).length
    assert.ok(count > 0 && count <= 4, `a group has ${count} tabs`)
  }
})

check('every panel renders from the same tab state, so none is orphaned', () => {
  const rendered = new Set([...app.matchAll(/railTab === '([a-z]+)'/g)].map((m) => m[1]))
  for (const id of rendered) {
    assert.ok(app.includes(`id: '${id}'`), `panel "${id}" renders but has no tab button`)
  }
  // The other direction, which is the one that actually strands a user: a tab
  // button whose panel was never wired up. Clicking it shows nothing and the
  // button looks dead, and the check above cannot see it.
  const catalogued = [...app.matchAll(/id: '([a-z]+)',\s*label:/g)].map((m) => m[1])
  for (const id of catalogued) {
    assert.ok(rendered.has(id), `tab "${id}" has a button but no panel renders for it`)
  }
})

if (process.exitCode) {
  console.log('\nlayout checks failed')
} else {
  console.log(`\nall layout checks passed (${passed})`)
}
