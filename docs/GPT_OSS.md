# gpt-oss / native Harmony role mode

MultiContext keeps two editable instruction fields:

- workspace `system` prompt (shared)
- member `developer` prompt (per chat)

Stock LibreChat currently accepts `developer` in its Remote Responses API but normalizes it to `system` before the Agent formatter. The Agent formatter also maps ordinary non-user/non-assistant input to system. Stock LibreChat additionally does not expose the internal conversation id created by `/api/agents/v1/responses`, so a remote client cannot reliably continue that stored thread.

For exact MultiContext semantics with gpt-oss, patch the LibreChat checkout used by your deployment:

```bash
node scripts/patch-librechat.mjs /path/to/LibreChat
```

Then rebuild/restart LibreChat and set:

```env
MULTICONTEXT_LIBRECHAT_MODE=native
```

The patch is intentionally small and idempotent. It:

1. preserves `developer` in the Responses converter,
2. inserts developer input as LangChain `ChatMessage(role='developer')` in the actual Remote Responses controller path; LibreChat's OpenAI adapter maps that generic role to OpenAI `developer`,
3. returns `X-LibreChat-Conversation-Id` so MultiContext can continue one real LibreChat conversation per member, and
4. sets `req.userId` from the authenticated user before persistence, fixing an upstream bug where Remote Agents API-key requests (which only set `req.user`) always failed to store `store:true` turns, silently breaking native conversation continuation.

`native` mode fails fast if that conversation-id header is missing. `compat` mode does not modify LibreChat; it keeps independent history in MultiContext and replays it on each request.

The patch uses exact source anchors and stops if upstream changes rather than applying a guessed transformation. Re-run it after a LibreChat upgrade and run LibreChat's own tests/build before deployment.

## Local llama.cpp serving notes

When serving gpt-oss directly with `llama-server --jinja`, use the corrected
chat template in `scripts/llama/gpt-oss-chat-template.fixed.jinja`:

```bash
llama-server -m gpt-oss-20b-MXFP4.gguf --jinja \
  --chat-template-file scripts/llama/gpt-oss-chat-template.fixed.jinja \
  --chat-template-kwargs '{"reasoning_effort":"low"}' ...
```

Two upstream llama.cpp issues motivated this template (verified against
ggml-org/gpt-oss-20b-GGUF, builds b9309 and b10621):

1. The bundled template inspects only `messages[0]` and misroutes
   `[system, developer, user]`: the workspace prompt is rendered as the
   developer message and the real developer message is dropped. Measured
   effect: developer format instructions are followed 0/6 times whenever a
   system message is present, and 6/6 when it is not.
2. The fixed template collects every system/developer message and renders
   them in the canonical harmony positions (system scaffolding + developer
   `# Instructions`). With this template adherence is 6/6 on short contexts.

Known model limitation (not fixable at the serving layer): with very long
replayed histories (~12+ turns), instructions placed in the canonical top
developer block lose salience and gpt-oss-20b may ignore strict output
formats even though roles are delivered correctly (0/4 at temperature 1.0
and 0.6 on a 26-message thread, versus 4/4 on an 8-message thread). Moving
the developer block next to the final user turn is not viable: terminal
developer segments trip llama-server's harmony output validation. For strict
machine-parsed formats, keep member threads short or restate the format in
the queued user task.

Serving-speed findings on M1 Max (64GB), measured: MXFP4 decode saturates at
~73 tok/s single-stream and ~95 tok/s aggregate across 4 parallel slots.
`reasoning_effort=low` (server default above; overridable per request via
`chat_template_kwargs`) cuts generated tokens roughly 3x and is the dominant
real-world latency lever. KV-cache q8_0, EAGLE3 speculative decoding
(draft-eagle3), and ngram speculation were all benchmarked and rejected as
neutral-to-slower for this model on Metal.
