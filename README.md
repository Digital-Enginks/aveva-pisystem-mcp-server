# AVEVA PI System MCP Server

A stateless, zero-trust Model Context Protocol (MCP) server for the AVEVA PI System. This server acts as an intermediary, enabling AI agents and LLM clients to securely query and write time-series archives, AF asset databases, elements, attributes, and summaries using standard tool calls.

---

## 1. Architecture Overview

The server is built using **Clean Architecture** principles to isolate the core PI System models from transport-level concerns:

```
[MCP Client] <--- stdio / http ---> [Protocol Layer (Edge Auth/Rate Limit)]
                                           |
                                   [Controller Layer]
                                           |
                              [PI Web API Client Gateway]
                                           |
                                    [PI Web API]
```

- **Protocol Layer:** Handles JSON-RPC framing over standard I/O (STDIO) or HTTP transport. Performs inbound token verification (JWKS) and client mTLS verification at the network edge.
- **Controller Layer:** Map namespaced tool inputs (e.g. `pi.data.get_value`) to domain actions.
- **PI Web API Gateway:** Handles undici-based HTTP connection pooling, retry policies, adaptive throttling, and batching.
- **Domain Layer:** Houses pure values (e.g. `TagPath`, `TimeRange`, `Paging`) governing formatting and validation invariants.

---

## 2. Outbound Identity Model (Load-Bearing)

> [!IMPORTANT]
> The server operates under a **single fixed service identity model**. It authenticates to the upstream PI Web API as a single configured service account (using Kerberos, Basic, or OAuth/Bearer credentials configured at startup).
> - The server **does not** delegate the inbound MCP caller's identity (no on-behalf-of delegation).
> - All cache layers (WebID and metadata) are keyed globally based on the resource path. If identity delegation is ever introduced, all caches must be re-keyed by caller identity to prevent privilege escalation.

---

## 3. Quickstart & Installation

**Strongly recommended: let an LLM agent install this for you.** Setup involves picking one of four authentication modes (Kerberos, Basic, Bearer/OIDC, or Anonymous), wiring TLS trust for private/internal OT certificate authorities, writing a `.env`, and registering the server with your MCP client — steps humans routinely fat-finger. An LLM agent reads the full guide and walks every step correctly for your environment.

Paste this prompt into Claude Code, Claude Desktop, Cursor, AmpCode, or any coding agent:

```
Install and configure the AVEVA PI System MCP Server by following the
instructions here:
https://raw.githubusercontent.com/Digital-Enginks/aveva-pisystem-mcp-server/refs/heads/main/README.md

Ask me which PI Web API authentication mode my company uses (Kerberos,
Basic, Bearer/OIDC, or Anonymous) and whether the PI Web API server uses a
private/internal certificate authority, then complete every step for me:
install dependencies, create the .env from the matching template, and wire
the MCP client registration block.
```

Prefer to do it by hand? Continue with the manual steps below.

### Prerequisites
- **Node.js:** Version **`22.14.0`** (LTS) must be installed.
- **Network Access:** You must have network access to your company's PI Web API server over HTTPS (usually port 443).
- **Kerberos (if using Windows accounts):** If you configure the server to use your Windows Active Directory account (Kerberos), ensure you have Kerberos client headers installed on your operating system (or standard Active Directory domain access).

### Installation
Clone this repository to your computer, open a terminal (PowerShell or Command Prompt on Windows), and run the following command to download and install required dependencies:
```bash
npm ci
```

---

## 4. Configuration

To configure the server, you need to create a file named `.env` in the root folder of this project. 

Because different companies use different ways to log into their PI Systems, we have created **4 pre-made configuration templates** you can copy. Select the one that matches your company's setup:

### A. Copy a Template matching your Setup
- **Windows / Active Directory Login (Kerberos):** Copy [templates/kerberos.env](templates/kerberos.env) to `.env`. This is the most common setup in industrial OT and corporate control systems.
- **Username & Password Login (Basic):** Copy [templates/basic.env](templates/basic.env) to `.env`. Use this if you have a dedicated service account with a fixed username and password.
- **AVEVA Identity Manager Login (Bearer OIDC):** Copy [templates/bearer.env](templates/bearer.env) to `.env`. Use this if your company uses modern web single-sign-on (SSO) web tokens.
- **Anonymous Login (No Authentication):** Copy [templates/anonymous.env](templates/anonymous.env) to `.env`. Use only for development or testing sandboxes.

### B. Understanding the Settings in Plain English
- `PIWEBAPI_BASE_URL`: The web address of your PI Web API service (e.g. `https://pi-server.company.com/piwebapi`). Always ask your PI Administrator or IT Support for the exact address.
- `PIWEBAPI_AUTH_MODE`: Tells the server how to log in. Must be either `kerberos`, `basic`, `bearer`, or `anonymous`.
- `PIWEBAPI_TLS_CA_FILE`: If your company uses private security certificates (very common in isolated OT networks), your browser might show a certificate warning when visiting the PI Web API page. Save your company's root certificate file (in `.pem` format) and put its full path here (e.g., `C:\certs\company-ca.pem`).
- `MCP_TRANSPORT`: Keep this as `stdio` if you are running the server locally on your computer with a client like Claude Desktop.
- `MCP_WRITE_TOOLS_ENABLED`: Set to `true` only if you want to allow the AI assistant to write data to the PI System. For safety, keep this as `false` to enable read-only access. **Note:** enabling writes also requires `MCP_READ_ONLY=false` — the server is read-only by default and refuses to start with `MCP_WRITE_TOOLS_ENABLED=true` while `MCP_READ_ONLY` is still `true`.

### C. Registering with Claude Desktop

To connect this server to your Claude Desktop application, open your Claude configuration file (located at `%APPDATA%\Claude\claude_desktop_config.json` on Windows) and add this server under the `mcpServers` list.

Choose the configuration block below that matches your company's authentication strategy:

#### Option 1: Windows / Active Directory (Kerberos)
```json
{
  "mcpServers": {
    "aveva-pi-system": {
      "command": "node",
      "args": ["c:/development/aveva-pisystem-mcp-server/src/main.js"],
      "env": {
        "PIWEBAPI_BASE_URL": "https://pi-web-api-server.company.com/piwebapi",
        "PIWEBAPI_AUTH_MODE": "kerberos",
        "PIWEBAPI_KERBEROS_SPN": "HTTP/pi-web-api-server.company.com",
        "PIWEBAPI_TLS_CA_FILE": "C:/certs/company-root-ca.pem",
        "MCP_TRANSPORT": "stdio",
        "MCP_WRITE_TOOLS_ENABLED": "false"
      }
    }
  }
}
```

#### Option 2: Username & Password Login (Basic)
```json
{
  "mcpServers": {
    "aveva-pi-system": {
      "command": "node",
      "args": ["c:/development/aveva-pisystem-mcp-server/src/main.js"],
      "env": {
        "PIWEBAPI_BASE_URL": "https://pi-web-api-server.company.com/piwebapi",
        "PIWEBAPI_AUTH_MODE": "basic",
        "PIWEBAPI_BASIC_USER": "company_domain\\service-username",
        "PIWEBAPI_BASIC_PASSWORD": "your-secret-password-here",
        "PIWEBAPI_TLS_CA_FILE": "C:/certs/company-root-ca.pem",
        "MCP_TRANSPORT": "stdio",
        "MCP_WRITE_TOOLS_ENABLED": "false"
      }
    }
  }
}
```

#### Option 3: AVEVA Identity Manager / OIDC (Bearer Tokens)
```json
{
  "mcpServers": {
    "aveva-pi-system": {
      "command": "node",
      "args": ["c:/development/aveva-pisystem-mcp-server/src/main.js"],
      "env": {
        "PIWEBAPI_BASE_URL": "https://pi-web-api-server.company.com/piwebapi",
        "PIWEBAPI_AUTH_MODE": "bearer",
        "PIWEBAPI_BEARER_ISSUER": "https://aim-server.company.com/identitymanager/",
        "PIWEBAPI_BEARER_CLIENT_ID": "mcp-client-application-id",
        "PIWEBAPI_BEARER_CLIENT_SECRET": "your-aim-client-secret-key",
        "PIWEBAPI_BEARER_AUDIENCE": "https://pi-web-api-server.company.com/piwebapi",
        "PIWEBAPI_TLS_CA_FILE": "C:/certs/company-root-ca.pem",
        "MCP_TRANSPORT": "stdio",
        "MCP_WRITE_TOOLS_ENABLED": "false"
      }
    }
  }
}
```

#### Option 4: Anonymous Access (No Login)
```json
{
  "mcpServers": {
    "aveva-pi-system": {
      "command": "node",
      "args": ["c:/development/aveva-pisystem-mcp-server/src/main.js"],
      "env": {
        "PIWEBAPI_BASE_URL": "https://pi-web-api-server.company.com/piwebapi",
        "PIWEBAPI_AUTH_MODE": "anonymous",
        "PIWEBAPI_ALLOW_ANONYMOUS": "true",
        "PIWEBAPI_TLS_CA_FILE": "C:/certs/company-root-ca.pem",
        "MCP_TRANSPORT": "stdio",
        "MCP_WRITE_TOOLS_ENABLED": "false"
      }
    }
  }
}
```

> [!IMPORTANT]
> **Need help with connection settings?**
> If you do not know the address of your PI Web API server, client keys, or certificate paths, or if you run into login/authentication errors, **please contact your company's PI System Administrator or IT Support team**. These values are specific to your company's corporate network and can only be provided by your IT department.



---

## 5. Security at a Glance

- **TLS verification is enforced where it matters:** `NODE_TLS_REJECT_UNAUTHORIZED=0` always rejects startup. `PIWEBAPI_TLS_VERIFY=false` exists as a non-production debugging escape hatch only — it is rejected when `NODE_ENV=production`, over the HTTP transport, or combined with certificate pinning.
- **Custom trust anchor:** For a PI Web API server using a private or internal CA, provide the PEM CA file via `PIWEBAPI_TLS_CA_FILE`. The server trusts the union of this file and the system's public roots (so public CAs such as AIM still validate).
- **CSRF header sent by default:** The `X-Requested-With` header is attached to every write request (POST/PUT/PATCH/DELETE); `PIWEBAPI_SEND_CSRF_HEADER=false` disables it only for upstream deployments that reject the header.
- **Writes are default-deny:** Write-capable tools are off unless both `MCP_READ_ONLY=false` and `MCP_WRITE_TOOLS_ENABLED=true` are set; over the HTTP transport they additionally require inbound edge auth (`MCP_EDGE_AUTH_MODE`) and a caller role matching `MCP_EDGE_WRITE_ROLES`.
- **Inbound HTTP transport is hardened:** A bearer token or mTLS is required at the edge (`MCP_EDGE_AUTH_MODE`), and `MCP_HTTP_BIND` does not wildcard-bind by default.

See the [Security Recommendations](docs/security/recommendations.md), [Threat Model](docs/security/threat-model.md), and [Inbound Transport guide](docs/security/inbound-transport.md) for the full posture.

---

## 6. Reference Documentation

- **Compatibility Matrix:** See [COMPATIBILITY.md](COMPATIBILITY.md) for supported PI Web API and Node versions.
- **Configuration Guide:** See [docs/configuration.md](docs/configuration.md) for a description of all configuration variables.
- **Authentication Setup:** [Basic](docs/auth/basic.md) · [Kerberos](docs/auth/kerberos.md) · [Bearer / OIDC (AIM)](docs/auth/bearer.md).
- **Threat Model:** See [docs/security/threat-model.md](docs/security/threat-model.md) for the STRIDE threat analysis.
- **Troubleshooting:** See [docs/troubleshooting.md](docs/troubleshooting.md) for debugging guides and common error resolutions.
- **Tool Catalog:** See [docs/tools.md](docs/tools.md) for details on namespaced tools and JSON schemas.

---

## 7. Provenance & SBOM

Published releases are built and published from GitHub Actions with **npm provenance** (`npm publish --provenance`). To verify a downloaded package was built from this source:

```bash
npm audit signatures
```

A CycloneDX **SBOM** is attached to each GitHub Release for downstream vulnerability and license scanning. See [SECURITY.md](SECURITY.md) for the verification details and disclosure policy.

---

## 8. License & Contributing

- **License:** Licensed under the Apache License, Version 2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).
- **Contributing:** Contributor guidelines and DCO sign-offs are in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Vulnerability Disclosure:** Security policy and reporting channels are defined in [SECURITY.md](SECURITY.md).
- **Contact & Support:** Maintained by **Oscar Ortiz** ([@oscarinom](https://github.com/oscarinom)). For support or custom OT integrations, email: `oscar.ortiz@denginks.com`.
