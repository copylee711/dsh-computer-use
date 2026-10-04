import { describe, expect, it } from 'vitest'
import { isOperating, lowestEffort } from '../src/effort.js'

const OWN = new Set(['computer', 'computer_batch', 'open_application'])
const user = { role: 'user', content: [{ type: 'text', text: '打开记事本' }] }
const calls = (id: string, name: string) => ({ role: 'assistant', content: [{ type: 'reasoning', text: '…' }, { type: 'tool-call', id, name, arguments: '{}' }] })
const result = (id: string) => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'done' }] })

describe('quick steps', () => {
  it('treats a request that follows one of the plugin\'s own tool results as operating', () => {
    expect(isOperating([user, calls('a', 'open_application'), result('a')], OWN)).toBe(true)
    expect(isOperating([user, calls('a', 'computer'), result('a'), calls('b', 'computer_batch'), result('b')], OWN)).toBe(true)
  })

  it('leaves planning and other tools at the session\'s effort', () => {
    expect(isOperating([user], OWN)).toBe(false)
    expect(isOperating([user, calls('a', 'bash'), result('a')], OWN)).toBe(false)
    // A new user message after computer use starts a fresh plan.
    expect(isOperating([user, calls('a', 'computer'), result('a'), { role: 'assistant', content: [{ type: 'text', text: '完成' }] }, user], OWN)).toBe(false)
    expect(isOperating([], OWN)).toBe(false)
  })

  it('stays lowered for the rest of the turn, so no thinking request follows a reply written without thinking', () => {
    // The user's failing run: computer use, then a shell command to verify the file.
    expect(isOperating([user, calls('a', 'computer'), result('a'), calls('b', 'bash'), result('b')], OWN)).toBe(true)
    expect(isOperating([user, calls('a', 'bash'), result('a'), calls('b', 'computer'), result('b'), calls('c', 'bash'), result('c')], OWN)).toBe(true)
  })

  it('does not match a result to a call from an earlier turn', () => {
    expect(isOperating([user, calls('a', 'computer'), result('a'), user, calls('b', 'bash'), result('a')], OWN)).toBe(false)
  })

  it('picks the lowest effort the model advertises, and nothing when it advertises none', () => {
    expect(lowestEffort([{ id: 'high' }, { id: 'off' }, { id: 'low' }])).toBe('off')
    expect(lowestEffort([{ id: 'High' }, { id: 'Low' }, { id: 'Medium' }])).toBe('Low')
    expect(lowestEffort([{ id: 'max' }, { id: 'high' }])).toBeUndefined()
    expect(lowestEffort(undefined)).toBeUndefined()
  })
})
