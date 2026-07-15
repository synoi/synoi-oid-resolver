// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * routes/resolve.ts — GET /v1/resolve/:oid + POST /v1/resolve/batch
 *
 * Unknown OIDs return 200 with an empty-locations payload (matches the
 * production gateway behavior — clients differentiate by inspecting
 * canonical_locations.length, NOT by HTTP status).
 *
 * Optional federation fallback: when the local store has no record AND
 * an upstream is configured, the upstream's result replaces the empty
 * local one. An unreachable upstream is logged and the local empty
 * result is returned (never 5xx).
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { OID_REGEX } from '../types'
import type {
  BatchResolveResponse, ResolveResult, ResolverStore, ResolverAuth,
} from '../types'
import type { FederationClient } from '../federation'
import type { UsageMeter } from '../metering'

export interface ResolveRouterDeps {
  store:      ResolverStore
  federation: FederationClient | null
  /**
   * Optional metering. When both are present, resolve requires auth and
   * records billable (non-self) verifications per tenant. When absent, resolve
   * is open + uncounted.
   */
  meter?:     UsageMeter
  auth?:      ResolverAuth
}

export function buildResolveRouter(deps: ResolveRouterDeps): Router {
  const r = Router()
  const { store, federation, meter, auth } = deps
  const metered = meter !== undefined && auth !== undefined

  /** Authenticate a metered request; returns tenant_id or null (after sending 401). */
  async function meteredTenant(req: Request, res: Response): Promise<string | null> {
    const result = await auth!.authenticate(req)
    if (!result.ok) {
      res.status(401).json({ error: { message: result.reason, type: 'auth_error' } })
      return null
    }
    return result.tenant_id
  }

  /** Is this a self-verification (tenant resolving its own announced OID)? */
  function isSelf(oid: string, tenant_id: string): boolean {
    return store.announcedByTenant?.(oid, tenant_id) ?? false
  }

  r.get('/v1/resolve/:oid', async (req: Request, res: Response): Promise<void> => {
    const oid = req.params['oid']
    if (oid === undefined || !OID_REGEX.test(oid)) {
      res.status(400).json({
        error: { message: 'oid must match sha256:<64 hex chars>', type: 'invalid_request' },
      })
      return
    }

    let tenant_id: string | null = null
    if (metered) {
      tenant_id = await meteredTenant(req, res)
      if (tenant_id === null) return
    }

    try {
      let result = store.resolve(oid)
      if (
        federation !== null &&
        result.canonical_locations.length === 0 &&
        !result.revoked &&
        result.superseded_by === null
      ) {
        const upstream = await federation.resolve(oid)
        if (upstream !== null) result = upstream
      }
      // Meter billable (non-self) verifications. Self-verification is free.
      if (metered && tenant_id !== null && !isSelf(oid, tenant_id)) {
        meter!.record(tenant_id, 1)
      }
      res.json(result)
    } catch (e) {
      process.stderr.write(JSON.stringify({
        level: 'error', at: 'resolve',
        message: e instanceof Error ? e.message : String(e),
        ts: new Date().toISOString(),
      }) + '\n')
      res.status(500).json({ error: { message: 'internal error', type: 'internal_error' } })
    }
  })

  r.post('/v1/resolve/batch', async (req: Request, res: Response): Promise<void> => {
    const body = req.body as { oids?: unknown }
    if (!Array.isArray(body.oids)) {
      res.status(400).json({
        error: { message: 'body.oids must be an array', type: 'invalid_request' },
      })
      return
    }
    if (body.oids.length > 100) {
      res.status(400).json({
        error: { message: 'max 100 oids per batch', type: 'invalid_request' },
      })
      return
    }

    let tenant_id: string | null = null
    if (metered) {
      tenant_id = await meteredTenant(req, res)
      if (tenant_id === null) return
    }

    const results: BatchResolveResponse['results'] = []
    let billable = 0
    for (const raw of body.oids) {
      if (typeof raw !== 'string' || !OID_REGEX.test(raw)) {
        results.push({ oid: raw, error: 'invalid_oid' })
        continue
      }
      try {
        let r1: ResolveResult = store.resolve(raw)
        if (
          federation !== null &&
          r1.canonical_locations.length === 0 &&
          !r1.revoked &&
          r1.superseded_by === null
        ) {
          const upstream = await federation.resolve(raw)
          if (upstream !== null) r1 = upstream
        }
        results.push(r1)
        if (metered && tenant_id !== null && !isSelf(raw, tenant_id)) billable++
      } catch {
        results.push({ oid: raw, error: 'lookup_failed' })
      }
    }
    if (metered && tenant_id !== null && billable > 0) meter!.record(tenant_id, billable)
    const out: BatchResolveResponse = { results, count: results.length }
    res.json(out)
  })

  return r
}
