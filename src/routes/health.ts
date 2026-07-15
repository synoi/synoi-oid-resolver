// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * routes/health.ts — GET /v1/health
 *
 * Liveness check. Returns 200 with a stable shape so load balancers and
 * federation peers can probe cheaply.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'

export function buildHealthRouter(): Router {
  const r = Router()
  r.get('/v1/health', (_req: Request, res: Response): void => {
    res.json({ ok: true, service: 'oid-resolver', version: '1.0' })
  })
  return r
}
