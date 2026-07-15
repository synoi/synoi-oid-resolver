// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * metering.ts — pluggable per-tenant verification counter for the Resolver.
 *
 * The reference Resolver is a neutral, self-hostable service: metering is a
 * commercial-operator concern, not a protocol requirement. So the default is
 * a no-op meter and resolve stays free + uncounted for anyone who just runs
 * the package. An operator who wants to bill for verifications wires in a
 * real UsageMeter (the bundled SQLite one, or their own) and reads the counts
 * out of band (a monthly reporter posts overage to their billing provider).
 *
 * Self-verification carve-out (verifying your OWN object/key) is decided by
 * the caller before it records — a self-verification is simply never passed
 * to the meter. This module only counts what it is told to count.
 */

import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface UsageSnapshot {
  tenant_id:  string
  period_key: string
  count:      number
}

export interface UsageMeter {
  /** Record `count` billable verifications for a tenant (default 1). */
  record(tenant_id: string, count?: number): void
  /** Current count for the tenant's active period (or a given period_key). */
  usage(tenant_id: string, period_key?: string): UsageSnapshot
  close(): void
}

/** Canonical monthly period key (UTC): "YYYY-MM". */
export function currentPeriodKey(now_ms: number = Date.now()): string {
  const d = new Date(now_ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Default meter — counts nothing. Keeps the OSS resolve path free + open. */
export class NoopUsageMeter implements UsageMeter {
  record(): void { /* no-op */ }
  usage(tenant_id: string, period_key: string = currentPeriodKey()): UsageSnapshot {
    return { tenant_id, period_key, count: 0 }
  }
  close(): void { /* no-op */ }
}

/**
 * SQLite-backed meter. Enable by passing an instance as
 * `ResolverServerOptions.meter`. Stores a per-(tenant, period) counter in
 * `oid-resolver-usage.db` alongside the main store.
 */
export class SqliteUsageMeter implements UsageMeter {
  private readonly db: Database.Database

  constructor(opts: { dataDir: string }) {
    fs.mkdirSync(opts.dataDir, { recursive: true })
    this.db = new Database(path.join(opts.dataDir, 'oid-resolver-usage.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resolver_usage (
        tenant_id   TEXT NOT NULL,
        period_key  TEXT NOT NULL,
        count       INTEGER NOT NULL DEFAULT 0,
        first_at_ms INTEGER NOT NULL,
        last_at_ms  INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, period_key)
      );
    `)
  }

  record(tenant_id: string, count = 1): void {
    if (count <= 0) return
    const now = Date.now()
    const period_key = currentPeriodKey(now)
    this.db.prepare(`
      INSERT INTO resolver_usage (tenant_id, period_key, count, first_at_ms, last_at_ms)
        VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, period_key) DO UPDATE SET
        count      = count + excluded.count,
        last_at_ms = excluded.last_at_ms
    `).run(tenant_id, period_key, count, now, now)
  }

  usage(tenant_id: string, period_key: string = currentPeriodKey()): UsageSnapshot {
    const row = this.db.prepare(`
      SELECT count FROM resolver_usage WHERE tenant_id = ? AND period_key = ?
    `).get(tenant_id, period_key) as { count: number } | undefined
    return { tenant_id, period_key, count: row?.count ?? 0 }
  }

  /** Every tenant's usage for a period — for an operator's billing reporter. */
  usageForPeriod(period_key: string = currentPeriodKey()): UsageSnapshot[] {
    const rows = this.db.prepare(`
      SELECT tenant_id, count FROM resolver_usage WHERE period_key = ? ORDER BY count DESC
    `).all(period_key) as Array<{ tenant_id: string; count: number }>
    return rows.map((r) => ({ tenant_id: r.tenant_id, period_key, count: r.count }))
  }

  close(): void {
    this.db.close()
  }
}
