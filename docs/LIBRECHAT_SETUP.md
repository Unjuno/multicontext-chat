# LibreChat setup

1. Run a current LibreChat release and enable Remote Agents API:

```yaml
interface:
  remoteAgents:
    use: true
    create: true
```

2. Create LibreChat Agents and configure each Agent's model, Web Search, MCP, code execution, knowledge, and other existing tools there.
3. Generate a Remote Agents API key and set `LIBRECHAT_BASE_URL` / `LIBRECHAT_API_KEY`.
4. For the gpt-oss baseline, use `native`: apply `node scripts/patch-librechat.mjs /path/to/LibreChat`, rebuild/restart LibreChat, and set `MULTICONTEXT_LIBRECHAT_MODE=native`. Use `compat` only when running unmodified LibreChat is preferable.
5. Set `MULTICONTEXT_PUBLIC_URL` to an address LibreChat itself can reach if you want cross-chat Actions. In Docker Desktop a common value is `http://host.docker.internal:4317`; use an actual routable hostname in other deployments.
6. Start MultiContext, create a workspace, and add members using the listed LibreChat Agent IDs.
7. Add each member's generated OpenAPI Action URL to the corresponding LibreChat Agent. It exposes `list_chats`, `inspect_chat`, and `send_to_chat`. If `MULTICONTEXT_TOOL_SECRET` is configured, use the same value for `X-Multicontext-Key` in Action authentication.
