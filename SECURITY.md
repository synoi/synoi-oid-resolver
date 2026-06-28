# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |

## Reporting a vulnerability

**Do not open a GitHub issue for security vulnerabilities.**

- **Preferred:** Use GitHub's [private vulnerability reporting](../../security/advisories/new) — creates a private draft advisory visible only to maintainers, no email required.
- **Alternative:** Submit the form at [synoi.systems/security](https://synoi.systems/security) — for reporters outside of GitHub (IETF mirrors, forks, etc.).

Include:
- A description of the vulnerability and the component affected
- Steps to reproduce or a proof-of-concept
- The potential impact (which security property breaks: revocation lookup, resolution integrity, cross-tenant isolation, etc.)
- Whether you believe it affects the resolver protocol spec (CC0) or only this implementation

We will acknowledge receipt within 72 hours and aim to provide a fix or mitigation plan within 14 days for critical issues.

## Disclosure policy

We follow responsible disclosure. Please allow us to release a fix before publishing details publicly. We will credit reporters in the release notes unless you prefer anonymity.

## Scope

In scope:
- Revocation status bypass (resolved as valid when actually revoked)
- Cross-tenant OID resolution leakage
- Cache poisoning attacks on resolution responses
- Signature verification errors on resolver responses

Out of scope:
- Vulnerabilities in the hosted SynOI resolver service infrastructure (report via the form above — distinct from this OSS library)
- Issues in `@noble/curves` (report upstream)
- Theoretical attacks requiring more than 2^128 operations
