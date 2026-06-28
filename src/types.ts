/**
 * types.ts — public types for the OID Resolver protocol.
 *
 * These shapes match the SynOI Gateway's production Resolver
 * (synoi-gateway/src/oid-resolver-router.ts) so any existing client
 * (synoi-mcp-server, the portal, federation peers) works against this
 * reference implementation unchanged.
 *
 * No SRAID. The naming retired on 2026-05-22; this is the OID Resolver
 * inside the SOF Stack family.
 */

import type { Request } from 'express'

/** Canonical OID format: `sha256:` + 64 hex chars. */
export const OID_REGEX = /^sha256:[0-9a-f]{64}$/

/** Single-OID resolution result returned by GET /v1/resolve/:oid. */
export interface ResolveResult {
  oid:                 string
  canonical_locations: string[]
  revoked:             boolean
  revoked_at_ms:       number | null
  superseded_by:       string | null
  signed_by:           string[]
  first_seen_ms:       number | null
  /** Object type label (e.g. "agp:grant") if the Resolver knows it. */
  type:                string | null
}

/** Batch error shape (per-OID) returned in POST /v1/resolve/batch results. */
export interface BatchErrorEntry {
  oid:   unknown
  error: 'invalid_oid' | 'lookup_failed'
}

/** Batch response envelope. */
export interface BatchResolveResponse {
  results: Array<ResolveResult | BatchErrorEntry>
  count:   number
}

/** Inbound POST /v1/announce payload. */
export interface AnnounceRequest {
  oid:          string
  location_url: string
}

/** POST /v1/announce success response. */
export interface AnnounceResponse {
  ok:               true
  oid:              string
  announced_at_ms:  number
}

/** GET /v1/revocations response row. */
export interface RevocationListEntry {
  revocation_oid:  string
  tenant_id:       string
  target_kind:     string
  target_oid:      string
  required_level:  string | null
  provisional:     boolean
  effective_at_ms: number
  lifted_at_ms:    number | null
  reason:          string | null
}

/** GET /v1/revocations response envelope. */
export interface RevocationListResponse {
  count:       number
  revocations: RevocationListEntry[]
}

/** Resolved authentication context attached to authenticated requests. */
export interface ResolverAuthContext {
  tenant_id: string
}

/**
 * Pluggable auth interface. The reference impl ships a `BearerTokenAuth`
 * that reads RESOLVER_BEARER_TOKEN from env; operators can swap in their
 * own (LDAP, mTLS, JWT, key-store-backed, etc.) by implementing this
 * single method.
 */
export interface ResolverAuth {
  authenticate(req: Request): Promise<
    | { ok: true; tenant_id: string }
    | { ok: false; reason: string }
  >
}

/** Options for createResolverServer. */
export interface ResolverServerOptions {
  /** Filesystem directory for the SQLite db. Defaults to `./resolver-data`. */
  dataDir?: string
  /** Pluggable auth for write endpoints. Defaults to BearerTokenAuth. */
  auth?: ResolverAuth
  /**
   * Optional upstream Resolver base URL (e.g. https://oid.synoi.systems).
   * If set, /v1/resolve/:oid misses fall back to this peer.
   */
  upstreamUrl?: string
  /** Test/embedding hook: pass a pre-built store instead of opening one. */
  store?: ResolverStore
}

/**
 * Storage interface — separated so operators can plug in non-SQLite
 * backends (PostgreSQL, DynamoDB, federation cache) without touching
 * route code.
 */
export interface ResolverStore {
  announce(input: {
    oid:          string
    tenant_id:    string
    location_url: string
    now_ms:       number
  }): void

  resolve(oid: string): ResolveResult

  recordRevocation(input: {
    revocation_oid:  string
    tenant_id:       string
    target_kind:     string
    target_oid:      string
    required_level?: string | null
    provisional?:    boolean
    effective_at_ms: number
    reason?:         string | null
  }): void

  listRevocations(opts: {
    limit:        number
    before_ms?:   number
    target_kind?: string
    tenant_id?:   string
  }): RevocationListEntry[]

  close(): void
}
