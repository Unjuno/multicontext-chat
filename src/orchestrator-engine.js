// Canonical orchestrator run engine (domain layer).
//
// Both the MCP transport (src/mcp/orchestrator.js) and the application API
// (src/application.js) route through these exact functions, so GUI-originated
// and MCP-originated runs share validation, queue behavior, provenance,
// events, pause/resume dispatch, and cancellation semantics.
//
// `invoke` carries the canonical member-mutation operations
// ({ send, broadcast, waitUntilSettled }); `scheduler` is used only for
// aborting in-flight model work on cancel.
export const terminalRunStatuses = new Set(['settled', 'blocked', 'failed', 'cancelled']);

export function targetFromArgs({ broadcast, chat_id } = {}) {
  return broadcast ? { type: 'broadcast' } : chat_id ? { type: 'member', memberId: chat_id } : { type: 'broadcast' };
}

export function createRunEngine({ store, scheduler = null, invoke = {} }) {
  if (!store) throw new Error('store required');
  const requireInvoke = () => {
    if (typeof invoke.send !== 'function' || typeof invoke.broadcast !== 'function' || typeof invoke.waitUntilSettled !== 'function') {
      throw new Error('invoke { send, broadcast, waitUntilSettled } required');
    }
    return invoke;
  };

  const createRunRecord = ({ workspaceId, prompt, priority = 1, target, origin = 'mcp', actor = 'orchestrator' }) => {
    const run = store.createOrchestratorRun(workspaceId, { prompt, priority, origin, actor });
    const qItem = store.enqueueOrchestrator(workspaceId, prompt, { priority, origin, actor, runId: run.id, target });
    return { run, qItem };
  };

  const dispatchRun = async ({ workspaceId, run, qItem, timeoutSeconds = 300 }) => {
    const currentRun = store.getOrchestratorRun(workspaceId, run.id);
    if (terminalRunStatuses.has(currentRun.status)) return { run: currentRun, qItem, enqueueResult: null, wait: null };
    if (currentRun.status === 'queued') store.updateOrchestratorRun(workspaceId, run.id, { status: 'running' });
    const currentQ = store.getWorkspace(workspaceId).orchestratorQueue.find(q => q.id === qItem.id);
    if (currentQ?.state === 'pending' || currentQ?.state === 'claimed') {
      store.updateOrchestratorQueueItem(workspaceId, qItem.id, { state: 'dispatched' });
    }

    const io = requireInvoke();
    let enqueueResult;
    try {
      const target = qItem.target || { type: 'broadcast' };
      const provenance = { orchestratorRunId: run.id, orchestratorQId: qItem.id };
      if (target.type === 'member') enqueueResult = await io.send(workspaceId, target.memberId, qItem.prompt, provenance);
      else enqueueResult = await io.broadcast(workspaceId, qItem.prompt, provenance);

      const wait = await io.waitUntilSettled(workspaceId, timeoutSeconds, 500);
      const latest = store.getOrchestratorRun(workspaceId, run.id);
      if (terminalRunStatuses.has(latest.status) && latest.status !== 'running') return { run: latest, qItem, enqueueResult, wait };

      const finalStatus = wait.state === 'SETTLED' ? 'settled' : wait.state === 'BLOCKED' ? 'blocked' : 'failed';
      store.updateOrchestratorRun(workspaceId, run.id, { status: finalStatus });
      store.markDispatchedQDone(workspaceId, run.id, finalStatus);
      return { run: store.getOrchestratorRun(workspaceId, run.id), qItem, enqueueResult, wait };
    } catch (error) {
      const latest = store.getOrchestratorRun(workspaceId, run.id);
      if (!terminalRunStatuses.has(latest.status)) {
        try { store.updateOrchestratorRun(workspaceId, run.id, { status: 'failed', error: String(error.message || error) }); } catch {}
        try {
          const q = store.getWorkspace(workspaceId).orchestratorQueue.find(x => x.id === qItem.id);
          if (q && (q.state === 'pending' || q.state === 'claimed' || q.state === 'dispatched')) {
            if (q.state === 'pending') store.updateOrchestratorQueueItem(workspaceId, q.id, { state: 'dispatched' });
            store.updateOrchestratorQueueItem(workspaceId, q.id, { state: 'failed' });
          }
        } catch {}
      }
      throw error;
    }
  };

  const startRun = ({ workspaceId, prompt, priority = 1, target, timeoutSeconds = 300, detached = true, origin = 'mcp', actor = 'orchestrator' }) => {
    const { run, qItem } = createRunRecord({ workspaceId, prompt, priority, target, origin, actor });
    const paused = Boolean(store.getWorkspace(workspaceId).orchestratorPaused);
    if (paused) return { run, qItem, paused: true, execution: null };
    const execution = dispatchRun({ workspaceId, run, qItem, timeoutSeconds });
    if (detached) void execution.catch(() => {});
    return { run, qItem, paused: false, execution };
  };

  const resumeQueuedRun = (workspaceId) => {
    if (store.getWorkspace(workspaceId).orchestratorPaused) return null;
    const run = store.listOrchestratorRuns(workspaceId).filter(r => r.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!run) return null;
    const qItem = store.getWorkspace(workspaceId).orchestratorQueue.find(q => q.runId === run.id && q.state === 'pending');
    if (!qItem) return null;
    const execution = dispatchRun({ workspaceId, run, qItem, timeoutSeconds: 300 });
    void execution.catch(() => {});
    return { run, qItem };
  };

  const cancelRun = (workspaceId, runId) => {
    const run = store.getOrchestratorRun(workspaceId, runId);
    if (run.status !== 'running' && run.status !== 'queued') return { run, aborted: 0, cancelledMemberItems: 0 };
    const aborted = typeof scheduler?.abortByOrchestratorRun === 'function' ? scheduler.abortByOrchestratorRun(workspaceId, runId) : 0;
    const cancelledMemberItems = store.cancelOrchestratorRunMembers(workspaceId, runId);
    store.updateOrchestratorRun(workspaceId, runId, { status: 'cancelled' });
    return { run: store.getOrchestratorRun(workspaceId, runId), aborted, cancelledMemberItems };
  };

  const setPaused = (workspaceId, paused) => {
    const p = store.setOrchestratorPaused(workspaceId, paused);
    const resumed = p ? null : resumeQueuedRun(workspaceId);
    return { paused: p, resumed };
  };

  return { createRunRecord, dispatchRun, startRun, resumeQueuedRun, cancelRun, setPaused };
}
