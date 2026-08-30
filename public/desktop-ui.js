// Shared, framework-free helpers for the MultiContext desktop startup/settings UI.
// Exposed as `window.DesktopUI` in the browser and `module.exports` under Node so
// the same logic can be unit-tested without a browser (see test/desktop.test.js).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DesktopUI = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Internal service key -> user-facing label.
  const SERVICE_LABELS = {
    "モデル": "GPT-OSS",
    "LibreChat": "LibreChat",
    "MultiContext": "MultiContext",
  };

  function labelFor(name) {
    return SERVICE_LABELS[name] || name;
  }

  // The full ordered set that must be READY before navigating.
  const STARTUP_SERVICES = ["モデル", "LibreChat", "MultiContext"];

  function indexBy(statuses) {
    const map = {};
    (statuses || []).forEach((s) => {
      map[s.name] = s;
    });
    return map;
  }

  // True only when every required service reports the backend's READY state.
  // The backend only emits `ready` for MultiContext when its usable-stack health
  // (GET /api/health ok===true) is actually satisfied, so this predicate already
  // encodes "MultiContext health is truly ready".
  function allServicesReady(statuses, services) {
    const list = services || STARTUP_SERVICES;
    if (!list.length) return false;
    const byName = indexBy(statuses);
    return list.every((n) => {
      const s = byName[n];
      return s && s.state === "ready";
    });
  }

  // Navigate exactly once: never re-trigger after we already navigated.
  function shouldNavigate(statuses, services, navigated) {
    if (navigated) return false;
    return allServicesReady(statuses, services);
  }

  // Classify the LibreChat connection for a user-facing message.
  // status: { has_key: bool, librechat_reachable: bool, auth_ok: bool }
  function librechatConnectionKind(status) {
    if (!status || !status.has_key) return "missing";
    if (status.auth_ok) return "ok";
    if (status.librechat_reachable) return "forbidden";
    return "offline";
  }

  function librechatConnectionText(status) {
    switch (librechatConnectionKind(status)) {
      case "missing":
        return "要設定";
      case "ok":
        return "接続済み";
      case "forbidden":
        return "接続キーを確認してください";
      case "offline":
        return "LibreChat に接続できません";
      default:
        return "確認中...";
    }
  }

  function ownershipText(ownership) {
    if (ownership === "startedbymulticontext") return "管理 (Desktop 起動)";
    if (ownership === "external") return "外部";
    return "";
  }

  // Apply a startup-progress event only if it belongs to the active attempt.
  // `statuses` is a name->status map for the active attempt.
  function applyStartupEvent(statuses, event, activeAttemptId) {
    if (event == null || typeof event.name !== "string") return statuses;
    if (event.attempt_id != null && event.attempt_id !== activeAttemptId) return statuses;
    const next = Object.assign({}, statuses);
    next[event.name] = event;
    return next;
  }

  // ── Runtime status helpers (shared between startup and workspace) ──
  const STATE_LABELS = {
    "モデル": { ready: "準備完了", starting: "起動中", checking: "確認中", needs_setup: "要設定", error: "エラー" },
    "LibreChat": { ready: "接続済み", starting: "接続中", checking: "接続中", needs_setup: "要設定", error: "エラー" },
    "MultiContext": { ready: "準備完了", starting: "起動中", checking: "確認中", needs_setup: "要設定", error: "エラー" },
    "LibreChat Agent": { ready: "利用可能", starting: "確認中", checking: "確認中", needs_setup: "未設定", error: "未設定" },
    "GPT-OSS": { ready: "準備完了", starting: "起動中", checking: "確認中", needs_setup: "要設定", error: "エラー" },
    "MCP": { ready: "有効", starting: "確認中", checking: "確認中", needs_setup: "無効", error: "無効" },
    "外部連携": { ready: "有効", starting: "確認中", checking: "確認中", needs_setup: "無効", error: "無効" },
  };

  function normalizeState(state) {
    if (!state) return "checking";
    const s = String(state).toLowerCase();
    if (s === "ready") return "ready";
    if (s === "starting") return "starting";
    if (s === "checking") return "checking";
    if (s === "needs_setup" || s === "needssetup" || s === "needs-setup") return "needs_setup";
    if (s === "error") return "error";
    return "checking";
  }

  function serviceDisplayLabel(name, state) {
    const map = STATE_LABELS[name] || STATE_LABELS["MultiContext"];
    const n = normalizeState(state);
    return map[n] || map.checking;
  }

  function dotClassForState(state) {
    const n = normalizeState(state);
    if (n === "ready") return "ready";
    if (n === "starting" || n === "checking") return "starting";
    if (n === "needs_setup") return "needs_setup";
    return "error";
  }

  function aggregateStatus(statuses) {
    // MCP external control is optional and must not affect aggregate readiness
    const list = (statuses || []).filter(s => !String(s.name || '').toLowerCase().includes('mcp') && !String(s.name || '').includes('外部'));
    if (!list.length) return { label: "確認中", cls: "checking", text: "AI Stack ● 確認中" };
    const states = list.map((s) => normalizeState(s.state));
    if (states.every((s) => s === "ready")) return { label: "準備完了", cls: "ready", text: "AI Stack ● 準備完了" };
    if (states.some((s) => s === "error")) return { label: "要確認", cls: "error", text: "AI Stack ● 要確認" };
    if (states.some((s) => s === "needs_setup")) return { label: "要設定", cls: "needs_setup", text: "AI Stack ● 要設定" };
    return { label: "起動中", cls: "starting", text: "AI Stack ● 起動中" };
  }

  // For browser mode: degrade gracefully when Tauri is absent
  function isTauriAvailable() {
    try {
      const t = typeof window !== "undefined" ? window.__TAURI__ : null;
      return !!(t && (t.core || t.invoke));
    } catch { return false; }
  }

  return {
    SERVICE_LABELS,
    STARTUP_SERVICES,
    labelFor,
    allServicesReady,
    shouldNavigate,
    librechatConnectionKind,
    librechatConnectionText,
    ownershipText,
    applyStartupEvent,
    serviceDisplayLabel,
    dotClassForState,
    aggregateStatus,
    normalizeState,
    isTauriAvailable,
  };
});
