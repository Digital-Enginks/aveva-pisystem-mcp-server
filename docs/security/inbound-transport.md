# Inbound MCP Transport & Auth

This guide documents the **inbound trust boundary** — how an MCP client authenticates to *this server*. It is intentionally distinct from the **outbound** server→PI Web API authentication (see the Auth Setup guides and `docs/security/recommendations.md`). The inbound token authorizes use of the *server*; it is never propagated to PI.

> [!IMPORTANT]
> **Inbound auth ≠ upstream PI auth.** A caller authenticated at the MCP edge does not gain a PI identity. All upstream PI Web API calls use the single configured service principal (see §"Relation to PI auth").

---

## 1. Transports and their trust boundaries

### stdio (default)

| Property | Value |
|---|---|
| Selected by | `MCP_TRANSPORT=stdio` (default) |
| Trust boundary | Local operating system and the parent process (e.g. Claude Desktop) |
| Network exposure | None |
| Inbound network auth | None added — the OS process boundary *is* the control |

stdio is the recommended deployment for a **co-located client**. JSON-RPC frames travel over the process's standard input/output, so the security perimeter is whatever the host OS and the launching parent process enforce. No bearer token or certificate is required because there is no network listener to protect.

### HTTP (`MCP_TRANSPORT=http`)

When the server is exposed over HTTP, an inbound credential is **required** and validated at the edge before any tool listing, status query, or tool execution is permitted:

| Mode | Variable | Validation |
|---|---|---|
| Bearer JWT | `MCP_EDGE_AUTH_MODE=bearer` | Token signature verified against the JWKS at `MCP_EDGE_JWKS_URL`; the audience claim is always checked (`MCP_EDGE_AUDIENCE` is required in bearer mode), the issuer claim when `MCP_EDGE_ISSUER` is configured |
| mTLS | `MCP_EDGE_AUTH_MODE=mtls` | Client certificate validated against the configured trust anchor at the edge |

Additional HTTP hardening:

- **`MCP_HTTP_BIND` must not wildcard-bind by default.** Bind to a specific interface (`127.0.0.1` or an internal interface). A `0.0.0.0`/`::` wildcard bind is not the default and must be a deliberate, justified operator choice behind a TLS-terminating reverse proxy.
- The Node listener speaks plain HTTP by design; terminate TLS at a reverse proxy that enforces the client certificate check or injects a validated JWT.

---

## 2. Write-tool authorization (separate from read)

Authorization to invoke **write-capable** tools is a distinct gate from authenticating at the edge:

- **Global gate:** `MCP_WRITE_TOOLS_ENABLED` (default **`false`**). When false, no write tool is exposed or executable regardless of the caller's identity.
- **Per-call gate:** write tools are subject to a **default-deny** scope/role check. Edge authentication alone does not authorize writes; the authenticated principal must additionally hold the configured write scope/role.
- Read tools are not subject to the write gate.

> [!NOTE]
> Being authenticated at the edge authorizes a caller to use the *server*. It does **not** by itself authorize destructive write tools — those require both `MCP_WRITE_TOOLS_ENABLED=true` and a passing write-scope check.

---

## 3. Relation to PI auth (single service identity)

The inbound caller identity is **not** propagated to the PI Web API. Every upstream call is made with the single configured service principal (Kerberos, Basic, or Bearer/OIDC — see the Auth Setup guides). Consequences operators must understand:

- The inbound bearer token / client certificate authorizes use of *this server*, not direct PI access.
- PI access is whatever the configured service principal is permitted; it is the same for all inbound callers.
- There is no on-behalf-of delegation. If delegation were ever introduced, all WebID/metadata caches would have to be re-keyed by caller identity to prevent privilege escalation.

---

## 4. Auth error-channel rule

Authentication and protocol failures are routed on a strict **two-axis** rule so an LLM client can reliably distinguish "I am not allowed to call this server" from "the object is access-trimmed upstream":

| Failure | Channel | Client experience |
|---|---|---|
| **Inbound** auth/protocol failure at the edge (missing/invalid JWT or client cert, malformed protocol) | **Protocol-level error** | `McpError` on stdio, or **HTTP 401** on the HTTP transport — before any tool/metadata is exposed |
| **Upstream** PI failure during tool execution (PI returns 401/403, token refresh fails) | **Sanitized tool result** | `{ content: [...], isError: true, code: "UPSTREAM_AUTH_DENIED" }` — no hostnames, IPs, tokens, or stack traces |

The distinction is *who failed*: the **caller** authenticating to the MCP server (protocol error) versus the **server-to-PI** identity being denied or the object being access-trimmed (sanitized tool result). Upstream PI 401/403 is never re-surfaced as an inbound protocol error.

See `docs/security/threat-model.md` §"Auth error-channel rule" for the authoritative statement.
