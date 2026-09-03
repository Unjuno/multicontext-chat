#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: node scripts/patch-librechat.mjs /path/to/LibreChat');
  process.exit(2);
}

let changed = 0;

function filePath(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new Error(`LibreChat file not found: ${rel}`);
  return file;
}

function replaceRequired(text, from, to, label, occurrence = 'first') {
  if (text.includes(to)) return { text, changed: false };
  if (!text.includes(from)) throw new Error(`Patch anchor not found: ${label}`);
  if (occurrence === 'last') {
    const idx = text.lastIndexOf(from);
    return { text: text.slice(0, idx) + to + text.slice(idx + from.length), changed: true };
  }
  return { text: text.replace(from, to), changed: true };
}

function save(rel, text, didChange) {
  if (!didChange) {
    console.log(`already patched ${rel}`);
    return;
  }
  fs.writeFileSync(filePath(rel), text);
  changed += 1;
  console.log(`patched ${rel}`);
}

// 1) Preserve developer role in the Responses converter.
{
  const rel = 'packages/api/src/agents/responses/service.ts';
  let text = fs.readFileSync(filePath(rel), 'utf8');
  let dirty = false;
  for (const [from, to, label] of [
    ["role: 'system' | 'user' | 'assistant' | 'tool';", "role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';", `${rel}: InternalMessage role`],
    ["// Map developer role to system (LibreChat convention)\n      let role: InternalMessage['role'];\n      if (messageItem.role === 'developer') {\n        role = 'system';", "// Preserve developer as a distinct role for gpt-oss/Harmony-compatible paths.\n      let role: InternalMessage['role'];\n      if (messageItem.role === 'developer') {\n        role = 'developer';", `${rel}: developer role mapping`],
  ]) {
    const out = replaceRequired(text, from, to, label);
    text = out.text;
    dirty ||= out.changed;
  }
  save(rel, text, dirty);
}

// 2) Patch the actual Remote Responses controller path.
{
  const rel = 'api/server/controllers/agents/responses.js';
  let text = fs.readFileSync(filePath(rel), 'utf8');
  let dirty = false;

  // Support stock LibreChat as well as older MultiContext patches that imported only ChatMessage.
  if (!text.includes("const { AIMessage, ChatMessage, ToolMessage } = require('@langchain/core/messages');")) {
    if (text.includes("const { ChatMessage } = require('@langchain/core/messages');")) {
      text = text.replace(
        "const { ChatMessage } = require('@langchain/core/messages');",
        "const { AIMessage, ChatMessage, ToolMessage } = require('@langchain/core/messages');",
      );
      dirty = true;
    } else {
      const out = replaceRequired(
        text,
        "const { v4: uuidv4 } = require('uuid');",
        "const { v4: uuidv4 } = require('uuid');\nconst { AIMessage, ChatMessage, ToolMessage } = require('@langchain/core/messages');",
        `${rel}: LangChain message imports`,
      );
      text = out.text;
      dirty ||= out.changed;
    }
  }

  const externalHelpers = `const db = require('~/models');\n\n/**\n * MultiContext extension: request-level cross-chat tools use deferred/external\n * execution. They are exposed to the provider so the model can emit\n * function_call items, but they must never run inside LibreChat: the caller\n * (MultiContext) executes them and continues via function_call_output +\n * previous_response_id. Applies ONLY to request-level cross-chat tools; normal\n * LibreChat-owned tools keep their stock execution path.\n */\nclass ExternalCrossChatToolCall extends Error {\n  constructor(toolNames) {\n    super(\`External cross-chat tool call deferred to caller: \${(toolNames || []).join(',')}\`);\n    this.name = 'ExternalCrossChatToolCall';\n    this.code = 'EXTERNAL_TOOL_DEFERRED';\n    this.toolNames = Array.isArray(toolNames) ? toolNames : [];\n  }\n}\n\nfunction crossChatToolNames(req) {\n  const tools = req?._crossChatTools;\n  if (!Array.isArray(tools)) return new Set();\n  return new Set(tools.map((t) => t?.function?.name).filter(Boolean));\n}\n\nfunction throwIfExternalCrossChatTools(req, toolNames) {\n  const cross = crossChatToolNames(req);\n  if (cross.size === 0 || !Array.isArray(toolNames) || toolNames.length === 0) return;\n  if (toolNames.every((name) => cross.has(name))) throw new ExternalCrossChatToolCall(toolNames);\n}`;
  if (!text.includes('class ExternalCrossChatToolCall extends Error')) {
    const out = replaceRequired(text, "const db = require('~/models');", externalHelpers, `${rel}: external tool helpers`);
    text = out.text;
    dirty ||= out.changed;
  }

  if (!text.includes('req._crossChatTools = requestTools')) {
    const out = replaceRequired(
      text,
      "  const request = envelope.payload;\n  const { principal } = envelope;",
      "  const request = envelope.payload;\n  // MultiContext extension: capture request-level cross-chat tools.\n  // MultiContext exposes them to the model and executes them externally.\n  const requestTools = Array.isArray(request.tools) ? request.tools : null;\n  if (requestTools) req._crossChatTools = requestTools;\n  const { principal } = envelope;",
      `${rel}: request-level tools capture`,
    );
    text = out.text;
    dirty ||= out.changed;
  }

  if (!text.includes("res.setHeader('X-LibreChat-Conversation-Id', conversationId)")) {
    const out = replaceRequired(
      text,
      "    const conversationId = request.previous_response_id ?? uuidv4();\n    const parentMessageId = null;",
      "    const conversationId = request.previous_response_id ?? uuidv4();\n    // MultiContext extension: expose the stable LibreChat conversation id.\n    res.setHeader('X-LibreChat-Conversation-Id', conversationId);\n    // Remote Agents API-key auth sets req.user; persistence reads req.userId.\n    req.userId = req.userId ?? req.user?.id;\n    const parentMessageId = null;",
      `${rel}: conversation id + userId`,
    );
    text = out.text;
    dirty ||= out.changed;
  }

  // First establish the developer-preserving/request-tool-aware formatting block if absent.
  if (!text.includes('const developerMessages = inputMessages.filter')) {
    const stockFormatting = "    // Merge previous messages with new input\n    const allMessages = [...previousMessages, ...inputMessages];\n\n    const toolSet = buildToolSet(primaryConfig);\n    const formatted = formatAgentMessages(stripActivityLabelParts(allMessages), {}, toolSet);\n    const formattedMessages = formatted.messages;";
    const baseFormatting = `    // Keep developer instructions distinct from system instructions.\n    const developerMessages = inputMessages.filter((message) => message.role === 'developer');\n    const allMessages = [\n      ...previousMessages,\n      ...inputMessages.filter((message) => message.role !== 'developer'),\n    ];\n\n    // MultiContext extension: expose request-level cross-chat tools to the model.\n    const crossTools = Array.isArray(req._crossChatTools) ? req._crossChatTools : null;\n    if (crossTools && crossTools.length > 0) {\n      if (!Array.isArray(primaryConfig.tools)) primaryConfig.tools = [];\n      if (!Array.isArray(primaryConfig.toolDefinitions)) primaryConfig.toolDefinitions = [];\n      for (const rt of crossTools) {\n        const fname = rt?.function?.name;\n        if (!fname) continue;\n        if (!primaryConfig.tools.some((t) => t?.function?.name === fname || t?.name === fname)) {\n          primaryConfig.tools.push({ ...rt, name: fname });\n        }\n        if (!primaryConfig.toolDefinitions.some((d) => d?.name === fname || d?.function?.name === fname)) {\n          primaryConfig.toolDefinitions.push({ ...rt, name: fname });\n        }\n      }\n    }\n\n    const toolSet = buildToolSet(primaryConfig);\n    const formatted = formatAgentMessages(stripActivityLabelParts(allMessages), {}, toolSet);\n    const formattedMessages = formatted.messages;\n    if (developerMessages.length > 0) {\n      const insertionIndex = Math.max(0, formattedMessages.length - 1);\n      formattedMessages.splice(\n        insertionIndex,\n        0,\n        ...developerMessages.map(\n          (message) => new ChatMessage({ role: 'developer', content: message.content }),\n        ),\n      );\n    }`;
    const out = replaceRequired(text, stockFormatting, baseFormatting, `${rel}: developer/request-tool formatting`);
    text = out.text;
    dirty ||= out.changed;
  }

  // Add first-class assistant tool_call + tool result round-trip handling. This also upgrades
  // the prior 6b906273 patch safely instead of requiring a clean LibreChat checkout.
  if (!text.includes('const isToolRoundTripMessage = (message) =>')) {
    const developerLine = "    const developerMessages = inputMessages.filter((message) => message.role === 'developer');";
    const roundTripDecl = `${developerLine}\n    // MultiContext extension: tool round-trips must bypass the shared formatter,\n    // which would otherwise drop assistant tool_calls / coerce tool messages.\n    const isToolRoundTripMessage = (message) =>\n      message?.role === 'tool' ||\n      (message?.role === 'assistant' &&\n        Array.isArray(message?.tool_calls) &&\n        message.tool_calls.length > 0);\n    const toolRoundTrips = inputMessages.filter(isToolRoundTripMessage);`;
    let out = replaceRequired(text, developerLine, roundTripDecl, `${rel}: tool round-trip declarations`);
    text = out.text;
    dirty ||= out.changed;

    out = replaceRequired(
      text,
      "      ...inputMessages.filter((message) => message.role !== 'developer'),",
      "      ...inputMessages.filter((message) => message.role !== 'developer' && !isToolRoundTripMessage(message)),",
      `${rel}: exclude tool round-trips from shared formatter`,
    );
    text = out.text;
    dirty ||= out.changed;

    const developerRender = `    if (developerMessages.length > 0) {\n      const insertionIndex = Math.max(0, formattedMessages.length - 1);\n      formattedMessages.splice(\n        insertionIndex,\n        0,\n        ...developerMessages.map(\n          (message) => new ChatMessage({ role: 'developer', content: message.content }),\n        ),\n      );\n    }`;
    const roundTripRender = `${developerRender}\n    if (toolRoundTrips.length > 0) {\n      for (const message of toolRoundTrips) {\n        if (message.role === 'tool') {\n          formattedMessages.push(new ToolMessage({\n            content: String(message.content ?? ''),\n            tool_call_id: message.tool_call_id ?? '',\n          }));\n          continue;\n        }\n        formattedMessages.push(new AIMessage({\n          content: typeof message.content === 'string' ? message.content : '',\n          tool_calls: message.tool_calls.map((tc) => {\n            let parsedArgs = {};\n            const rawArgs = tc?.function?.arguments ?? tc?.args;\n            if (typeof rawArgs === 'string' && rawArgs) {\n              try { parsedArgs = JSON.parse(rawArgs); } catch { parsedArgs = {}; }\n            } else if (rawArgs && typeof rawArgs === 'object') {\n              parsedArgs = rawArgs;\n            }\n            return {\n              name: tc?.function?.name ?? tc?.name ?? '',\n              args: parsedArgs,\n              id: tc?.id ?? tc?.call_id ?? '',\n              type: 'tool_call',\n            };\n          }),\n        }));\n      }\n    }`;
    out = replaceRequired(text, developerRender, roundTripRender, `${rel}: render tool round-trips`);
    text = out.text;
    dirty ||= out.changed;
  }

  // Migrate the historical positional constructor from 6b906273 to the LangChain API shape
  // used by LibreChat upstream: ToolMessage({ content, tool_call_id }).
  const legacyToolMessage = "          formattedMessages.push(new ToolMessage(String(message.content ?? ''), message.tool_call_id ?? ''));";
  const objectToolMessage = "          formattedMessages.push(new ToolMessage({\n            content: String(message.content ?? ''),\n            tool_call_id: message.tool_call_id ?? '',\n          }));";
  if (text.includes(legacyToolMessage)) {
    text = text.replace(legacyToolMessage, objectToolMessage);
    dirty = true;
  }

  // Install the external-execution guard in both loadTools branches.
  const guard = '          throwIfExternalCrossChatTools(req, toolNames);';
  const loadAnchor = "        loadTools: async (toolNames, agentId, _configurable, callerCapabilityProjection) => {\n          const ctx =";
  while ((text.match(/throwIfExternalCrossChatTools\(req, toolNames\);/g) || []).length < 2) {
    if (!text.includes(loadAnchor)) throw new Error(`Patch anchor not found: ${rel}: loadTools external guard`);
    text = text.replace(
      loadAnchor,
      "        loadTools: async (toolNames, agentId, _configurable, callerCapabilityProjection) => {\n          // MultiContext request-level tools execute outside LibreChat.\n" + guard + "\n          const ctx =",
    );
    dirty = true;
  }

  // Non-streaming Remote Responses must return the model-emitted function_call rather than
  // converting external-tool deferral into a normal LibreChat tool error/retry loop.
  if (!text.includes("streamError.code !== 'EXTERNAL_TOOL_DEFERRED'")) {
    const processStream = `      await run.processStream({ messages: formattedMessages }, config, {\n        callbacks: {\n          [Callback.TOOL_ERROR]: (graph, error, toolId) => {\n            logger.error(\`[Responses API] Tool Error "\${toolId}"\`, getSafeErrorMetadata(error));\n          },\n        },\n      });`;
    const wrapped = `      try {\n        await run.processStream({ messages: formattedMessages }, config, {\n          callbacks: {\n            [Callback.TOOL_ERROR]: (graph, error, toolId) => {\n              logger.error(\`[Responses API] Tool Error "\${toolId}"\`, getSafeErrorMetadata(error));\n            },\n          },\n        });\n      } catch (streamError) {\n        if (!streamError || streamError.code !== 'EXTERNAL_TOOL_DEFERRED') throw streamError;\n        logger.info(\n          \`[MultiContext] deferred external tool call to caller: \${(streamError.toolNames || []).join(',')}\`,\n        );\n      }`;
    const out = replaceRequired(text, processStream, wrapped, `${rel}: non-streaming external deferral`, 'last');
    text = out.text;
    dirty ||= out.changed;
  }

  save(rel, text, dirty);
}

console.log(changed ? `Patched ${changed} LibreChat file(s). Rebuild LibreChat.` : 'LibreChat is already patched.');
