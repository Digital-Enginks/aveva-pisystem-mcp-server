# Security Policy - AVEVA PI System MCP Server

## 1. Supported Versions

Only the latest release line is supported for security updates:

| Version | Supported |
|---|---|
| `1.x` | Yes (Active) |
| `<1.0.0` | No |

---

## 2. Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

If you discover a security vulnerability in this project, please report it privately:
1. **GitHub Private Vulnerability Reporting:** Navigate to the "Security" tab of the repository and select "Report a vulnerability".
2. **Email Contact:** If private reporting is unavailable, contact the security team at `oscar.ortiz@denginks.com`.

### Our Commitment (SLA)
- **Acknowledgement:** We will acknowledge receipt of your report within 48 business hours.
- **Triage:** A preliminary triage assessment and status update will be provided within 5 business days.
- **Resolution:** We aim to resolve verified vulnerabilities within 30 days of disclosure and coordinate release advisories.

---

## 3. Scope & Verification

- **In-Scope:** The source code of the MCP server, dependencies, configuration schemas, and container build/publish pipelines.
- **Out-of-Scope:** Host system configurations, upstream AVEVA PI Web API vulnerabilities, Active Directory/KDC setup, and AIM deployment configurations.
- **Provenance Verification:** To confirm that a package release has not been tampered with, run:
  ```bash
  npm audit signatures
  ```
- **SBOM:** A CycloneDX SBOM (`sbom.cdx.json`) is generated at release time and attached to each GitHub Release for downstream vulnerability and license scanning.
