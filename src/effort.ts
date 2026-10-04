/**
 * Quick steps: while the agent is operating the computer, each model request
 * is "look at the screenshot, pick the next click". Deliberating over that
 * costs seconds per step and is what makes the motion feel halting, so those
 * requests can run at the model's lowest reasoning effort. Requests that are
 * not in the middle of operating (planning from the user's message, working
 * with other tools) keep the session's own setting.
 */

interface MessageLike {
  role?: string
  toolCallId?: string
  content?: unknown
}

/**
 * Is this request the continuation of computer use: was the last thing in the
 * conversation the result of one of this plugin's tools?
 */
export function isOperating(messages: readonly unknown[], ownTools: ReadonlySet<string>): boolean {
  const last = messages[messages.length - 1] as MessageLike | undefined
  if (last?.role !== 'tool' || typeof last.toolCallId !== 'string') return false
  for (let index = messages.length - 2; index >= 0; index--) {
    const message = messages[index] as MessageLike
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const call = (message.content as Array<{ type?: string; id?: string; name?: string }>).find(part => part.type === 'tool-call' && part.id === last.toolCallId)
    if (call) return typeof call.name === 'string' && ownTools.has(call.name)
    // The matching call is always in the nearest assistant message; an older one would be another turn's.
    return false
  }
  return false
}

/** Effort ids that mean "do not deliberate", best first. Only an exact, advertised id is ever used. */
const LOWEST = ['off', 'none', 'disabled', 'minimal', 'low']

/** The lowest reasoning effort a model offers, or undefined when it offers none we recognise. */
export function lowestEffort(efforts: readonly { id: string }[] | undefined): string | undefined {
  if (!Array.isArray(efforts)) return undefined
  const ids = new Set(efforts.map(effort => String(effort.id).toLowerCase()))
  const pick = LOWEST.find(id => ids.has(id))
  return pick === undefined ? undefined : efforts.find(effort => String(effort.id).toLowerCase() === pick)!.id
}
