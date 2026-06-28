/**
 * test/_helpers.ts — shared scaffolding for the tsx-run test suite.
 *
 * Style mirrors synoi-gateway/test/agp-grants-router.test.ts:
 *   manual `ok()` counter, per-file pass/fail summary, exit code from main.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { RunningResolver } from '../src/server'

export function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `synoi-oid-resolver-${prefix}-`))
}

export interface Counter {
  passed: number
  failed: number
  ok(label: string, cond: boolean, detail?: string): void
  summary(): { passed: number; failed: number }
}

export function makeCounter(): Counter {
  const c = {
    passed: 0,
    failed: 0,
    ok(label: string, cond: boolean, detail?: string): void {
      if (cond) {
        c.passed++
        process.stdout.write(`OK   ${label}\n`)
      } else {
        c.failed++
        process.stdout.write(`FAIL ${label}${detail !== undefined ? ' — ' + detail : ''}\n`)
      }
    },
    summary(): { passed: number; failed: number } {
      return { passed: c.passed, failed: c.failed }
    },
  }
  return c
}

export interface HttpResponse {
  status: number
  json:   unknown
}

export async function http(
  base:    string,
  method:  'GET' | 'POST',
  pathStr: string,
  body?:   unknown,
  headers?: Record<string, string>,
): Promise<HttpResponse> {
  const init: RequestInit = { method, headers: { ...(headers ?? {}) } }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  const res = await fetch(`${base}${pathStr}`, init)
  const text = await res.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, json: parsed }
}

export function baseUrl(srv: RunningResolver): string {
  return `http://127.0.0.1:${srv.port}`
}

/** Valid OID stub for tests. */
export function fakeOid(seed: string): string {
  // pad-or-truncate seed to 64 hex chars
  let hex = ''
  for (const ch of seed) {
    const c = ch.charCodeAt(0).toString(16).padStart(2, '0')
    hex += c
    if (hex.length >= 64) break
  }
  while (hex.length < 64) hex += '0'
  return `sha256:${hex.slice(0, 64)}`
}
