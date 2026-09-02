import { createMcpHandler as sdkCreateMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export function createMcpHandlerFactory({ config, store, client, scheduler, app }) {
  // app is createApplication instance
  const handler = sdkCreateMcpHandler(async ({ authInfo }) => {
    const server = new McpServer({ name: 'multicontext', version: '0.2.0' });

    // Helper to ensure auth
    // For MCP, auth already checked at HTTP layer; but also check here for disabled
    // If MCP disabled, we can still return server but tools will error

    // Register tools
    server.registerTool('multicontext_list_workspaces', {
      description: 'List all MultiContext workspaces with runtime state and chat counts',
      inputSchema: z.object({}),
    }, async () => {
      if (!config.mcpEnabled) throw new Error('MCP disabled');
      const workspaces = await app.listWorkspaces();
      const sanitized = workspaces.map(w => ({
        id: w.id,
        name: w.name,
        runtimeState: w.runtimeState,
        settled: w.settled,
        activeChatCount: Object.values(w.members || {}).filter(m => m.active).length,
        totalChatCount: Object.keys(w.members || {}).length,
        defaultAgentId: w.defaultAgentId || null,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ workspaces: sanitized }, null, 2) }], structuredContent: { workspaces: sanitized } };
    });

    server.registerTool('multicontext_get_workspace', {
      description: 'Get workspace configuration, members, queue sizes, effective agents, runtime state, compile output. Does not expose secrets.',
      inputSchema: z.object({ workspace_id: z.string().min(1), include_messages: z.boolean().optional(), message_limit: z.number().int().min(1).max(200).optional() }),
    }, async ({ workspace_id, include_messages, message_limit }) => {
      const ws = await app.getWorkspace(workspace_id, { includeMessages: include_messages !== false, boundedMessages: message_limit || 50 });
      // Strip private
      return { content: [{ type: 'text', text: JSON.stringify(ws, null, 2) }], structuredContent: ws };
    });

    server.registerTool('multicontext_create_workspace', {
      description: 'Create a new workspace. Optionally create initial chats.',
      inputSchema: z.object({
        name: z.string().min(1).max(200).optional(),
        system_prompt: z.string().optional(),
        default_agent_id: z.string().optional(),
        initial_chat_count: z.number().int().min(0).max(10).optional(),
      }),
    }, async ({ name, system_prompt, default_agent_id, initial_chat_count }) => {
      const ws = await app.createWorkspace({ name, globalPrompt: system_prompt, defaultAgentId: default_agent_id, initial_chat_count });
      return { content: [{ type: 'text', text: JSON.stringify(ws, null, 2) }], structuredContent: ws };
    });

    server.registerTool('multicontext_update_workspace', {
      description: 'Update workspace name, system prompt, default agent, compile settings',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        name: z.string().optional(),
        system_prompt: z.string().optional(),
        default_agent_id: z.string().optional(),
        compile_agent_id: z.string().optional(),
        compile_prompt: z.string().optional(),
      }),
    }, async ({ workspace_id, name, system_prompt, default_agent_id, compile_agent_id, compile_prompt }) => {
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (system_prompt !== undefined) patch.globalPrompt = system_prompt;
      if (default_agent_id !== undefined) patch.defaultAgentId = default_agent_id;
      if (compile_agent_id !== undefined) patch.compileAgentId = compile_agent_id;
      if (compile_prompt !== undefined) patch.compilePrompt = compile_prompt;
      const ws = await app.updateWorkspace(workspace_id, patch);
      return { content: [{ type: 'text', text: JSON.stringify(ws, null, 2) }], structuredContent: ws };
    });

    server.registerTool('multicontext_delete_workspace', {
      description: 'Delete a workspace. Destructive.',
      inputSchema: z.object({ workspace_id: z.string().min(1) }),
    }, async ({ workspace_id }) => {
      const res = await app.deleteWorkspace(workspace_id);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], structuredContent: res };
    });

    server.registerTool('multicontext_list_agents', {
      description: 'List available LibreChat Agents suitable for selection. Never exposes credentials.',
      inputSchema: z.object({}),
    }, async () => {
      const agents = await app.listAgents();
      return { content: [{ type: 'text', text: JSON.stringify({ agents }, null, 2) }], structuredContent: { agents } };
    });

    server.registerTool('multicontext_add_chat', {
      description: 'Add a chat to a workspace',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        name: z.string().optional(),
        developer_prompt: z.string().optional(),
        agent_id: z.string().optional(),
      }),
    }, async ({ workspace_id, name, developer_prompt, agent_id }) => {
      const res = await app.addChat(workspace_id, { name, developerPrompt: developer_prompt, agentId: agent_id });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], structuredContent: res };
    });

    server.registerTool('multicontext_update_chat', {
      description: 'Update chat name, developer prompt, agent, active, permissions',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        chat_id: z.string().min(1),
        name: z.string().optional(),
        developer_prompt: z.string().optional(),
        agent_id: z.string().optional(),
        active: z.boolean().optional(),
        can_inspect_others: z.boolean().optional(),
        can_send_others: z.boolean().optional(),
      }),
    }, async ({ workspace_id, chat_id, name, developer_prompt, agent_id, active, can_inspect_others, can_send_others }) => {
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (developer_prompt !== undefined) patch.developerPrompt = developer_prompt;
      if (agent_id !== undefined) patch.agentId = agent_id;
      if (active !== undefined) patch.active = active;
      if (can_inspect_others !== undefined) patch.canInspectOthers = can_inspect_others;
      if (can_send_others !== undefined) patch.canSendOthers = can_send_others;
      const ws = await app.updateChat(workspace_id, chat_id, patch);
      return { content: [{ type: 'text', text: JSON.stringify(ws, null, 2) }], structuredContent: ws };
    });

    server.registerTool('multicontext_delete_chat', {
      description: 'Delete a chat',
      inputSchema: z.object({ workspace_id: z.string().min(1), chat_id: z.string().min(1) }),
    }, async ({ workspace_id, chat_id }) => {
      const res = await app.deleteChat(workspace_id, chat_id);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], structuredContent: res };
    });

    server.registerTool('multicontext_broadcast', {
      description: 'Broadcast a prompt to all active chats as ordinary user message. Validates config before queue mutation.',
      inputSchema: z.object({ workspace_id: z.string().min(1), prompt: z.string().min(1).max(100000) }),
    }, async ({ workspace_id, prompt }) => {
      const res = await app.broadcast(workspace_id, prompt);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], structuredContent: res };
    });

    server.registerTool('multicontext_send', {
      description: 'Send a prompt to one chat as ordinary user message',
      inputSchema: z.object({ workspace_id: z.string().min(1), chat_id: z.string().min(1), prompt: z.string().min(1).max(100000) }),
    }, async ({ workspace_id, chat_id, prompt }) => {
      const res = await app.send(workspace_id, chat_id, prompt);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], structuredContent: res };
    });

    server.registerTool('multicontext_stop_workspace', {
      description: 'Stop all chats in a workspace',
      inputSchema: z.object({ workspace_id: z.string().min(1) }),
    }, async ({ workspace_id }) => {
      const ws = await app.stopWorkspace(workspace_id);
      return { content: [{ type: 'text', text: JSON.stringify(ws, null, 2) }], structuredContent: ws };
    });

    server.registerTool('multicontext_stop_chat', {
      description: 'Stop a single chat',
      inputSchema: z.object({ workspace_id: z.string().min(1), chat_id: z.string().min(1) }),
    }, async ({ workspace_id, chat_id }) => {
      const ws = await app.stopChat(workspace_id, chat_id);
      return { content: [{ type: 'text', text: JSON.stringify(ws, null, 2) }], structuredContent: ws };
    });

    server.registerTool('multicontext_retry_chat', {
      description: 'Retry a blocked chat',
      inputSchema: z.object({ workspace_id: z.string().min(1), chat_id: z.string().min(1) }),
    }, async ({ workspace_id, chat_id }) => {
      const ws = await app.retryChat(workspace_id, chat_id);
      return { content: [{ type: 'text', text: JSON.stringify(ws, null, 2) }], structuredContent: ws };
    });

    server.registerTool('multicontext_get_runtime_status', {
      description: 'Get infrastructure and application readiness. Does not conflate GPT-OSS health with agent config.',
      inputSchema: z.object({ workspace_id: z.string().optional() }),
    }, async ({ workspace_id }) => {
      const status = await app.getRuntimeStatus(workspace_id);
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }], structuredContent: status };
    });

    server.registerTool('multicontext_compile', {
      description: 'Manual compile. Only when SETTLED. Does not mutate histories.',
      inputSchema: z.object({ workspace_id: z.string().min(1) }),
    }, async ({ workspace_id }) => {
      const ws = await app.compile(workspace_id);
      return { content: [{ type: 'text', text: JSON.stringify(ws, null, 2) }], structuredContent: ws };
    });

    server.registerTool('multicontext_wait_until_settled', {
      description: 'Wait until workspace is SETTLED or BLOCKED or timeout. Mechanical only.',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        timeout_seconds: z.number().min(1).max(300).optional(),
        poll_interval_ms: z.number().min(100).max(5000).optional(),
      }),
    }, async ({ workspace_id, timeout_seconds, poll_interval_ms }) => {
      const res = await app.waitUntilSettled(workspace_id, timeout_seconds ?? 60, poll_interval_ms ?? 500);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], structuredContent: res };
    });

    server.registerTool('multicontext_get_chat_messages', {
      description: 'Get bounded visible history for a chat',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        chat_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
        since: z.string().optional(),
      }),
    }, async ({ workspace_id, chat_id, limit, since }) => {
      const msgs = await app.getChatMessages(workspace_id, chat_id, { limit, since });
      return { content: [{ type: 'text', text: JSON.stringify({ messages: msgs }, null, 2) }], structuredContent: { messages: msgs } };
    });

    server.registerTool('multicontext_get_compile_result', {
      description: 'Get latest compile output',
      inputSchema: z.object({ workspace_id: z.string().min(1) }),
    }, async ({ workspace_id }) => {
      const res = await app.getCompileResult(workspace_id);
      return { content: [{ type: 'text', text: JSON.stringify({ result: res }, null, 2) }], structuredContent: { result: res } };
    });

    server.registerTool('multicontext_list_peer_chats', {
      description: 'List active peer chat ids and names, excluding self',
      inputSchema: z.object({ workspace_id: z.string().min(1), source_chat_id: z.string().min(1) }),
    }, async ({ workspace_id, source_chat_id }) => {
      const chats = await app.listPeerChats(workspace_id, source_chat_id);
      return { content: [{ type: 'text', text: JSON.stringify({ chats }, null, 2) }], structuredContent: { chats } };
    });

    server.registerTool('multicontext_inspect_peer_chat', {
      description: 'Search selected messages from one peer chat by UUID or exact name',
      inputSchema: z.object({ workspace_id: z.string().min(1), source_chat_id: z.string().min(1), target: z.string().min(1), query: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }),
    }, async ({ workspace_id, source_chat_id, target, query, limit }) => {
      const result = await app.inspectPeerChat(workspaceId, source_chat_id, target, query ?? null, limit ?? 8);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    });

    server.registerTool('multicontext_send_to_peer_chats', {
      description: 'Queue prompt into one or two peer chats atomically (non-idempotent external call)',
      inputSchema: z.object({ workspace_id: z.string().min(1), source_chat_id: z.string().min(1), targets: z.array(z.string().min(1)).min(1).max(2), prompt: z.string().min(1) }),
    }, async ({ workspace_id, source_chat_id, targets, prompt }) => {
      const result = await app.sendToChats(workspace_id, source_chat_id, targets, prompt);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    });

    return server;
  });
  return handler;
}

export function createMcpHandler(options) {
  return createMcpHandlerFactory(options);
}
export const createMcpHandlerAlias = createMcpHandlerFactory;
