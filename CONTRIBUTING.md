# Contributing Guide

Thank you for contributing to the AVEVA PI System MCP Server! Please review the guidelines below to ensure a smooth contribution process.

---

## 1. Development Setup

- **Node.js Version:** Pins to **`22.14.0`** (defined in `.nvmrc` and `.node-version`).
- **Dependencies:** Install dependencies using `npm ci` to guarantee a clean, lockfile-reproducible install.
- **Kerberos Prerequisites:** Building the `kerberos` NPM package requires GSSAPI/Cyrus SASL header libraries installed on the host operating system.

---

## 2. Conventional Commits

All commit messages and PR titles must follow Conventional Commits 1.0.0 rules:
`type(scope)!: description`

- **Allowed Types:** `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `revert`, `security`.
- **Allowed Scopes:** `protocol`, `tools`, `gateway`, `auth`, `security`, `config`, `errors`, `docs`, `ci`, `release`.
- **Breaking Changes:** Indicated by a `!` after the type/scope, or a `BREAKING CHANGE:` footer.
- **Enforcement:** Verified in CI via `scripts/lint-commits.js`.

---

## 3. Branch & PR Workflow

1. Create a branch from `main`.
2. Commit your changes with Conventional Commit formatting.
3. Verify that all linting, fixture validation, and tests pass:
   ```bash
   npm test
   ```
4. Submit a Pull Request. PRs will be squash-merged into `main` to preserve linear history.

---

## 4. Coverage Thresholds

The project enforces minimum test coverage levels via `npm run test:coverage` (node:test `--experimental-test-coverage`). PRs failing these global thresholds will fail CI:
- **Lines:** >= 88%
- **Branches:** >= 74%
- **Functions:** >= 85%

Thresholds are global (whole project), defined in the `test:coverage` script in `package.json`.

---

## 5. Developer Certificate of Origin (DCO)

To maintain a clean IP trail and ensure patent grants are coherent under our Apache-2.0 license, this project uses the **Developer Certificate of Origin (DCO)** sign-off model.

- All commits must include a `Signed-off-by` footer containing your real name and email:
  `Signed-off-by: Oscar Ortiz <oscar.ortiz@denginks.com>`
- You can automate this by committing with the `-s` flag: `git commit -s -m "feat(tools): add tool"`
- **Inbound = Outbound License:** By contributing to this project, you agree that your contributions are licensed inbound under the same Apache-2.0 terms as the project's outbound license.
