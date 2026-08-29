// Deterministic UI regression coverage for the desktop startup/settings logic.
// The orchestration lives in src-tauri (Rust); here we lock the pure,
// user-facing predicates that drive navigation and connection messaging so a
// browser-free change cannot silently break the "navigate exactly once" and
// "do not claim READY unless MultiContext health is truly ready" guarantees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// desktop-ui.js is a UMD browser helper (loaded via <script> in the Tauri
// window), so it is not an ES module. Evaluate it in a sandbox that provides
// the CommonJS `module`/`exports` shims so we can assert on its pure functions
// without a browser.
const code = readFileSync(
  fileURLToPath(new URL("../public/desktop-ui.js", import.meta.url)),
  "utf8"
);
const sandbox = { exports: {} };
// eslint-disable-next-line no-new-func
const factory = new Function("module", "exports", "self", "window", code);
factory(sandbox, sandbox.exports, undefined, undefined);
const UI = sandbox.exports;

function status(name, state, extra = {}) {
  return { name, state, message: "", ownership: null, ...extra };
}

test("labelFor maps internal service keys to user-facing labels", () => {
  assert.equal(UI.labelFor("モデル"), "GPT-OSS");
  assert.equal(UI.labelFor("LibreChat"), "LibreChat");
  assert.equal(UI.labelFor("MultiContext"), "MultiContext");
  assert.equal(UI.labelFor("未知"), "未知");
});

test("allServicesReady is false until every service reports ready", () => {
  const partial = [status("モデル", "ready"), status("LibreChat", "ready")];
  assert.equal(UI.allServicesReady(partial), false);
  const withError = [
    status("モデル", "ready"),
    status("LibreChat", "ready"),
    status("MultiContext", "error"),
  ];
  assert.equal(UI.allServicesReady(withError), false);
  const all = [
    status("モデル", "ready"),
    status("LibreChat", "ready"),
    status("MultiContext", "ready"),
  ];
  assert.equal(UI.allServicesReady(all), true);
});

test("startup screen does NOT navigate if MultiContext health is not truly ready", () => {
  // Backend only emits state "ready" for MultiContext once GET /api/health
  // returns ok===true. If it is merely listening (error/checking/starting),
  // navigation must not happen.
  const notReady = [
    status("モデル", "ready"),
    status("LibreChat", "ready"),
    status("MultiContext", "checking"),
  ];
  assert.equal(UI.shouldNavigate(notReady, false), false);
  const wrongService = [
    status("モデル", "ready"),
    status("LibreChat", "ready"),
    status("MultiContext", "error", { message: "MultiContext ポートに想定外のサービス" }),
  ];
  assert.equal(UI.shouldNavigate(wrongService, false), false);
});

test("startup screen navigates exactly once across repeated ready snapshots", () => {
  const all = [
    status("モデル", "ready"),
    status("LibreChat", "ready"),
    status("MultiContext", "ready"),
  ];
  let navigated = false;
  assert.equal(UI.shouldNavigate(all, navigated), true);
  navigated = true;
  // A later refresh that again reports ready must NOT re-trigger navigation.
  assert.equal(UI.shouldNavigate(all, navigated), false);
});

test("librechat connection text distinguishes missing/ok/forbidden/offline", () => {
  assert.equal(UI.librechatConnectionText({ has_key: false }), "要設定");
  assert.equal(
    UI.librechatConnectionText({ has_key: true, librechat_reachable: true, auth_ok: true }),
    "接続済み"
  );
  assert.equal(
    UI.librechatConnectionText({ has_key: true, librechat_reachable: true, auth_ok: false }),
    "接続キーを確認してください"
  );
  assert.equal(
    UI.librechatConnectionText({ has_key: true, librechat_reachable: false, auth_ok: false }),
    "LibreChat に接続できません"
  );
});

test("ownership text is empty for unknown, labelled for known kinds", () => {
  assert.equal(UI.ownershipText(null), "");
  assert.equal(UI.ownershipText("external"), "外部");
  assert.equal(UI.ownershipText("startedbymulticontext"), "管理 (Desktop 起動)");
});
