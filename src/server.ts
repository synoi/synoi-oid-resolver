// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * server.ts — Express factory for the @synoi/oid-resolver reference impl.
 *
 * The factory composes pluggable pieces (store, auth, federation) into a
 * spec-compliant Resolver server. Operators wanting to embed the
 * Resolver inside a larger Express app can call `createResolverApp` for
 * just the routes; the standalone `createResolverServer` returns both
 * the app + handles to its underlying resources (store, http.Server) so
 * SIGTERM teardown is clean.
 *
 * Exports the BearerTokenAuth default that reads `RESOLVER_BEARER_TOKEN`
 * from env. Any string of length >= 16 is accepted; a per-tenant map is
 * out of scope for the reference impl.
 */

import express from 'express'
import type { Express, Request } from 'express'
import * as http from 'node:http'
import * as path from 'node:path'
import { SqliteResolverStore } from './store'
import {
  buildResolveRouter,
} from './routes/resolve'
import { buildAnnounceRouter } from './routes/announce'
import { buildRevocationsRouter } from './routes/revocations'
import { buildHealthRouter } from './routes/health'
import { createFederationClient } from './federation'
import type { FederationClient } from './federation'
import type {
  ResolverAuth,
  ResolverServerOptions,
  ResolverStore,
} from './types'

export { OID_REGEX } from './types'
export type {
  ResolverAuth,
  ResolverStore,
  ResolverServerOptions,
  ResolveResult,
  AnnounceRequest,
  AnnounceResponse,
  RevocationListEntry,
  RevocationListResponse,
  BatchResolveResponse,
} from './types'
export { SqliteResolverStore } from './store'
export { createFederationClient } from './federation'
export { ApiKeyAuth } from './api-key-auth'
export type { IssuedKey } from './api-key-auth'
export {
  NoopUsageMeter, SqliteUsageMeter, currentPeriodKey,
} from './metering'
export type { UsageMeter, UsageSnapshot } from './metering'
export {
  checkCommercialLicense, verifyLicenseToken, printLicenseBanner,
  SYNOI_LICENSE_PUBKEY_HEX,
} from './license'
export type { LicenseStatus, LicenseClaims } from './license'

// ── Default auth: bearer-token-from-env ─────────────────────────────────────

export class BearerTokenAuth implements ResolverAuth {
  private readonly expected: string | null
  private readonly tenantId: string

  constructor(opts: { token?: string | null; tenantId?: string } = {}) {
    this.expected = opts.token ?? process.env['RESOLVER_BEARER_TOKEN'] ?? null
    this.tenantId = opts.tenantId ?? process.env['RESOLVER_TENANT_ID'] ?? 'default'
  }

  async authenticate(req: Request): Promise<
    | { ok: true; tenant_id: string }
    | { ok: false; reason: string }
  > {
    if (this.expected === null || this.expected.length === 0) {
      return { ok: false, reason: 'RESOLVER_BEARER_TOKEN not configured' }
    }
    const header = req.headers['authorization']
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return { ok: false, reason: 'Missing Authorization header' }
    }
    const token = header.slice(7).trim()
    if (token !== this.expected) {
      return { ok: false, reason: 'Invalid bearer token' }
    }
    return { ok: true, tenant_id: this.tenantId }
  }
}

// ── App factory (just the routes, no http.Server) ───────────────────────────

export interface ResolverAppHandles {
  app:        Express
  store:      ResolverStore
  federation: FederationClient | null
  ownsStore:  boolean
}

export function createResolverApp(opts: ResolverServerOptions = {}): ResolverAppHandles {
  let store: ResolverStore
  let ownsStore: boolean
  if (opts.store !== undefined) {
    store = opts.store
    ownsStore = false
  } else {
    const dataDir = opts.dataDir ?? path.resolve(process.cwd(), 'resolver-data')
    store = new SqliteResolverStore({ dataDir })
    ownsStore = true
  }
  const auth = opts.auth ?? new BearerTokenAuth()
  const federation: FederationClient | null = opts.upstreamUrl !== undefined
    ? createFederationClient({ upstreamUrl: opts.upstreamUrl })
    : null

  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use(buildHealthRouter())
  app.use(buildResolveRouter({
    store,
    federation,
    // Metering is opt-in: only when a meter is supplied does resolve require
    // auth + count billable verifications. Default = open, uncounted.
    ...(opts.meter !== undefined ? { meter: opts.meter, auth } : {}),
  }))
  app.use(buildAnnounceRouter({ store, auth }))
  app.use(buildRevocationsRouter({ store }))

  app.use((_req, res) => {
    res.status(404).json({ error: { message: 'not found', type: 'not_found' } })
  })

  return { app, store, federation, ownsStore }
}

// ── Full server: app + listen + graceful shutdown ──────────────────────────

export interface RunningResolver {
  app:    Express
  server: http.Server
  store:  ResolverStore
  port:   number
  /** Closes the http listener and the SQLite handle (if owned). */
  close():  Promise<void>
}

export async function createResolverServer(
  opts: ResolverServerOptions & { port?: number } = {},
): Promise<RunningResolver> {
  const handles = createResolverApp(opts)
  const port = opts.port ?? Number(process.env['PORT'] ?? 4000)

  const server = http.createServer(handles.app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port

  return {
    app:    handles.app,
    server,
    store:  handles.store,
    port:   boundPort,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err !== undefined ? reject(err) : resolve())
      })
      if (handles.ownsStore) handles.store.close()
    },
  }
}
