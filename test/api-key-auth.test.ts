// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * test/api-key-auth.test.ts — ApiKeyAuth issue / authenticate / revoke.
 */

import type { Request } from 'express'
import { ApiKeyAuth } from '../src/api-key-auth'
import { makeCounter, mkTmp } from './_helpers'

function fakeReq(headers: Record<string, string>): Request {
  return { headers } as unknown as Request
}

async function main(): Promise<number> {
  const c = mkTmp('apikey')
  const auth = new ApiKeyAuth({ dataDir: c })
  const t = makeCounter()

  // Issue → returns raw key once, correct prefix + tenant.
  const issued = auth.issueKey('acme', 'prod')
  t.ok('1: key has orsk_ prefix', issued.key.startsWith('orsk_'))
  t.ok('1: key_prefix is a short display prefix', issued.key_prefix.length === 'orsk_'.length + 6)
  t.ok('1: tenant echoed', issued.tenant_id === 'acme')

  // Authenticate via Bearer → resolves the tenant.
  const okBearer = await auth.authenticate(fakeReq({ authorization: `Bearer ${issued.key}` }))
  t.ok('2: valid Bearer authenticates', okBearer.ok === true)
  t.ok('2: attributes to tenant', okBearer.ok && okBearer.tenant_id === 'acme')

  // Authenticate via x-api-key header → also works.
  const okXkey = await auth.authenticate(fakeReq({ 'x-api-key': issued.key }))
  t.ok('3: valid x-api-key authenticates', okXkey.ok === true)

  // Missing / malformed key → rejected.
  const noKey = await auth.authenticate(fakeReq({}))
  t.ok('4: missing key rejected', noKey.ok === false)
  const badFmt = await auth.authenticate(fakeReq({ authorization: 'Bearer not-an-orsk-key' }))
  t.ok('4: wrong-prefix key rejected', badFmt.ok === false)

  // Unknown key (never issued) → rejected.
  const unknown = await auth.authenticate(fakeReq({ authorization: 'Bearer orsk_deadbeefdeadbeef' }))
  t.ok('5: unknown key rejected', unknown.ok === false)

  // Revoke → subsequent auth fails; revoking again is a no-op.
  t.ok('6: revoke returns true for a live key', auth.revokeKey(issued.key) === true)
  const afterRevoke = await auth.authenticate(fakeReq({ authorization: `Bearer ${issued.key}` }))
  t.ok('6: revoked key no longer authenticates', afterRevoke.ok === false)
  t.ok('6: re-revoke is a no-op', auth.revokeKey(issued.key) === false)

  // Two tenants get distinct attribution.
  const k2 = auth.issueKey('globex')
  const okG = await auth.authenticate(fakeReq({ authorization: `Bearer ${k2.key}` }))
  t.ok('7: second tenant attributes correctly', okG.ok && okG.tenant_id === 'globex')

  auth.close()
  const { passed, failed } = t.summary()
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
  return failed === 0 ? 0 : 1
}

void main().then((code) => process.exit(code))
