# Troubleshooting Guide - AVEVA PI System MCP Server

This guide helps operators diagnose and resolve common errors and setup problems.

---

## 1. Outbound Connection Errors (Server ↔ PI Web API)

### Symptom: HTTP 401 Unauthorized under OIDC Bearer Mode
- **Likely Cause:**
  1. `PIWEBAPI_BEARER_ISSUER` is configured with a placeholder (e.g. `OSIsoft.Invalid.ChangeMe`).
  2. The AIM SSL/TLS certificate is not trusted by the host running the MCP server or the PI Web API server.
  3. The OIDC provider (AIM) rejects the configured client ID/secret or does not allow the `client_credentials` grant.
- **Resolution:**
  - Verify that `PIWEBAPI_BEARER_ISSUER` points to the real AIM FQDN ending in `/identitymanager/`.
  - Trust the AIM certificate by adding its private root CA to the `PIWEBAPI_TLS_CA_FILE` bundle.
  - Check the PI Web API Admin Event logs for detailed bearer token validation errors.
  - If AIM rejects `client_credentials`, configure the grant fallback via `PIWEBAPI_BEARER_GRANT`.

### Symptom: HTTP 401 under Kerberos Mode ("cannot be delegated")
- **Likely Cause:**
  - Active Directory double-hop or delegation misconfiguration.
  - SPNs are missing or registered on the wrong service account.
  - The client machine's service account is marked "sensitive and cannot be delegated."
- **Resolution:**
  - Verify SPNs are registered for both `HTTP/{host}` and `HTTP/{fully.qualified.hostname}` on the service account.
  - Coordinate with the Active Directory administrator to ensure the service account is configured for constrained or unconstrained delegation.

### Symptom: Server fails to start with "kerberos build missing" error
- **Likely Cause:**
  - The native `kerberos` NPM package failed to compile on installation.
- **Resolution:**
  - Install build tools (MSVC Build Tools on Windows or build-essential on Linux).
  - Run `npm rebuild kerberos` or `npm install` again.
  - The server is designed to **fail loud** at startup rather than silently downgrading auth protocols.

### Symptom: Active Directory requests NTLM / "NTLM not supported"
- **Likely Cause:**
  - NTLM authentication is explicitly out of scope for this server.
- **Resolution:**
  - Configure Kerberos (Negotiate) per AVEVA guidelines. Ensure the client base URL uses a hostname (not an IP address), as Kerberos requires hostnames for ticket acquisition.

### Symptom: HTTP 401/"Authorization has been denied" on system configuration lookups
- **Likely Cause:**
  - The configured service account is not a member of the **PI Web API Admins** group, or you are connecting using Bearer authentication (Bearer tokens cannot access protected `/system/*` endpoints).
- **Resolution:**
  - Use Kerberos or Basic authentication with an admin-privileged account. Avoid using `/system/*` tools under Bearer.

### Symptom: HTTP 429 "Rate limit was reached"
- **Likely Cause:**
  - Upstream PI Web API rate limiting is active.
- **Resolution:**
  - The server handles rate limits automatically via adaptive cooldown and coordinated throttling.
  - If rate limits persist, decrease `PIWEBAPI_MAX_CONCURRENT` to reduce load.

### Symptom: HTTP 413 "Payload Too Large"
- **Likely Cause:**
  - Request body size exceeds the PI Web API `MaxRequestContentLength` setting.
- **Resolution:**
  - Shrink the batch size or split the queries into smaller time ranges. The client's plan builder automatically attempts to chunk batch plans, but large arrays of writes must be managed by the caller.

### Symptom: Writes are silently rejected or ignored
- **Likely Cause:**
  - Write validation metadata is stale or missing, the server is in read-only mode (`DisableWrites` is active on PI), or the inbound write gate `MCP_WRITE_TOOLS_ENABLED` is `false`.
- **Resolution:**
  - Check the value of `MCP_WRITE_TOOLS_ENABLED` (must be `true`).
  - Verify that the target PI points do not have `DisableWrites=true` on the PI server.

### Symptom: TLS Handshake / Certificate Trust Verification Failure
- **Likely Cause:**
  - The PI Web API server uses a self-signed or private CA certificate that is not trusted by the Node.js process.
- **Resolution:**
  - Provide the path to the PEM-formatted CA certificate file via `PIWEBAPI_TLS_CA_FILE`.
  - **Never** set `rejectUnauthorized: false` or use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

---

## 2. Inbound Connection Errors (Client ↔ MCP Server)

### Symptom: HTTP 401/403 at the Edge (HTTP Transport)
- **Likely Cause:**
  - The inbound caller failed client authentication. The bearer token is invalid/expired or the client certificate presented is not trusted.
- **Resolution:**
  - Verify that the client is sending a valid JWT matching the JWKS endpoint `MCP_EDGE_JWKS_URL` or a valid mTLS certificate.
  - Note: this is a protocol-level edge error, distinct from outbound PI failures.
