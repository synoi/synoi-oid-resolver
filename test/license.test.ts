// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * test/license.test.ts — commercial-license verification.
 *
 * Mints tokens with a throwaway Ed25519 keypair (same CBOR + Ed25519 + base64url
 * format as synoi-control) and checks the accept / reject paths.
 */

import * as ed from '@noble/ed25519'
import { encode } from 'cbor-x'
import { checkCommercialLicense } from '../src/license'
import { makeCounter } from './_helpers'

interface Claims {
  v: number; iss: string; tnt: string; sub: string
  lic: string; ent: string[]; exp: number; iat: number
}

async function mint(priv: Uint8Array, claims: Claims): Promise<string> {
  const sig = await ed.signAsync(encode(claims), priv)
  const wire = encode({ ...claims, sig })
  return Buffer.from(wire).toString('base64url')
}

async function main(): Promise<number> {
  const t = makeCounter()
  const now = Math.floor(Date.now() / 1000)

  const priv = ed.utils.randomPrivateKey()
  const pub  = await ed.getPublicKeyAsync(priv)
  const pubkeyHex = Buffer.from(pub).toString('hex')

  const base: Claims = {
    v: 1, iss: 'synoi', tnt: 'synoi', sub: 'acme@example.com',
    lic: 'lic_test', ent: ['commercial_license'], iat: now, exp: now + 3600,
  }

  // Valid, unexpired, correct entitlement → commercial.
  const good = await checkCommercialLicense({ token: await mint(priv, base), pubkeyHex, now_s: now })
  t.ok('1: valid license → commercial', good.commercial === true)
  t.ok('1: licensee surfaced', good.licensee === 'acme@example.com')

  // Expired → not commercial.
  const expired = await checkCommercialLicense({
    token: await mint(priv, { ...base, exp: now - 10 }), pubkeyHex, now_s: now,
  })
  t.ok('2: expired license → not commercial', expired.commercial === false)
  t.ok('2: reason mentions expiry', /expired/.test(expired.reason))

  // Missing the commercial_license entitlement → not commercial.
  const noEnt = await checkCommercialLicense({
    token: await mint(priv, { ...base, ent: ['hosted_gateway'] }), pubkeyHex, now_s: now,
  })
  t.ok('3: missing entitlement → not commercial', noEnt.commercial === false)

  // Signed by a DIFFERENT key → signature invalid.
  const otherPriv = ed.utils.randomPrivateKey()
  const forged = await checkCommercialLicense({
    token: await mint(otherPriv, base), pubkeyHex, now_s: now,
  })
  t.ok('4: wrong-key signature → not commercial', forged.commercial === false)
  t.ok('4: reason is signature failure', /signature/.test(forged.reason))

  // No verification key configured → safe default (AGPL mode).
  const noKey = await checkCommercialLicense({ token: await mint(priv, base), pubkeyHex: '', now_s: now })
  t.ok('5: no verification key → not commercial', noKey.commercial === false)

  // No token at all → not commercial.
  const noToken = await checkCommercialLicense({ token: '', pubkeyHex, now_s: now })
  t.ok('6: no token → not commercial', noToken.commercial === false)

  // Garbage token → not commercial, does not throw.
  const garbage = await checkCommercialLicense({ token: 'not-a-real-token', pubkeyHex, now_s: now })
  t.ok('7: garbage token → not commercial (no throw)', garbage.commercial === false)

  const { passed, failed } = t.summary()
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
  return failed === 0 ? 0 : 1
}

void main().then((code) => process.exit(code))
