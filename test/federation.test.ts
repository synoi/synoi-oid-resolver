/**
 * test/federation.test.ts — upstream Resolver fallback.
 *
 * Two scenarios:
 *   1. Local miss + upstream hit: upstream's result is returned through
 *      the local Resolver's GET /v1/resolve/:oid.
 *   2. Local miss + upstream unreachable: local empty result is returned;
 *      response is still 200.
 *
 * Strategy: stand up a "primary" Resolver pointing at a real "upstream"
 * Resolver. Announce an OID against the upstream, then resolve it via
 * the primary — the upstream answer should surface. Stop the upstream,
 * resolve a different OID via the primary, and verify a clean miss.
 */

import { createResolverServer, BearerTokenAuth } from '../src/server'
import { mkTmp, makeCounter, http, baseUrl, fakeOid } from './_helpers'

async function main(): Promise<void> {
  const c = makeCounter()

  const upstreamDir = mkTmp('fed-upstream')
  const primaryDir  = mkTmp('fed-primary')
  const TOKEN = 'test-token-federation-dddddddddddddd'

  const upstream = await createResolverServer({
    port: 0, dataDir: upstreamDir,
    auth: new BearerTokenAuth({ token: TOKEN, tenantId: 't-upstream' }),
  })
  const upstreamBase = baseUrl(upstream)

  // Seed an OID on the upstream
  const oid = fakeOid('federated')
  const ann = await http(upstreamBase, 'POST', '/v1/announce',
    { oid, location_url: 'https://upstream.example.com/objects/x' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('upstream.announce: 200', ann.status === 200)

  const primary = await createResolverServer({
    port: 0, dataDir: primaryDir,
    auth: new BearerTokenAuth({ token: TOKEN, tenantId: 't-primary' }),
    upstreamUrl: upstreamBase,
  })
  const primaryBase = baseUrl(primary)

  // ── 1. Local miss + upstream hit → upstream wins ───────────────────────
  const viaFed = await http(primaryBase, 'GET', `/v1/resolve/${oid}`)
  c.ok('federation.hit: 200', viaFed.status === 200)
  const vf = viaFed.json as { canonical_locations: string[] }
  c.ok('federation.hit: location from upstream',
    vf.canonical_locations.includes('https://upstream.example.com/objects/x'))

  // ── Sanity: local has nothing recorded directly ────────────────────────
  // (resolve via primary again would still go through federation, so we
  //  hit the primary's batch path with a tiny payload — the batch should
  //  also use federation. This is the same code path; we just exercise it.)
  const batchFed = await http(primaryBase, 'POST', '/v1/resolve/batch',
    { oids: [oid] })
  c.ok('federation.batch: 200', batchFed.status === 200)
  const bfJ = batchFed.json as { results: Array<{ canonical_locations?: string[] }> }
  c.ok('federation.batch: upstream location surfaced via batch',
    bfJ.results[0]?.canonical_locations?.includes('https://upstream.example.com/objects/x') === true)

  // ── 2. Upstream unreachable → local empty result ──────────────────────
  await upstream.close()

  const otherOid = fakeOid('unreached')
  const offline = await http(primaryBase, 'GET', `/v1/resolve/${otherOid}`)
  c.ok('federation.miss: 200', offline.status === 200,
    `unexpected status ${offline.status}: ${JSON.stringify(offline.json)}`)
  const oj = offline.json as { canonical_locations: string[]; revoked: boolean }
  c.ok('federation.miss: empty locations',
    Array.isArray(oj.canonical_locations) && oj.canonical_locations.length === 0)
  c.ok('federation.miss: revoked=false', oj.revoked === false)

  // Previously-known OID also falls back to empty when upstream gone
  // (since the primary doesn't have it locally either).
  const alsoOffline = await http(primaryBase, 'GET', `/v1/resolve/${oid}`)
  c.ok('federation.miss-on-known: 200', alsoOffline.status === 200)
  const aoJ = alsoOffline.json as { canonical_locations: string[] }
  c.ok('federation.miss-on-known: empty (upstream gone)',
    aoJ.canonical_locations.length === 0)

  await primary.close()

  // ── 3. No upstream configured = pure local resolver, no network ───────
  const soloDir = mkTmp('fed-solo')
  const solo = await createResolverServer({
    port: 0, dataDir: soloDir,
    auth: new BearerTokenAuth({ token: TOKEN, tenantId: 't-solo' }),
  })
  const soloBase = baseUrl(solo)
  const soloMiss = await http(soloBase, 'GET', `/v1/resolve/${oid}`)
  c.ok('solo.miss: 200', soloMiss.status === 200)
  const smJ = soloMiss.json as { canonical_locations: string[] }
  c.ok('solo.miss: empty locations', smJ.canonical_locations.length === 0)
  await solo.close()

  const s = c.summary()
  process.stdout.write(`\n${s.passed} passed, ${s.failed} failed\n`)
  process.exit(s.failed > 0 ? 1 : 0)
}

void main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
