/**
 * routes/revocations.ts — GET /v1/revocations
 *
 * Public, unauthenticated. Revocation events are inherently broadcast —
 * the whole point of the Resolver is to tell verifiers to stop trusting
 * a targeted object. Tenant scoping is opt-in via query param.
 *
 * Query params:
 *   limit         1-500 (default 50)
 *   before_ms     pagination cursor (effective_at_ms < before_ms)
 *   target_kind   filter to one of the allowed AGP kinds
 *   tenant_id     scope to a single tenant
 *
 * Response shape matches the gateway's /oid/revocations contract so
 * synoi-mcp-server + portal don't need a forked client.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import type { ResolverStore, RevocationListResponse } from '../types'

export interface RevocationsRouterDeps {
  store: ResolverStore
}

const ALLOWED_KINDS = new Set([
  'capability_declaration',
  'capability_grant',
  'workflow_definition',
  'workflow_instance',
  'skill',
])

export function buildRevocationsRouter(deps: RevocationsRouterDeps): Router {
  const r = Router()
  const { store } = deps

  r.get('/v1/revocations', (req: Request, res: Response): void => {
    const limitRaw = req.query['limit']
    const limit = typeof limitRaw === 'string'
      ? Math.max(1, Math.min(500, Number(limitRaw) | 0 || 50))
      : 50

    const beforeRaw = req.query['before_ms']
    const before_ms = typeof beforeRaw === 'string' && Number.isFinite(Number(beforeRaw))
      ? Number(beforeRaw) : undefined

    const target_kind = typeof req.query['target_kind'] === 'string'
      ? (req.query['target_kind'] as string)
      : undefined
    const tenant_id = typeof req.query['tenant_id'] === 'string'
      ? (req.query['tenant_id'] as string)
      : undefined

    if (target_kind !== undefined && !ALLOWED_KINDS.has(target_kind)) {
      res.status(400).json({
        error: `target_kind must be one of: ${Array.from(ALLOWED_KINDS).join(' | ')}`,
      })
      return
    }

    const rows = store.listRevocations({
      limit,
      ...(before_ms   !== undefined ? { before_ms }   : {}),
      ...(target_kind !== undefined ? { target_kind } : {}),
      ...(tenant_id   !== undefined ? { tenant_id }   : {}),
    })
    const out: RevocationListResponse = {
      count:       rows.length,
      revocations: rows,
    }
    res.json(out)
  })

  return r
}
