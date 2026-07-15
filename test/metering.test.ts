// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * test/metering.test.ts — end-to-end metered resolve.
 *
 * Verifies: resolve requires a key when metered; self-verification (an OID the
 * tenant announced) is free; cross-verification is counted; batch counts only
 * billable OIDs; and with no meter, resolve is open + uncounted.
 */

import { createResolverServer } from '../src/server'
import { ApiKeyAuth } from '../src/api-key-auth'
import { SqliteUsageMeter } from '../src/metering'
import { makeCounter, mkTmp, http, baseUrl, fakeOid } from './_helpers'

async function main(): Promise<number> {
  const t = makeCounter()

  // ── Metered server ────────────────────────────────────────────────────────
  const dir   = mkTmp('metered')
  const auth  = new ApiKeyAuth({ dataDir: dir })
  const meter = new SqliteUsageMeter({ dataDir: dir })
  const acme  = auth.issueKey('acme')
  const srv   = await createResolverServer({ dataDir: dir, store: undefined, auth, meter, port: 0 })
  const base  = baseUrl(srv)
  const H = (k: string) => ({ authorization: `Bearer ${k}` })

  const selfOid  = fakeOid('acme-owned')
  const otherOid = fakeOid('someone-else')

  // Announce selfOid as acme so it counts as self-verification later.
  const ann = await http(base, 'POST', '/v1/announce',
    { oid: selfOid, location_url: 'https://acme.example/obj' }, H(acme.key))
  t.ok('0: announce as acme ok', ann.status === 200)

  // No key → 401.
  const noKey = await http(base, 'GET', `/v1/resolve/${selfOid}`)
  t.ok('1: metered resolve without key → 401', noKey.status === 401)

  // Self-verify → 200 and NOT counted.
  const self = await http(base, 'GET', `/v1/resolve/${selfOid}`, undefined, H(acme.key))
  t.ok('2: self-verify → 200', self.status === 200)
  t.ok('2: self-verify not counted', meter.usage('acme').count === 0)

  // Cross-verify → 200 and counted.
  const cross = await http(base, 'GET', `/v1/resolve/${otherOid}`, undefined, H(acme.key))
  t.ok('3: cross-verify → 200', cross.status === 200)
  t.ok('3: cross-verify counted (used=1)', meter.usage('acme').count === 1)

  // Batch of 3: selfOid (free) + 2 others (billable) → +2.
  const batch = await http(base, 'POST', '/v1/resolve/batch',
    { oids: [selfOid, fakeOid('b1'), fakeOid('b2')] }, H(acme.key))
  t.ok('4: batch → 200', batch.status === 200)
  t.ok('4: batch counts only billable (used=3)', meter.usage('acme').count === 3)

  // Batch without a key → 401 and no count change.
  const batchNoKey = await http(base, 'POST', '/v1/resolve/batch', { oids: [otherOid] })
  t.ok('5: metered batch without key → 401', batchNoKey.status === 401)
  t.ok('5: refused batch did not count', meter.usage('acme').count === 3)

  // usageForPeriod surfaces the tenant tally for a billing reporter.
  const period = meter.usageForPeriod()
  t.ok('6: usageForPeriod lists acme=3',
    period.some((u) => u.tenant_id === 'acme' && u.count === 3))

  await srv.close(); auth.close(); meter.close()

  // ── Open server (no meter) — resolve stays public + uncounted ─────────────
  const dir2 = mkTmp('open')
  const srv2 = await createResolverServer({ dataDir: dir2, port: 0 })
  const base2 = baseUrl(srv2)
  const open = await http(base2, 'GET', `/v1/resolve/${fakeOid('anon')}`)
  t.ok('7: no-meter resolve is open (200, no key)', open.status === 200)
  await srv2.close()

  const { passed, failed } = t.summary()
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
  return failed === 0 ? 0 : 1
}

void main().then((code) => process.exit(code))
