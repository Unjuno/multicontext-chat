# Architecture

MultiContext Chat is a thin orchestration layer over LibreChat Agents API.

- One workspace contains N logical members.
- Every member owns its own message history and FIFO prompt queue.
- One member has at most one active generation; different members run concurrently.
- A user broadcast is copied into every active member queue.
- Cross-context communication is explicit through `inspect_chat` and `send_to_chat`; no foreign history is auto-injected.
- Tool results remain inside the LibreChat Agent run unless an agent explicitly sends a derived prompt to another member.
- `SETTLED` means no active generation and no queued prompts; it does not mean consensus.
- Compile is manual and never writes its synthesis back into member histories.

## Why a companion layer instead of vendoring LibreChat

LibreChat is kept as the model/tool/agent runtime. This repository owns only the new semantics. That keeps upstream upgrades tractable and avoids copying a large MIT project into a second repository.

## Instruction hierarchy

Requests use Open Responses input items in this order:

1. workspace global prompt as `system`
2. member prompt as `developer`
3. independent user/assistant history
4. current queue prompt as `user`

Current LibreChat main accepts `developer` in its Open Responses schema but its converter normalizes developer input to an internal system message. Therefore the application preserves the intended distinction on its side, but native `system > developer > user` behavior ultimately depends on the LibreChat/provider path. Backend tool permissions must never rely on prompt hierarchy.
