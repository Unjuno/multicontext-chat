export const CROSS_CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_chats',
      description: 'List active peer chat ids and names in the workspace, excluding self.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_chat',
      description: 'Search selected messages from one peer chat by UUID or exact name.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Peer chat UUID or exact name.' },
          query: { type: 'string', description: 'Search query tokens.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 8, description: 'Max results (1-20).' },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_chat',
      description: 'Queue the same prompt into one or two peer chats atomically.',
      parameters: {
        type: 'object',
        properties: {
          targets: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', description: 'Peer chat UUID or exact name.' } },
          prompt: { type: 'string', minLength: 1, description: 'Prompt to enqueue.' },
        },
        required: ['targets', 'prompt'],
        additionalProperties: false,
      },
    },
  },
];

export function findCrossChatTool(name) {
  return CROSS_CHAT_TOOLS.find(t => t.function.name === name) ?? null;
}

export function isCrossChatTool(name) {
  return CROSS_CHAT_TOOLS.some(t => t.function.name === name);
}
