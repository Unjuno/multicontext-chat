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

### Local checkout upgrade completed

The next check backed up both existing patched files to
`/tmp/mcc-librechat-upgrade.Ft0kW4` and applied the current patch to the actual
LibreChat checkout. Only `responses.js` changed: nine lines validating missing,
blank, or duplicate tool call IDs before any provider side effect. The existing
`service.ts` was unchanged. Reapplying the patch reported already patched;
`node --check` passed, and the installed-source gate plus executor/SDK contract
probe now pass. This supersedes the on-disk mismatch above, not the live-process
verification gap: listener PID 18506 was not restarted by this operation.

Read-only Agent management probes for both discovered Agents returned HTTP 401
using the existing Remote Responses credential. Discovery succeeds, but that
credential does not establish authority to inspect/configure saved provider tools.
No account, credential, database record, or Agent configuration was modified.
Real LibreChat provider-calculator/search plus cross-chat model E2E therefore
remains pending authenticated Agent setup and safe live-server reload. The
registration-free direct-local backend does not require this LibreChat setup.

## Cancellation-before-dispatch regression

The LibreChat client forwarded future abort events to its request controller but
did not check an already-aborted caller signal. Six deterministic regression
cases initially failed: discovery, direct native initial/continuation calls,
both native `runAgent` routes, and compat generation could still invoke fetch.
Each public request entry now calls `signal.throwIfAborted()` before constructing
the request/timer, preserving the original cancellation reason and sending zero
requests. The direct-local client already performs this preflight check.

`npm run check` after the production fix and six pre-cancellation tests passed
(338 total / 335 passed / 0 failed / 3 skipped). Six subsequent in-flight
cancellation tests also pass; the focused suite is 12/12. They use an injected
transport, not a live-model Stop test. GUI-only user Stop policy is unchanged.
The running servers and built desktop bundle have not been updated with this
client change; the prior packaged-artifact evidence does not cover it.
