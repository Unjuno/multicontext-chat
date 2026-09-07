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
