# Native research experiment — 2026-09-08

Workspace: `55814d5f-a0ee-48a4-9703-3523be8f4390`

Started through the running desktop REST server on port 4317. Health reported
native mode and two discovered GPT-OSS agents. Researcher and Auditor both use
ChatA, with independent member contexts and distinct developer instructions.

Researcher must search primary sources for a precise 3D Navier–Stokes
regularity criterion, then send it to Auditor. Auditor must inspect assumptions
and scaling, and review the received claim once. Both distinguish proved
results from the estimate still needed for a proof. Search unavailability must
be reported explicitly. Responses are requested under 500 words.

Broadcast accepted. Completion, actual search calls, cross-chat delivery and
mathematical claims remain to be inspected. Preserve this workspace as evidence.
The running desktop has NOT been rebuilt with the current uncommitted fixes;
this experiment is baseline runtime evidence, not validation of those fixes.

## Observed terminal state

Both members became BLOCKED with `Cross-chat tool iteration budget exhausted
after 10 tool rounds`. Neither retained a completed assistant message. Workspace
stats: executions 0, toolEnqueues 1, inspections 9. Researcher's original queue
item remains for Retry; Auditor retains its original item plus one peer item.
The delivered peer content repeats the user request rather than a sourced
regularity criterion. Search execution and substantive mathematical progress
were not established. Both members report inFlight=false; there is no active
inference to wait for in this workspace. Do not classify this run as a success.

## Patch compatibility check

Copied the two currently modified LibreChat source files into a temporary
directory, applied the new patch, checked controller JavaScript syntax, and
applied the patch again. Both files upgraded successfully; the second pass
reported already patched. The running LibreChat process was not restarted.
This proves compatibility with the local patched source, not provider wire
behavior or successful model execution.

## Corrected scheduler comparison

Started repository server at port 4897 using commit ce5a039 and independent
state file `/tmp/mcc-audit-ce5a039-state.json`. Native health passed with two
agents. Workspace `c292c6bb-da06-4a25-9033-4ec941a0fd5b` repeats the baseline
two personas and identical broadcast. Server execution handle: 16799.
LibreChat remains the existing running version; its new source patches have
not been deployed. This comparison tests the corrected MultiContext scheduler.

Comparison reached SETTLED: executions=2, inspections=6, toolEnqueues=0;
both members idle with lastError=null and assistant responses preserved.
Events record a send attempt to lowercase `auditor`, but no successful
delivery. Cross-chat sharing therefore did not pass. Both answers claim
literature search; no provider search trace has yet been captured to support
this. References and mathematical claims remain unverified. This is runtime
completion evidence, not a knowledge-flywheel acceptance pass. Full responses
remain in the isolated state file and workspace identified above.

Follow-up: explicitly instructed Researcher to send `AUDIT_SHARE_20260908`
to Auditor UUID `15044b1a-65e0-4c8c-bea2-2fbedffdf510`. Enqueue accepted
with item `232db639-4d9a-4906-8dcc-43003508a7cf`.
Authenticated LibreChat response-history reads returned 200 for both member
conversations, but exposed message items only, no tool call/output trace.
This history endpoint cannot substantiate the claimed web searches; absence
of such items here does not establish that search never ran.

UUID follow-up completed: SETTLED, executions=4, toolEnqueues=1,
inspections=6, both idle without errors. Auditor history contains the exact
AUDIT_SHARE marker as received user content. This proves one cross-chat
delivery and recipient processing with an explicit UUID.

## Search capability diagnosis

A direct native request through the repository LibreChatClient asked ChatA
to actually search the official Clay problem statement or explicitly report
unavailability. Response: SEARCH_UNAVAILABLE; raw output contained reasoning
and message items only. Conversation: 93b8fc32-b727-4b8f-8b67-404eac7c56fe.
Read-only MongoDB inspection of only id/name/provider/tools for the two
configured agents confirmed ChatA.tools=[] and ChatB.tools=[]. No provider
research tool is configured on either Agent. Request-bound cross-chat tools
are supplied separately by MultiContext. Earlier model claims of web search
are therefore not evidence of actual configured web search. Enabling and
testing a real research tool is required before accepting a search flywheel.

Environment-presence check (values were not printed) found none of
SERPER_API_KEY, TAVILY_API_KEY, SEARXNG_INSTANCE_URL, FIRECRAWL_API_KEY,
or JINA_API_KEY in the LibreChat process environment loaded from its .env.
This is not an exhaustive check of database-stored user credentials or other
search integrations, and does not prove every possible search route unavailable.
No credentials or new third-party services were provisioned by this audit.

## Final local verification checkpoint

`npm run check`: 278 tests, 275 passed, 0 failed, 3 skipped.
`npm run verify:bundle`: passed, including bundled-server MCP list_workspaces.
These are local results, not a new GitHub CI run or signed desktop GUI pass.

Tool results with `ok:false` now produce `tool.failed` observer events with
the returned error code, rather than successful-looking send/inspect events.
Regression coverage checks both scheduler event classification and UI wording.

Release assessment remains conditional: native provider-wire propagation,
same-step mixed ownership execution, and real search-plus-cross-chat E2E
are not verified. Missing provider outputs are rejected before external
delivery; this fail-closed guard is not implementation of mixed execution.
The live LibreChat process has not been upgraded or restarted. Local fixes
and test success must not be described as deployed production behavior.

## Deployed legacy guard spelling regression

Further inspection found the live LibreChat source still uses
`toolNames.every((n) => cross.has(n))`. The previous migration only matched
the callback identifier `name`; its passing fixture did not cover this actual
deployed spelling. Migration now matches the bound callback identifier and
normalizes the guard to `some`. Regression cases for both `name` and `n`
pass, including a second idempotent application (4 patch tests total).
Copies of the actual two LibreChat files were patched in
`/tmp/mcc-patch-upgrade.FPZl2J`: controller syntax passed, the resulting guard
uses `some`, and a second patch reports already patched. Live source/process
was left unchanged. This strengthens upgrade coverage, not mixed execution
correctness or runtime deployment evidence.

## Mixed event-boundary implementation checkpoint

Added a dependency-free non-streaming execution adapter embedded by the
LibreChat patch. It partitions the event batch before the guarded loader,
invokes the stock handler with provider calls only, checks returned call IDs
and completeness, saves actual results in the response aggregator, and then
rejects the original graph batch with EXTERNAL_TOOL_DEFERRED for cross-chat.
It does not resolve the original batch with invented cross-chat outputs.
Provider-only events retain the original handler and callbacks. Abort during
provider execution prevents external deferral.

Seven adapter tests cover mock search/MCP/code mixed batches (2+2 calls),
provider-only, cross-only, missing results, and cancellation. With four patch
tests, 11 targeted tests pass. Reapplying to copied actual LibreChat source
passes controller syntax and idempotence checks. The streaming path remains
unchanged; MultiContext native requests use the non-streaming path.

This implementation is not yet release-verified: actual SDK result truncation
and structured-content conversion, graph unwind persistence, and real native
mixed execution require integration coverage. No live LibreChat files were
modified and no running service was restarted by this checkpoint.

Installed-handler contract verification now passes via
`node scripts/verify-librechat-mixed-handler.mjs /Users/taka/projects/LibreChat`.
This loads the actual installed `@librechat/api` createToolExecuteHandler,
supplies deterministic provider tools, and checks invocation and tool-end
callbacks. Both provider tools execute, cross-chat never loads or executes,
and real text/empty outputs reach the aggregator. This is stronger than the
mock-handler unit test, but intentionally not a search or model E2E.

SDK inspection confirms eager completion uses truncateToolResultContent for
strings/errors and serializeStructuredValueBounded for structured results,
with the agent-specific size limit. The adapter currently uses unbounded
JSON serialization instead; correcting this difference remains required
before committing/deploying the mixed implementation as release-ready.

Subsequent correction replaces production JSON serialization with the installed
SDK's own truncateToolResultContent and serializeStructuredValueBounded,
using graph agent context limits where provided. The integration command now
compares empty, long, structured, circular and error outputs with the installed
SDK and passes all five cases. Actual-source copy upgrade, syntax and repeat
application also pass. The structured serializer is not a public package
export: the patch resolves its path relative to the installed CommonJS entry.
This is an explicit SDK-version compatibility dependency; upgrade validation
must run the integration command. It is not proof of graph persistence or
real-model E2E, which remain open.

## Persistence defect reproduced (open)

`node scripts/verify-librechat-tool-persistence.mjs /Users/taka/projects/LibreChat`
fails with `Provider tool evidence is lost by saveResponseOutput`.
The probe reads the actual controller's saveResponseOutput function and runs
it with an in-memory saveMessage stub: summary text is saved, while a distinct
provider function_call_output marker is not. No MongoDB connection or live
conversation mutation is involved. This verifies a source-level persistence
loss, not the behavior of every native model continuation.

The controller's saveInputMessages also saves only user-role input. Current
MultiContext ordered continuation re-injects the current response's tool
transcript, which can bridge the immediate turn, but is not evidence that
earlier tool evidence survives subsequent turns. Before claiming durable
knowledge extraction, tool evidence must have a persisted representation
and replay must avoid duplicating calls already present in history. The probe
is intentionally failing until that contract is implemented; it is a manual
integration gate, not included in the default Node unit suite.

Persistence implementation preparation: inspected LibreChat's actual
api/app/clients/prompts/formatMessages.js. It expects a preceding text part
with tool_call_ids and a tool_call part containing id/name/args/output. It
creates a ToolMessage with `output || ''`, so persisting an unresolved call
would incorrectly create an empty result. Added completedToolContent and
deduplicateToolHistory helpers with four passing tests: retain completed
evidence, distinguish empty from pending, deduplicate without mutation/text
loss, and reject conflicting replay. These helpers are not yet connected to
controller persistence; the persistence integration gate still fails.

Controller integration checkpoint: the patch now saves completed response
tools as native LibreChat content, saves completed tool round-trip inputs,
deduplicates stored tool history, and excludes matching saved pairs from
immediate continuation replay. Pending calls are never persisted as completed
tools. Five history unit tests and four patch tests pass.

The previously failing persistence probe now passes against the patched copy:
`node scripts/verify-librechat-tool-persistence.mjs /tmp/mcc-patch-upgrade.FPZl2J /Users/taka/projects/LibreChat`.
Its optional second path loads the installed LibreChat formatter; replay
contains exactly one AI tool call, its real ToolMessage output, then summary
text even when history includes a duplicate saved pair. Controller syntax
and patch idempotence also pass. This tests source persistence arguments with
an in-memory DB stub, not an actual MongoDB save/load cycle. Live deployment
and real-model mixed E2E remain outstanding.

## Actual database persistence verification

Added and ran `scripts/verify-librechat-tool-database.mjs` with the patched
source copy and installed LibreChat runtime, loading MONGO_URI without printing
it. The script creates a unique audit database, uses installed createModels /
createMethods, executes patched controller saveResponseOutput/saveInputMessages,
reads via loadPreviousMessages, then formats deduplicated history with the
installed formatter. Synthetic provider evidence and cross-chat receipt are
restored once each, in call/output order. No existing conversation is changed.

Clean pass: database `multicontext_audit_1788812881634_4dcde948`, conversation
`53150a3d-8349-4e15-acf3-a9dc8f2773a7`; two stored documents, two restored calls.
Records are retained for later inspection. Initial pass database
`multicontext_audit_1788812859907_8aa9449e` also remains; that run completed
assertions but reported interrupted background index creation at disconnect.
The verifier now disables automatic index/collection initialization and the
second run exited cleanly. This is actual MongoDB round-trip evidence with
synthetic inputs, not an actual model/search invocation or live deployment.

## Desktop build checkpoint

After commit 1e397b7, `npm run verify:bundle`, `npm run desktop:check`, and
`npm run desktop:build -- --bundles app` passed. The build produced
`src-tauri/target/release/bundle/macos/MultiContext.app` without installing or
opening it. `npm run verify:desktop` also passed after extending its checksum
checks to activity-feed.js and dist/server.bundle.mjs, covering the observer
and scheduler artifacts changed in this audit. Signing/notarization and a
direct GUI pass are not established by these build results.

## Built-in keyless source discovery (2026-09-08)

At the user's request, search is now a standard MultiContext-owned native
tool (`search_sources`), without additional packages, API keys or a separate
service. General web discovery uses DuckDuckGo HTML; scholarly discovery uses
Crossref's public API. This removes the dependency on configuring a provider
search tool on each LibreChat Agent. Query egress, limits, disable switch and
failure semantics are documented in BUILTIN_SEARCH.md and GUI help.

Direct real-network checks returned Navier–Stokes results from both sources.
Two real ChatA native model probes each emitted one search_sources call,
received actual Crossref output and completed. The second also asserts that
the final answer contains a DOI from the retrieved results:

- Conversation `e46a20f1-d1cc-4cdd-a6e8-5e4acb5cc692`, evidence directory
  `/var/folders/pz/8_nc5kp109z8f36jl0172xzw0000gn/T/multicontext-search-smoke-Ig6WFn`.
- Conversation `7967bf16-a544-4874-aeeb-3c9a63b7bdd9`, evidence directory
  `/var/folders/pz/8_nc5kp109z8f36jl0172xzw0000gn/T/multicontext-search-smoke-zaSCEG`.

Both retrieved DOI `10.1142/9789814623414_0006`, title
"Local Regularity Theory for Non-Stationary Navier-Stokes Equations".
Evidence JSON records requests/responses and actual tool results, not just
model assertions. The first model response invented an author not present in
the returned metadata. Author fields were then added to search results; the
second response avoided a specific author name but still asserted review/
peer-review properties unsupported by the retrieved metadata. Thus actual
retrieval/DOI citation passes; research correctness does not. No theorem has
been established and no full text was fetched. Temporary raw evidence should
be archived before OS cleanup; these observations are retained in git.

`npm run check`: 298 total, 295 passed, 0 failed, 3 skipped.
`npm run verify:bundle`: passed. Tests cover disabled mode, validation,
fixed-host requests, caching, CAPTCHA/format failure, size limits, provenance
and external executor call IDs. The live probes use the existing LibreChat
with request-owned search; they do not establish provider-owned mixed-batch
correctness, the new desktop GUI path, or deployment of the pending host patch.

## Search-to-peer runtime test and instruction continuity

Added `smoke-research-flywheel.mjs`: real native client, canonical application,
FIFO scheduler, independent researcher/auditor personas and isolated durable
state under `data/experiments/` (git-ignored, retained locally). Model request/
response traces are recorded; no production workspace is overwritten.

Baseline `research-flywheel-1788813938286`, workspace
`c1cbd9f0-e421-4ea6-b66e-9c44ab9e28c0`: searches occurred but no delivery;
researcher repeatedly targeted nonexistent `auditor` instead of supplied UUID
and exhausted ten tool rounds. No completion is claimed.

LibreChat does not persist request system/developer roles. Scheduler native
continuations now explicitly rebind the original global/developer instructions
without replaying ordinary user history. Regression tests verify both client
body roles and scheduler forwarding. This is a request-contract fix, not proof
that the model follows the instructions.

Retest `research-flywheel-1788814017531`, workspace
`683382cd-4799-4576-9905-686ddad01cb9`: one delivery and one completed auditor,
but researcher again exhausted ten rounds. The researcher eventually sent a
DOI/title/author claim not supported by the recorded search results. Auditor
searched Crossref and challenged that citation, but falsely also claimed a
general web search, which its trace does not contain. Runtime test therefore
fails its both-members-complete condition, and scientific correctness fails.
The running LibreChat still uses the old text-only persistence path; the new
host patch must be exercised before attributing all continuation behavior to
the model alone. `npm run check`: 299 total, 296 pass, 0 fail, 3 skip.

## Host source upgrade checkpoint

Applied the repository patch to the actual `/Users/taka/projects/LibreChat`
checkout after backing up responses.js, service.ts and packages/api/dist to
`/tmp/librechat-before-mcc-upgrade.19H9es`. Existing source modifications were
preserved by the migration script. Controller syntax passed and
`npm exec -- tsdown` in packages/api completed successfully.

PID 82907 still runs the old in-memory controller. No restart was performed.
Read-only MultiContext workspace listings at ports 4317 and 4897 showed only
SETTLED or BLOCKED workspaces, not RUNNING; this does not establish whether an
independent LibreChat client is using that service. Restart coordination is
required before claiming the new host code has been exercised by the model.

## Authorized restart and post-upgrade run

User authorized restart (`sakidou`). Sent TERM to old PID 82907. Initial
startup failed because 127.0.0.1:27017 was unavailable; OrbStack was not running
and existing container `mcc-mongo` was stopped. Started OrbStack and that
existing container with its existing volumes (no data deletion/recreation),
then started LibreChat with the rebuilt source. PID 18506 listens on
127.0.0.1:3080; authenticated native health reports two agents. Startup logs:
`/tmp/librechat-mcc-restart.log` and `/tmp/librechat-mcc-restart-2.log`.

Post-upgrade flywheel run `research-flywheel-1788814497156`, workspace
`ba09594c-a766-4d38-8e8d-b52dc7d02e37`, passes the runtime assertions:
two completed members, one peer delivery, no inspections, both idle. Durable
local evidence is under `data/experiments/research-flywheel-1788814497156/`.

Research correctness still fails: auditor treated a bibliographic search for
the DOI as a failed exact DOI resolution and claimed direct resolver activity
not established by this tool interface. Therefore runtime completion is not
proof of accurate source verification. Exact DOI lookup and evidence-grounded
auditor reporting need further work; no scientific conclusion is accepted.

## Exact DOI correction and evidence-sharing retest

`search_sources` now recognizes a DOI-only query in papers mode and uses the
exact Crossref works endpoint instead of bibliographic keyword search. It
reports queryMode, requestedDoi, lookupStatus and fullTextFetched=false.
404 is explicitly scoped to Crossref; HTTP/network errors are not negative
findings. Tests cover normalized DOI inputs, returned identity mismatch,
not-found and service failure.

Run `research-flywheel-1788814796119`, workspace
`cbe46e75-85bf-40cb-96fb-f0215181e215`, completed both chats with one delivery.
Recorded auditor result: queryMode=exact_doi, lookupStatus=found,
requestedDoi=10.1142/9789814623414_0006. Auditor final text correctly reproduced
the returned title/year/DOI and distinguished the need to consult the publisher
for further detail. It no longer falsely described an unsuccessful resolver
visit. This is a successful source-discovery/metadata-cross-check example,
not verification of the contents of the paper or a mathematical result.
Raw trace/state/results remain under the corresponding data/experiments path.
The reusable smoke test additionally requires an auditor exact lookup and
citation of its returned DOI; runtime completion alone is insufficient.

Reproducibility run `research-flywheel-1788814892450`, workspace
`850ccbbb-a7b4-4ad2-92f1-ec1cd04ce31a`, passes the strengthened exact-lookup
assertion with both members completing. Latest local safety change lets a
cancelled queued search return promptly without waiting for the preceding
network request; its regression test verifies no cancelled request is sent.
`npm run check`: 302 total, 299 pass, 0 fail, 3 skip. A rebuilt macOS app and
`verify:desktop` pass with that change. No installation/GUI claim follows.
