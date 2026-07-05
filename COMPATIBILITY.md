# Compatibility Matrix - AVEVA PI System MCP Server

This document lists the tested and supported versions of the AVEVA PI System Web API, Node.js runtimes, and authentication configurations.

---

## 1. Compatibility Matrix

| MCP Server Line | Target PI Web API | Node.js Runtime (Min / Recommended) | Supported Auth Modes (Server ↔ PI) | Inbound Transport Auth (Client ↔ Server) |
|---|---|---|---|---|
| **`1.x`** | 2023 SP1 Patch 1 (and newer) | Min: `22.14.0` / Rec: `22.x` (LTS) | `anonymous`, `basic`, `kerberos`, `bearer` (OIDC/AIM) | `none` (STDIO), `bearer` (HTTP), `mtls` (HTTP) |

---

## 2. Capability & Auth Rules (Grounded Constraints)

### A. Bearer Token vs. Kerberos Mutual Exclusion
- **Kerberos and OIDC Bearer authentication cannot be combined.** You must select exactly one authentication scheme via `PIWEBAPI_AUTH_MODE`.
- Enforced at startup: if both OIDC credentials and Kerberos settings are enabled in the environment, the server fails validation and refuses to start.

### B. Anonymous Authentication read-only Posture
- If `PIWEBAPI_AUTH_MODE=anonymous` is enabled, it overrides all other outbound authentication methods.
- **Anonymous mode must only be used for read-only access.**
- Ensure that the write gate `MCP_WRITE_TOOLS_ENABLED` is set to `false` and that the PI Web API configuration has `DisableWrites=true` on the anonymous account mapping.

### C. System Administration and Bearer token Limitations
- System endpoints requiring membership in the **PI Web API Admins** group (such as `/piwebapi/system/configuration`, `/piwebapi/system/status`, and cache evictions) are **incompatible with OIDC Bearer tokens** issued by AVEVA Identity Manager (AIM).
- Any features or use-cases requiring access to system configuration/administration tools must utilize **Kerberos (Negotiate)** or **Basic** authentication using an admin-privileged account.

### D. OIDC Bearer Token Requirements
- OAuth Bearer token authentication requires **PI Web API 2023** or newer, paired with a configured **AVEVA Identity Manager (AIM)** server.
- The `PIWEBAPI_BEARER_ISSUER` must be configured with the full AIM URL ending in `/identitymanager/`.
- Ensure that the AIM SSL/TLS certificate is fully trusted by the machine executing the MCP server (either via OS certificates or specified in `PIWEBAPI_TLS_CA_FILE`).
- The default OIDC grant is `client_credentials`, with contingency selection for `authorization_code` or `refresh_token` supported via `PIWEBAPI_BEARER_GRANT`.

### E. Active Directory and NTLM Exclusion
- **NTLM authentication is explicitly out of scope.**
- For Active Directory environments, **Kerberos (Negotiate)** is the mandated authentication protocol. Ensure SPNs are registered (`HTTP/{host}`) and delegation is permitted.
