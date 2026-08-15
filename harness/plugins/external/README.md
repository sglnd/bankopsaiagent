# Vendored DSH plugins

These directories are immutable upstream snapshots pinned in
`../../upstream.lock.json`. The Docker image loads their published `lib/`
artifacts and bundle manifests; they are not local TypeScript workspaces.

VS Code hides upstream `src/`, `tests/`, build scripts, and TypeScript project
files by default so their absent development-only dependencies do not pollute
BankOps diagnostics. Disable the matching `files.exclude` entries temporarily
when auditing upstream source.

Do not edit a vendored snapshot in place. Upgrade it by importing a reviewed
commit, updating `upstream.lock.json`, and rebuilding all Harness profiles.
