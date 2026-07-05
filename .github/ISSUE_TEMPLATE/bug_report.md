---
name: Bug report
about: Create a report to help us improve.
title: ''
labels: bug
assignees: ''

---

> [!WARNING]
> **DO NOT PASTE SECRETS, CREDENTIALS, OR TOKENS.** Ensure all log snippets, configuration dumps, and URLs are fully redacted before submitting.

### Description
A clear and concise description of what the bug is.

### Environment Details
- **MCP Server Version:** 
- **PI Web API Version:** (e.g. 2023 SP1 Patch 1)
- **Node.js Version:** 
- **Outbound Authentication Mode (`PIWEBAPI_AUTH_MODE`):** [anonymous / basic / kerberos / bearer]
- **Inbound Transport / Auth Mode:** [stdio / http-bearer / http-mtls]

### Redacted Configuration (`.env` or env vars)
```bash
# Paste redacted configuration here
```

### Affected MCP Tool & Inputs
- **Tool Name:** (e.g. `pi.data.get_value`)
- **Arguments Passed:**
```json
// Paste tool arguments JSON here
```

### Steps to Reproduce
Steps to reproduce the behavior.

### Observed vs Expected Behavior
- **Observed Behavior:**
- **Expected Behavior:**

### Redacted Logs
```
// Paste redacted stderr logs here (ensure tokens, hostnames, and SPNs are scrubbed)
```
