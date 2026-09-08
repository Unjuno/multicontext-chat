# MultiContext 0.2.0 release checklist

## Current gate

Scope decision: the user chose registration-free direct-local orchestration as
the required product path. LibreChat integration is optional compatibility and
must not block local release acceptance or require the user to register. This
does not promote unverified LibreChat behavior to verified, and does not remove
the signed macOS distribution gates below.

- [x] Latest local `npm run check` after native review propagation: 369 total,
  366 passed, 0 failed, 3 skipped. Latest public `main` checkpoint is
  `73aced07f0dfce67913819e4549f94838872aebc`; GitHub Actions run
  `34251475745` completed `test`, `rust`, and `app` successfully.
  The three skipped cases are obsolete MCP Stop/differential Stop tests under
  the GUI-only Stop policy, not optional stress scripts. See
  `docs/DESKTOP_RESEARCH_AUDIT.md` for the native direct-local and Compile audit.
- [x] Real MCP user flow: 4-chat Navier–Stokes stress completed with 4 answers-bearing chats, empty queues, and confirmed cleanup.
- [x] All 50 Rust tests and the macOS production `.app`/`.dmg` build.
- [x] `verify:desktop` matched all 11 public files; `verify:bundle` passed its
  bundled MCP initialize/list-workspaces smoke.
- [ ] Final release checkout and packaged artifacts match the intended release commit. Local `logs/` remains untracked and must not be published. Resource freshness is checked during development; a designated release commit and signed artifacts remain required. Earlier runtime evidence in `docs/PRODUCT_RUNTIME_CHECK.md` is historical, not a current clean-worktree assertion.
- [x] Registration-free direct-local search → peer delivery → exact DOI metadata audit passed on real GPT-OSS (`research-flywheel-1788826035714`). This is not mathematical verification.
- [x] Native direct-local review-note save and authenticated MCP readback, with unchanged source/queue state (`DESKTOP_RESEARCH_AUDIT.md`).
- [x] Native direct-local backup button: saved state and both local conversation snapshots matched original bytes (`LOCAL_BACKEND.md`). Restore GUI is not claimed verified.
- [x] Real reviewed-finding handoff and one targeted MCP intervention exercised (`REVIEWED_RESEARCH_CYCLE.md`). Initial model tool compliance failed; intervention recovered the missing calculation. This is oversight evidence, not autonomous research correctness.
- [x] Native `inspect_chat` now carries bounded, attributable review records.
  The packaged server preserved a rejected note through MCP extraction without
  mutating the recorded source. A real local-model reader received that note and
  rejected one false matrix identity after two calculations. A matched no-review
  control also rejected it, so no causal accuracy benefit from review attachment
  is claimed. See `RESEARCH_METHOD_AB.md`.
- [ ] Autonomous research-quality gate. Broad four-persona reviews repeatedly
  accepted false elementary claims despite successful search/calculation calls.
  Atomic obligations and explicit numeric checks were more useful, but some
  answers still omitted a requested derivation or contained inconsistent steps.
  MultiContext records enough evidence for human/orchestrator review; it is not
  yet an autonomous mathematical verifier and has not produced a Navier–Stokes
  regularity result.
- [ ] Developer ID Application signing.
- [ ] Apple notarization and stapler validation.
- [ ] Final GUI pass on the signed artifact.

`npm run verify:signing` is the hard gate for the signed artifact. It rejects
adhoc signatures and missing Team ID / Developer ID authority.

## Optional compatibility — outside the local release gate

- [ ] Real LibreChat-owned provider tool + external cross-chat execution, including
  provider wire and continuation evidence. Still unverified; direct-local success
  is not evidence for this path. Do not request LibreChat login to finish the local
  product audit. Existing integration code and saved data remain intact.

## Signed distribution procedure

Run in the release environment after installing the Developer ID certificate and configuring notarization credentials. Do not commit credentials or tokens.

```bash
npm run verify:release
codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/MultiContext.app
codesign -dv --verbose=4 src-tauri/target/release/bundle/macos/MultiContext.app 2>&1 | grep -E 'Authority=Developer ID Application|TeamIdentifier='
xcrun notarytool submit src-tauri/target/release/bundle/dmg/MultiContext_0.2.0_aarch64.dmg --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
xcrun stapler staple src-tauri/target/release/bundle/macos/MultiContext.app
xcrun stapler validate src-tauri/target/release/bundle/macos/MultiContext.app
spctl --assess --type execute --verbose=4 src-tauri/target/release/bundle/macos/MultiContext.app
```

If any signing or notarization check fails, classify the artifact as internal-only and do not publish it.
