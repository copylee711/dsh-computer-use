// Windows acceptance: node scripts/uia-chromium-smoke.mjs [path/to/chrome.exe]
// Opens an isolated scratch profile; never navigates or types into user tabs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { HelperClient } from '../lib/types/helper-client.js'
import { matchTarget } from '../lib/types/target.js'

const root = resolve('.smoke', `uia-chromium-${Date.now()}`)
mkdirSync(root, { recursive: true })
const title = `DSH UIA acceptance ${Date.now()}`
const page = resolve(root, 'index.html')
writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>${title}</title>
<button>UIA fixture button</button><input aria-label="UIA fixture input">
<div role="group" class="ProseMirror" contenteditable="true" aria-label="UIA fixture composer" style="width:400px;height:100px;border:1px solid">Composer</div>
<div role="group" aria-label="UIA ordinary group" style="width:400px;height:50px">Ordinary group</div>`)
const chrome = spawn(process.argv[2] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--user-data-dir=${resolve(root, 'profile')}`, '--no-first-run', '--no-default-browser-check', pathToFileURL(page).href,
], { windowsHide: true, stdio: 'ignore' })
let launchError
chrome.on('error', error => { launchError = error })
const helper = new HelperClient(console.warn)
let hwnd
try {
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError
    const windows = await helper.call('windows')
    hwnd = windows.find(w => w.exe === 'chrome.exe' && w.title.includes(title))?.hwnd
    if (hwnd) break
    await sleep(250)
  }
  assert.ok(hwnd, 'scratch Chrome window must open')
  const start = Date.now()
  // A title can arrive before the renderer's accessibility tree is ready.
  let elements = []
  for (let i = 0; i < 30; i++) {
    const result = await helper.call('ui', { hwnd, maxNodes: 400, popups: true })
    elements = result.elements
    if (elements.some(e => e.name === 'UIA fixture button') && elements.some(e => e.name === 'UIA fixture composer')) break
    await sleep(200)
  }
  assert.ok(elements.some(e => e.role === 'TabItem'), 'retain browser tabs')
  assert.ok(elements.some(e => e.role === 'Edit' && !e.name.startsWith('UIA fixture')), 'retain browser address bar')
  for (const name of ['UIA fixture button', 'UIA fixture input', 'UIA fixture composer']) {
    assert.equal(matchTarget(elements, name).kind, 'found', name)
  }
  const editor = matchTarget(elements, '输入框:UIA fixture composer')
  assert.equal(editor.kind, 'found', 'composer works with input role aliases')
  assert.equal(editor.element.editable, true, 'editor Group is marked editable')
  assert.equal(editor.element.focusable, true)
  assert.ok(!elements.some(e => e.name === 'UIA ordinary group'), 'skip ordinary Groups')
  const keys = elements.map(e => JSON.stringify([e.role, e.name, e.x, e.y, e.width, e.height]))
  assert.equal(new Set(keys).size, keys.length, 'window and renderer controls are deduplicated')
  const limited = await helper.call('ui', { hwnd, maxNodes: 10 })
  assert.ok(limited.elements.length <= 10, 'respect maxNodes after supplementing')
  console.log(`PASS: browser chrome, page controls, editable Group, input targeting, metadata, deduplication and maxNodes (${elements.length} elements, ${Date.now() - start} ms)`)
} finally {
  try { if (hwnd) await helper.call('window_cmd', { hwnd, op: 'close' }) }
  finally { helper.dispose() }
  // This PID belongs only to the scratch profile created above.
  if (chrome.exitCode === null) chrome.kill()
}
