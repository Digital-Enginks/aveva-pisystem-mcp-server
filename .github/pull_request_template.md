## Description
Provide a clear summary of the changes made, including references to any related issues.

## Conventional Commit Title
Please ensure your PR title follows Conventional Commits syntax:
`type(scope)?: description`
Example: `feat(tools): add resolve_point tool`

## Type of Change (SemVer Impact)
- [ ] **BREAKING CHANGE (MAJOR):** A tool removed, renamed, schema changed, config variable removed/renamed, or node minimum raised.
- [ ] **Feature (MINOR):** A new tool, optional config var, or optional parameter added.
- [ ] **Bug Fix (PATCH):** A backward-compatible bug fix, patch, or performance improvement.
- [ ] **Refactor / Docs (None):** Code change that does not affect output or shipping contract.

## Checklist
- [ ] **Conventional Commit Title:** The title matches Conventional Commits format.
- [ ] **Tests:** Unit and integration tests cover the new/modified logic.
- [ ] **Fixture Validation:** `node test/validate-fixtures.js` passes.
- [ ] **Docs:** Relevant documents (README, Configuration, Tools catalog) have been updated or regenerated.
- [ ] **No Secrets:** Verified that no tokens, passwords, private key files, or internal domain names are checked in.
- [ ] **DCO Signed:** All commits in this PR are signed-off (`Signed-off-by`).

## Security Impact Assessment
- Does this change touch authentication (`/src/security`, `/src/gateway/auth`)? [Yes / No]
- Does this change modify outbound TLS agents or certificate checks? [Yes / No]
- Does this change expose any new `/system/*` admin endpoints as tools? [Yes / No]
- Does this change affect secret logging or scrubbing? [Yes / No]
- **Details:** (If yes, provide details on how the STRIDE threat model remains satisfied.)
