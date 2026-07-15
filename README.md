# @synoi/oid-resolver

[![npm](https://img.shields.io/npm/v/@synoi/oid-resolver.svg)](https://www.npmjs.com/package/@synoi/oid-resolver)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

AGPL-3.0-or-later reference implementation of the **SynOI OID Resolver protocol** — the lookup layer of the SRAID stack. The protocol is an open specification; a [SynOI Commercial License](#license) lifts the AGPL obligation for embedders who need it.

Given a content-addressed OID (`sha256:<64 hex>`), a Resolver returns:

- `canonical_locations` — where to fetch the object
- `revoked` / `revoked_at_ms` — revocation status
- `superseded_by` — head-of-chain pointer if a newer version exists
- `signed_by` — which signing keys produced the object
- `first_seen_ms` — when the Resolver first heard of this OID

Anyone can run a Resolver. SynOI's hosted Resolver at `oid.synoi.systems` competes on uptime and reach, not protocol secrecy.

## Install + run with npx

```bash
npx @synoi/oid-resolver --port 4000 --data ./resolver-data
```

Set a bearer token in your environment before authenticated writes work:

```bash
export RESOLVER_BEARER_TOKEN="$(openssl rand -hex 32)"
npx @synoi/oid-resolver --port 4000 --data ./resolver-data
```

## Endpoints

| Method | Path                 | Auth   | Notes                                         |
|--------|----------------------|--------|-----------------------------------------------|
| GET    | `/v1/health`         | none   | Liveness                                      |
| GET    | `/v1/resolve/:oid`   | none\* | Single-OID lookup; unknown → 200 empty result |
| POST   | `/v1/resolve/batch`  | none\* | Up to 100 OIDs per request                    |
| POST   | `/v1/announce`       | bearer | Register a location for an OID                |
| GET    | `/v1/revocations`    | none   | List recent revocations                       |

\* Open and uncounted by default. In [metered operation](#metered-operation) the resolve endpoints require a per-tenant API key and count billable verifications.

Shapes match the production SynOI Gateway Resolver — existing clients (`synoi-mcp-server`, the portal, federation peers) work against this reference impl unchanged.

## Metered operation

The neutral resolver can be sold as a metered network service. Metering is
**opt-in** — pass a `UsageMeter` and a tenant-aware `auth`, and the resolve
endpoints then require an API key, attribute each lookup to a tenant, and
count billable verifications. **Self-verification (resolving an OID you
announced) is never counted.** Omit the meter and resolve stays open + free —
the neutral self-host path this package is designed for.

```ts
import express from 'express'
import {
  createResolverApp, ApiKeyAuth, SqliteUsageMeter,
} from '@synoi/oid-resolver'

const auth  = new ApiKeyAuth({ dataDir: './data' })
const meter = new SqliteUsageMeter({ dataDir: './data' })

// Issue a key to a customer (shown once — store it now):
const { key } = auth.issueKey('acme-corp', 'prod')

const { app } = createResolverApp({ dataDir: './data', auth, meter })
express().use('/oid', app).listen(8080)

// A billing job reads per-tenant counts and posts overage to your provider:
meter.usageForPeriod()   // → [{ tenant_id: 'acme-corp', period_key: '2026-07', count: 1240 }]
```

This package **counts**; it deliberately does not enforce an allowance or bill
— the allowance policy, hard-stop, and provider integration are the operator's
(the SynOI hosted resolver enforces `resolver_lookups:N/mo` and posts monthly
overage to Paddle).

## Embedding

```ts
import express from 'express'
import { createResolverApp, BearerTokenAuth } from '@synoi/oid-resolver'

const app = express()
const { app: resolver } = createResolverApp({
  dataDir:     './data',
  auth:        new BearerTokenAuth({ token: process.env.MY_TOKEN, tenantId: 'acme' }),
  upstreamUrl: 'https://oid.synoi.systems',
})
app.use('/oid', resolver)
app.listen(8080)
```

## docker-compose

```yaml
services:
  oid-resolver:
    image: node:20-alpine
    working_dir: /app
    environment:
      - RESOLVER_BEARER_TOKEN=${RESOLVER_BEARER_TOKEN}
    ports:
      - "4000:4000"
    volumes:
      - ./resolver-data:/app/resolver-data
    command: >
      sh -c "npm i -g @synoi/oid-resolver
             && synoi-oid-resolver --port 4000 --data /app/resolver-data"
```

## Federation

Pass `--upstream https://oid.synoi.systems` (or `RESOLVER_UPSTREAM_URL=...`). When a `/v1/resolve/:oid` lookup misses locally, the Resolver asks the upstream. Unreachable upstream → local empty result (never 5xx).

## What this package is NOT

- Not an inference broker, not GAP, not Vault — the Resolver protocol is one layer.
- Does NOT verify announced object signatures. That is the verifier's job at fetch time; the Resolver only indexes `(oid → location)` and revocation/supersession status.

## License

**AGPL-3.0-or-later.** Copyright (c) 2026 SynOI Inc. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Running the unmodified package, or self-hosting for your own use, is fully
covered by the AGPL. If you run a **modified** version as a network service,
the AGPL requires you to offer users its complete source. A **SynOI Commercial
License** removes that obligation — it is issued as an offline, Ed25519-signed
token this package can verify locally:

```ts
import { checkCommercialLicense } from '@synoi/oid-resolver'
// Reads SYNOI_COMMERCIAL_LICENSE + SYNOI_LICENSE_PUBKEY:
const status = await checkCommercialLicense()   // → { commercial: true, licensee, expires_at }
```

Obtain a commercial license at https://synoi.systems/resolver. The Resolver
**protocol** (wire shapes + endpoint contracts) is an open specification — the
copyleft covers this implementation, not the protocol.
