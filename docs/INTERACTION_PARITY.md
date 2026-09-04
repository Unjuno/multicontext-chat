# Interaction Parity — Desktop GUI vs MCP

## Invariant

**INTERACTION PARITY INVARIANT.** Any domain operation exposed through both
Desktop GUI and MCP must execute through the same canonical application
operation and produce equivalent persisted state, runtime behavior, events,
permissions, errors, provenance, and side effects. Differences must be limited
to transport and presentation concerns.

```
        Desktop GUI
             │
             │ HTTP/UI transport
             ▼
     canonical application API   (src/application.js + src/orchestrator-engine.js)
             ▲
             │ MCP transport
             │
        MCP / agents
```

Rules:

- Do NOT make MCP call GUI handlers. Do NOT make GUI call MCP handlers.
- Both call the same application/domain operation underneath.
- New domain behavior goes in `src/application.js` (or `src/orchestrator-engine.js`
  for run dispatch), never duplicated into `src/server.js` routes or `src/mcp/*`.
- Focus hints (`POST /api/workspaces/:id/focus`, `GET /api/focus/pending`) are
  transport/UI metadata: they may be emitted by MCP experiment-start paths but
  must not alter domain state or execution semantics.
- The differential suite `test/interaction-parity.test.js` fails if either
  transport bypasses the canonical method (canonical-method spies + A/B fixture
  comparison). Keep it green and extend it for every new dual-surface operation.

## Root audit (what drift/duplication was found and fixed)

All items below were class C (domain drift) or D (duplicated domain logic);
each is now routed through one canonical operation.

| # | Drift found | Fix (canonical op) |
|---|-------------|--------------------|
| 1 | MCP `inspect_peer_chat` crashed with `ReferenceError` (`workspaceId` vs `workspace_id`) — MCP had its own broken call path | MCP routes through `Application.inspectPeerChat`, same as `POST /tools/:ws/:member/inspect-chat` |
| 2 | `human.broadcast / human.send / human.stop` lived in the MCP handler with their own validation/events | Moved into `Application.broadcast / send / stopWorkspace / stopChat` with `origin` passthrough; MCP is a thin wrapper |
| 3 | Run start/resume/cancel/pause logic duplicated between GUI pause route and MCP orchestrator tools | New `src/orchestrator-engine.js` (`createRunRecord / dispatchRun / startRun / resumeQueuedRun / cancelRun / setPaused`); `Application.startRun / cancelRun / setOrchestratorPaused / resumeQueuedRun` delegate to it; both transports share it |
| 4 | MCP `send` limit `100k` vs GUI `1MB` (validation drift) | Removed the MCP-side cap; both enforce the GUI limit |
| 5 | MCP `update_workspace` could not set cross-chat settings (GUI could) | `settings.allowCrossChatInspect / allowCrossChatSend` supported on both |
| 6 | `send_to_chat` idempotency existed only per-transport | `Application.sendToChats` owns `idempotencyKey /^[A-Za-z0-9_-]{1,64}$/` + atomic receipt/replay; MCP `idempotency_key`, HTTP `idempotency_key`, OpenAPI `sendParamsHttp` all feed it |

Native `gpt-oss` role/continuation semantics, compat contracts, compile
isolation (result never injected into member history), and run-scoped
cancellation (no rollback of completed external effects) were preserved.

## Parity matrix

Status labels: **VERIFIED** (differential test), **PARTIAL** (shared code path by
inspection, no differential test yet), **GUI ONLY** / **MCP ONLY** (single
surface by design), **TRANSPORT-ONLY** (presentation difference, same domain op).

| Operation | GUI surface | MCP surface | Canonical op | State | Events | Provenance | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| create workspace | `POST /api/workspaces` | `multicontext_create_workspace` | `app.createWorkspace` | = | = | n/a | VERIFIED | spy proves shared impl |
| update workspace (+settings) | `PATCH /api/workspaces/:id` | `multicontext_update_workspace` | `app.updateWorkspace` | = | = | n/a | VERIFIED | cross-chat settings both ways |
| delete workspace | `DELETE /api/workspaces/:id` | `multicontext_delete_workspace` | `app.deleteWorkspace` | = | = | n/a | PARTIAL | shared impl by inspection |
| add member | `POST …/members` | `multicontext_add_chat` | `app.addChat` | = | = | n/a | VERIFIED | |
| update member | `PATCH …/members/:id` | `multicontext_update_chat` | `app.updateChat` | = | = | n/a | VERIFIED | |
| delete member | `DELETE …/members/:id` | `multicontext_delete_chat` | `app.deleteChat` | = | = | n/a | VERIFIED | |
| broadcast | `POST …/broadcast` | `multicontext_broadcast` | `app.broadcast` (+`origin`) | = | = | = | VERIFIED | queue/events compared |
| direct enqueue | `POST …/members/:id/enqueue` | `multicontext_send` | `app.send` (+`origin`) | = | = | = | VERIFIED | |
| stop member | `POST …/members/:id/stop` | `multicontext_stop_chat` | `app.stopChat` | = | = | n/a | VERIFIED | same abort semantics |
| stop workspace | `POST …/stop` | `multicontext_stop_workspace` | `app.stopWorkspace` | = | = | n/a | VERIFIED | |
| retry blocked member | `POST …/members/:id/retry` | `multicontext_retry_chat` | `app.retryChat` | = | = | n/a | VERIFIED | same requeue semantics |
| compile | `POST …/compile` | `multicontext_compile` | `app.compile` | = | = | n/a | VERIFIED | same preconditions; isolation asserted on both |
| start run | — | `multicontext_orchestrate_start_run` | `app.startRun` → engine | = | = | = | MCP ONLY | no GUI start-run route by design; engine shared + spy-verified |
| create session / run (preset) | — | `multicontext_orchestrate_create_session`, `multicontext_orchestrate_run` | engine via `app.startRun` | = | = | = | MCP ONLY | agent-driven; GUI observes via state/focus |
| pause dispatch | `POST …/orchestrator/pause` | `multicontext_orchestrate_set_paused` | `app.setOrchestratorPaused` → engine | = | = | = | VERIFIED | opposite-surface resume tested |
| resume dispatch | `POST …/orchestrator/pause` (`paused:false`) | `multicontext_orchestrate_set_paused` (`paused:false`) | engine `resumeQueuedRun` (oldest queued) | = | = | = | VERIFIED | |
| cancel run | — | `multicontext_orchestrate_cancel_run` | `app.cancelRun` → engine | = | = | = | VERIFIED | works on running, queued, **blocked**, **failed**; run-scoped; unrelated human work preserved |
| read workspace | `GET /api/workspaces/:id` | `multicontext_get_workspace` | `app.getWorkspace` | = | n/a | = | VERIFIED | mid-flight provenance item identical on both reads |
| read run / orchestrator state | `GET …/orchestrator` | `multicontext_orchestrate_get_run`, `…_get_state` | `store.getOrchestratorRun / getOrchestratorState` | = | n/a | = | PARTIAL | direct store reads; envelopes differ |
| inspect chat | `POST /tools/:ws/:member/inspect-chat` | `multicontext_inspect_peer_chat` | `app.inspectPeerChat` | = | = | n/a | VERIFIED | incl. former ReferenceError regression |
| cross-chat send | `POST /tools/:ws/:member/send-to-chat` | `multicontext_send_to_peer_chats` | `app.sendToChats` | = | = | = | VERIFIED | idempotency key + replay on both; bad-key 400 both |
| list peers | `GET /tools/:ws/:member/list-chats` | `multicontext_list_peer_chats` | `app.listPeerChats` | = | n/a | n/a | PARTIAL | shared impl by inspection |
| wait until settled | `POST …/wait` | `multicontext_wait_until_settled` | `app.waitUntilSettled` | = | n/a | n/a | PARTIAL | mechanical-only on both |
| read messages | `GET …/messages` | `multicontext_get_chat_messages` | `app.getChatMessages` | = | n/a | n/a | PARTIAL | same bounds/strip rules |
| compile result read | workspace view `lastCompile` | `multicontext_get_compile_result` | `app.getCompileResult` / store | = | n/a | n/a | PARTIAL | |
| orchestrator queue ops (enqueue/next) | — | `multicontext_orchestrate_enqueue`, `…_next` | store Q ops | n/a | n/a | = | MCP ONLY | agent queue mechanics; no GUI equivalent by design |
| distill / findings / join | — | `…_distill_context`, `…_extract_findings`, `…_join_as_member` | store/app reads | n/a | n/a | = | MCP ONLY | agent-only helpers |
| focus hints | `GET /api/focus/pending` (consume) | emitted on experiment-start tools | none (metadata) | n/a | n/a | n/a | TRANSPORT-ONLY | consume-once, in-memory, never alters domain |
| toasts / dialogs / dirty guard / navigation | GUI rendering | MCP envelope | none (presentation) | n/a | n/a | n/a | TRANSPORT-ONLY | |

Summary: **VERIFIED 18** (incl. 4 cross-cutting: permission-denied, invalid
input/ids, recursive provenance, tool-budget block), **PARTIAL 7**,
**MCP ONLY 4**, **GUI ONLY 0** (visual-only operations intentionally unexposed),
**TRANSPORT-ONLY 2**.

## Differential tests (`test/interaction-parity.test.js`, 17 tests)

Each test builds equivalent fixtures A (GUI/HTTP) and B (MCP), normalizes only
transport-only fields (uuids, timestamps, envelopes, caller origin), and
compares persisted state, queue contents, runtime state, provenance, events,
receipts, and errors. Canonical-method spies prove both surfaces route through
the same implementation.

1. create workspace · 2. update workspace incl. settings · 3. add/update/delete
   member · 4. broadcast state/queue/events · 5. direct enqueue · 6. stop member
   + stop workspace · 7. retry blocked member · 8. compile precondition + result
   isolation · 9. pause/resume dispatch (opposite-surface resume) · 10. cancel
   run run-scoped (in-flight, gated) · 11. cancel run on blocked/failed status
   (store transition `blocked/failed → cancelled`, run-scoped) · 12. inspect
   (ReferenceError regression) · 13. send_to_chat idempotency + replay + bad key ·
   14. permission-denied inspect/send (identical codes `CROSS_CHAT_INSPECT_DISABLED` /
   `CROSS_CHAT_SEND_DISABLED`) · 15. invalid input + unknown ids ·
   16. recursive provenance A→B→C collapses to root run/Q + GUI/MCP read
   agreement mid-flight + normalized messages/events equality ·
   17. native tool-budget block (`TOOL_ITERATION_BUDGET_EXHAUSTED`, deliveries
   kept, `BLOCKED` on both surfaces).

Notable: while writing test 17, a fixed `call_id` caused the second tool round
to replay instead of deliver — the canonical atomic receipt working as
designed. Test uses unique call ids per round (test 16).

## Remaining limitations

- PARTIAL rows have shared-impl evidence but no differential test yet (delete
  workspace, run-state reads, list peers, wait, message reads, compile-result
  read). Promote them by adding A/B tests, not by weakening the suite.
- Run/session creation and queue mechanics are MCP-only
  surfaces; GUI parity for them means observing identical state, not issuing
  the operations. (cancel now VERIFIED — it works on all terminal statuses)
- MCP error envelopes are opaque SDK errors while GUI returns `{error, code}`
  JSON; parity is proven at the canonical error (`status/code/message`) level.

Implementation notes:
- `store.js` transition table: `blocked: ['cancelled']`, `failed: ['cancelled']` (were `[]`); terminal immutability exception for `cancelled` from blocked/failed
- `orchestrator-engine.js`: `cancelRun` guard changed from `!(running||queued)` to `!['running','queued','blocked','failed'].includes(status)`; TOCTOU fixed via store atomic transition validation; `dispatchRun` race fixed by re-checking status before dispatching
- Total: **264** Node tests (+1), 46 Rust tests, bundle verified
