# Desktop research build audit — 2026-09-08

## Direct-local final core checkpoint (2026-09-08)

This checkpoint supersedes earlier local-path and native-window gaps in this
record. LibreChat is not part of the required product path: it remains available
only when a user explicitly selects the compatibility backend. No compatibility
data or code was deleted.

- A fresh production-bundle launch logged `backend=local` and
  `startup: direct-local backend; LibreChat omitted`. Startup required exactly
  the model and MultiContext. The native AI-stack detail showed those services,
  the discovered model, and optional MCP; it showed no LibreChat row.
- Native Settings selected `ローカルLMへ直接接続（登録不要）` and exposed the
  model/MCP controls without LibreChat checkout, URL, or key fields. The local
  child environment does not receive LibreChat URLs, mode flags, or credentials.
- `GET /api/health` returned `backend: local` and a backend-neutral
  `modelBackend` object, with no `librechat` property.
- Through the native server's authenticated MCP endpoint, workspace
  `7cd95a05-3fc6-45b6-8b1a-3cc5cd030424` executed exactly one real
  `calculate((7*8)+1)` call. It settled in about 2.3 seconds with value 57 and
  `proofVerified: false`. Persisted Scheduler evidence recorded one attempt,
  one success, zero failures, and zero replays. The already-open native GUI
  discovered the result and displayed the same tool evidence without reload.
- The first real Compile exposed a product defect: deterministic coverage
  correctly reported one older assistant message with unrecorded tool evidence,
  while model prose contradicted that fact. Compile now renders an expandable
  app-owned audit before a separately labelled `モデルによる統合（未検証）`, and
  copy/download preserves the exact JSON. The synthesis prompt cannot create
  machine-audit sections or restate their counts. A second real Compile retained
  `unrecordedAssistantMessages: 1`; its model prose no longer claimed complete
  coverage and identified the old answer as unrecorded in its evidence/gaps.
- Final code review found one additional direct-local edge case: translated
  Scheduler errors discarded `AGENT_SELECTION_REQUIRED`, so a pre-existing
  queued item could be requeued when no local model was available. Translation
  now preserves error code/status/cause; a regression verifies idle state, an
  empty queue, and registration-free recovery guidance without model dispatch.
- Final automated evidence: `npm run check` collected 366 tests (363 passed,
  0 failed, 3 intentional product-policy skips); Rust passed 50/50;
  `npm run verify:bundle`, the bundled MCP smoke, production `.app`/DMG build,
  and `npm run verify:desktop` all passed. The desktop verifier matched the
  bundled server and all 11 public files.
- `npm run verify:signing` still rejects the ad-hoc artifact because no Developer
  ID TeamIdentifier is present. Signing, notarization/stapling, and a final GUI
  pass on that signed artifact remain the separate general-distribution gate.

This verifies the registration-free direct-local core as usable for internal
macOS release: local-model generation, canonical MCP operation, native
observation, bounded tool attribution, and Compile all worked together. It does
not certify optional LibreChat mixed-tool compatibility, external source truth,
model-written synthesis, or a Navier-Stokes proof. The two-run method comparison
and its deliberately narrow conclusion are recorded in `RESEARCH_METHOD_AB.md`.

## Native review-note save and authenticated MCP readback (2026-09-08)

- Rebuilt `b7a463d` with `npm run desktop:build -- --bundles app` and passed
  `npm run verify:desktop` (all 10 packaged public files matched).
- Gracefully quit the idle native app and launched the new bundle from
  `src-tauri/target/release/bundle/macos/MultiContext.app`. It reopened the
  direct-local workspace and its persisted calculation answer without login.
- In the native UI, scrolled the chat into view, opened the assistant answer's
  source-specific review button, entered a reason and self-reported reviewer,
  and clicked `メモを保存`. The UI confirmed saving and displayed one review.
  An initial offscreen AX click failed; scrolling into view resolved it.
- Workspace: `7cd95a05-3fc6-45b6-8b1a-3cc5cd030424`.
  Message: `49b7e59b-8126-4bca-8d48-5cb04e92c86c`.
  Review: `845be8b4-825a-4d79-8eec-e9d85d98fa86`, saved at
  `2026-09-08T01:26:56.142Z`, verdict `needs_check`.
- Authenticated `multicontext_get_workspace` on the native server's port 4317
  returned the exact persisted review array, including source hash,
  `SELF_REPORTED`, and `assessmentNotProof: true`. No credential was logged.
- SHA-256 of the workspace JSON excluding only `reviewNotes` and `updatedAt`
  was identical before and after the native save:
  `3708715d92f17521023ac3aac19622ffd2553ebc406ea47bcd89bc4e3250b798`.
  This covers unchanged messages, queues, receipts, settings, and execution stats.
- This verifies native review entry and GUI-to-MCP persistence, not a new
  mathematical result. The note explicitly distinguishes arithmetic from a
  Navier–Stokes regularity proof. Developer ID/notarization remains a separate
  public-distribution gate; this bundle is not claimed signed for distribution.
- Corrected contradictory README desktop instructions that still made
  LibreChat credentials sound mandatory despite the direct-local default.

## Current product scope (supersedes earlier blocking conclusions below)

The user explicitly removed LibreChat from the required workflow. Acceptance now
targets registration-free direct-local orchestration; legacy LibreChat mixed-tool
E2E remains unverified optional compatibility, not a blocker for this local path.
No integration code, saved settings, or legacy data was deleted or silently
migrated. The running desktop's existing LibreChat selection is not evidence of
native direct-local onboarding. That flow, current final-artifact checks, and
signed distribution requirements must still be judged on their own evidence.
Earlier login-wait conclusions are historical and no longer a reason to halt
the local product audit. See `RELEASE_CHECKLIST.md` for the current gates.

Native settings inspection found that selecting local mode left LibreChat path,
key, and URL fields visible. The startup page now hides those three field groups
on load and backend changes, preserves their values, and explains registration-free
local setup. The focused desktop suites pass 20/20, including a VM-backed test
of the actual visibility function and return-to-LibreChat behavior. Native
selection was closed without saving; actual backend remains unchanged. The new
visibility code still needs a rebuilt native GUI check and the local saved-setting
startup test; do not count this as completed local onboarding.

Follow-up found that both GUI validation and Rust config validation still required
a valid LibreChat URL in local mode. Both now ignore that unused URL only when
the backend is local; its saved value is preserved. LibreChat mode still validates
it, and local model URL restrictions remain enforced. Two settings-function tests
pass, and Rust reports 49 passed / 0 failed, including an invalid retained LibreChat
URL with local mode and rejection of a non-loopback HTTPS model URL. This removes
a potential invisible-field save blocker; saved native backend switching remains
an integration check, not proven merely by these tests.

Native direct-local switch subsequently passed on the rebuilt `556a958` app.
Before switching, persisted members were 79 idle / 13 error, and config was
backed up to `/var/folders/pz/8_nc5kp109z8f36jl0172xzw0000gn/T/mcc-before-local-switch-uQk9wX/config.json`.
Using native controls, selected local mode, observed LibreChat path/key fields
disappear, saved, quit normally, and relaunched. Config readback is `backend: local`
with model URL `http://127.0.0.1:8080/v1`; health on 4317 reports local and one
available model. Native UI reached `desktop_ready=1` with zero local workspaces.
The legacy `state.json` still contains all 32 workspaces; no migration/deletion
was performed. Browser QA listener 58555 remained PID 43068. This verifies saved
backend switching and startup, not a generated conversation in the native local
workspace. Saved configuration now intentionally remains local.

Native-local MCP generation then completed in workspace
`7cd95a05-3fc6-45b6-8b1a-3cc5cd030424` (`Native local calculation audit`). The
actual persisted transcript contains `calculate(1/(1-3/4))`, real value 4 with
`proofVerified: false`, and a Japanese answer distinguishing arithmetic from an
NS regularity proof. Workspace ended SETTLED with an empty queue; MCP evidence
is `/tmp/mcc-native-local-generation.jsonl`, with native local-state/transcripts
retained. No other workspace was changed by this experiment.

This exposed an observer defect: a native window launched with zero workspaces
remained at zero after MCP creation, with its initial loading text still visible.
Polling was only scheduled by selecting a workspace, and `refresh(null)` returned
without discovering the list. Startup now schedules the observer even without a
selection; that branch refreshes the sidebar and a successful empty-list read
shows selection guidance instead of a perpetual loading message. The production
early-return branch has a passing regression test; full Node checks also passed
before that test was added. The correction still requires rebuilt native GUI
verification; model success does not prove the observer fix.

The rebuilt `49eb3d3` bundle then passed actual empty-list observer verification
in an isolated browser: served its packaged server and public resources on
49617 with a fresh temp store and a client that rejects any model execution.
The initial UI showed zero workspaces and selection guidance (not loading).
After creation through HTTP MCP, workspace
`63deb048-a281-4e60-91df-69c3deeab40c` appeared as the first sidebar item without
reload, click, or changing selection. Browser verification skill workflow used
Computer Use because its dedicated CLI was unavailable. This is browser rendering
of actual packaged assets, not yet a fresh native-window verification of this fix.
The test tab was closed and its dedicated server PID 63718 stopped; state remains
at `/var/folders/pz/8_nc5kp109z8f36jl0172xzw0000gn/T/mcc-empty-observer-tMiRMJ`.
Other app/server data was untouched. Full check: 348 total / 345 passed / 0 failed /
3 skipped; macOS build and all ten packaged public-file checks passed.

Fresh native process PID 64029 (09:27:31) subsequently loaded the local backend
and restored `Native local calculation audit` with one workspace, one answer,
idle member, and empty queue. Native AX inspection after scrolling exposed the
saved answer value 4 and its explicit arithmetic-not-NS-proof disclaimer, plus
the honest no-search-this-attempt indicator. No new model request was made.
This closes native display/reload for that persisted generation, not every
review-note interaction: clicking the repeated review button hit a stale/ambiguous
AX target, and subsequent scroll/latest controls did not establish a successful
dialog interaction. No review note was saved during this check. Existing browser
review tests remain separate evidence, not a substitute for this native gap.

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

### Post-cancellation package refresh

Rebuilt the macOS `.app` from application commit `dc54610`; this supersedes the
outdated generated-bundle status above, but does not update an already-running
server or the `/Applications` installation. Final `npm run check` now includes
all twelve cancellation tests: **344 total / 341 passed / 0 failed / 3 skipped**.
`desktop:build -- --bundles app` succeeded, and `verify:desktop` matched all ten
public files plus the bundled server.

The freshly packaged server passed the actual HTTP MCP research-handoff probe
against a copied recorded NS experiment: all three routes retained rejection
notes and `UNREVIEWED`, with zero model requests and original state unchanged.
Probe directory: `/var/folders/pz/8_nc5kp109z8f36jl0172xzw0000gn/T/mcc-handoff-sPV4bB`.
Build/check logs: `/tmp/mcc-current-desktop-build.log` and
`/tmp/mcc-current-full-check.log`.

`verify:signing` still exits 1 (ad-hoc signature or no TeamIdentifier). No signed
artifact, notarization, fresh native-window QA, or real LibreChat mixed-model E2E
is implied by this package refresh.

### Native window observation and process-version boundary

Computer Use identified two apps sharing `com.unjuno.multicontext` (installed
and build-output paths); selecting the bundle ID was ambiguous. Selecting the
build-output path exposed the actual native Tauri window, `DesktopApp E2E`, at
`tauri://localhost/index.html?desktop_ready=1`. It showed 32 saved workspaces,
six needing attention, and the selected workspace with two chats, no running
executions, no queued items, and Stop disabled. This is an observation only;
no settings, prompts, workspace data, or generation controls were changed.

PID 31015 started at 2026-09-08 06:44:20, whereas the rebuilt executable was
modified at 08:36:03. Thus the visible window cannot establish that the latest
native code is loaded, even though its executable path matches the new bundle.
The selected workspace's idle state does not establish that all 32 workspaces
are idle. No app quit/relaunch was performed. Fresh native verification remains
pending a safe restart; do not count this observation as final-artifact GUI QA.

### Fresh native launch after user closed the old GUI

After the user reported closing the native GUI, the process check found no
`multicontext-desktop` process and no listener on 4317. The isolated browser QA
server on 58555 remained PID 43068. Computer Use opened the rebuilt bundle:
new native PID 55886 started at 09:02:21, and new server PID 55908 listened on
4317, while 58555 retained its original PID. No server was killed or installation
replaced by this launch.

The startup view progressed to the native workspace view (`desktop_ready=1`),
showing the existing 32 workspaces and selected `DesktopApp E2E`. The new
unverified-summary warning appeared beside its existing Compile result. This
establishes fresh native startup and observation of that control, not all native
interaction paths, signed distribution readiness, or mixed-model E2E. No prompts
were submitted and no workspace settings were edited during the check.

The native server on 4317 reports the `librechat` backend and two discovered
Agents. An unauthenticated MCP handshake was rejected with `AUTH_REQUIRED`.
Using the existing Keychain MCP credential in-memory (not logged or regenerated),
the actual HTTP MCP client connected and listed 33 tools and 32 workspaces:
26 SETTLED, six BLOCKED. `DesktopApp E2E` was SETTLED with two active chats,
matching the native GUI observation. This proves authenticated readback and
unauthenticated rejection on the native listener, not successful execution of
all tools. No generation, queue, or workspace mutation was requested.

### Stored BLOCKED-state triage via native MCP

Read all six BLOCKED workspaces through authenticated `get_workspace` calls:

- Four workspaces contain `LibreChat agentId is required` member errors and
  retained queued work (three named `新しいワークスペース`, plus
  `DESKTOP_SANITY_1788014121173`).
- `Navier-Stokes 5ペルソナ` has five stored provider errors: requests of
  2053–2080 tokens exceeded a reported 2048-token context limit.
- `NS audit sequential research 2026-09-08` has two stored ten-round tool-budget
  exhaustion errors, explicitly retaining already-made deliveries and queued work.

These are persisted error observations, not six newly reproduced defects, and
the context error's reported capacity is not a probe of current model capacity.
No retries, Stop operations, queue deletion, or automatic Agent substitutions
were performed. `test/agentResolution.test.js` and `test/scheduler.test.js` were
rerun successfully; output is `/tmp/mcc-blocked-audit-tests.log`. Their fixture
coverage does not prove recovery of these real conversations. Actual recovery
would need an explicit choice of Agent/context handling or continued research;
do not erase the blocked records merely to make the status panel green.

### Registration-free missing-model guidance

Canonical application operations previously told users to create a LibreChat
Agent even with `backend: local` and a successful but empty model discovery.
They now share a backend-specific missing-model message: local users are told
to start the local inference server, load a model, and check its URL, explicitly
without LibreChat registration. The existing error code remains
`AGENT_SELECTION_REQUIRED`. A regression checks both broadcast and direct-send
rejection and verifies the whole workspace stays unchanged; the focused Agent
resolution suite passes 30/30. This change addresses empty-discovery guidance,
not every transport-error translation or legacy scheduler message. Running and
packaged builds have not yet been refreshed for this wording change.

### Real registration-free flywheel rerun on `72cb077`

Executed `smoke-research-flywheel.mjs` with `MULTICONTEXT_BACKEND=local` and
the actual local GPT-OSS 20B model, without loading a LibreChat env file. Evidence:
`data/experiments/research-flywheel-1788826035714/{state,trace,result}.json`;
console log `/tmp/mcc-final-local-flywheel.log`. The isolated workspace ID is
`4d7f2163-feee-4e77-a671-930eaa61a12e`; existing native/browser workspaces were
not used for this experiment.

Runtime acceptance passed: two completed members, one cross-chat delivery,
one successful observed Crossref query per member, and an exact DOI lookup by
the auditor matching the reported DOI. Five actual model requests reported
5097 total tokens (including repeated/cached prompt usage; not a cost comparison).
Both outputs retain `fullTextVerified: false` search evidence.

The retrieved record concerned DOI `10.1142/9789814623414_0006`. The auditor
matched title/year/DOI and absent author metadata and explicitly declined to
infer proof status from that metadata. The researcher's final text was only
“Done.”; its useful contribution is the recorded peer delivery and tool trace.
This establishes a working bibliographic discovery/handoff/check cycle, not
full-text research, a new Navier–Stokes result, mathematical correctness of the
referenced work, or the separate LibreChat-owned mixed-tool acceptance gate.
