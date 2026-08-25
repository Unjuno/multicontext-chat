# LibreChat setup

1. Run a current LibreChat release and enable the remote Agents API:

```yaml
interface:
  remoteAgents:
    use: true
    create: true
```

2. In LibreChat create one Agent per MultiContext member. Configure model, web search, MCP, code interpreter, knowledge and other tools there. Keep behavioral instructions in MultiContext if you want them visible/editable per member here.
3. Generate a LibreChat Agents API key and set `LIBRECHAT_BASE_URL` and `LIBRECHAT_API_KEY` in `.env`.
4. Start MultiContext Chat.
5. Create a workspace and add members using the LibreChat Agent IDs.
6. Optional cross-chat tools: each member card exposes an OpenAPI Action URL. Add that URL to the corresponding LibreChat Agent as an Action. It exposes `inspect_chat` and `send_to_chat` scoped to the source member. If `MULTICONTEXT_TOOL_SECRET` is set, configure `X-Multicontext-Key` with the same value in the Action authentication settings.

The Action endpoints intentionally return snippets, not entire foreign histories.
