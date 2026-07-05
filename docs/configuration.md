# Configuration Reference - AVEVA PI System MCP Server

This document lists and explains all environment variables used to configure the AVEVA PI System MCP Server.

---

## 1. Core & Transport Settings

| Variable Name | Required | Type / Allowed Values | Default | Description |
|---|---|---|---|---|
| `PIWEBAPI_BASE_URL` | **Yes** | HTTPS URL | N/A | The root endpoint of your PI Web API server. Must start with `https://` and end with `/piwebapi`. Loopback hosts (e.g. localhost) are rejected in production. |
| `MCP_TRANSPORT` | **Yes** | `stdio` \| `http` | N/A (no default) | The inbound transport method for MCP requests. STDIO is for co-located clients; HTTP supports remote multi-replica setups. |
| `MCP_HTTP_BIND` | **Yes** when `MCP_TRANSPORT=http` | IP Address | N/A (no default) | The network interface the HTTP server binds to. Startup fails if omitted in HTTP mode. |
| `MCP_HTTP_PORT` | **Yes** when `MCP_TRANSPORT=http` | Integer (1–65535) | N/A (no default) | The port the HTTP server listens on. Startup fails if omitted in HTTP mode. |

---

## 2. Outbound Authentication Settings (Server ↔ PI Web API)

The server authenticates to the PI Web API as a single fixed service account configured using one of the modes below:

| Variable Name | Required for Mode | Type / Allowed Values | Default | Description |
|---|---|---|---|---|
| `PIWEBAPI_AUTH_MODE` | **Yes** | `kerberos` \| `bearer` \| `basic` \| `anonymous` | N/A (no default) | Selects the active authentication provider strategy at bootstrap. Startup fails if omitted. |

### Option A: Kerberos (MANDATED DEFAULT FOR ACTIVE DIRECTORY)
Use this option when connecting in a standard Active Directory realm.
- `PIWEBAPI_KERBEROS_SPN`: **Required**. The Service Principal Name of the PI Web API service (e.g. `HTTP/pi-server.your-domain.com`).
- `KRB5_CONFIG`: Optional. Path to a custom Kerberos configuration file (`krb5.conf`).
- `KRB5_CLIENT_KTNAME`: Optional. Path to a client keytab file for headless service account authentication.

### Option B: Bearer (OAuth 2.0 / AIM)
Use this option when connecting through AVEVA Identity Manager (AIM) or an OIDC provider.
- `PIWEBAPI_BEARER_ISSUER`: **Required**. The base URL of the identity manager (AIM) endpoint (e.g. `https://aim.pi.local/identitymanager/`).
- `PIWEBAPI_BEARER_CLIENT_ID`: **Required**. The OAuth client ID registered with the OIDC server.
- `PIWEBAPI_BEARER_SCOPE`: Optional. Scope values requested during authorization.
- `PIWEBAPI_BEARER_AUDIENCE`: Optional. The target audience identifier (often matches the base URL).
- `PIWEBAPI_BEARER_GRANT`: Optional. `client_credentials` (default) or `password` (for resource owner fallback).
- **Client Secrets:** Choose exactly one of:
  - `PIWEBAPI_BEARER_CLIENT_SECRET`: Raw client secret value.
  - `PIWEBAPI_BEARER_CLIENT_SECRET_FILE`: Path to a file containing the secret.
  - `PIWEBAPI_BEARER_CLIENT_SECRET_REF`: Environment variable reference containing the secret.

### Option C: Basic Authentication (LAST RESORT)
Use this option only when other delegation or token-based protocols are unavailable.
- `PIWEBAPI_BASIC_USER`: **Required**. The domain username (e.g. `domain\service-user`).
- **Passwords:** Choose exactly one of:
  - `PIWEBAPI_BASIC_PASSWORD`: Raw cleartext password value.
  - `PIWEBAPI_BASIC_PASSWORD_FILE`: Path to a file containing the password.
  - `PIWEBAPI_BASIC_PASSWORD_REF`: Environment variable reference containing the password.

### Option D: Anonymous Mode
- `PIWEBAPI_ALLOW_ANONYMOUS`: Set to `true` to allow anonymous access. Restricted to read-only configurations.

---

## 3. Outbound TLS & Trust Policies

- `PIWEBAPI_TLS_VERIFY`: Enforce TLS certificate checks. Default is `true`. Setting it to `false` is rejected at startup when `NODE_ENV=production`, when using the HTTP transport, or when combined with `PIWEBAPI_TLS_PIN_SHA256` — it is a non-production debugging escape hatch only.
- `PIWEBAPI_TLS_CA_FILE`: Path to a custom CA root certificate bundle (PEM format). Required if connecting to a server using a private or internal CA. Unioned with the system's built-in root certificates.
- `PIWEBAPI_TLS_MIN_VERSION`: `TLSv1.2` or `TLSv1.3`. Default is `TLSv1.2`.
- `PIWEBAPI_TLS_SERVERNAME`: Optional. Overrides the hostname used for SNI and certificate identity checks. Use when `PIWEBAPI_BASE_URL` points at an IP address (or a name not present in the certificate) but the server certificate is issued for a different DNS name.
- `PIWEBAPI_TLS_PIN_SHA256`: Optional. A 64-character SHA-256 fingerprint hash of the trusted server certificate. Cannot be combined with `PIWEBAPI_TLS_VERIFY=false` (startup fails).
- `PIWEBAPI_CLIENT_CERT_FILE` / `PIWEBAPI_CLIENT_CERT_KEY_FILE`: Outbound client certificate and key paths for mTLS.

---

## 4. Inbound Edge Security (HTTP Transport Only)

- `MCP_EDGE_AUTH_MODE`: Inbound client authentication scheme: `bearer` (JWT/JWKS verification), `mtls` (client cert validation), or `none`. Default is `none`.
- `MCP_EDGE_JWKS_URL`: URL to fetch public keys to verify JWT signatures (Edge Bearer mode).
- `MCP_EDGE_AUDIENCE`: The expected JWT audience claim value. **Required** when `MCP_EDGE_AUTH_MODE=bearer` (startup fails without it); otherwise any valid token from the issuer, minted for a different relying party, would be accepted.
- `MCP_EDGE_ISSUER`: The expected JWT issuer (`iss`) claim value (Edge Bearer mode). When set, tokens from any other issuer are rejected. Strongly recommended for internet-facing deployments.
- `MCP_EDGE_MTLS_CA_FILE`: CA bundle to verify client certificates (Edge mTLS mode).
- `MCP_EDGE_MTLS_ROLES`: Comma-separated roles granted to an authenticated mTLS client. Defaults to `read` (read-only); set to e.g. `read,write` to allow writes over mTLS.
- `MCP_EDGE_WRITE_ROLES`: Comma-separated list of scopes or roles required to execute write tools.
- `MCP_EDGE_RATE_LIMIT`: The request rate limit cap per window per IP.

---

## 5. Performance, Timeouts & Caching

- `PIWEBAPI_REQUEST_TIMEOUT_MS`: Request timeout floor. Default is `10000` (10 seconds).
- `PIWEBAPI_MAX_CONCURRENT`: Global cap on concurrent outbound requests to the PI Web API. Default is `50`.
- `PIWEBAPI_WEBID_CACHE_TTL_SEC`: Duration in seconds to cache path-to-WebID resolutions. Default is `300`.
- `PIWEBAPI_META_CACHE_TTL_SEC`: Duration in seconds to cache write-validation metadata. Default is `300`.
- `PIWEBAPI_SEND_CSRF_HEADER`: Attach the `X-Requested-With` header to write requests (POST/PUT/PATCH/DELETE). Default is `true`. Set to `false` only if your PI Web API deployment rejects the header.
- `MCP_MAX_RESPONSE_BYTES`: Maximum size (in UTF-8 bytes) of a single tool response payload; larger results are truncated and, where supported, continued via `nextPageToken`. Default is `1048576` (1 MiB).

---

## 6. Gating & Feature Flags

- `MCP_READ_ONLY`: Master read-only switch. Default is `true`. While `true`, the server refuses any configuration that enables writes. **To enable write tools you must set both `MCP_READ_ONLY=false` and `MCP_WRITE_TOOLS_ENABLED=true`** — setting only `MCP_WRITE_TOOLS_ENABLED=true` fails at startup. Anonymous outbound auth (`PIWEBAPI_AUTH_MODE=anonymous`) requires `MCP_READ_ONLY=true`.
- `MCP_WRITE_TOOLS_ENABLED`: Set to `true` to list and execute write-capable tools. Default is `false`. Requires `MCP_READ_ONLY=false`; over the HTTP transport it additionally requires edge authentication (`MCP_EDGE_AUTH_MODE` ≠ `none`) and `MCP_EDGE_WRITE_ROLES`.
- `MCP_ADMIN_IDENTITY_CONFIGURED`: Set to `true` to declare that the configured PI Web API service account has admin rights, enabling the `pi.meta.server_status` tool. Default is `false` (the tool returns FEATURE_DISABLED).
- `MCP_LOG_LEVEL`: Log verbosity: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`. Default is `info`.
