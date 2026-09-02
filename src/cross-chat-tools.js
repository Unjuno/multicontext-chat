export const CROSS_CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_chats',
      description: 'MUST call this tool when the user asks to list, discover, or see peer chats. Returns active peer ids and names, excluding self. Do not hallucinate the list.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_chat',
      description: 'MUST call this tool to read selected messages from one peer chat. Provide peer UUID or exact name. Do not invent peer content; use this tool instead.',
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
      description: 'MUST call this tool to send a message to one or two peer chats. This is the ONLY way to deliver a prompt to another chat. Queues atomically; do not hallucinate delivery.',
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
