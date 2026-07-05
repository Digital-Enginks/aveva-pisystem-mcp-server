# Security Recommendations - AVEVA PI System MCP Server

This document contains key security configurations and guidelines for deploying the AVEVA PI System MCP Server in production environments.

---

## 1. Outbound TLS Security

- **Enforce TLS Verification:** The server is configured to reject invalid or self-signed certificates by default. **Never bypass verification.** Bypasses via `rejectUnauthorized: false` or setting `NODE_TLS_REJECT_UNAUTHORIZED=0` are blocked at startup.
- **Configure Private Root CAs:** If your PI Web API server uses a certificate signed by an internal Active Directory CA or private CA, supply the CA certificate path in `PIWEBAPI_TLS_CA_FILE`. The server trusts the union of this file and public roots.

---

## 2. Authentication Strategy Recommendation

1. **Recommended Default (Active Directory):** Use **Kerberos (Negotiate)** authentication. Reusable credentials are not sent over the wire, and tickets are acquired natively using connection affinity.
2. **Recommended Default (OIDC/AIM):** Use **Bearer** mode. This integrates with AVEVA Identity Manager, obtaining short-lived JWT tokens.
3. **Basic Authentication (Last Resort):** Avoid basic authentication where possible. If it must be used, ensure all traffic is encrypted over HTTPS, and source the password from an environment secret manager rather than files.
4. **Anonymous Mode:** Restricted to read-only testing. Pair with `DisableWrites=true` on the server and ensure `MCP_WRITE_TOOLS_ENABLED=false` on the client.

---

## 3. Inbound Edge Hardening (HTTP Transport)

If exposing the MCP server over HTTP (`MCP_TRANSPORT=http`):
- **Enable Inbound Authentication:** Enforce Bearer JWT tokens (`MCP_EDGE_AUTH_MODE=bearer`, verified against `MCP_EDGE_JWKS_URL`) or mTLS (`MCP_EDGE_AUTH_MODE=mtls`). `none` is only permitted on a loopback bind.
- **Bind Bearer Tokens to This Service:** `MCP_EDGE_AUDIENCE` is required in bearer mode (startup fails without it), so tokens minted for another audience are always rejected. Also set `MCP_EDGE_ISSUER` — without it the issuer claim is not checked.
- **Least-Privilege mTLS:** A valid client certificate is read-only by default. Grant writes explicitly with `MCP_EDGE_MTLS_ROLES=read,write` only for the certificates that need them.
- **Enforce Write Gates:** Keep `MCP_WRITE_TOOLS_ENABLED=false` unless explicitly required. If enabled, restrict access using the `MCP_EDGE_WRITE_ROLES` scope/role filter.
- **Rate Limit:** Set `MCP_EDGE_RATE_LIMIT` (the in-process limiter is off when unset and keys on the socket IP, so it is per-replica only). Apply per-tenant limits at the reverse proxy.
- **Terminate TLS at a Proxy:** The Node listener speaks plain HTTP by design. Place it behind a TLS-terminating reverse proxy and bind the process to loopback or an internal interface.
- **Do Not Wildcard Bind:** Bind only to specific interfaces (`127.0.0.1` or internal VPC network IPs).
