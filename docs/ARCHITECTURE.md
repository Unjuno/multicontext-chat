# Architecture

MultiContext Chat is a thin orchestration layer over LibreChat Agents.

- One workspace contains N independent members.
- Each member has one FIFO input queue and at most one active run.
- Different members can run concurrently.
- A human broadcast copies the same prompt into every active member queue.
- A queued prompt is executed as a normal `user` input in the target member.
- Cross-chat access exists only through explicit `list_chats`, `inspect_chat`, and `send_to_chat` tools.
- The application does not assign meaning, persona, debate rules, or reaction policy to messages. Those belong to the editable prompts and model.
- `SETTLED` means no active or blocked work remains. It does not assert semantic agreement.
- Compile is manual and never writes its output into member histories.

## External Control MCP (B)

MultiContext itself is an MCP server for external clients (OpenCode etc.):

```
External MCP client → Streamable HTTP /mcp → src/mcp/handler.js → src/application.js → StateStore/Scheduler/LibreChatClient → LibreChat → GPT-OSS
```

`src/application.js` is the single source of truth for workspace state, agent resolution, broadcast/direct validation, compile gating, and cross-chat semantics. Both `src/server.js` (REST) and `src/mcp/*` (MCP) are thin adapters that call it. This avoids duplicated orchestration logic and guarantees REST and MCP behave consistently.

- Agent resolution: `member.agentId ?? workspace.defaultAgentId ?? (single available ? that : AGENT_SELECTION_REQUIRED)`, validated against live discovery; stale IDs surface `AGENT_NOT_AVAILABLE`.
- Compile: `compileAgentId ?? workspace.defaultAgentId ?? singleAgent ?? error`.
- Cross-chat `send-to-chat` validates all targets before any enqueue.
- `wait_until_settled` polls mechanical `runtimeState`, bounded 1-300s, no mutation.

## Runtime states

`RUNNING` means at least one active generation. `PENDING` means queued work is ready to run. `BLOCKED` means a member failed and has a queued turn waiting for explicit Retry. `SETTLED` means active members have no current work, queue, or error.

Queue reservation is persisted before a model call. On process restart, an interrupted item is returned to the front of its member FIFO. On model failure it is also requeued and the member becomes `BLOCKED`; retry is explicit to avoid a runaway error loop.

## LibreChat modes

`compat` uses stock LibreChat and keeps the canonical conversational history in MultiContext. It sends `store:false` and replays only that member's bounded history.

`native` requires the small patch documented in `GPT_OSS.md`. It uses LibreChat persistence as the canonical model context: the first turn creates a LibreChat conversation, its id is stored on the member, and later turns send `previous_response_id`. MultiContext still mirrors visible user/assistant messages for UI and cross-chat inspection, but does not replay them to the model.

### Native cross-chat tool ownership and continuation

Request-level `CROSS_CHAT_TOOLS` are externally executed tools. LibreChat exposes their definitions to the provider so gpt-oss can emit a `function_call`, but the MultiContext LibreChat patch prevents those calls from entering LibreChat's normal internal tool executor. LibreChat-owned Agent tools remain on the stock execution path.

The native round trip is:

```
initial:      system + developer + user + tools + store:true
                    ↓
model:        function_call
                    ↓
LibreChat:    return function_call without executing it
                    ↓
MultiContext: execute list_chats / inspect_chat / send_to_chat
                    ↓
continuation: previous_response_id
              + answered function_call
              + matching function_call_output
              + same tools
                    ↓
model:        final assistant response or another function_call
```

The continuation deliberately re-sends the answered `function_call` before its `function_call_output`. LibreChat persistence does not preserve enough structured tool-call state for gpt-oss to reliably ground a standalone output; without the paired call, the output can dangle and the model may re-call the tool or return empty text. `system`, `developer`, `user`, and local member history are **not** replayed during continuation. `previous_response_id` owns the stored conversational history, while the explicit call/output pair restores the structured tool round trip required by the provider.

## Prompt hierarchy

At the MultiContext → LibreChat API boundary the request order is:

1. workspace prompt as `system`
2. member prompt as `developer`
3. current queued prompt as `user`

In `compat`, stock LibreChat may normalize roles internally. In `native`, the supplied LibreChat patch preserves the distinction for gpt-oss/OpenAI-compatible model paths.
