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
