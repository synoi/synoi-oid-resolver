// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * store.ts — SQLite-backed implementation of ResolverStore.
 *
 * Schema mirrors the relevant slice of the production gateway Resolver
 * (synoi-gateway/src/oid-resolver-router.ts):
 *
 *   oid_resolver_announcements      announced locations per (oid, tenant, url)
 *   oid_resolver_revocations        recorded revocation events
 *   oid_resolver_supersessions      supersession edges (old_oid → new_oid)
 *   oid_resolver_object_meta        per-OID type + signed_by metadata
 *
 * The reference impl does NOT attempt to read the full AGP table set the
 * production gateway probes (agp_grants, agp_workflow_definitions, etc.).
 * Operators publishing AGP objects record metadata directly via the
 * record* helpers; everything else stays a black-box content address.
 */

import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ResolverStore, ResolveResult, RevocationListEntry } from './types'

export interface SqliteStoreOptions {
  /** Filesystem directory holding `oid-resolver.db`. Created if missing. */
  dataDir: string
}

export class SqliteResolverStore implements ResolverStore {
  private readonly db: Database.Database

  constructor(opts: SqliteStoreOptions) {
    fs.mkdirSync(opts.dataDir, { recursive: true })
    this.db = new Database(path.join(opts.dataDir, 'oid-resolver.db'))
    this.db.pragma('journal_mode = WAL')
    this.bootstrap()
  }

  private bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oid_resolver_announcements (
        oid                  TEXT NOT NULL,
        tenant_id            TEXT NOT NULL,
        location_url         TEXT NOT NULL,
        announced_at_ms      INTEGER NOT NULL,
        first_seen_ms        INTEGER NOT NULL,
        PRIMARY KEY (oid, tenant_id, location_url)
      );
      CREATE INDEX IF NOT EXISTS idx_oid_resolver_lookup
        ON oid_resolver_announcements(oid);

      CREATE TABLE IF NOT EXISTS oid_resolver_revocations (
        revocation_oid   TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL,
        target_kind      TEXT NOT NULL,
        target_oid       TEXT NOT NULL,
        required_level   TEXT,
        provisional      INTEGER NOT NULL DEFAULT 0,
        effective_at_ms  INTEGER NOT NULL,
        lifted_at_ms     INTEGER,
        reason           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_oid_resolver_rev_target
        ON oid_resolver_revocations(target_oid);
      CREATE INDEX IF NOT EXISTS idx_oid_resolver_rev_kind
        ON oid_resolver_revocations(target_kind);
      CREATE INDEX IF NOT EXISTS idx_oid_resolver_rev_effective
        ON oid_resolver_revocations(effective_at_ms DESC);

      CREATE TABLE IF NOT EXISTS oid_resolver_supersessions (
        old_oid       TEXT PRIMARY KEY,
        new_oid       TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oid_resolver_object_meta (
        oid       TEXT PRIMARY KEY,
        type      TEXT,
        signed_by TEXT
      );
    `)
  }

  announce(input: {
    oid: string; tenant_id: string; location_url: string; now_ms: number
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO oid_resolver_announcements
        (oid, tenant_id, location_url, announced_at_ms, first_seen_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.oid, input.tenant_id, input.location_url, input.now_ms, input.now_ms)
  }

  resolve(oid: string): ResolveResult {
    const locRows = this.db.prepare(`
      SELECT location_url, MIN(first_seen_ms) AS first_seen_ms
        FROM oid_resolver_announcements
       WHERE oid = ?
       GROUP BY location_url
       ORDER BY first_seen_ms ASC
    `).all(oid) as Array<{ location_url: string; first_seen_ms: number }>

    const canonical_locations = locRows.map((r) => r.location_url)
    const first_seen_ms = locRows[0]?.first_seen_ms ?? null

    // Revocation: explicit event takes precedence, then provisional blocks.
    let revoked = false
    let revoked_at_ms: number | null = null

    const revRow = this.db.prepare(`
      SELECT effective_at_ms FROM oid_resolver_revocations
       WHERE target_oid = ?
         AND provisional = 0
         AND (lifted_at_ms IS NULL OR lifted_at_ms > ?)
       ORDER BY effective_at_ms DESC LIMIT 1
    `).get(oid, Date.now()) as { effective_at_ms: number } | undefined
    if (revRow !== undefined) {
      revoked = true
      revoked_at_ms = revRow.effective_at_ms
    }

    if (!revoked) {
      const provRow = this.db.prepare(`
        SELECT effective_at_ms FROM oid_resolver_revocations
         WHERE target_oid = ?
           AND provisional = 1
           AND (lifted_at_ms IS NULL OR lifted_at_ms > ?)
         ORDER BY effective_at_ms DESC LIMIT 1
      `).get(oid, Date.now()) as { effective_at_ms: number } | undefined
      if (provRow !== undefined) {
        revoked = true
        revoked_at_ms = provRow.effective_at_ms
      }
    }

    const supRow = this.db.prepare(`
      SELECT new_oid FROM oid_resolver_supersessions WHERE old_oid = ?
    `).get(oid) as { new_oid: string } | undefined
    const superseded_by = supRow?.new_oid ?? null

    const metaRow = this.db.prepare(`
      SELECT type, signed_by FROM oid_resolver_object_meta WHERE oid = ?
    `).get(oid) as { type: string | null; signed_by: string | null } | undefined

    let signed_by: string[] = []
    let type: string | null = null
    if (metaRow !== undefined) {
      type = metaRow.type
      if (metaRow.signed_by !== null) {
        try {
          const parsed = JSON.parse(metaRow.signed_by) as unknown
          if (Array.isArray(parsed)) {
            signed_by = parsed.filter((s): s is string => typeof s === 'string')
          }
        } catch {
          /* malformed metadata row — ignore */
        }
      }
    }

    return {
      oid,
      canonical_locations,
      revoked,
      revoked_at_ms,
      superseded_by,
      signed_by,
      first_seen_ms,
      type,
    }
  }

  /** Did this tenant announce this OID? Powers the metered self-verify carve-out. */
  announcedByTenant(oid: string, tenant_id: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM oid_resolver_announcements WHERE oid = ? AND tenant_id = ? LIMIT 1
    `).get(oid, tenant_id)
    return row !== undefined
  }

  recordRevocation(input: {
    revocation_oid:  string
    tenant_id:       string
    target_kind:     string
    target_oid:      string
    required_level?: string | null
    provisional?:    boolean
    effective_at_ms: number
    reason?:         string | null
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO oid_resolver_revocations
        (revocation_oid, tenant_id, target_kind, target_oid,
         required_level, provisional, effective_at_ms, lifted_at_ms, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      input.revocation_oid,
      input.tenant_id,
      input.target_kind,
      input.target_oid,
      input.required_level ?? null,
      input.provisional === true ? 1 : 0,
      input.effective_at_ms,
      input.reason ?? null,
    )
  }

  listRevocations(opts: {
    limit:        number
    before_ms?:   number
    target_kind?: string
    tenant_id?:   string
  }): RevocationListEntry[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (opts.before_ms !== undefined) {
      clauses.push('effective_at_ms < ?')
      params.push(opts.before_ms)
    }
    if (opts.target_kind !== undefined) {
      clauses.push('target_kind = ?')
      params.push(opts.target_kind)
    }
    if (opts.tenant_id !== undefined) {
      clauses.push('tenant_id = ?')
      params.push(opts.tenant_id)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const sql = `
      SELECT revocation_oid, tenant_id, target_kind, target_oid,
             required_level, provisional, effective_at_ms, lifted_at_ms, reason
        FROM oid_resolver_revocations
        ${where}
       ORDER BY effective_at_ms DESC
       LIMIT ?
    `
    params.push(opts.limit)
    const rows = this.db.prepare(sql).all(...params) as Array<{
      revocation_oid:  string
      tenant_id:       string
      target_kind:     string
      target_oid:      string
      required_level:  string | null
      provisional:     number
      effective_at_ms: number
      lifted_at_ms:    number | null
      reason:          string | null
    }>
    return rows.map((r) => ({
      revocation_oid:  r.revocation_oid,
      tenant_id:       r.tenant_id,
      target_kind:     r.target_kind,
      target_oid:      r.target_oid,
      required_level:  r.required_level,
      provisional:     r.provisional === 1,
      effective_at_ms: r.effective_at_ms,
      lifted_at_ms:    r.lifted_at_ms,
      reason:          r.reason,
    }))
  }

  /** Test-only convenience: record an object's type + signing keys. */
  recordObjectMeta(input: { oid: string; type?: string | null; signed_by?: string[] }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO oid_resolver_object_meta (oid, type, signed_by)
      VALUES (?, ?, ?)
    `).run(
      input.oid,
      input.type ?? null,
      input.signed_by !== undefined ? JSON.stringify(input.signed_by) : null,
    )
  }

  /** Test-only convenience: record a supersession edge. */
  recordSupersession(input: { old_oid: string; new_oid: string; now_ms: number }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO oid_resolver_supersessions (old_oid, new_oid, created_at_ms)
      VALUES (?, ?, ?)
    `).run(input.old_oid, input.new_oid, input.now_ms)
  }

  close(): void {
    this.db.close()
  }
}
