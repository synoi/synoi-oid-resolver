// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * federation.ts — optional fallback to an upstream Resolver.
 *
 * When configured, the resolve routes call FederationClient.resolve(oid)
 * on a local miss and adopt the upstream result if it has non-empty
 * locations or marks the OID revoked/superseded. Network failures are
 * swallowed (the caller falls back to the local empty result) — no 5xx
 * is ever surfaced for a federation timeout.
 *
 * `fetchImpl` is injectable so tests can substitute a stub without
 * monkey-patching globalThis.
 */

import type { ResolveResult } from './types'
import { OID_REGEX } from './types'

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export interface FederationClientOptions {
  upstreamUrl: string
  /** Per-request timeout in ms. Default 2000. */
  timeoutMs?:  number
  /** Test seam — defaults to globalThis.fetch. */
  fetchImpl?:  FetchLike
}

export interface FederationClient {
  resolve(oid: string): Promise<ResolveResult | null>
}

export function createFederationClient(opts: FederationClientOptions): FederationClient {
  const base       = opts.upstreamUrl.replace(/\/+$/, '')
  const timeoutMs  = opts.timeoutMs ?? 2000
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)

  return {
    async resolve(oid: string): Promise<ResolveResult | null> {
      if (!OID_REGEX.test(oid)) return null
      const url = `${base}/v1/resolve/${encodeURIComponent(oid)}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const resp = await doFetch(url, {
          method: 'GET',
          headers: { 'accept': 'application/json' },
          signal: controller.signal,
        })
        if (!resp.ok) return null
        const json = await resp.json() as unknown
        return coerceResolveResult(json)
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function coerceResolveResult(raw: unknown): ResolveResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['oid'] !== 'string') return null
  const locations = Array.isArray(r['canonical_locations'])
    ? (r['canonical_locations'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  const signed_by = Array.isArray(r['signed_by'])
    ? (r['signed_by'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  return {
    oid:                 r['oid'],
    canonical_locations: locations,
    revoked:             r['revoked'] === true,
    revoked_at_ms:       typeof r['revoked_at_ms'] === 'number' ? r['revoked_at_ms'] : null,
    superseded_by:       typeof r['superseded_by'] === 'string' ? r['superseded_by'] : null,
    signed_by,
    first_seen_ms:       typeof r['first_seen_ms'] === 'number' ? r['first_seen_ms'] : null,
    type:                typeof r['type'] === 'string' ? r['type'] : null,
  }
}
