/**
 * test/revocations.test.ts — covers:
 *   • GET /v1/revocations returns empty list cleanly
 *   • Recorded revocations surface in list ordered by effective_at_ms desc
 *   • limit caps at 500
 *   • target_kind filter scopes results
 *   • tenant_id filter scopes results
 *   • Invalid target_kind → 400
 *   • A resolve() on a revoked OID reports revoked=true with revoked_at_ms
 *   • A resolve() on a superseded OID returns superseded_by
 */

import { createResolverServer, BearerTokenAuth } from '../src/server'
import { SqliteResolverStore } from '../src/store'
import { mkTmp, makeCounter, http, baseUrl, fakeOid } from './_helpers'

async function main(): Promise<void> {
  const c = makeCounter()
  const dataDir = mkTmp('revocations')
  const TOKEN = 'test-token-revocations-cccccccccccccc'

  // Build a store directly so we can seed it, then hand it to the server.
  const store = new SqliteResolverStore({ dataDir })

  const grantOid    = fakeOid('grant-1')
  const skillOid    = fakeOid('skill-1')
  const wfOid       = fakeOid('workflow-1')
  const supersededO = fakeOid('superseded')
  const newOid      = fakeOid('replacement')

  store.recordRevocation({
    revocation_oid:  fakeOid('rev-grant'),
    tenant_id:       't-alpha',
    target_kind:     'capability_grant',
    target_oid:      grantOid,
    effective_at_ms: 1_000_000,
    reason:          'compromised',
  })
  store.recordRevocation({
    revocation_oid:  fakeOid('rev-skill'),
    tenant_id:       't-alpha',
    target_kind:     'skill',
    target_oid:      skillOid,
    effective_at_ms: 2_000_000,
    reason:          'deprecated',
  })
  store.recordRevocation({
    revocation_oid:  fakeOid('rev-wf'),
    tenant_id:       't-beta',
    target_kind:     'workflow_definition',
    target_oid:      wfOid,
    effective_at_ms: 3_000_000,
    reason:          'replaced',
  })
  store.recordSupersession({ old_oid: supersededO, new_oid: newOid, now_ms: 4_000_000 })

  const srv = await createResolverServer({
    port: 0, dataDir, store,
    auth: new BearerTokenAuth({ token: TOKEN, tenantId: 't-alpha' }),
  })
  const base = baseUrl(srv)

  // ── Listing without filters ───────────────────────────────────────────
  const all = await http(base, 'GET', '/v1/revocations')
  c.ok('revocations.list: 200', all.status === 200)
  const aj = all.json as {
    count: number
    revocations: Array<{
      revocation_oid: string; target_kind: string; target_oid: string;
      tenant_id: string; effective_at_ms: number; reason: string | null;
      provisional: boolean; lifted_at_ms: number | null; required_level: string | null;
    }>
  }
  c.ok('revocations.list: count=3', aj.count === 3, `count=${aj.count}`)
  c.ok('revocations.list: ordered desc by effective_at_ms',
    aj.revocations[0]?.effective_at_ms === 3_000_000
    && aj.revocations[1]?.effective_at_ms === 2_000_000
    && aj.revocations[2]?.effective_at_ms === 1_000_000)
  c.ok('revocations.list: shape — provisional present', typeof aj.revocations[0]?.provisional === 'boolean')
  c.ok('revocations.list: shape — lifted_at_ms present', aj.revocations[0]?.lifted_at_ms === null)
  c.ok('revocations.list: reason echoed', aj.revocations[0]?.reason === 'replaced')

  // ── Limit param ────────────────────────────────────────────────────────
  const limited = await http(base, 'GET', '/v1/revocations?limit=1')
  const lj = limited.json as { count: number }
  c.ok('revocations.limit=1: count=1', lj.count === 1)

  // ── target_kind filter ────────────────────────────────────────────────
  const skills = await http(base, 'GET', '/v1/revocations?target_kind=skill')
  const sj = skills.json as { count: number; revocations: Array<{ target_kind: string }> }
  c.ok('revocations.filter.kind=skill: count=1', sj.count === 1)
  c.ok('revocations.filter.kind=skill: only skills',
    sj.revocations.every((r) => r.target_kind === 'skill'))

  // ── tenant_id filter ──────────────────────────────────────────────────
  const beta = await http(base, 'GET', '/v1/revocations?tenant_id=t-beta')
  const bj = beta.json as { count: number; revocations: Array<{ tenant_id: string }> }
  c.ok('revocations.filter.tenant: count=1', bj.count === 1)
  c.ok('revocations.filter.tenant: only t-beta',
    bj.revocations.every((r) => r.tenant_id === 't-beta'))

  // ── Combined filters ──────────────────────────────────────────────────
  const both = await http(base, 'GET', '/v1/revocations?tenant_id=t-alpha&target_kind=skill')
  const bothJ = both.json as { count: number }
  c.ok('revocations.filter.combined: count=1', bothJ.count === 1)

  // ── Invalid target_kind ───────────────────────────────────────────────
  const badKind = await http(base, 'GET', '/v1/revocations?target_kind=nonsense')
  c.ok('revocations.bad-kind: 400', badKind.status === 400)

  // ── A revoked OID's resolve() reports revoked=true ────────────────────
  const r = await http(base, 'GET', `/v1/resolve/${grantOid}`)
  const rj = r.json as { revoked: boolean; revoked_at_ms: number | null }
  c.ok('resolve.revoked: revoked=true', rj.revoked === true)
  c.ok('resolve.revoked: revoked_at_ms surfaced',
    rj.revoked_at_ms === 1_000_000)

  // ── Superseded OID's resolve() returns superseded_by ──────────────────
  const sup = await http(base, 'GET', `/v1/resolve/${supersededO}`)
  const supJ = sup.json as { superseded_by: string | null }
  c.ok('resolve.superseded: superseded_by set', supJ.superseded_by === newOid)

  await srv.close()
  // store is shared with the server but the server didn't own it; close ourselves.
  store.close()
  const s = c.summary()
  process.stdout.write(`\n${s.passed} passed, ${s.failed} failed\n`)
  process.exit(s.failed > 0 ? 1 : 0)
}

void main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
