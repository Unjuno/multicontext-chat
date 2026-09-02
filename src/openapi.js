import { CROSS_CHAT_TOOLS } from './cross-chat-tools.js';

function toolParams(name) {
  const t = CROSS_CHAT_TOOLS.find(x => x.function.name === name);
  return t ? t.function.parameters : null;
}

export function buildActionSpec({ origin, workspace, member, requireSecret }) {
  const base = `/tools/${workspace.id}/${member.id}`; const security = requireSecret ? [{ ToolKey: [] }] : [];
  const errorResponse = (code, description) => ({ description, content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } });
  const errorResponses = { '400': errorResponse('400', 'Bad request — invalid or missing parameters'), '401': errorResponse('401', 'Unauthorized — missing or invalid X-Multicontext-Key'), '403': errorResponse('403', 'Forbidden — chat not active or access denied'), '404': errorResponse('404', 'Not found — workspace or chat does not exist') };
  const inspectParams = toolParams('inspect_chat');
  const sendParams = toolParams('send_to_chat');
  return {
    openapi: '3.1.0',
    info: { title: `MultiContext tools — ${workspace.name} / ${member.name}`, version: '1.2.0', description: 'Tools for listing peer chats, reading selected peer history, and queuing prompts to selected peer chats.' },
    servers: [{ url: origin }],
    components: requireSecret ? { securitySchemes: { ToolKey: { type: 'apiKey', in: 'header', name: 'X-Multicontext-Key' } } } : {},
    paths: {
      [`${base}/list-chats`]: { get: { operationId: 'list_chats', summary: 'List available peer chat ids and names.', security, responses: { '200': { description: 'Available peer chats' }, ...errorResponses } } },
      [`${base}/inspect-chat`]: { post: { operationId: 'inspect_chat', summary: 'Search selected messages from one peer chat.', security,
        requestBody: { required: true, content: { 'application/json': { schema: inspectParams } } }, responses: { '200': { description: 'Selected peer messages' }, ...errorResponses } } },
      [`${base}/send-to-chat`]: { post: { operationId: 'send_to_chat', summary: 'Queue the same prompt into one or two peer chats.', security,
        requestBody: { required: true, content: { 'application/json': { schema: sendParams } } }, responses: { '202': { description: 'Prompt accepted into target FIFO queue(s)' }, ...errorResponses, '409': errorResponse('409', 'Conflict — target is inactive or member reference is ambiguous') } } },
    },
  };
}
