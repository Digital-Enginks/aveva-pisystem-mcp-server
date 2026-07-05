# Authentication Setup: Basic

Setup guide for connecting the AVEVA PI System MCP Server to PI Web API using HTTP Basic authentication. Set `PIWEBAPI_AUTH_MODE=basic` to select this provider.

---

## 1. When to use it

Use Basic authentication only when Active Directory delegation / Kerberos is impractical and a service identity with an explicit username and password is required (for example, a non-domain host, a cross-realm boundary, or a constrained appliance).

> [!WARNING]
> Basic is a **last resort**. Prefer Kerberos in Active Directory environments and Bearer/OIDC where an identity provider exists. See [`docs/security/recommendations.md`](../security/recommendations.md).

---

## 2. Server-side prerequisites

- The PI Web API server `AuthenticationMethods` list **includes `Basic`**.
- All traffic is over TLS. This is always true for PI Web API (HTTPS, default port 443) and is mandatory here — Basic credentials are transmitted on every request and must never traverse a cleartext channel.
- The service account is scoped to **least privilege** for the operations this server performs.

---

## 3. Client config

Set the following environment variables (see [`docs/configuration.md`](../configuration.md) §2, Option C):

| Variable | Required | Description |
|---|---|---|
| `PIWEBAPI_AUTH_MODE` | **Yes** | Set to `basic`. |
| `PIWEBAPI_BASIC_USER` | **Yes** | The domain username (e.g. `domain\service-user`). |
| `PIWEBAPI_BASIC_PASSWORD` | One of | Raw cleartext password value. |
| `PIWEBAPI_BASIC_PASSWORD_FILE` | One of | Path to a file containing the password. |
| `PIWEBAPI_BASIC_PASSWORD_REF` | One of | Environment variable reference containing the password. |
| `PIWEBAPI_TLS_CA_FILE` | If private CA | Path to a PEM CA bundle for an internal/private CA. Unioned with the bundled public roots. |

Choose **exactly one** of the three password sources. Prefer `PIWEBAPI_BASIC_PASSWORD_REF` or `PIWEBAPI_BASIC_PASSWORD_FILE` sourced from a secret manager over a raw value in plaintext config.

---

## 4. Verification

1. Start the server with `PIWEBAPI_AUTH_MODE=basic`.
2. Issue a read against a non-protected endpoint (e.g. a tag value read). A successful response confirms the credentials and TLS trust chain are valid.
3. If the PI Web API server uses an internal CA, confirm `PIWEBAPI_TLS_CA_FILE` is set before troubleshooting credentials — a TLS handshake failure presents differently from a 401.

---

## 5. Failure signatures

| Signature | Likely cause | Resolution |
|---|---|---|
| `401 Unauthorized` | Wrong username/password, or `Basic` not in the server `AuthenticationMethods`. | Verify the credentials; confirm Basic is enabled server-side. |
| `401`/`403` "Authorization has been denied" on `/piwebapi/system/*` | Account not in **PI Web API Admins**. | Use an admin-privileged account for admin features, or do not call admin endpoints. |
| TLS handshake / certificate verification failure | Internal/private CA not trusted by the Node.js process. | Supply the CA via `PIWEBAPI_TLS_CA_FILE` (merged with public roots). **Never** set `NODE_TLS_REJECT_UNAUTHORIZED=0`. |

Upstream PI `401`/`403` denials surface as a sanitized tool result (`isError: true`) with a stable code, never as a leaked hostname, token, or stack trace.

---

## 6. Security caveats

> [!WARNING]
> With Basic authentication, the credentials **traverse the wire on every single request** and are held **decrypted in PI Web API process memory** for the duration of each request. Basic is **weaker than Kerberos**, which does not retransmit reusable credentials. Basic is **only acceptable over TLS with a trusted server**.

If Basic must be used:
- Scope the account to **least privilege**.
- **Rotate** the secret regularly.
- Source the password from a **secret manager** (`PIWEBAPI_BASIC_PASSWORD_REF` / `PIWEBAPI_BASIC_PASSWORD_FILE`) — never the repository or plaintext config.
- Never disable TLS verification.

See the full mandated guidance in [`docs/security/recommendations.md`](../security/recommendations.md).
