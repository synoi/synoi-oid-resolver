# @synoi/oid-resolver

[![npm](https://img.shields.io/npm/v/@synoi/oid-resolver.svg)](https://www.npmjs.com/package/@synoi/oid-resolver)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MIT-licensed reference implementation of the **SynOI OID Resolver protocol** — the lookup layer of the SOF Stack.

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
| GET    | `/v1/resolve/:oid`   | none   | Single-OID lookup; unknown → 200 empty result |
| POST   | `/v1/resolve/batch`  | none   | Up to 100 OIDs per request                    |
| POST   | `/v1/announce`       | bearer | Register a location for an OID                |
| GET    | `/v1/revocations`    | none   | List recent revocations                       |

Shapes match the production SynOI Gateway Resolver — existing clients (`synoi-mcp-server`, the portal, federation peers) work against this reference impl unchanged.

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

- Not an inference broker, not AGP, not Vault — the Resolver protocol is one layer.
- Does NOT verify announced object signatures. That is the verifier's job (`@synoi/cof`).
- Does NOT use the retired name "SRAID" anywhere.

## License

MIT. Copyright (c) 2026 SynOI Inc.
