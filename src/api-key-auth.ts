// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * api-key-auth.ts — multi-tenant API-key auth for the Resolver.
 *
 * The reference impl ships a single-static-token `BearerTokenAuth` (one
 * tenant, one secret). That is fine for a private single-operator resolver,
 * but a commercial operator selling metered verifications needs real
 * per-customer identity so usage attributes to the right tenant. `ApiKeyAuth`
 * provides that: SQLite-backed keys, each bound to a tenant, stored only as a
 * SHA-256 hash + short display prefix (the raw key is shown once at issuance
 * and never recoverable), with revocation.
 *
 * It is OPT-IN — pass an instance as `ResolverServerOptions.auth`. The default
 * remains BearerTokenAuth, so nothing about the open self-host path changes.
 * The key format mirrors the SynOI gateway's issue/hash/prefix/revoke pattern
 * (synoi-gateway/src/tenant-store.ts) so the two stay conceptually aligned.
 */

import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Request } from 'express'
import type { ResolverAuth } from './types'

/** Raw-key prefix: "OID Resolver Key". */
const KEY_PREFIX = 'orsk_'

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export interface IssuedKey {
  /** Shown ONCE — the customer's actual key. Store it now; unrecoverable after. */
  key:        string
  key_prefix: string
  tenant_id:  string
}

export class ApiKeyAuth implements ResolverAuth {
  private readonly db: Database.Database

  constructor(opts: { dataDir: string }) {
    fs.mkdirSync(opts.dataDir, { recursive: true })
    this.db = new Database(path.join(opts.dataDir, 'oid-resolver-keys.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resolver_api_keys (
        key_hash     TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        key_prefix   TEXT NOT NULL,
        label        TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_resolver_api_keys_tenant
        ON resolver_api_keys(tenant_id);
    `)
  }

  /** Mint a key bound to a tenant. Returns the raw key ONCE. */
  issueKey(tenant_id: string, label = ''): IssuedKey {
    const raw        = randomBytes(24).toString('hex')
    const key        = `${KEY_PREFIX}${raw}`
    const key_prefix = key.slice(0, KEY_PREFIX.length + 6)
    this.db.prepare(`
      INSERT INTO resolver_api_keys (key_hash, tenant_id, key_prefix, label, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hashKey(key), tenant_id, key_prefix, label, Date.now())
    return { key, key_prefix, tenant_id }
  }

  /** Revoke a key by its raw value. Returns true if a live key was revoked. */
  revokeKey(key: string): boolean {
    const res = this.db.prepare(`
      UPDATE resolver_api_keys SET revoked_at = ? WHERE key_hash = ? AND revoked_at IS NULL
    `).run(Date.now(), hashKey(key))
    return res.changes > 0
  }

  async authenticate(req: Request): Promise<
    | { ok: true; tenant_id: string }
    | { ok: false; reason: string }
  > {
    const header = req.headers['authorization']
    let key: string | undefined
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      key = header.slice(7).trim()
    } else if (typeof req.headers['x-api-key'] === 'string') {
      key = (req.headers['x-api-key'] as string).trim()
    }
    if (!key || !key.startsWith(KEY_PREFIX)) {
      return { ok: false, reason: 'Missing or malformed API key' }
    }
    const row = this.db.prepare(`
      SELECT tenant_id, revoked_at FROM resolver_api_keys WHERE key_hash = ?
    `).get(hashKey(key)) as { tenant_id: string; revoked_at: number | null } | undefined
    if (!row || row.revoked_at !== null) {
      return { ok: false, reason: 'Unknown or revoked API key' }
    }
    this.db.prepare(`UPDATE resolver_api_keys SET last_used_at = ? WHERE key_hash = ?`)
      .run(Date.now(), hashKey(key))
    return { ok: true, tenant_id: row.tenant_id }
  }

  close(): void {
    this.db.close()
  }
}
