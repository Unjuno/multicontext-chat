# MultiContext 0.2.0 release checklist

## Current gate

Scope decision: the user chose registration-free direct-local orchestration as
the required product path. LibreChat integration is optional compatibility and
must not block local release acceptance or require the user to register. This
does not promote unverified LibreChat behavior to verified, and does not remove
the signed macOS distribution gates below.

- [x] `npm run check` on application commit `72cb077`: 345 total, 342 passed, 0 failed, 3 skipped. The three skipped cases are obsolete MCP Stop/differential Stop tests under the GUI-only Stop policy, not the optional stress scripts. See `docs/DESKTOP_RESEARCH_AUDIT.md` for scope and subsequent evidence.
- [x] Real MCP user flow: 4-chat Navier–Stokes stress completed with 4 answers-bearing chats, empty queues, and confirmed cleanup.
- [x] `cargo check` and macOS production `.app`/`.dmg` build.
- [x] `verify:desktop` and `verify:bundle` (bundled MCP initialize/list workspaces).
- [ ] Final release checkout and packaged artifacts match the intended release commit. Local `logs/` remains untracked and must not be published; the latest wording change has not been rebuilt into the desktop artifact. Earlier runtime evidence in `docs/PRODUCT_RUNTIME_CHECK.md` is historical, not a current clean-worktree assertion.
- [x] Registration-free direct-local search → peer delivery → exact DOI metadata audit passed on real GPT-OSS (`research-flywheel-1788826035714`). This is not mathematical verification.
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
