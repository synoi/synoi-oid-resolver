/**
 * test/announce.test.ts — auth + validation surface for POST /v1/announce.
 *
 * Covers:
 *   • missing Bearer → 401
 *   • wrong Bearer → 401
 *   • valid Bearer → 200
 *   • invalid OID syntax → 400
 *   • missing location_url → 400
 *   • non-http(s) location_url → 400
 *   • malformed JSON URL → 400
 *   • pluggable auth: custom auth function picks tenant_id
 */

import type { Request } from 'express'
import { createResolverServer, BearerTokenAuth } from '../src/server'
import type { ResolverAuth } from '../src/types'
import { mkTmp, makeCounter, http, baseUrl, fakeOid } from './_helpers'

async function main(): Promise<void> {
  const c = makeCounter()
  const dataDir = mkTmp('announce')
  const TOKEN = 'test-token-announce-bbbbbbbbbbbbbbbb'

  const srv = await createResolverServer({
    port:    0,
    dataDir,
    auth:    new BearerTokenAuth({ token: TOKEN, tenantId: 't-announce' }),
  })
  const base = baseUrl(srv)
  const oid = fakeOid('valid')

  // ── No auth ────────────────────────────────────────────────────────────
  const noAuth = await http(base, 'POST', '/v1/announce',
    { oid, location_url: 'https://e.com/x' })
  c.ok('announce.no-auth: 401', noAuth.status === 401)

  // ── Wrong auth ─────────────────────────────────────────────────────────
  const wrongAuth = await http(base, 'POST', '/v1/announce',
    { oid, location_url: 'https://e.com/x' },
    { authorization: 'Bearer not-the-real-token' })
  c.ok('announce.wrong-auth: 401', wrongAuth.status === 401)

  // ── Non-Bearer scheme ──────────────────────────────────────────────────
  const basicAuth = await http(base, 'POST', '/v1/announce',
    { oid, location_url: 'https://e.com/x' },
    { authorization: 'Basic abc' })
  c.ok('announce.basic-auth: 401', basicAuth.status === 401)

  // ── Valid auth ─────────────────────────────────────────────────────────
  const valid = await http(base, 'POST', '/v1/announce',
    { oid, location_url: 'https://e.com/x' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce.valid: 200', valid.status === 200,
    `got ${valid.status}: ${JSON.stringify(valid.json)}`)

  // ── Invalid OID format ─────────────────────────────────────────────────
  const badOid = await http(base, 'POST', '/v1/announce',
    { oid: 'sha256:short', location_url: 'https://e.com/x' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce.bad-oid: 400', badOid.status === 400)

  // ── Missing oid ────────────────────────────────────────────────────────
  const noOid = await http(base, 'POST', '/v1/announce',
    { location_url: 'https://e.com/x' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce.missing-oid: 400', noOid.status === 400)

  // ── Missing location_url ──────────────────────────────────────────────
  const noLoc = await http(base, 'POST', '/v1/announce',
    { oid },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce.missing-loc: 400', noLoc.status === 400)

  // ── Empty location_url ────────────────────────────────────────────────
  const emptyLoc = await http(base, 'POST', '/v1/announce',
    { oid, location_url: '' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce.empty-loc: 400', emptyLoc.status === 400)

  // ── Non-http scheme ───────────────────────────────────────────────────
  const ftp = await http(base, 'POST', '/v1/announce',
    { oid, location_url: 'ftp://e.com/x' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce.ftp-scheme: 400', ftp.status === 400)

  // ── Malformed URL ─────────────────────────────────────────────────────
  const malformed = await http(base, 'POST', '/v1/announce',
    { oid, location_url: 'not a url' },
    { authorization: `Bearer ${TOKEN}` })
  c.ok('announce.malformed-url: 400', malformed.status === 400)

  await srv.close()

  // ── Pluggable auth: custom function selects tenant_id from header ─────
  const dataDir2 = mkTmp('announce-custom')
  const customAuth: ResolverAuth = {
    async authenticate(req: Request) {
      const tenant = req.headers['x-tenant-id']
      if (typeof tenant !== 'string' || tenant.length === 0) {
        return { ok: false as const, reason: 'missing X-Tenant-Id' }
      }
      return { ok: true as const, tenant_id: tenant }
    },
  }
  const srv2 = await createResolverServer({
    port: 0, dataDir: dataDir2, auth: customAuth,
  })
  const base2 = baseUrl(srv2)

  const noTenant = await http(base2, 'POST', '/v1/announce',
    { oid, location_url: 'https://e.com/x' })
  c.ok('custom-auth.missing-tenant: 401', noTenant.status === 401)

  const withTenant = await http(base2, 'POST', '/v1/announce',
    { oid, location_url: 'https://e.com/x' },
    { 'x-tenant-id': 't-custom' })
  c.ok('custom-auth.with-tenant: 200', withTenant.status === 200)
  await srv2.close()

  const s = c.summary()
  process.stdout.write(`\n${s.passed} passed, ${s.failed} failed\n`)
  process.exit(s.failed > 0 ? 1 : 0)
}

void main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
