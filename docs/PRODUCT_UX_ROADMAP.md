# Product UX Roadmap

MultiContext Chat is useful when a user wants several independent AI perspectives on one task, while keeping each conversation inspectable and combining the results only at the end. The product experience should make that workflow understandable before the first send and recoverable when one perspective fails.

## Current product promise

- Create a workspace for one research, planning, or review task.
- Give each independent chat a role and an Agent.
- Broadcast the same prompt, or send to one chat, while preserving separate histories.
- Inspect execution state, retry blocked work, stop queued work, and compile a final report without modifying member histories.

## Prioritized improvements

### P0 — first successful run

1. Keep the new-workspace dialog focused on the first decision: name and number of chats.
2. After creation, show a short setup checklist when a chat has no Agent or role.
3. Make the first-send path explicit: “設定を保存 → 送信”.
4. Preserve drafts when refresh, retry, or a workspace switch is triggered.

Acceptance: a new user can create two chats, assign Agents, send one broadcast, and identify where the two independent answers are shown without reading documentation.

### P0 — execution confidence and recovery

1. Keep one authoritative status vocabulary across the header, workspace list, chat cards, and MCP responses.
2. Show the reason and next action for `BLOCKED`, including retry availability and the last failure time.
3. Keep Stop, Retry, and refresh idempotent from the user's perspective.
4. Make stale data explicit and provide a single recovery action.

Acceptance: an interrupted run can be diagnosed, retried, or stopped without duplicate delivery or an ambiguous blank screen.

### P1 — result review

1. Add clear visual separation between member answers and the compiled report.
2. Show which messages were included in a compile and when the snapshot was taken.
3. Make “latest” navigation and copy/export actions visible at the result level. Compile history keeps the latest five reports selectable and exportable.
4. Preserve the report prompt and make re-compilation deliberate.

Acceptance: a user can explain which independent answers produced a report and can reproduce the report without changing member history.

### P1 — workspace organization

1. Keep search, state filtering, sorting, pinning, and archive recovery consistent.
2. Distinguish active workspaces from archived workspaces without hiding recovery.
3. Add a compact workspace summary: active chats, queued work, blocked chats, and last update.

Acceptance: a user with dozens of workspaces can find the right one and identify required action in one pass.

### P2 — settings and portability

1. Keep Agent selection mode configurable, visible, and persisted per workspace.
2. Keep OS-specific process, path, secret-store, and GPU launch behavior behind the desktop boundary.
3. Document the Tauri data-store location and provide an explicit backup/restore path before shipping.

Acceptance: changing Agent policy is observable in the UI and API, and a Windows/CUDA port does not require changing orchestration semantics.

## Manual release loop

For each UX change, run a focused manual flow on the macOS bundle: launch, create or select a workspace, perform the affected action, force one recovery path where safe, and inspect the resulting state. Record evidence in `docs/PRODUCT_RUNTIME_CHECK.md`. Unit and regression suites are intentionally outside this product-validation loop.
