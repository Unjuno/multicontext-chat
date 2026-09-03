import { CrossChatToolExecutor, extractToolCalls } from './cross-chat-executor.js';
export class Scheduler {
  constructor({ store, client, app, maxHistoryMessages = 120, maxNativeToolIterations = 10 }) {
    this.store = store; this.client = client; this.app = app; this.maxHistoryMessages = maxHistoryMessages; this.maxNativeToolIterations = maxNativeToolIterations; this.running = new Map(); this.executor = null;
  }
  setApp(app) { this.app = app; app._scheduler = this; app._store = this.store; this.executor = new CrossChatToolExecutor({ app }); }
  key(workspaceId, memberId) { return `${workspaceId}:${memberId}`; }
  runningMemberIds(workspaceId) {
    const prefix = `${workspaceId}:`;
    return new Set([...this.running.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  }
  resumeAll() {
    for (const workspace of Object.values(this.store.state.workspaces)) {
      const recoveredRunIds = new Set(Object.values(workspace.orchestratorRuns || {})
        .filter((run) => run.status === 'failed' && run.error === 'Recovered after restart')
        .map((run) => run.id));
      let changed = false;
      if (recoveredRunIds.size > 0) {
        // Close the tiny crash window between an atomic cross-chat receipt commit and the
        // executor's provenance attachment. On restart the source current item has already
        // been requeued by StateStore recovery, so use the receipt key to recover ownership
        // onto each delivered child before removing all work from the failed run.
        for (const [receiptKey, receipt] of Object.entries(workspace.crossChatReceipts || {})) {
          const [sourceMemberId, sourceQueueItemId] = String(receiptKey).split(':');
          const sourceMember = workspace.members?.[sourceMemberId];
          const sourceItem = sourceMember?.current?.item?.id === sourceQueueItemId
            ? sourceMember.current.item
            : sourceMember?.queue?.find((item) => item.id === sourceQueueItemId);
          const runId = sourceItem?.orchestratorRunId || null;
          if (!runId || !recoveredRunIds.has(runId)) continue;
          const qId = sourceItem.orchestratorQId || null;
          for (const delivery of receipt?.deliveries || []) {
            const target = workspace.members?.[delivery.targetId];
            if (!target) continue;
            const delivered = target.current?.item?.id === delivery.queueItemId
              ? target.current.item
              : target.queue?.find((item) => item.id === delivery.queueItemId);
            if (!delivered) continue;
            delivered.orchestratorRunId = runId;
            delivered.orchestratorQId = qId;
            changed = true;
          }
        }
        for (const member of Object.values(workspace.members || {})) {
          const before = member.queue.length;
          member.queue = member.queue.filter((item) => !recoveredRunIds.has(item.orchestratorRunId));
          if (member.queue.length !== before) changed = true;
          if (member.current?.item && recoveredRunIds.has(member.current.item.orchestratorRunId)) {
            if (member.current.pendingMessageId) member.messages = member.messages.filter((m) => m.id !== member.current.pendingMessageId);
            member.current = null;
            if (member.status === 'running') member.status = 'idle';
            changed = true;
          }
        }
        for (const q of workspace.orchestratorQueue || []) {
          if (recoveredRunIds.has(q.runId) && (q.state === 'pending' || q.state === 'claimed' || q.state === 'dispatched')) {
            q.state = 'failed';
            q.doneAt = new Date().toISOString();
            changed = true;
          }
        }
      }
      if (changed) this.store.save();
      this.kickWorkspace(workspace.id);
    }
  }
  kickWorkspace(workspaceId) { const w = this.store.requireWorkspace(workspaceId); for (const m of Object.values(w.members)) this.kickMember(workspaceId, m.id); }
  kickMember(workspaceId, memberId) {
    const key = this.key(workspaceId, memberId); if (this.running.has(key)) return;
    const member = this.store.getMember(workspaceId, memberId); if (!member || !member.active || member.status === 'error' || member.queue.length === 0) return;
    const controller = new AbortController(); this.running.set(key, controller);
    void this.drain(workspaceId, memberId, controller).finally(() => {
      this.running.delete(key);
      const latest = this.store.getMember(workspaceId, memberId);
      if (latest?.active && latest.status !== 'error' && latest.queue.length > 0) this.kickMember(workspaceId, memberId);
    });
  }
  async drain(workspaceId, memberId, controller) {
    while (!controller.signal.aborted) {
      const member = this.store.getMember(workspaceId, memberId); if (!member || !member.active || member.status === 'error' || member.queue.length === 0) break;
      const prepared = this.store.beginNext(workspaceId, memberId); if (!prepared) break;
      const { item, history, conversationId } = prepared;
      try { this.store.appendEvent(workspaceId, { type: 'member.started', origin: 'system', memberId, qId: item.id, detail: { queueItemId: item.id } }); } catch {}
      try {
        const workspace = this.store.getWorkspace(workspaceId); const current = this.store.getMember(workspaceId, memberId);
        if (!workspace || !current || controller.signal.aborted) break;
        const mkErr = (msg, code, status=400) => Object.assign(new Error(msg), { code, status });
        let effectiveAgentId = String(current.agentId || workspace.defaultAgentId || '').trim();
        let availableAgents = null;
        let discoveryError = null;
        const canList = typeof this.client.listAgents === 'function';
        if (!effectiveAgentId) {
          if (!canList) {
            availableAgents = [];
          } else {
            try {
              const agents = await this.client.listAgents();
              availableAgents = agents;
              if (agents && agents.length === 1) {
                effectiveAgentId = String(agents[0].id || '');
                if (effectiveAgentId && !workspace.defaultAgentId) {
                  try { this.store.updateWorkspace(workspaceId, { defaultAgentId: effectiveAgentId }); } catch {}
                }
              } else if (agents && agents.length > 1) {
                effectiveAgentId = '';
              }
            } catch (e) {
              discoveryError = e;
            }
            if (discoveryError) {
              const err = mkErr(`LibreChat Agentの取得に失敗しました: ${discoveryError?.message || String(discoveryError)}`, 'DISCOVERY_FAILED', 503);
              err.cause = discoveryError;
              throw err;
            }
          }
        }
        if (!effectiveAgentId) {
          if (discoveryError) {
            const err = mkErr(`LibreChat Agentの取得に失敗しました: ${discoveryError?.message || String(discoveryError)}`, 'DISCOVERY_FAILED', 503);
            err.cause = discoveryError;
            throw err;
          }
          let agents = availableAgents;
          if (agents === null) {
            if (!canList) {
              agents = [];
            } else {
              try {
                agents = await this.client.listAgents();
              } catch (e) {
                throw mkErr(`LibreChat Agentの取得に失敗しました: ${e?.message || String(e)}`, 'DISCOVERY_FAILED', 503);
              }
            }
          }
          if (!agents || agents.length === 0) throw mkErr('利用可能なLibreChat Agentがありません。LibreChatでAgentを作成してください。', 'AGENT_SELECTION_REQUIRED', 400);
          if (agents.length > 1) throw mkErr('複数のLibreChat Agentがあります。ワークスペースの既定エージェントを選択してください。', 'AGENT_SELECTION_REQUIRED', 400);
          throw mkErr('利用可能なLibreChat Agentが設定されていません。LibreChatでAgentを作成するか、設定からAgentを選択してください。', 'AGENT_SELECTION_REQUIRED', 400);
        }
        if (availableAgents === null) {
          if (!canList) {
            availableAgents = [];
          } else {
            try { availableAgents = await this.client.listAgents(); } catch (e) {
              throw mkErr(`LibreChat Agentの取得に失敗しました: ${e?.message || String(e)}`, 'DISCOVERY_FAILED', 503);
            }
          }
        }
        if (availableAgents && availableAgents.length && !availableAgents.some(a => String(a.id) === effectiveAgentId)) {
          if (current.agentId && String(current.agentId) === effectiveAgentId) {
            throw mkErr('このチャットに設定されたエージェントがLibreChatに存在しません。エージェントを選び直すか、ワークスペース既定を使用してください。', 'AGENT_NOT_AVAILABLE', 400);
          } else {
            throw mkErr('設定されている既定エージェントがLibreChatに存在しません。エージェントを選び直してください。', 'AGENT_NOT_AVAILABLE', 400);
          }
        }
        const japMap = (msg) => {
          const m = String(msg || '');
          if (m.includes('LibreChat agentId is required')) return '利用可能なLibreChat Agentが設定されていません。LibreChatでAgentを作成するか、設定からAgentを選択してください。';
          if (m.includes('Invalid API key') || m.includes('invalid_api_key')) return 'LibreChat接続キーを確認してください';
          if (m.includes('Failed to connect') || m.includes('fetch failed') || m.includes('Connection refused')) return 'LibreChatに接続できません';
          if (m.includes('GPT-OSS') || m.includes('llama')) return 'GPT-OSSを利用できません';
          return m;
        };
        try {
          const result = await this.client.runAgent({
            agentId: effectiveAgentId, globalPrompt: workspace.globalPrompt, developerPrompt: current.developerPrompt,
            history: history.slice(-(this.maxHistoryMessages - 1)), prompt: item.prompt, conversationId,
            signal: controller.signal, metadata: { workspace_id: workspaceId, member_id: memberId, queue_item_id: item.id },
          });
          if (controller.signal.aborted || !this.store.getMember(workspaceId, memberId)) continue;
          let currentResult = result;
          let currentConversationId = result.conversationId;
          let toolCalls = extractToolCalls(currentResult.raw);
          if (this.client.mode !== 'compat' && toolCalls.length > 0) {
            if (!this.executor) throw new Error('CrossChatToolExecutor not initialized — call setApp(app)');
            // Bound the native tool loop: a model that keeps emitting function
            // calls would otherwise recurse unboundedly within one queue item
            // (unbounded model spend and deliveries). Exhaustion BLOCKs the
            // member with an explicit message; deliveries already made are kept
            // and Retry continues explicitly. Stop still aborts immediately.
            let toolIterations = 0;
            for (;;) {
              toolIterations += 1;
              if (toolIterations > this.maxNativeToolIterations) {
                throw Object.assign(new Error(`Cross-chat tool iteration budget exhausted after ${this.maxNativeToolIterations} tool rounds; deliveries already made are kept. Retry to continue or Stop to end.`), { code: 'TOOL_ITERATION_BUDGET_EXHAUSTED', status: 400 });
              }
              const liveCurrent = this.store.getMember(workspaceId, memberId)?.current?.item;
              if (controller.signal.aborted || !liveCurrent || liveCurrent.id !== item.id) break;
              const toolResults = await this.executor.execute({
                workspaceId,
                sourceMemberId: memberId,
                sourceQueueItemId: item.id,
                // Use the live store record rather than the beginNext clone. A parent send_to_chat
                // may attach orchestrator provenance just after this child began executing.
                sourceOrchestratorRunId: liveCurrent.orchestratorRunId || item.orchestratorRunId || null,
                sourceOrchestratorQId: liveCurrent.orchestratorQId || item.orchestratorQId || null,
                toolCalls,
                signal: controller.signal,
              });
              for (const r of toolResults) {
                try {
                  const tc = toolCalls.find(t => (t.call_id || t.call_id === r.call_id) && t.call_id === r.call_id) || toolCalls[0];
                  const tname = tc?.name || tc?.function?.name || 'unknown';
                  let replayed = false;
                  try { const parsed = JSON.parse(r.output); if (parsed && parsed.replayed === true) replayed = true; if (parsed && parsed.ok === false) replayed = false; } catch {}
                  const evType = replayed ? 'tool.replayed' : `tool.${tname}`;
                  this.store.appendEvent(workspaceId, { type: evType, origin: 'system', memberId, qId: item.id, detail: { callId: r.call_id, tool: tname, replayed } });
                } catch {}
              }
              if (controller.signal.aborted || !this.store.getMember(workspaceId, memberId) || this.store.getMember(workspaceId, memberId)?.current?.item?.id !== item.id) break;
              const functionCallOutput = toolResults.map(r => ({ type: 'function_call_output', call_id: r.call_id, output: r.output }));
              if (this.client.mode === 'native' && typeof this.client.continueAgent === 'function') {
                currentResult = await this.client.continueAgent({ agentId: effectiveAgentId, conversationId: currentConversationId, toolCalls, toolResults: functionCallOutput, signal: controller.signal, metadata: { workspace_id: workspaceId, member_id: memberId, queue_item_id: item.id } });
              } else {
                currentResult = await this.client.runAgent({ agentId: effectiveAgentId, conversationId: currentConversationId, signal: controller.signal, metadata: { workspace_id: workspaceId, member_id: memberId, queue_item_id: item.id }, toolResults: functionCallOutput });
              }
              if (controller.signal.aborted || !this.store.getMember(workspaceId, memberId) || this.store.getMember(workspaceId, memberId)?.current?.item?.id !== item.id) break;
              currentConversationId = currentResult.conversationId;
              const nextToolCalls = extractToolCalls(currentResult.raw);
              if (nextToolCalls.length === 0) break;
              toolCalls = nextToolCalls;
            }
          }
          this.store.completeRun(workspaceId, memberId, item.id, currentResult);
          try { this.store.appendEvent(workspaceId, { type: 'member.completed', origin: 'system', memberId, qId: item.id }); } catch {}
          this.store.trimMessages(workspaceId, memberId, this.maxHistoryMessages);
        } catch (inner) {
          const msg = japMap(inner?.message || String(inner));
          throw new Error(msg);
        }
      } catch (error) {
        if (!this.store.getMember(workspaceId, memberId)) break;
        const msg = String(error?.message || String(error));
        const code = error?.code || '';
        const isConfigError = code === 'AGENT_SELECTION_REQUIRED' || code === 'AGENT_NOT_AVAILABLE' || msg.includes('存在しません') || msg.includes('Agentが') || msg.includes('エージェント');
        const isDiscovery = code === 'DISCOVERY_FAILED' || msg.includes('取得に失敗');
        if (controller.signal.aborted) {
          this.store.failRun(workspaceId, memberId, item.id, 'Stopped by user', { requeue: false });
          try { this.store.appendEvent(workspaceId, { type: 'member.cancelled', origin: 'system', memberId, qId: item.id }); } catch {}
        } else if (isDiscovery) {
          this.store.failRun(workspaceId, memberId, item.id, msg, { requeue: true });
          try { this.store.appendEvent(workspaceId, { type: 'member.failed', origin: 'system', memberId, qId: item.id, detail: { code } }); } catch {}
        } else {
          this.store.failRun(workspaceId, memberId, item.id, msg, { requeue: !isConfigError });
          try { this.store.appendEvent(workspaceId, { type: 'member.failed', origin: 'system', memberId, qId: item.id, detail: { code } }); } catch {}
        }
        break;
      }
    }
  }
  stopMember(workspaceId, memberId, { clearQueue = true } = {}) {
    const key = this.key(workspaceId, memberId); this.running.get(key)?.abort(new Error('Stopped by user'));
    this.store.cancelCurrent(workspaceId, memberId, { clearQueue });
  }
  stopWorkspace(workspaceId, { clearQueue = true } = {}) {
    const workspace = this.store.getWorkspace(workspaceId); if (!workspace) return;
    for (const member of Object.values(workspace.members)) this.stopMember(workspaceId, member.id, { clearQueue });
  }
  abortByOrchestratorRun(workspaceId, runId) {
    const ws = this.store.getWorkspace(workspaceId);
    if (!ws) return 0;
    let aborted = 0;
    for (const member of Object.values(ws.members)) {
      const cur = member.current;
      if (cur && cur.item && cur.item.orchestratorRunId === runId) {
        const key = this.key(workspaceId, member.id);
        const ctrl = this.running.get(key);
        if (ctrl && !ctrl.signal.aborted) {
          ctrl.abort(new Error('Cancelled by orchestrator run'));
          aborted++;
        }
      }
    }
    return aborted;
  }
  retryMember(workspaceId, memberId) { this.store.retryMember(workspaceId, memberId); this.kickMember(workspaceId, memberId); }
}