/** Build LibreChat's existing assistant-content representation. Only completed
 * call/output pairs belong here: the stock formatter invents an empty tool
 * output when a tool_call part has no output, so pending calls must stay out. */
function completedToolContent(items) {
  const results = new Map();
  for (const item of items) {
    if (item.type === 'function_call_output') {
      if (results.has(item.call_id) && results.get(item.call_id) !== item.output) {
        throw new Error('Conflicting persisted tool outputs');
      }
      results.set(item.call_id, item.output);
    }
  }
  const content = [];
  const seen = new Set();
  for (const item of items) {
    if (item.type !== 'function_call' || !results.has(item.call_id)) continue;
    if (seen.has(item.call_id)) continue;
    seen.add(item.call_id);
    const output = results.get(item.call_id);
    if (typeof output !== 'string') throw new Error('Persisted tool output must already be serialized');
    content.push({ type: 'text', text: '', tool_call_ids: [item.call_id] });
    content.push({ type: 'tool_call', tool_call: {
      id: item.call_id, name: item.name, args: item.arguments, output,
    } });
  }
  return content;
}

/** A continuation may repeat a completed call already persisted by the prior
 * response. Keep its first chronological occurrence and reject conflicting
 * replays rather than silently replacing evidence. Never mutate DB records. */
function deduplicateToolHistory(messages) {
  const seen = new Map();
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    const retainedIds = new Set();
    const content = message.content.filter(part => {
      if (part.type !== 'tool_call') return true;
      const call = part.tool_call;
      const prior = seen.get(call.id);
      if (prior) {
        if (prior.name !== call.name || prior.args !== call.args || prior.output !== call.output) {
          throw new Error('Conflicting persisted tool replay');
        }
        return false;
      }
      seen.set(call.id, call);
      retainedIds.add(call.id);
      return true;
    }).flatMap(part => {
      if (part.type !== 'text' || !Array.isArray(part.tool_call_ids)) return [part];
      const ids = part.tool_call_ids.filter(id => retainedIds.has(id));
      if (ids.length) return [{ ...part, tool_call_ids: ids }];
      return part.text ? [{ type: 'text', text: part.text }] : [];
    });
    return { ...message, content };
  }).filter(message => !Array.isArray(message.content) || message.content.length > 0);
}

function internalToolItems(messages) {
  return messages.flatMap(message => {
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
    if (message.role !== 'assistant') return [];
    return (message.tool_calls || []).map(call => ({
      type: 'function_call', call_id: call.id ?? call.call_id,
      name: call.function?.name ?? call.name,
      arguments: call.function?.arguments ?? (typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {})),
    }));
  });
}

function excludePersistedToolReplay(inputMessages, previousMessages) {
  const existing = new Map(previousMessages.flatMap(message =>
    Array.isArray(message.content) ? message.content.filter(part => part.type === 'tool_call').map(part => [part.tool_call.id, part.tool_call]) : []));
  const duplicates = new Set();
  for (const part of completedToolContent(internalToolItems(inputMessages))) {
    if (part.type !== 'tool_call') continue;
    const call = part.tool_call;
    const prior = existing.get(call.id);
    if (!prior) continue;
    if (prior.name !== call.name || prior.args !== call.args || prior.output !== call.output) {
      throw new Error('Conflicting persisted tool replay');
    }
    duplicates.add(call.id);
  }
  return inputMessages.flatMap(message => {
    if (message.role === 'tool' && duplicates.has(message.tool_call_id)) return [];
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return [message];
    const calls = message.tool_calls.filter(call => !duplicates.has(call.id ?? call.call_id));
    return calls.length || message.content ? [{ ...message, tool_calls: calls }] : [];
  });
}

module.exports = { completedToolContent, deduplicateToolHistory, internalToolItems, excludePersistedToolReplay };
