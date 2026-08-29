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

  return {
    SERVICE_LABELS,
    STARTUP_SERVICES,
    labelFor,
    allServicesReady,
    shouldNavigate,
    librechatConnectionKind,
    librechatConnectionText,
    ownershipText,
  };
});
