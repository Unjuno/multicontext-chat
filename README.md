# MultiContext Chat

A local-first, OSS multi-context deliberation workspace backed by **LibreChat Agents**.

One user prompt fans out to N independent chats. Each chat keeps its own history and Agent/tool configuration. Agents do **not** automatically receive one another's outputs; they can explicitly inspect another history or enqueue a prompt into another chat through opt-in tools. Deliberation can recursively continue until queues drain, a budget is reached outside this app, or the user hits Stop. `SETTLED` means exploration is idle, not that agents agree.

## What is implemented

- N independent member histories
- one shared broadcast composer
- per-member FIFO queue; one active run per member
- parallel execution across members
- user intervention after any settled cycle without resetting member history
- explicit `inspect_chat` and `send_to_chat` Action endpoints
- cross-chat permission toggles
- always-visible Stop endpoint/button that aborts active calls and clears queues
- `SETTLED` detection
- manual Result Synthesizer / Compile
- usage/run metadata persistence
- local JSON persistence with atomic writes
- optional API bearer auth and tool key
- zero runtime npm dependencies (Node 22+)
- Dockerfile and Compose
- tests for isolation/FIFO/parallelism

LibreChat remains responsible for model providers, Agent configuration, Web Search, MCP, Code Interpreter, RAG/knowledge, tool execution, credentials and provider-specific behavior.

## Quick start

```bash
cp .env.example .env
# set LIBRECHAT_BASE_URL and LIBRECHAT_API_KEY
npm test
npm start
```

Open `http://127.0.0.1:4317`.

Docker:

```bash
cp .env.example .env
docker compose up --build
```

See `docs/LIBRECHAT_SETUP.md` for LibreChat Agent/API configuration.

## Core model

```text
User prompt
   │
   ├────> Chat A FIFO ──> LibreChat Agent A ──> independent history A
   ├────> Chat B FIFO ──> LibreChat Agent B ──> independent history B
   └────> Chat N FIFO ──> LibreChat Agent N ──> independent history N

Agent A --inspect_chat--> selected snippets from B
Agent A --send_to_chat--> B FIFO (as a new user-role task)
```

A queued prompt is never inserted into every model's context as foreign assistant text. It becomes a normal new task in the target's own context.

## Compile semantics

Compile is disabled until the workspace is `SETTLED`. It uses `compileAgentId` or the first active Agent, receives bounded recent records from every active member, and produces a synthesis that preserves dissent. The synthesis is stored at workspace level and is not injected back into member histories.

## Instruction hierarchy caveat

MultiContext sends the workspace prompt as an Open Responses `system` item and the member prompt as a `developer` item. This is the correct abstraction for models such as gpt-oss. However, current LibreChat main accepts `developer` in the public Responses type and then normalizes it to an internal `system` message before `formatAgentMessages`. Therefore **native** gpt-oss hierarchy is not guaranteed end-to-end unless the serving path preserves/reconstructs it. This repository deliberately does not treat prompt hierarchy as a security boundary; tool access remains enforced by LibreChat Agent configuration and MultiContext backend checks.

For generic models, the same configuration works as an emulated instruction hierarchy.

## Cross-chat tools

For a member `M`, open/copy:

```text
http://HOST:4317/tools/WORKSPACE_ID/MEMBER_ID/openapi.json
```

Add it as a LibreChat Action to that member's LibreChat Agent. Two operations appear:

- `inspect_chat(target_member_id, query, limit)`
- `send_to_chat(target_member_id, prompt)`

Other-agent statements remain hypotheses/arguments, not evidence merely because another agent produced them.

## Persistence and limits

State defaults to `./data/state.json` and is written atomically. Histories are bounded by `MULTICONTEXT_MAX_HISTORY_MESSAGES`. LibreChat itself may additionally summarize/prune context according to its Agent settings.

Recursive deliberation can create substantial inference load. Local models are recommended for Deep/Exhaustive usage. External paid APIs should be configured with provider-side budgets and rate limits.

## License

MIT. LibreChat is a separate upstream dependency and retains its own MIT license.
