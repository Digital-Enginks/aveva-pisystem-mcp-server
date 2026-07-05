# Threat Model & Security Posture — AVEVA PI System MCP Server

> [!NOTE]
> This is the **canonical** threat model, referenced by the development plan (§6.2.7). A copy at the repository root (`/THREAT_MODEL.md`) is retained for discoverability; this `docs/security/` version is authoritative.

This document models threats against the stateless, zero-trust Model Context Protocol (MCP) server for the AVEVA PI System Web API. It uses **STRIDE** over the four-layer architecture (Protocol → Controller → Gateway → PI Web API) plus an explicit trust-boundary description.

---

## 1. Architecture & trust-boundary diagram

```
              inbound trust boundary                 outbound trust boundary
                       |                                       |
[MCP Client] <-- stdio / http --> [Protocol Layer] -> [Controller] -> [Gateway] == TLS ==> [PI Web API]
                       |            (edge auth /                                  |
                       |             rate limit)                                  +== TLS ==> [AIM token endpoint]
                       |                                                          |
                  local OS /                                              [secret store]
                  bearer / mTLS                                       (env / secret manager)
```

- **Protocol Layer:** JSON-RPC framing over stdio or HTTP; inbound JWKS/mTLS verification and rate limiting at the network edge.
- **Controller Layer:** maps namespaced tool inputs to domain actions; enforces the default-deny write gate.
- **Gateway Layer:** undici-backed PI Web API client — connection pooling, retry/backoff, batching, outbound TLS.
- **PI Web API:** upstream system of record, reached as a single fixed service identity.

---

## 2. Assets under protection

1. **PI System Data (Read):** time-series archives, AF asset databases, element hierarchies, attributes, and summaries.
2. **PI System Integrity (Write):** PI point configurations, OMF containers, and recorded/current values.
3. **Service principal credentials/tokens (outbound):** Basic username/password, Kerberos keytabs/tickets, SPNEGO tokens, and OIDC/AIM bearer tokens — the single identity the server presents to PI.
4. **Internal CA / TLS trust material:** private CA root bundles (`PIWEBAPI_TLS_CA_FILE`) and any pinned certificates/fingerprints.
5. **Inbound MCP caller credential:** the caller's bearer token (verified against JWKS) or client TLS certificate (mTLS).

---

## 3. Trust boundaries

1. **MCP client ↔ MCP server (inbound).**
   - **stdio:** boundary is the local OS / parent process; no network auth added (default; co-located client).
   - **HTTP (`MCP_TRANSPORT=http`):** boundary is the network edge; an inbound **bearer token** (`MCP_EDGE_AUTH_MODE=bearer`, verified against `MCP_EDGE_JWKS_URL`) or **mTLS** (`MCP_EDGE_AUTH_MODE=mtls`) is **required** and validated at the edge; `MCP_HTTP_BIND` must not wildcard-bind by default. See `docs/security/inbound-transport.md`.
2. **MCP server ↔ PI Web API (outbound).** Network/TLS boundary traversed via undici under a **single fixed service identity** — no on-behalf-of delegation of the inbound caller.
3. **MCP server ↔ secret store.** Configuration/secrets sourced from environment or a secret manager, never from the repository or plaintext committed config.
4. **MCP server ↔ AIM token endpoint (Bearer).** OIDC discovery and token acquisition over TLS; if AIM uses an internal CA, the same custom-CA trust (`PIWEBAPI_TLS_CA_FILE`) applies.

---

## 4. STRIDE threats & mitigations

### Spoofing
- **Threat:** an attacker spoofs the PI Web API server, the AIM/OIDC provider, or an unauthenticated client impersonates a legitimate caller.
- **Mitigations:**
  - Enforced TLS verification: `rejectUnauthorized: true` across all client agents; `NODE_TLS_REJECT_UNAUTHORIZED=0` is forbidden and blocked at startup. `PIWEBAPI_TLS_VERIFY=false` is a non-production debugging escape hatch: it is rejected when `NODE_ENV=production`, over the HTTP transport, or combined with `PIWEBAPI_TLS_PIN_SHA256`.
  - Private-CA support: roots from `PIWEBAPI_TLS_CA_FILE` are **unioned** with the bundled public roots so internal and public CAs (e.g. AIM) both validate.
  - Outbound service identity established via Kerberos/Bearer/Basic; OIDC discovery validated with strict URL hostname rules.
  - **Inbound:** the HTTP transport requires a valid bearer token or client certificate at the edge before any interaction.

### Tampering
- **Threat:** an attacker modifies values/OMF writes in transit, or tampers with the published artifact / dependency tree.
- **Mitigations:**
  - End-to-end TLS with SNI matching on all upstream calls.
  - Supply chain: committed `package-lock.json` with `npm ci`, SHA-pinned GitHub Actions, pinned minimum npm CLI, SBOM (CycloneDX), and npm provenance / signed releases.
  - Inbound body verification: request size limits and JSON validation before transport processing.

### Repudiation
- **Threat:** actions are executed on the PI System but cannot be audited.
- **Mitigations:**
  - Pino-based structured audit logs to `stderr` recording tool invocation, correlation IDs, execution durations, and status.
  - Log redaction strips JWTs, SPNs, and Basic blobs before emission so audit records carry no secrets.

### Information disclosure
- **Threat:** stack traces, internal hostnames, Windows account names, tokens, or OIDC config leak to the client or into logs/SBOM/tarball.
- **Mitigations:**
  - Allowlist-based error **sanitizer** strips AD account names, SPNs, bearer tokens, issuer/audience URIs, internal hostnames, and stack traces before any error reaches the client.
  - The MCP layer never echoes raw upstream error bodies; `DebugMode=false` is the production guidance.
  - No secrets in logs, SBOM, or the published tarball (explicit `files` allowlist).
  - WebID/metadata caches are keyed only by (`PIWEBAPI_BASE_URL` + resource path + WebIDType) / by WebID — safe precisely because there is one service identity (no per-caller data crossing).

### Denial of service
- **Threat:** an attacker floods the server, or causes it to flood PI Web API and trigger upstream rate limiting.
- **Mitigations:**
  - **Inbound:** bounded in-memory token-bucket rate limiting on the HTTP transport (per-replica, keyed on socket IP); apply per-tenant limits at the reverse proxy.
  - **Outbound:** global concurrency bound via `PIWEBAPI_MAX_CONCURRENT`; on HTTP 429 the server reduces concurrency and recovers gradually, avoiding retry storms. (PI's rate limit is per-IP; behind NAT all traffic shares one IP, so the server centralizes throttling.)

### Elevation of privilege
- **Threat:** an unprivileged caller executes destructive write tools or reaches protected admin endpoints.
- **Mitigations:**
  - **Default-deny writes:** write tools globally disabled unless `MCP_WRITE_TOOLS_ENABLED=true`, plus a per-call scope/role gate; edge authentication alone does not authorize writes.
  - **Least-privilege service principal:** the configured PI identity is scoped to the minimum required.
  - Protected `/piwebapi/system/*` tools are not exposed unless explicitly intended (and are incompatible with Bearer — they require a Kerberos/Basic PI Web API Admins identity).

---

## 5. Auth error-channel rule (authoritative)

Authentication and protocol failures follow a strict **two-axis** rule (*who failed*: caller vs server-to-PI). No phase routes auth failures differently.

| Trigger | Channel | Client experience | Rationale |
|---|---|---|---|
| **(a) Inbound** MCP auth/protocol failure at the transport edge (wrong/missing JWT or client cert, malformed protocol) | **Protocol-level error** | `McpError`, or **HTTP 401** on the HTTP transport | Prevents an unauthenticated caller from listing tools, querying status, or reading metadata |
| **(b)** **All** tool-execution failures — **including upstream PI 401/403** | **Tool result with `isError: true`** carrying a **stable sanitized AppError code** (e.g. `UPSTREAM_AUTH_DENIED`) | `{ content: [...], isError: true, code: "UPSTREAM_AUTH_DENIED" }` — never leaks hostnames, internal IPs, tokens, or stack traces | Lets the LLM client distinguish "I may not call this server" from "the object is access-trimmed upstream" |

Upstream PI 401/403 is **never** re-surfaced as an inbound protocol error; it always arrives as a sanitized `isError` tool result.

---

## 6. Error-mapping posture

- **Primary signal is the HTTP status code** (stable and authoritative). Response-body shapes (`Errors[]`, per-item `Errors`, `WebException`) are **best-effort enrichment** only.
- **Provenance = `assumed`:** error fixtures are built from the official PI Web API online reference and tagged `provenance=assumed`; a live-shape confirmation suite exists only as an OPTIONAL/quarantined workflow and is not required to ship.
- **The parser never throws** on an absent or unexpected body shape; it degrades to status-code classification.
- **Classification:** transient = 429 / connectivity (retried with backoff); permanent = 400 / 401 / 403 / 413 (not retried).

---

## 7. Residual risks & assumptions

1. **Operator-correct server config:** the server assumes the PI Web API and AIM are correctly configured (issuer, cert trust, admin group membership) and that the host running the Node process is secure and its config is not readable by unauthorized local processes.
2. **`provenance=assumed` body shapes:** error-body shapes are assumed from documentation; mitigated by the status-code-primary mapping (the authoritative signal does not depend on body shape).
3. **AIM grant/audience Open Decision:** the exact AIM grant/audience is operator-confirmed; mitigated by the `PIWEBAPI_BEARER_GRANT` contingency (`client_credentials` default, with `authorization_code`/`refresh_token` fallback).
4. **Native `kerberos` build availability:** depends on host build prerequisites; mitigated by fail-loud startup (the server never silently downgrades).
5. **Reverse-proxy mapping (HTTP transport):** the proxy must enforce TLS client-certificate checks or inject validated JWTs; the Node listener speaks plain HTTP by design.
6. **No identity delegation (forward note):** the single service identity makes the global cache keying safe. Introducing on-behalf-of delegation would require **re-keying all WebID/metadata caches by caller identity** to prevent privilege escalation.
