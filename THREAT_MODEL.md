# Threat Model & Security Posture - AVEVA PI System MCP Server

This document outlines the threat model and security posture for the stateless, zero-trust Model Context Protocol (MCP) server for the AVEVA PI System Web API.

---

## 1. Security Assets under Protection

The following high-value assets are protected by the server's security controls:
1. **PI System Data (Read):** Time-series archives, asset databases, element hierarchies, attributes, and summaries.
2. **PI System Integrity (Write):** PI point configurations, OMF containers, and recorded/current values.
3. **Outbound Credentials (Server-to-PI):** Basic username/password, Kerberos keytabs, SPNEGO tokens, and OIDC Oauth/AIM bearer tokens.
4. **Inbound Credentials (Client-to-Server):** Client TLS certificates (mTLS) or JWT bearer tokens verified against JWKS.
5. **TLS Trust Infrastructure:** Private CA root bundles (`PIWEBAPI_TLS_CA_FILE`) and pinned certificates/fingerprints.

---

## 2. Trust Boundaries & Interaction Diagram

The server operates at the intersection of two primary trust boundaries:
1. **Inbound Trust Boundary (Client ↔ MCP Server):**
   - **STDIO Transport:** Isolated to the local host. The trust boundary is the local operating system and the parent process (e.g. Claude Desktop).
   - **HTTP Transport:** Exposed to the network. Requires inbound client authentication via Bearer JWT (`MCP_EDGE_AUTH_MODE=bearer`) or mTLS (`MCP_EDGE_AUTH_MODE=mtls`) at the edge. Wildcard binds are disabled by default.
2. **Outbound Trust Boundary (MCP Server ↔ PI Web API / AIM):**
   - Traversing the network via undici. Secured via mandatory TLS (SNI and fingerprint/CA verification).
   - Single fixed service identity model: the server presents a single service credential to PI, meaning the server does **not** delegate the individual caller's identity (no on-behalf-of delegation).

---

## 3. STRIDE Threat Analysis & Mitigations

### Spoofing
- **Threat:** An attacker spoofs the PI Web API server or an OIDC provider.
- **Mitigation:**
  - Enforced TLS verification: `rejectUnauthorized: true` is hardcoded across all client agents. The global environment bypass `NODE_TLS_REJECT_UNAUTHORIZED=0` is blocked at startup.
  - Private-CA support: Private root certificates must be supplied in `PIWEBAPI_TLS_CA_FILE` and are unioned with system certificates, ensuring that untrusted certificates are rejected.
  - OIDC discovery endpoints are validated using strict URL hostname rules.

### Tampering
- **Threat:** An attacker modifies transient values or OMF writes in transit.
- **Mitigation:**
  - End-to-end TLS encryption with SNI matching.
  - Dependency pinning: supply-chain hardening using package-lock.json and SHA-pinned GitHub actions.
  - Inbound request body verification: request size limits (4MB edge cap) and JSON format verification happen before transport processing.

### Repudiation
- **Threat:** Actions are executed on the PI System but cannot be audited.
- **Mitigation:**
  - Pino-based structured audit logs are written to `stderr`. They track tool invocation, correlation IDs, execution durations, and return status codes.
  - Log redaction: regex-based scrub filters (`src/security/redactor.js`) strip sensitive credentials (JWTs, SPNs, Basic blobs) to prevent secret leaks in log repositories.

### Information Disclosure
- **Threat:** Stack traces, internal hostnames, Windows account names, or OIDC configuration details leak to the client.
- **Mitigation:**
  - **The Sanitizer:** A strict allowlist-based error sanitizer strips Windows AD account names, SPNs, Bearer tokens, issuer/audience URIs, internal hostnames, and stack traces before returning errors to the MCP client.
  - Upstream PI 401/403 errors are returned as standardized tool results with `isError: true` and an obfuscated code (e.g. `UPSTREAM_AUTH_DENIED`). They never propagate raw bodies or stack traces.

### Denial of Service (DoS)
- **Threat:** An attacker floods the MCP server or causes it to flood PI Web API, triggering upstream rate limiting.
- **Mitigation:**
  - **Inbound Rate Limiting:** Bounded in memory using token bucket IP tracking on HTTP transport.
  - **Outbound Concurrency Limiting:** Managed via a global Promise-based semaphore bounded by `PIWEBAPI_MAX_CONCURRENT`.
  - **Adaptive Cooldown:** If PI Web API returns HTTP 429, the server decreases active concurrency capacity and recovers gradually as calls succeed, avoiding retry storms.

### Elevation of Privilege
- **Threat:** An unprivileged caller executes destructive write tools.
- **Mitigation:**
  - **Default-Deny Writes:** Write tools are globally disabled by default. Enabling them requires setting `MCP_WRITE_TOOLS_ENABLED=true`.
  - **Role-Based Gating:** Write tools verify that the edge-authenticated user possesses write roles specified in `MCP_EDGE_WRITE_ROLES`.

---

## 4. The Two-Axis Auth Error-Channel Rule

To prevent information leaks and aid LLM reasoning, authentication failures are split into two distinct channels:

| Trigger Condition | Target Channel | MCP Client Experience | Security Rationale |
|---|---|---|---|
| **Inbound Call Auth Failure** (wrong JWT/cert at transport edge) | **Protocol-level error** | McpError or HTTP 401/403 | Prevents unauthenticated clients from listing tools, querying status, or reading metadata. |
| **Outbound Upstream Failure** (PI returns 401/403, or token refresh fails) | **Tool result with `isError:true`** | JSON response: `{ content: [...], isError: true, code: "UPSTREAM_AUTH_DENIED" }` | Obfuscates upstream URLs, SPNs, and AD domains. Allows the LLM client to gracefully handle access-trimmed data. |

---

## 5. Residual Risks & Assumptions

1. **Host Security:** The server assumes the host running the Node process is secure and config variables are not readable by unauthorized local processes.
2. **Reverse Proxy Mapping:** When running HTTP transport behind a reverse proxy, the proxy must properly enforce TLS client certificate checks or inject validated JWTs.
3. **Service Identity Least Privilege:** The server assumes the configured service account on the PI Web API server is scoped to the minimum required permissions (least privilege).
