/**
 * Context Doctor browser half — registers the audit ring into the
 * native composer context-control position and drives it from the host's same-origin
 * `/api/context-doctor/audit` endpoint: fetch on mount, manual refresh.
 * @module dsh-context-doctor/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createAuditStore, type AuditUiState } from './store.ts'
import { ContextAuditRing } from './ContextAuditRing.tsx'
import { NS, en, zh } from './locales.ts'

/** Required services. */
export const inject = ['slots', 'locale']

export type { ContextAuditRingProps } from './ContextAuditRing.tsx'
export type { AuditUiState } from './store.ts'

/**
 * Client plugin body: register dictionaries, seed the store, and seat the
 * audit control once its native replacement hole is on the ledger.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-doctor: dictionaries')

  const store = createAuditStore()

  ctx.slots.inject('conversation.input.context', () =>
    ctx.slots.register({
      name: 'conversation.input.context',
      store,
      locale: NS,
    }, ContextAuditRing))
}
