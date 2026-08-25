export function buildActionSpec({ origin, workspace, member, requireSecret }) {
  const base = `/tools/${workspace.id}/${member.id}`; const security = requireSecret ? [{ ToolKey: [] }] : [];
  return {
    openapi: '3.1.0',
    info: { title: `MultiContext tools — ${workspace.name} / ${member.name}`, version: '1.1.0', description: 'Tools for listing peer chats, reading selected peer history, and queuing prompts to selected peer chats.' },
    servers: [{ url: origin }],
    components: requireSecret ? { securitySchemes: { ToolKey: { type: 'apiKey', in: 'header', name: 'X-Multicontext-Key' } } } : {},
    paths: {
      [`${base}/list-chats`]: { get: { operationId: 'list_chats', summary: 'List available peer chat ids and names.', security, responses: { '200': { description: 'Available peer chats' } } } },
      [`${base}/inspect-chat`]: { post: { operationId: 'inspect_chat', summary: 'Search selected messages from one peer chat.', security,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['target'], properties: { target: { type: 'string', description: 'Peer chat UUID or exact name.' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } } } } } }, responses: { '200': { description: 'Selected peer messages' } } } },
      [`${base}/send-to-chat`]: { post: { operationId: 'send_to_chat', summary: 'Queue the same prompt into one or two peer chats.', security,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['targets', 'prompt'], properties: { targets: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', description: 'Peer chat UUID or exact name.' } }, prompt: { type: 'string', minLength: 1 } } } } } }, responses: { '202': { description: 'Prompt accepted into target FIFO queue(s)' } } } },
    },
  };
}
