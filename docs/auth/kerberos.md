# Authentication Setup: Kerberos (Negotiate)

Setup guide for connecting the AVEVA PI System MCP Server to PI Web API using Kerberos (SPNEGO/Negotiate). Set `PIWEBAPI_AUTH_MODE=kerberos` to select this provider.

---

## 1. When to use it

Kerberos is the **recommended default in Active Directory environments**. A single service principal authenticates natively, and reusable credentials are not transmitted on every request.

> [!IMPORTANT]
> **NTLM is not supported.** Active Directory environments use Kerberos (Negotiate) per AVEVA guidance. If the domain falls back to NTLM, that is a server/SPN configuration problem — see Failure signatures below.

---

## 2. Server-side prerequisites

Server-side configuration is the most common failure source. Confirm all of the following with your Active Directory administrator:

- The PI Web API service account is **trusted for delegation**.
- SPNs are registered for **both** `HTTP/{hostname}` and `HTTP/{fully.qualified.hostname}` on the correct service account.
- The account is **NOT** marked "sensitive and cannot be delegated."
- The client base URL (`PIWEBAPI_BASE_URL`) uses a **hostname, not an IP address** — Kerberos requires a hostname to acquire a ticket.

---

## 3. Client config

SPNEGO/Negotiate is implemented **manually over undici** using the native `kerberos` npm package: the server mints a token, sends `Authorization: Negotiate <token>`, and handles the `401 → token → retry` handshake with **connection affinity** so the authenticated handshake stays on one connection.

| Variable | Required | Description |
|---|---|---|
| `PIWEBAPI_AUTH_MODE` | **Yes** | Set to `kerberos`. |
| `PIWEBAPI_KERBEROS_SPN` | **Yes** | The Service Principal Name of the PI Web API service (e.g. `HTTP/pi-server.your-domain.com`). |
| `KRB5_CLIENT_KTNAME` | If headless | Path to a client keytab file for non-interactive service-account authentication. |
| `KRB5_CONFIG` | Optional | Path to a custom Kerberos configuration file (`krb5.conf`). |
| `PIWEBAPI_TLS_CA_FILE` | If private CA | Path to a PEM CA bundle for an internal/private CA. Unioned with the bundled public roots. |

> [!IMPORTANT]
> **Contingency (fail loud):** If the native `kerberos` build is unavailable at startup, the server **fails loud** with remediation guidance and **never silently downgrades** to another authentication mode.

> [!NOTE]
> **No mutual authentication at the GSSAPI layer:** the client sends its SPNEGO token but does **not** verify the server's final `WWW-Authenticate: Negotiate` response token, so Kerberos mutual auth is not enforced by this client. Server authenticity is instead guaranteed by **TLS certificate validation**, which is mandatory in this deployment model (`PIWEBAPI_TLS_VERIFY` stays `true`; see the TLS trust options). Do not run Kerberos mode over untrusted TLS.

---

## 4. Verification

1. Start the server with `PIWEBAPI_AUTH_MODE=kerberos`.
2. Issue a read against a **non-protected endpoint** (e.g. a tag value read). Success confirms the SPNEGO handshake and the service principal are valid.
3. For **admin features** (anything touching `/piwebapi/system/*`), confirm the service principal is a member of **PI Web API Admins**.

**Testability:** SPNEGO header injection is unit-tested with a **mocked `kerberos` module**. An optional, quarantined integration job runs against a **containerized KDC**. Full double-hop / delegation behavior is validated only in a **staging realm** and is not required for CI.

---

## 5. Failure signatures

| Signature | Likely cause | Resolution |
|---|---|---|
| `401` "the impersonated client user account cannot be delegated to the remote server" | Double-hop / delegation or SPN misconfiguration. | Trust the account/computer for delegation; register `HTTP/{hostname}` + `HTTP/{fqdn}` SPNs; clear "sensitive, cannot be delegated." This is a **server-side** condition the client cannot fix — the server surfaces a clear diagnostic. |
| Startup fails: native `kerberos` unavailable | The `kerberos` package native build is missing on the host. | Install build prerequisites (MSVC Build Tools on Windows, `build-essential` on Linux) and run `npm rebuild kerberos`. The server fails loud by design. |
| "NTLM not supported" / AD asks for NTLM | NTLM is out of scope; SPN/Negotiate not configured. | Configure Kerberos (Negotiate); ensure SPNs are registered and the base URL uses a hostname. |
| `401`/"Authorization has been denied" on `/piwebapi/system/*` | Service principal not in **PI Web API Admins**. | Use an admin-privileged identity for admin reads. |

Upstream PI denials surface as a sanitized tool result (`isError: true`) with a stable code, never as a leaked hostname, token, or stack trace.

---

## 6. Security caveats

- Kerberos avoids transmitting reusable credentials on every request, making it stronger than Basic.
- The server operates under a **single fixed service identity** and does **not** delegate the inbound MCP caller's identity. All cache layers are keyed globally by resource path; if identity delegation is ever introduced, all caches must be re-keyed by caller identity.
- Protect the keytab (`KRB5_CLIENT_KTNAME`) with strict filesystem permissions; treat it as a credential.
- Never disable TLS verification.

See [`docs/security/recommendations.md`](../security/recommendations.md).
