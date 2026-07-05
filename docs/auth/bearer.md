# Authentication Setup: Bearer / OIDC (AVEVA Identity Manager)

Setup guide for connecting the AVEVA PI System MCP Server to PI Web API using a token-based service identity issued by an OpenID Connect (OIDC) identity provider — AVEVA Identity Manager (AIM). Set `PIWEBAPI_AUTH_MODE=bearer` to select this provider.

---

## 1. When to use it

Use Bearer mode for a **token-based service identity** via an OIDC IdP (AVEVA Identity Manager). The server obtains short-lived JWT access tokens and presents them as `Authorization: Bearer <token>`.

> [!IMPORTANT]
> **Hard constraints — read first:**
> - **Bearer XOR Kerberos.** A given server instance authenticates upstream with exactly one of the two; they are mutually exclusive.
> - **Bearer cannot access protected `/piwebapi/system/*` resources.** Features that need admin reads must use Kerberos or Basic with an admin account, or be disabled under Bearer.

---

## 2. Server-side prerequisites

- A separately installed and configured **AIM** server.
- `PIWEBAPI_BEARER_ISSUER` set to the **real AIM URL** `https://{aimFQDN}/identitymanager/` — **NOT** the sentinel `OSIsoft.Invalid.ChangeMe` (the sentinel itself errors).
- The **AIM TLS certificate trusted on the PI Web API host**. If it is not trusted, the result is a **silent 401** rather than an explicit trust error.
- The PI Web API service **restarted** after the bearer configuration is applied.

---

## 3. Client config

The **default grant is `client_credentials`** for an unattended single service identity.

| Variable | Required | Description |
|---|---|---|
| `PIWEBAPI_AUTH_MODE` | **Yes** | Set to `bearer`. |
| `PIWEBAPI_BEARER_ISSUER` | **Yes** | Base URL of the AIM endpoint (e.g. `https://aim.pi.local/identitymanager/`). |
| `PIWEBAPI_BEARER_CLIENT_ID` | **Yes** | The OAuth client ID registered with the OIDC server. |
| `PIWEBAPI_BEARER_AUDIENCE` | Recommended | The target audience identifier naming the PI Web API resource (often matches the base URL). |
| `PIWEBAPI_BEARER_SCOPE` | Optional | Scope values requested during authorization. |
| `PIWEBAPI_BEARER_GRANT` | Optional | Grant type. Defaults to `client_credentials`. |
| `PIWEBAPI_BEARER_CLIENT_SECRET` | One of | Raw client secret value. |
| `PIWEBAPI_BEARER_CLIENT_SECRET_FILE` | One of | Path to a file containing the secret. |
| `PIWEBAPI_BEARER_CLIENT_SECRET_REF` | One of | Environment variable reference containing the secret. |
| `PIWEBAPI_TLS_CA_FILE` | If AIM internal CA | PEM CA bundle; the token-endpoint request also uses this trust. Unioned with the bundled public roots. |

Choose **exactly one** client-secret source. Prefer `PIWEBAPI_BEARER_CLIENT_SECRET_REF` or `..._FILE` from a secret manager over a raw value.

> [!IMPORTANT]
> **Contingency:** If AIM does not permit `client_credentials` for unattended use, select an alternative grant via `PIWEBAPI_BEARER_GRANT` (`authorization_code` or `refresh_token`). The exact AIM grant and audience are an **Open Decision** for the operator to confirm with their AIM deployment.

**Token handling:** Endpoints are discovered from `{PIWEBAPI_BEARER_ISSUER}/.well-known/openid-configuration`. The JWT is **cached in-memory**, **short-lived**, and **proactively refreshed** with a clock-skew margin. Refresh failures surface as a **sanitized tool error** (`isError: true`), never a leaked token or stack trace. If AIM uses an internal CA, the **token-endpoint request also uses** `PIWEBAPI_TLS_CA_FILE` for trust.

---

## 4. Verification

1. Start the server with `PIWEBAPI_AUTH_MODE=bearer`.
2. Issue a read against a **non-protected endpoint** (e.g. a tag value read). Success confirms token acquisition, audience, and AIM/PI trust.
3. Do **not** expect `/piwebapi/system/*` admin reads to succeed under Bearer — they are blocked by design.

---

## 5. Failure signatures

| Signature | Likely cause | Resolution |
|---|---|---|
| `401` under Bearer | `PIWEBAPI_BEARER_ISSUER` unset or set to the sentinel; AIM cert not trusted on the PI host; or AIM disallows the chosen grant. | Set the real AIM issuer and **restart** the service; trust the AIM cert; if `client_credentials` is refused, set `PIWEBAPI_BEARER_GRANT`. Check the PIWebAPI Admin event log. |
| PIWebAPI Admin event-log: `BearerIssuer` not configured | Issuer left unset or at the sentinel `OSIsoft.Invalid.ChangeMe`. | Configure `PIWEBAPI_BEARER_ISSUER` to the real AIM URL and restart. |
| PIWebAPI Admin event-log: "Error using access token" | Token rejected by PI Web API (audience/issuer/signature). | Verify `PIWEBAPI_BEARER_AUDIENCE` and that AIM signs tokens the PI host trusts. |
| Silent `401`, no explicit trust error | AIM TLS certificate not trusted on the PI Web API host. | Trust the AIM certificate on the PI host; if AIM uses an internal CA, also set `PIWEBAPI_TLS_CA_FILE`. |
| `401`/"Authorization has been denied" on `/piwebapi/system/*` | Bearer cannot reach protected resources. | Use Kerberos/Basic with an admin account for admin reads; do not expect admin endpoints under Bearer. |

---

## 6. Security caveats

- Bearer/OIDC avoids sending reusable credentials on every request; tokens are short-lived and refreshed proactively.
- **Bearer XOR Kerberos**, and Bearer **cannot** access protected `/piwebapi/system/*` resources — design tool exposure accordingly.
- Protect the client secret: source it from a secret manager (`PIWEBAPI_BEARER_CLIENT_SECRET_REF` / `..._FILE`), never the repository or plaintext config.
- The server operates under a **single fixed service identity** and does not delegate the inbound caller's identity.
- Never disable TLS verification, including for the AIM token endpoint.

See [`docs/security/recommendations.md`](../security/recommendations.md).
