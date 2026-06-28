#!/usr/bin/env node
/**
 * cli.ts — `npx @synoi/oid-resolver` entrypoint.
 *
 * Parses a small argv surface, picks port + data dir, starts the
 * Resolver server, logs structured JSON, and shuts down cleanly on
 * SIGTERM/SIGINT.
 *
 * Usage:
 *   npx @synoi/oid-resolver --port 4000 --data ./resolver-data \
 *       [--upstream https://oid.synoi.systems]
 *
 * Env:
 *   RESOLVER_BEARER_TOKEN   required to use POST /v1/announce
 *   RESOLVER_TENANT_ID      tenant id reported by the default auth
 *   PORT                    alternative to --port
 */

import * as path from 'node:path'
import { createResolverServer } from './server'

interface Args {
  port:     number
  dataDir:  string
  upstream: string | undefined
  help:     boolean
  version:  boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    port:     Number(process.env['PORT'] ?? 4000),
    dataDir:  path.resolve(process.cwd(), 'resolver-data'),
    upstream: process.env['RESOLVER_UPSTREAM_URL'],
    help:     false,
    version:  false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--help':
      case '-h':
        out.help = true
        break
      case '--version':
      case '-v':
        out.version = true
        break
      case '--port':
      case '-p': {
        const next = argv[++i]
        if (next === undefined) throw new Error('--port requires a value')
        const n = Number(next)
        if (!Number.isFinite(n) || n <= 0 || n > 65535) {
          throw new Error(`invalid --port value: ${next}`)
        }
        out.port = n
        break
      }
      case '--data':
      case '--data-dir':
      case '-d': {
        const next = argv[++i]
        if (next === undefined) throw new Error('--data requires a value')
        out.dataDir = path.resolve(next)
        break
      }
      case '--upstream':
      case '-u': {
        const next = argv[++i]
        if (next === undefined) throw new Error('--upstream requires a value')
        out.upstream = next
        break
      }
      default:
        if (a !== undefined && a.length > 0) {
          throw new Error(`unknown argument: ${a}`)
        }
    }
  }
  return out
}

function printHelp(): void {
  process.stdout.write(
`@synoi/oid-resolver — reference implementation of the SynOI OID Resolver protocol.

USAGE
  npx @synoi/oid-resolver [options]

OPTIONS
  -p, --port <n>          Port to bind (default 4000 or $PORT)
  -d, --data <dir>        SQLite data directory (default ./resolver-data)
  -u, --upstream <url>    Optional upstream Resolver for federation fallback
  -h, --help              Show this help and exit
  -v, --version           Print version and exit

ENV
  RESOLVER_BEARER_TOKEN   Bearer token required to call POST /v1/announce
  RESOLVER_TENANT_ID      Tenant id reported for authenticated requests
  RESOLVER_UPSTREAM_URL   Equivalent to --upstream
  PORT                    Equivalent to --port

ENDPOINTS
  GET  /v1/health
  GET  /v1/resolve/:oid
  POST /v1/resolve/batch
  POST /v1/announce        (Bearer auth required)
  GET  /v1/revocations
`,
  )
}

function log(level: 'info' | 'error', fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), ...fields })
  if (level === 'error') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

async function main(): Promise<void> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n`)
    printHelp()
    process.exit(2)
  }

  if (args.help) { printHelp(); process.exit(0) }
  if (args.version) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const pkg = require('../package.json') as { version: string }
    process.stdout.write(`${pkg.version}\n`)
    process.exit(0)
  }

  const running = await createResolverServer({
    port:    args.port,
    dataDir: args.dataDir,
    ...(args.upstream !== undefined ? { upstreamUrl: args.upstream } : {}),
  })

  log('info', {
    msg:      'oid-resolver listening',
    port:     running.port,
    dataDir:  args.dataDir,
    upstream: args.upstream ?? null,
  })

  const shutdown = (signal: string): void => {
    log('info', { msg: 'shutdown requested', signal })
    running.close().then(
      () => { log('info', { msg: 'shutdown complete' }); process.exit(0) },
      (e: unknown) => {
        log('error', { msg: 'shutdown failed', err: e instanceof Error ? e.message : String(e) })
        process.exit(1)
      },
    )
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

void main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
