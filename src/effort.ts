/**
 * Quick steps: while the agent is operating the computer, each model request
 * is "look at the screenshot, pick the next click". Deliberating over that
 * costs seconds per step and is what makes the motion feel halting, so those
 * requests can run at the model's lowest reasoning effort. Requests that are
 * not part of operating (planning from the user's message, turns that never
 * touch the computer) keep the session's own setting.
 */

interface MessageLike {
  role?: string
  toolCallId?: string
  content?: unknown
}

/**
 * Has this turn started operating the computer: is there a result of one of
 * this plugin's tools since the user's last message?
 *
 * It has to hold for the rest of the turn, not only right after such a result:
 * the replies written at the lowered effort carry no reasoning, and a provider
 * in thinking mode refuses a turn whose earlier tool-calling replies lack it
 * (DeepSeek: "content[].thinking ... must be passed back"). So once a turn has
 * a reply written without thinking, every later request of that turn goes
 * without it too.
 */
export function isOperating(messages: readonly unknown[], ownTools: ReadonlySet<string>): boolean {
  let start = messages.length
  while (start > 0 && (messages[start - 1] as MessageLike | undefined)?.role !== 'user') start--
  const names = new Map<string, string>()
  for (let index = start; index < messages.length; index++) {
    const message = messages[index] as MessageLike | undefined
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; id?: string; name?: string }>) {
        if (part.type === 'tool-call' && typeof part.id === 'string' && typeof part.name === 'string') names.set(part.id, part.name)
      }
    } else if (message?.role === 'tool' && typeof message.toolCallId === 'string') {
      const name = names.get(message.toolCallId)
      if (name !== undefined && ownTools.has(name)) return true
    }
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

/**
 * Without deliberation the model now and then writes a tool call whose
 * arguments are not valid JSON, which the adapter raises as
 * MALFORMED_RESPONSE and which would end the turn. Such a reply is thrown
 * away and asked for again. The reply is held back until it is complete, as
 * events already passed on could not be taken back.
 */
export async function* retryMalformed<T>(run: () => AsyncIterable<T>, attempts = 3): AsyncGenerator<T> {
  for (let attempt = 1; ; attempt++) {
    const events: T[] = []
    try {
      for await (const event of run()) events.push(event)
    } catch (error) {
      if (attempt < attempts && (error as { code?: unknown } | null)?.code === 'MALFORMED_RESPONSE') continue
      throw error
    }
    yield* events
    return
  }
}
