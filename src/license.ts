// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 SynOI Inc.

/**
 * license.ts — offline commercial-license verification.
 *
 * This package is AGPL-3.0-or-later. Running a modified Resolver as a network
 * service triggers the AGPL's source-availability obligation. A SynOI
 * Commercial License is the paid exception that lifts it. This module lets an
 * embedder self-check that exception WITHOUT calling home: the license is a
 * CBOR map, Ed25519-signed by SynOI, base64url-encoded — the exact token
 * format minted by synoi-control (src/licensing/token.ts). We verify the
 * signature against SynOI's public key and check expiry + the
 * `commercial_license` entitlement.
 *
 * No network, no phone-home. Absent or invalid license → AGPL mode. A valid
 * license → commercial mode (the AGPL notice is suppressed).
 */

import * as ed from '@noble/ed25519'
import { encode, decode } from 'cbor-x'

/**
 * SynOI's Ed25519 public key (hex, 32 bytes) used to verify commercial
 * licenses. Baked at release from the `synoi` tenant signing key. Left empty
 * in source so the OSS build ships no secret and defaults to AGPL mode; set
 * SYNOI_LICENSE_PUBKEY to the real key (or a test key) to enable verification.
 */
export const SYNOI_LICENSE_PUBKEY_HEX = ''

/** Decoded license claims (subset of the synoi-control token). */
export interface LicenseClaims {
  v:   number
  iss: string
  tnt: string
  sub: string       // licensee (email/handle)
  lic: string       // license id
  ent: string[]     // entitlements
  exp: number       // unix seconds
  iat: number
}

export interface LicenseStatus {
  /** True only when a valid, unexpired commercial license is present. */
  commercial: boolean
  reason:     string
  licensee?:  string
  expires_at?: number
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '')
  if (clean.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/**
 * Verify a license token's signature against `pubkeyHex` and return its
 * claims. Throws on decode/signature failure. Mirrors
 * synoi-control/src/licensing/token.ts#verifyToken (sig stripped, remaining
 * CBOR re-encoded as the signed message).
 */
export async function verifyLicenseToken(wire: string, pubkeyHex: string): Promise<LicenseClaims> {
  if (!pubkeyHex) throw new Error('no_verification_key')
  const bytes = base64UrlDecode(wire)
  let decoded: LicenseClaims & { sig: Uint8Array }
  try {
    decoded = decode(bytes) as LicenseClaims & { sig: Uint8Array }
  } catch {
    throw new Error('token_decode_failed')
  }
  if (decoded.v !== 1) throw new Error('token_version_unsupported')
  const { sig, ...unsigned } = decoded
  const msg = encode(unsigned)
  const ok = await ed.verifyAsync(sig, msg, hexToBytes(pubkeyHex))
  if (!ok) throw new Error('token_signature_invalid')
  return unsigned as LicenseClaims
}

/**
 * High-level check: is a valid commercial license present? Reads the token
 * from `opts.token` or SYNOI_COMMERCIAL_LICENSE, and the verification key from
 * `opts.pubkeyHex`, SYNOI_LICENSE_PUBKEY, or the baked constant. Never throws —
 * any failure resolves to `{ commercial: false, reason }` (AGPL mode).
 */
export async function checkCommercialLicense(opts: {
  token?:     string
  pubkeyHex?: string
  now_s?:     number
} = {}): Promise<LicenseStatus> {
  const token  = opts.token ?? process.env['SYNOI_COMMERCIAL_LICENSE'] ?? ''
  const pubkey = opts.pubkeyHex ?? process.env['SYNOI_LICENSE_PUBKEY'] ?? SYNOI_LICENSE_PUBKEY_HEX
  const now_s  = opts.now_s ?? Math.floor(Date.now() / 1000)

  if (!token)  return { commercial: false, reason: 'no license configured' }
  if (!pubkey) return { commercial: false, reason: 'no verification key configured' }

  let claims: LicenseClaims
  try {
    claims = await verifyLicenseToken(token, pubkey)
  } catch (e) {
    return { commercial: false, reason: e instanceof Error ? e.message : 'verification failed' }
  }
  if (typeof claims.exp === 'number' && claims.exp < now_s) {
    return { commercial: false, reason: 'license expired', licensee: claims.sub, expires_at: claims.exp }
  }
  if (!Array.isArray(claims.ent) || !claims.ent.includes('commercial_license')) {
    return { commercial: false, reason: 'license lacks commercial_license entitlement', licensee: claims.sub }
  }
  return { commercial: true, reason: 'valid commercial license', licensee: claims.sub, expires_at: claims.exp }
}

const AGPL_NOTICE =
  '@synoi/oid-resolver is AGPL-3.0-or-later. If you run a modified version as a\n' +
  'network service you must offer users its complete source. A SynOI Commercial\n' +
  'License lifts this obligation: https://synoi.systems/resolver'

/**
 * Print the licensing banner at startup. Commercial → a one-line confirmation;
 * otherwise → the AGPL source-availability notice. Returns the status so
 * callers can branch on it too.
 */
export async function printLicenseBanner(
  logger: { log: (m: string) => void } = console,
): Promise<LicenseStatus> {
  const status = await checkCommercialLicense()
  if (status.commercial) {
    logger.log(`[license] SynOI Commercial License active (licensee: ${status.licensee ?? 'unknown'})`)
  } else {
    logger.log(`[license] ${AGPL_NOTICE}`)
  }
  return status
}
