# Desktop research build audit — 2026-09-08

Application code audited: `f8e0971`, including source-linked GUI reviews, observed
search evidence, registration-free local model orchestration, and reviewed MCP
handoff. The subsequent changes in this audit affect verification scripts/tests.

## Current evidence

- Final `npm run check`: 331 total, 328 passed, 0 failed, 3 skipped.
- `npm run desktop:build -- --bundles app`: succeeded; release Rust compilation
  and macOS `.app` bundling completed.
- `npm run verify:desktop`: all 10 public files matched their packaged resources,
  as did `dist/server.bundle.mjs`.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 48 passed, none failed.
- Actual packaged `createApp` was imported from the `.app` resource bundle and
  served through its real HTTP MCP transport. With a copy of the recorded NS
  experiment, findings extraction and both distillation scopes retained rejection
  notes and `UNREVIEWED` status. No model calls or source-state changes occurred.
- `npm run verify:signing`: failed correctly; this artifact is ad-hoc signed or
  lacks a TeamIdentifier. It is not a Developer ID distribution artifact.

The packaged-server check can be repeated with:

```sh
node scripts/smoke-research-handoff.mjs \
  data/experiments/ns-structure-1788822328816/state.json \
  src-tauri/target/release/bundle/macos/MultiContext.app/Contents/Resources/multicontext/dist/server.bundle.mjs
```

## Verification defects fixed

The desktop checker compared only four named UI files. It now recursively checks
every public file, including styles, new modules, and nested assets; missing,
modified, unexpected, and unsupported entries fail verification.

The signing checker read only stdout from a successful `codesign -d` invocation,
but macOS writes the signature description to stderr. It now reads both streams,
requires successful inspection, and still rejects ad-hoc/missing Developer ID
signatures before running strict signature verification. Synthetic tests cover a
successful stderr report and failed inspection; they do not prove a signed release.

## Scope and remaining gates

No `/Applications` installation or existing user workspace was replaced. This
turn rebuilt the generated app bundle but did not launch a new native window or
exercise the new controls through Tauri. Prior browser GUI/MCP checks are recorded
separately in REVIEW_NOTES.md. Direct native QA on the final signed artifact,
Developer ID signing, notarization/stapling, and legacy LibreChat mixed-provider
real-model verification remain distinct gates. Do not interpret this audit as
CORE FINAL VERIFIED, public distribution readiness, or mathematical proof.

## Live LibreChat recheck

The configured Remote Responses discovery endpoint returned ChatA and ChatB;
it did not expose their tool configuration. The actual controller in
`/Users/taka/projects/LibreChat` contains the `parallel_tool_calls: false`
forwarding, and its serializer matches the repository helper, but its
`createMixedOwnershipHandler` does **not** match the current helper.
This is on-disk evidence, not proof of the running process version or provider wire.

The old `verify-librechat-mixed-handler.mjs` still passed against that checkout:
it tested the installed executor with the repository's adapter, so it could not
detect an outdated deployed adapter. The verifier now rejects missing/stale
controller helpers before executing its contract probe. A regression test covers
both missing helpers and a removed duplicate-call guard. The current actual
checkout correctly fails this new gate; no LibreChat restart or saved Agent
mutation was performed during this check. Reapply the patch and rebuild/restart
before attempting the remaining real mixed-model acceptance test. A passing
source gate alone would still not establish running-process or model E2E parity.
