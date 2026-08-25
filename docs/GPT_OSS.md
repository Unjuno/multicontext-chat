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
