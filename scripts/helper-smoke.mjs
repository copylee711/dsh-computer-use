// Live smoke test of the Windows helper (real screen, real input).
//   pnpm run build && node scripts/helper-smoke.mjs [--notepad]
// Compiles the helper, prints displays/windows, saves screenshots to .smoke/,
// shows the overlay for a few seconds and, with --notepad, opens Notepad,
// types mixed Chinese/English text and verifies it via UI Automation.
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { HelperClient, ensureHelperExe } from '../lib/types/helper-client.js'
import { matchTarget } from '../lib/types/target.js'

const out = new URL('../.smoke/', import.meta.url)
mkdirSync(out, { recursive: true })
const t0 = Date.now()
console.log('helper exe:', await ensureHelperExe(), `(${Date.now() - t0} ms)`)
const helper = new HelperClient(console.warn)
helper.onEvent(event => console.log('event:', event))

const displays = await helper.call('displays')
console.log('displays:', displays)
const d = displays.find(x => x.primary) ?? displays[0]
const shot = async (file, show = true) => {
  const started = Date.now()
  const r = await helper.call('screenshot', { x: d.x, y: d.y, width: d.width, height: d.height, outWidth: Math.round(d.width / 2), outHeight: Math.round(d.height / 2), quality: 80 })
  writeFileSync(new URL(file, out), Buffer.from(r.data, 'base64'))
  if (show) console.log(`screenshot ${file}: ${r.width}x${r.height} in ${Date.now() - started} ms`)
}
await shot('desktop.jpg')
console.log('windows:', (await helper.call('windows')).map(w => `${w.exe} | ${w.title.slice(0, 50)}${w.foreground ? ' *' : ''}`))

await helper.call('overlay_show', { label: 'DeepSeek 正在使用你的电脑', status: '冒烟测试' })
await shot('with-overlay.jpg') // must look identical: the overlay is excluded from capture

if (process.argv.includes('--notepad')) {
  // Only ever touch a scratch file of our own, and check the foreground window
  // before every keystroke: never send blind input to the user's tabs.
  const file = new URL('smoke-notepad.txt', out)
  writeFileSync(file, '')
  const path = fileURLToPath(file)
  await helper.call('launch', { target: 'notepad.exe', args: `"${path}"` })
  const ours = async () => {
    const fg = await helper.call('foreground')
    return /notepad/i.test(fg.exe) && fg.title.includes('smoke-notepad') ? fg : undefined
  }
  let fg
  for (let i = 0; i < 40 && !(fg = await ours()); i++) await sleep(250)
  if (!fg) {
    console.log('ABORT: smoke-notepad.txt is not the foreground window; no keys sent.')
  } else {
    console.log('foreground:', fg.exe, fg.title)
    await helper.call('overlay_status', { status: '输入 “你好，DeepSeek”' })
    const text = '你好，DeepSeek！Computer use 测试 123\n第二行 ✓'
    await helper.call('type', { text })
    await sleep(300)
    const ui = await helper.call('ui', {})
    const doc = ui.elements.find(e => (e.role === 'Document' || e.role === 'Edit') && e.value)
    console.log('editor value:', JSON.stringify(doc?.value))
    console.log(doc?.value?.startsWith('你好，DeepSeek！Computer use 测试 123') ? 'PASS: typed text matches' : 'CHECK: text mismatch')
    await shot('notepad.jpg')

    // Reading the window as text, and finding controls by name (also inside an open menu).
    let started = Date.now()
    const read = await helper.call('text', { tail: 2000 })
    console.log(`window text (${read.source}, ${read.length} chars, ${Date.now() - started} ms):`, JSON.stringify(read.text.slice(0, 60)))
    console.log(read.text.includes('Computer use 测试 123') ? 'PASS: text command reads the document' : 'CHECK: text command did not return the document')
    started = Date.now()
    const controls = (await helper.call('ui', { includeText: true, popups: true, maxNodes: 400 })).elements
    const menu = matchTarget(controls, '文件')
    console.log(`target "文件": ${menu.kind}${menu.kind === 'found' ? ` (${menu.element.role} "${menu.element.name}")` : ''} among ${controls.length} controls in ${Date.now() - started} ms`)
    if (menu.kind === 'found' && await ours()) {
      const el = menu.element
      await helper.call('click', { x: Math.round(el.x + el.width / 2), y: Math.round(el.y + el.height / 2), button: 'left', count: 1, modifiers: [] })
      let item
      started = Date.now()
      for (let i = 0; i < 15 && item?.kind !== 'found'; i++) {
        await sleep(200)
        item = matchTarget((await helper.call('ui', { includeText: true, popups: true, maxNodes: 400 })).elements, '另存为')
      }
      console.log(item?.kind === 'found' ? `PASS: menu item "${item.element.name}" found in the open menu after ${Date.now() - started} ms` : `CHECK: "另存为" not found in the open menu (${item?.kind})`)
      // Close the menu again; Esc goes to our own Notepad only.
      if (await ours()) await helper.call('keys', { combos: [[0x1B]] })
      await sleep(300)
    }
    if (await ours()) await helper.call('keys', { combos: [[0x11, 0x53], [0x11, 0x57]] }) // ctrl+s, ctrl+w on our own file
    await sleep(500)
  }
}

console.log('overlay visible for 3s — press Esc to see a stop event')
await sleep(3000)
await helper.call('overlay_hide')
helper.dispose()
console.log(`done in ${Date.now() - t0} ms; images in ${out.pathname}`)
