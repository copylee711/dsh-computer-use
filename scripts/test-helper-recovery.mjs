// End-to-end HelperClient crash/timeout/dispose recovery, on a scratch window.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { HelperClient, useHostedHelper } from '../lib/types/helper-client.js'

const fixture = spawn(fileURLToPath(new URL('../.smoke/card-recovery.exe', import.meta.url)), ['--window'], { windowsHide: true })
const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]()
const hwnd = Number((await lines.next()).value)
const state = async () => { fixture.stdin.write('\n'); return JSON.parse((await lines.next()).value) }
const before = await state()
useHostedHelper(true)
let helper
try {
  for (const mode of ['crash', 'timeout', 'dispose', 'dispose-stuck']) {
    helper = new HelperClient(console.warn)
    await helper.call('window_card', { hwnd, x: 200, y: 200, width: 400, height: 300, opacity: 80 })
    assert.notDeepEqual(await state(), before)
    const child = helper.child
    if (mode === 'crash') {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    } else if (mode === 'timeout') {
      // Settle blocks the real command loop long enough to trip the client timer.
      await assert.rejects(helper.call('settle', { x: 200, y: 200, width: 20, height: 20, minMs: 5000, maxMs: 5000 }, 20), /timed out/)
    } else if (mode === 'dispose-stuck') {
      const pending = helper.call('settle', { x: 200, y: 200, width: 20, height: 20, minMs: 5000, maxMs: 5000 })
      const rejected = assert.rejects(pending, /exited/)
      await sleep(50)
      helper.dispose()
      await rejected
    } else {
      helper.dispose()
    }
    let restored = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (JSON.stringify(await state()) === JSON.stringify(before)) { restored = true; break }
      await sleep(100)
    }
    assert.ok(restored, `${mode}: restores host without another caller command`)
    console.log(`PASS: HelperClient ${mode} restores the host window`)
    helper.dispose()
  }
} finally {
  helper?.dispose()
  fixture.stdin.end()
  await once(fixture, 'exit')
}

