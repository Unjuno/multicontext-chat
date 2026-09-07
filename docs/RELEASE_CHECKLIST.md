# MultiContext 0.2.0 release checklist

## Current gate

- [x] `node --test`: 266 passed, 0 failed. The 3 long-running stress entries are skipped unless an explicit MCP URL and token are supplied.
- [x] Real MCP user flow: 4-chat Navier–Stokes stress completed with 4 answers-bearing chats, empty queues, and confirmed cleanup.
- [x] `cargo check` and macOS production `.app`/`.dmg` build.
- [x] `verify:desktop` and `verify:bundle` (bundled MCP initialize/list workspaces).
- [x] Worktree is clean and release evidence is recorded in `docs/PRODUCT_RUNTIME_CHECK.md`.
- [ ] Developer ID Application signing.
- [ ] Apple notarization and stapler validation.
- [ ] Final GUI pass on the signed artifact.

`npm run verify:signing` is the hard gate for the signed artifact. It rejects
adhoc signatures and missing Team ID / Developer ID authority.

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
