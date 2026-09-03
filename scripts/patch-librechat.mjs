#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('Usage: node scripts/patch-librechat.mjs /path/to/LibreChat'); process.exit(2); }

const replacements = [
  {
    file: 'packages/api/src/agents/responses/service.ts',
    edits: [
      ["role: 'system' | 'user' | 'assistant' | 'tool';", "role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';"],
      ["// Map developer role to system (LibreChat convention)\n      let role: InternalMessage['role'];\n      if (messageItem.role === 'developer') {\n        role = 'system';", "// Preserve developer as a distinct role for gpt-oss/Harmony-compatible paths.\n      let role: InternalMessage['role'];\n      if (messageItem.role === 'developer') {\n        role = 'developer';"],
    ],
  },
  {
    file: 'api/server/controllers/agents/responses.js',
    edits: [
      ["const { v4: uuidv4 } = require('uuid');", "const { v4: uuidv4 } = require('uuid');\nconst { ChatMessage } = require('@langchain/core/messages');"],
      ["  const request = envelope.payload;\n  const { principal } = envelope;", "  const request = envelope.payload;\n  // MultiContext extension: capture request-level cross-chat tools (if any).\n  // MultiContext owns orchestration; LibreChat exposes these to the model but\n  // MultiContext executes them via function_call_output continuation.\n  const requestTools = Array.isArray(request.tools) ? request.tools : null;\n  if (requestTools) req._crossChatTools = requestTools;\n  const { principal } = envelope;"],
      ["    const conversationId = request.previous_response_id ?? uuidv4();\n    const parentMessageId = null;", "    const conversationId = request.previous_response_id ?? uuidv4();\n    // MultiContext extension: expose the stable LibreChat conversation id so\n    // a remote caller can continue the same stored thread on later turns.\n    res.setHeader('X-LibreChat-Conversation-Id', conversationId);\n    // MultiContext extension: message persistence reads userId off the request\n    // object, but the Remote Agents API-key middleware only sets req.user.\n    // Without this, every store:true response fails to persist its turn.\n    req.userId = req.userId ?? req.user?.id;\n    const parentMessageId = null;"],
      ["    // Merge previous messages with new input\n    const allMessages = [...previousMessages, ...inputMessages];\n\n    const toolSet = buildToolSet(primaryConfig);\n    const formatted = formatAgentMessages(stripActivityLabelParts(allMessages), {}, toolSet);\n    const formattedMessages = formatted.messages;", "    // Keep developer instructions distinct from system instructions. The shared\n    // formatter currently maps every non-user/non-assistant role to system, so\n    // format the rest normally and insert developer messages as generic\n    // ChatMessage(role='developer') immediately before the current user turn.\n    const developerMessages = inputMessages.filter((message) => message.role === 'developer');\n    const allMessages = [\n      ...previousMessages,\n      ...inputMessages.filter((message) => message.role !== 'developer'),\n    ];\n\n    // MultiContext extension: expose request-level cross-chat tools to the model.\n    // These bypass DB resolution; MultiContext executes them via continuation.\n    const crossTools = Array.isArray(req._crossChatTools) ? req._crossChatTools : null;\n    if (crossTools && crossTools.length > 0) {\n      if (!Array.isArray(primaryConfig.tools)) primaryConfig.tools = [];\n      if (!Array.isArray(primaryConfig.toolDefinitions)) primaryConfig.toolDefinitions = [];\n      for (const rt of crossTools) {\n        const fname = rt?.function?.name;\n        if (!fname) continue;\n        if (!primaryConfig.tools.some((t) => t?.function?.name === fname || t?.name === fname)) {\n          primaryConfig.tools.push({ ...rt, name: fname });\n        }\n        if (!primaryConfig.toolDefinitions.some((d) => d?.name === fname || d?.function?.name === fname)) {\n          primaryConfig.toolDefinitions.push({ ...rt, name: fname });\n        }\n      }\n    }\n\n    const toolSet = buildToolSet(primaryConfig);\n    const formatted = formatAgentMessages(stripActivityLabelParts(allMessages), {}, toolSet);\n    const formattedMessages = formatted.messages;\n    if (developerMessages.length > 0) {\n      const insertionIndex = Math.max(0, formattedMessages.length - 1);\n      formattedMessages.splice(\n        insertionIndex,\n        0,\n        ...developerMessages.map(\n          (message) => new ChatMessage({ role: 'developer', content: message.content }),\n        ),\n      );\n    }"],
    ],
  },
];

let changed = 0;
for (const spec of replacements) {
  const file = path.join(root, spec.file);
  if (!fs.existsSync(file)) throw new Error(`LibreChat file not found: ${spec.file}`);
  let text = fs.readFileSync(file, 'utf8'); let fileChanged = false;
  for (const [from, to] of spec.edits) {
    if (text.includes(to)) continue;
    if (!text.includes(from)) throw new Error(`Patch anchor not found in ${spec.file}`);
    text = text.replace(from, to); fileChanged = true;
  }
  if (fileChanged) { fs.writeFileSync(file, text); changed += 1; console.log(`patched ${spec.file}`); }
  else console.log(`already patched ${spec.file}`);
}
console.log(changed ? `Patched ${changed} LibreChat file(s). Rebuild LibreChat.` : 'LibreChat is already patched.');
