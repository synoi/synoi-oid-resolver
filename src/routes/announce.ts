// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * routes/announce.ts — POST /v1/announce
 *
 * Auth-required write. Operators publishing an object call this to tell
 * the Resolver "this OID is reachable at this URL." Multiple locations
 * per OID are allowed and accumulate (federation peers, mirrors).
 *
 * Validation:
 *   • oid matches sha256:<64 hex chars>
 *   • location_url is a syntactically valid http(s) URL
 *
 * Signature verification of the announced object is OUT of scope here —
 * that is @synoi/cof's job, and clients perform it themselves at fetch
 * time. The Resolver merely indexes the (oid → location) mapping.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { OID_REGEX } from '../types'
import type { ResolverAuth, ResolverStore, AnnounceResponse } from '../types'

export interface AnnounceRouterDeps {
  store: ResolverStore
  auth:  ResolverAuth
}

export function buildAnnounceRouter(deps: AnnounceRouterDeps): Router {
  const r = Router()
  const { store, auth } = deps

  r.post('/v1/announce', async (req: Request, res: Response): Promise<void> => {
    const authResult = await auth.authenticate(req)
    if (!authResult.ok) {
      res.status(401).json({
        error: { message: authResult.reason, type: 'auth_error' },
      })
      return
    }

    const body = req.body as { oid?: unknown; location_url?: unknown }
    if (typeof body.oid !== 'string' || !OID_REGEX.test(body.oid)) {
      res.status(400).json({
        error: { message: 'oid required (sha256:<64 hex chars>)', type: 'invalid_request' },
      })
      return
    }
    if (typeof body.location_url !== 'string' || body.location_url.length === 0) {
      res.status(400).json({
        error: { message: 'location_url required', type: 'invalid_request' },
      })
      return
    }
    try {
      const url = new URL(body.location_url)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        res.status(400).json({
          error: { message: 'location_url must be http(s)', type: 'invalid_request' },
        })
        return
      }
    } catch {
      res.status(400).json({
        error: { message: 'location_url is not a valid URL', type: 'invalid_request' },
      })
      return
    }

    const now = Date.now()
    try {
      store.announce({
        oid:          body.oid,
        tenant_id:    authResult.tenant_id,
        location_url: body.location_url,
        now_ms:       now,
      })
    } catch (e) {
      process.stderr.write(JSON.stringify({
        level: 'error', at: 'announce',
        message: e instanceof Error ? e.message : String(e),
        ts: new Date().toISOString(),
      }) + '\n')
      res.status(500).json({ error: { message: 'internal error', type: 'internal_error' } })
      return
    }

    const out: AnnounceResponse = { ok: true, oid: body.oid, announced_at_ms: now }
    res.json(out)
  })

  return r
}
