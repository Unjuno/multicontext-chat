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
