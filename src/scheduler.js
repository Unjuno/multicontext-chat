export class Scheduler {
  constructor({ store, client, maxHistoryMessages = 120 }) {
    this.store = store; this.client = client; this.maxHistoryMessages = maxHistoryMessages; this.running = new Map();
  }
  key(workspaceId, memberId) { return `${workspaceId}:${memberId}`; }
  runningMemberIds(workspaceId) {
    const prefix = `${workspaceId}:`;
    return new Set([...this.running.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  }
  resumeAll() { for (const workspace of Object.values(this.store.state.workspaces)) this.kickWorkspace(workspace.id); }
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
            // No listAgents available (test mock); treat as cannot auto-resolve
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
        // Map known English errors to Japanese
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
          // Handle explicit marker-based autonomous send-to-chat as fallback when LLM tool calling is not configured
          // e.g. "[[SEND_TO_CHAT:targetId:prompt]]" or "[[SEND_TO:target:prompt]]" — tolerate one or two trailing ]]
          const markerMatch = String(result.text || '').match(/\[\[SEND_TO(?:_CHAT)?:([^:\]]+):([\s\S]*?)\]\]?/);
          if (markerMatch) {
            const targetRaw = markerMatch[1].trim();
            const promptRaw = markerMatch[2].trim();
            if (targetRaw && promptRaw) {
              try {
                const target = this.store.resolveMember(workspaceId, targetRaw, { activeOnly: true });
                const cleanText = String(result.text).replace(markerMatch[0], '').trim();
                const cleanedResult = { ...result, text: cleanText || '(autonomous send)' };
                this.store.completeRun(workspaceId, memberId, item.id, cleanedResult);
                this.store.trimMessages(workspaceId, memberId, this.maxHistoryMessages);
                this.store.enqueue(workspaceId, target.id, promptRaw, { source: 'tool', sourceMemberId: memberId });
                this.kickMember(workspaceId, target.id);
                continue;
              } catch (e) {
                console.error('[scheduler marker] resolve/enqueue failed', e?.message || String(e));
              }
            }
          }
          // Also handle raw tool_calls if present in LibreChat response
          const rawToolCalls = result.raw?.output?.filter?.(x => x.type === 'tool_call' || x.type === 'function_call') || result.raw?.tool_calls || [];
          if (Array.isArray(rawToolCalls) && rawToolCalls.length) {
            for (const tc of rawToolCalls) {
              const name = tc.name || tc.function?.name || '';
              const args = tc.args || tc.arguments || tc.function?.arguments || {};
              let parsed = args;
              if (typeof args === 'string') { try { parsed = JSON.parse(args); } catch { parsed = {}; } }
              if (name === 'send_to_chat' || name === 'send-to-chat') {
                const targets = parsed.targets || (parsed.target ? [parsed.target] : []);
                const promptArg = parsed.prompt || '';
                for (const t of targets.slice(0,2)) {
                  try {
                    const target = this.store.resolveMember(workspaceId, String(t), { activeOnly: true });
                    this.store.enqueue(workspaceId, target.id, String(promptArg), { source: 'tool', sourceMemberId: memberId });
                    this.kickMember(workspaceId, target.id);
                  } catch {}
                }
              }
            }
          }
          this.store.completeRun(workspaceId, memberId, item.id, result);
          this.store.trimMessages(workspaceId, memberId, this.maxHistoryMessages);
        } catch (inner) {
          const msg = japMap(inner?.message || String(inner));
          throw new Error(msg);
        }
      } catch (error) {
        if (!this.store.getMember(workspaceId, memberId)) break;
        const msg = String(error?.message || String(error));
        const code = error?.code || '';
        // Typed classification: DISCOVERY_FAILED and network/auth are retriable; config errors are not
        const isConfigError = code === 'AGENT_SELECTION_REQUIRED' || code === 'AGENT_NOT_AVAILABLE' || msg.includes('存在しません') || msg.includes('Agentが') || msg.includes('エージェント');
        const isDiscovery = code === 'DISCOVERY_FAILED' || msg.includes('取得に失敗');
        if (controller.signal.aborted) this.store.failRun(workspaceId, memberId, item.id, 'Stopped by user', { requeue: false });
        else if (isDiscovery) this.store.failRun(workspaceId, memberId, item.id, msg, { requeue: true });
        else this.store.failRun(workspaceId, memberId, item.id, msg, { requeue: !isConfigError });
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
  retryMember(workspaceId, memberId) { this.store.retryMember(workspaceId, memberId); this.kickMember(workspaceId, memberId); }
}
