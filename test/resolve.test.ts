/**
 * test/resolve.test.ts — covers:
 *   • GET /v1/resolve/:oid for unknown OID → 200 with empty result
 *   • POST /v1/resolve/batch mixing known + unknown OIDs
 *   • Announce → resolve round-trip (location appears in result)
 *   • GET /v1/health → 200 { ok: true }
 *   • Invalid OID format → 400
 *   • Batch > 100 → 400
 */

import { createResolverServer, BearerTokenAuth } from '../src/server'
import { mkTmp, makeCounter, http, baseUrl, fakeOid } from './_helpers'

async function main(): Promise<void> {
  const c = makeCounter()
  const dataDir = mkTmp('resolve')
  const TOKEN = 'test-token-resolve-aaaaaaaaaaaaaaaa'

  const srv = await createResolverServer({
    port:    0,
    dataDir,
    auth:    new BearerTokenAuth({ token: TOKEN, tenantId: 't-resolve' }),
  })
  const base = baseUrl(srv)

  // ── Health ─────────────────────────────────────────────────────────────
  const health = await http(base, 'GET', '/v1/health')
  c.ok('health: 200', health.status === 200)
  const healthJson = health.json as { ok: boolean; service: string }
  c.ok('health: ok=true', healthJson.ok === true)
  c.ok('health: service=oid-resolver', healthJson.service === 'oid-resolver')

  // ── Unknown OID returns empty result (NOT 404) ─────────────────────────
  const unknown = fakeOid('unknown')
  const u = await http(base, 'GET', `/v1/resolve/${unknown}`)
  c.ok('resolve.unknown: 200', u.status === 200,
    `got ${u.status}: ${JSON.stringify(u.json)}`)
  const uj = u.json as {
    oid: string; canonical_locations: string[]; revoked: boolean;
    superseded_by: string | null; signed_by: string[];
    first_seen_ms: number | null; type: string | null;
  }
  c.ok('resolve.unknown: oid echoed', uj.oid === unknown)
  c.ok('resolve.unknown: empty locations', Array.isArray(uj.canonical_locations) && uj.canonical_locations.length === 0)
  c.ok('resolve.unknown: revoked=false', uj.revoked === false)
  c.ok('resolve.unknown: superseded_by null', uj.superseded_by === null)
  c.ok('resolve.unknown: signed_by empty', Array.isArray(uj.signed_by) && uj.signed_by.length === 0)
  c.ok('resolve.unknown: first_seen_ms null', uj.first_seen_ms === null)
  c.ok('resolve.unknown: type null', uj.type === null)

  // ── Invalid OID syntax ────────────────────────────────────────────────
  const bad = await http(base, 'GET', '/v1/resolve/not-an-oid')
  c.ok('resolve.bad-syntax: 400', bad.status === 400)

  // ── Announce → Resolve round-trip ──────────────────────────────────────
  const oidA = fakeOid('alpha')
  const announce = await http(base, 'POST', '/v1/announce',
    { oid: oidA, location_url: 'https://example.com/objects/alpha' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce: 200', announce.status === 200,
    `got ${announce.status}: ${JSON.stringify(announce.json)}`)
  const aj = announce.json as { ok: boolean; oid: string; announced_at_ms: number }
  c.ok('announce: ok=true', aj.ok === true)
  c.ok('announce: oid echoed', aj.oid === oidA)
  c.ok('announce: announced_at_ms numeric', typeof aj.announced_at_ms === 'number' && aj.announced_at_ms > 0)

  const r = await http(base, 'GET', `/v1/resolve/${oidA}`)
  c.ok('round-trip: 200', r.status === 200)
  const rj = r.json as { canonical_locations: string[]; first_seen_ms: number | null }
  c.ok('round-trip: location present',
    rj.canonical_locations.includes('https://example.com/objects/alpha'))
  c.ok('round-trip: first_seen_ms set',
    typeof rj.first_seen_ms === 'number' && rj.first_seen_ms > 0)

  // Idempotent announce (PK collision → INSERT OR IGNORE)
  const announceAgain = await http(base, 'POST', '/v1/announce',
    { oid: oidA, location_url: 'https://example.com/objects/alpha' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce.idempotent: 200', announceAgain.status === 200)
  const r2 = await http(base, 'GET', `/v1/resolve/${oidA}`)
  const r2j = r2.json as { canonical_locations: string[] }
  c.ok('announce.idempotent: no duplicate location',
    r2j.canonical_locations.length === 1)

  // Multiple locations per OID accumulate
  const announce2 = await http(base, 'POST', '/v1/announce',
    { oid: oidA, location_url: 'https://mirror.example.com/objects/alpha' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce.second-location: 200', announce2.status === 200)
  const r3 = await http(base, 'GET', `/v1/resolve/${oidA}`)
  const r3j = r3.json as { canonical_locations: string[] }
  c.ok('announce.second-location: two locations',
    r3j.canonical_locations.length === 2)

  // ── Batch lookup ──────────────────────────────────────────────────────
  const oidB = fakeOid('beta')
  const batch = await http(base, 'POST', '/v1/resolve/batch', { oids: [oidA, oidB] })
  c.ok('batch: 200', batch.status === 200)
  const bj = batch.json as {
    count: number
    results: Array<{ oid: string; canonical_locations?: string[]; error?: string }>
  }
  c.ok('batch: count=2', bj.count === 2)
  const knownEntry = bj.results.find((x) => x.oid === oidA)
  const unknownEntry = bj.results.find((x) => x.oid === oidB)
  c.ok('batch: known entry has locations',
    knownEntry !== undefined && Array.isArray(knownEntry.canonical_locations)
      && knownEntry.canonical_locations.length === 2)
  c.ok('batch: unknown entry has empty locations',
    unknownEntry !== undefined && Array.isArray(unknownEntry.canonical_locations)
      && unknownEntry.canonical_locations.length === 0)

  // Batch with an invalid OID mixed in
  const batchBad = await http(base, 'POST', '/v1/resolve/batch',
    { oids: [oidA, 'not-an-oid', oidB] })
  c.ok('batch.bad: 200', batchBad.status === 200)
  const bbj = batchBad.json as {
    count: number
    results: Array<{ oid: unknown; error?: string }>
  }
  c.ok('batch.bad: count=3', bbj.count === 3)
  const bad1 = bbj.results.find((x) => x.error === 'invalid_oid')
  c.ok('batch.bad: invalid_oid surfaced', bad1 !== undefined)

  // Batch missing oids → 400
  const batchMissing = await http(base, 'POST', '/v1/resolve/batch', {})
  c.ok('batch.missing: 400', batchMissing.status === 400)

  // Batch over 100 → 400
  const overSized = await http(base, 'POST', '/v1/resolve/batch',
    { oids: new Array(101).fill(oidA) })
  c.ok('batch.over-100: 400', overSized.status === 400)

  await srv.close()
  const s = c.summary()
  process.stdout.write(`\n${s.passed} passed, ${s.failed} failed\n`)
  process.exit(s.failed > 0 ? 1 : 0)
}

void main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
