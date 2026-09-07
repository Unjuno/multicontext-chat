/**
 * Non-streaming Responses adapter. Intentionally dependency-free so the patch
 * can embed this function into the LibreChat controller. The stock handler
 * remains responsible for authorization, loading, invocation and filtering.
 */
function createMixedOwnershipHandler(handler, crossNames, aggregator, signal, serializeResult) {
  return {
    async handle(event, data, metadata, graph) {
      const external = data.toolCalls.filter(call => crossNames.has(call.name));
      if (external.length === 0) return handler.handle(event, data);
      const provider = data.toolCalls.filter(call => !crossNames.has(call.name));
      try {
        signal?.throwIfAborted();
        // Validate the entire ownership boundary before any provider side effect.
        // A Set of expected provider IDs alone would hide duplicate requests.
        const callIds = new Set();
        for (const call of data.toolCalls) {
          if (typeof call.id !== 'string' || !call.id.trim() || callIds.has(call.id)) {
            throw new Error('Invalid or duplicate mixed tool call identity');
          }
          callIds.add(call.id);
        }
        if (provider.length) {
          const results = await new Promise((resolve, reject) => {
            // Partial results must not resolve the original graph batch. It is
            // still waiting for external outputs when we unwind below.
            Promise.resolve(handler.handle(event, {
              ...data, toolCalls: provider, onResult: undefined, resolve, reject,
            })).catch(reject);
          });
          signal?.throwIfAborted();
          const expected = new Set(provider.map(call => call.id));
          const actual = new Map();
          for (const result of results) {
            if (!expected.has(result.toolCallId) || actual.has(result.toolCallId)) {
              throw new Error('Invalid provider tool result identity');
            }
            // Match the stock SDK's error message; retain successful content,
            // including the empty string. No placeholder for unexecuted calls.
            const content = result.status === 'error'
              ? `Error: ${result.errorMessage ?? 'Unknown error'}\n Please fix your mistakes.`
              : result.content;
            if (content === undefined) throw new Error('Missing provider tool result content');
            // Production passes the installed SDK serializer. The fallback is
            // retained for small isolated contract fixtures only.
            actual.set(result.toolCallId, serializeResult
              ? serializeResult(result, graph?.getAgentContext?.(metadata))
              : typeof content === 'string' ? content : JSON.stringify(content));
          }
          if (actual.size !== expected.size) throw new Error('Missing provider tool results');
          for (const [id, output] of actual) aggregator.toolOutputs.set(id, output);
        }
        signal?.throwIfAborted();
        const error = new Error('External cross-chat tool calls deferred to caller');
        error.code = 'EXTERNAL_TOOL_DEFERRED';
        error.toolNames = external.map(call => call.name);
        data.reject(error);
      } catch (error) {
        data.reject(error);
      }
    },
  };
}

function createMixedResultSerializer(sdk) {
  const { calculateMaxToolResultChars, truncateToolResultContent, serializeStructuredValueBounded } = sdk;
  if ([calculateMaxToolResultChars, truncateToolResultContent, serializeStructuredValueBounded].some(fn => typeof fn !== 'function')) {
    throw new Error('Unsupported LibreChat SDK: mixed result serializers unavailable');
  }
  return (result, context) => {
    const limit = context?.maxToolResultChars ?? calculateMaxToolResultChars(context?.maxContextTokens);
    if (result.status === 'error') {
      return truncateToolResultContent(`Error: ${result.errorMessage ?? 'Unknown error'}\n Please fix your mistakes.`, limit);
    }
    return typeof result.content === 'string'
      ? truncateToolResultContent(result.content, limit)
      : serializeStructuredValueBounded(result.content, limit).content;
  };
}

module.exports = { createMixedOwnershipHandler, createMixedResultSerializer };
