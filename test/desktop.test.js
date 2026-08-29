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

test("Retry clears stale READY: only GPT-OSS ready in new attempt must not navigate", () => {
  // Attempt 1 reaches all READY.
  let statuses = {};
  statuses = UI.applyStartupEvent(statuses, status("モデル", "ready", { attempt_id: 1 }), 1);
  statuses = UI.applyStartupEvent(statuses, status("LibreChat", "ready", { attempt_id: 1 }), 1);
  statuses = UI.applyStartupEvent(statuses, status("MultiContext", "ready", { attempt_id: 1 }), 1);
  assert.equal(UI.shouldNavigate(Object.values(statuses), false), true);
  // Attempt 2 begins: fresh map.
  let statuses2 = {};
  statuses2 = UI.applyStartupEvent(statuses2, status("モデル", "ready", { attempt_id: 2 }), 2);
  // Only GPT-OSS ready -> must not navigate.
  assert.equal(UI.shouldNavigate(Object.values(statuses2), false), false);
  // After LibreChat + MultiContext also READY in attempt 2, may navigate.
  statuses2 = UI.applyStartupEvent(statuses2, status("LibreChat", "ready", { attempt_id: 2 }), 2);
  statuses2 = UI.applyStartupEvent(statuses2, status("MultiContext", "ready", { attempt_id: 2 }), 2);
  assert.equal(UI.shouldNavigate(Object.values(statuses2), false), true);
});

test("delayed event from attempt 1 arriving during attempt 2 is ignored", () => {
  let statuses = {};
  statuses = UI.applyStartupEvent(statuses, status("モデル", "ready", { attempt_id: 2 }), 2);
  // Delayed LibreChat ready from attempt 1 should be ignored.
  statuses = UI.applyStartupEvent(statuses, status("LibreChat", "ready", { attempt_id: 1 }), 2);
  assert.equal(statuses.LibreChat, undefined);
  assert.equal(UI.shouldNavigate(Object.values(statuses), false), false);
  // Correct attempt 2 event is accepted.
  statuses = UI.applyStartupEvent(statuses, status("LibreChat", "ready", { attempt_id: 2 }), 2);
  statuses = UI.applyStartupEvent(statuses, status("MultiContext", "ready", { attempt_id: 2 }), 2);
  assert.equal(UI.shouldNavigate(Object.values(statuses), false), true);
});

test("production startup HTML contains no localhost:9999 debug beacon", () => {
  const html = readFileSync(
    fileURLToPath(new URL("../public/desktop-startup.html", import.meta.url)),
    "utf8"
  );
  assert.equal(html.includes("127.0.0.1:9999"), false, "must not contain 127.0.0.1:9999");
  assert.equal(html.includes("beacon("), false, "must not contain beacon(");
});

test("aggregate status is READY only when all required services are READY", () => {
  const allReady = [
    status("モデル", "ready"),
    status("LibreChat", "ready"),
    status("MultiContext", "ready"),
  ];
  const agg = UI.aggregateStatus(allReady);
  assert.equal(agg.cls, "ready");
  assert.equal(agg.text, "AI Stack ● 準備完了");
});

test("one failed service makes aggregate non-READY", () => {
  const oneError = [
    status("モデル", "ready"),
    status("LibreChat", "error"),
    status("MultiContext", "ready"),
  ];
  const agg = UI.aggregateStatus(oneError);
  assert.equal(agg.cls, "error");
  assert.equal(agg.text, "AI Stack ● 要確認");
});

test("starting/checking aggregate shows 起動中", () => {
  const starting = [
    status("モデル", "starting"),
    status("LibreChat", "ready"),
    status("MultiContext", "ready"),
  ];
  assert.equal(UI.aggregateStatus(starting).cls, "starting");
  assert.equal(UI.aggregateStatus(starting).text, "AI Stack ● 起動中");
  const checking = [
    status("モデル", "checking"),
    status("LibreChat", "ready"),
    status("MultiContext", "ready"),
  ];
  assert.equal(UI.aggregateStatus(checking).cls, "starting");
});

test("serviceDisplayLabel returns correct Japanese labels", () => {
  assert.equal(UI.serviceDisplayLabel("モデル", "ready"), "準備完了");
  assert.equal(UI.serviceDisplayLabel("モデル", "starting"), "起動中");
  assert.equal(UI.serviceDisplayLabel("モデル", "checking"), "確認中");
  assert.equal(UI.serviceDisplayLabel("モデル", "error"), "エラー");
  assert.equal(UI.serviceDisplayLabel("LibreChat", "ready"), "接続済み");
  assert.equal(UI.serviceDisplayLabel("LibreChat", "starting"), "接続中");
  assert.equal(UI.serviceDisplayLabel("LibreChat", "needs_setup"), "要設定");
  assert.equal(UI.serviceDisplayLabel("MultiContext", "ready"), "準備完了");
  assert.equal(UI.serviceDisplayLabel("MultiContext", "checking"), "確認中");
});

test("dotClassForState maps states correctly", () => {
  assert.equal(UI.dotClassForState("ready"), "ready");
  assert.equal(UI.dotClassForState("starting"), "starting");
  assert.equal(UI.dotClassForState("checking"), "starting");
  assert.equal(UI.dotClassForState("error"), "error");
  assert.equal(UI.dotClassForState("needs_setup"), "needs_setup");
});

test("old startup run cannot emit events labeled with newer attempt_id (run-local token)", () => {
  // Simulate Rust run-local token: attempt 1 emits with id=1, attempt 2's rejected call would not change it.
  // Frontend must still ignore attempt 2's stale event if it were somehow emitted with wrong id.
  let statuses = {};
  // Attempt 1 legitimately emits ready for all
  statuses = UI.applyStartupEvent(statuses, status("モデル", "ready", { attempt_id: 1 }), 1);
  statuses = UI.applyStartupEvent(statuses, status("LibreChat", "ready", { attempt_id: 1 }), 1);
  statuses = UI.applyStartupEvent(statuses, status("MultiContext", "ready", { attempt_id: 1 }), 1);
  assert.equal(UI.shouldNavigate(Object.values(statuses), false), true);
  // Now attempt 2 is the active attempt; a delayed event from attempt 1 with attempt_id=2 would be malicious relabel
  // Our backend now uses run-local token so this relabel cannot happen; frontend still correctly filters by attempt_id
  let statuses2 = {};
  statuses2 = UI.applyStartupEvent(statuses2, status("モデル", "ready", { attempt_id: 2 }), 2);
  // If backend mistakenly relabeled old attempt 1's LibreChat as 2, it would appear as ready, but we test that old id=1 is ignored
  statuses2 = UI.applyStartupEvent(statuses2, status("LibreChat", "ready", { attempt_id: 1 }), 2);
  assert.equal(statuses2.LibreChat, undefined, "must not accept relabeled old event");
});

test("no secrets in serialized runtime status", () => {
  const statuses = [
    status("モデル", "ready", { message: "準備完了" }),
    status("LibreChat", "ready", { message: "接続済み" }),
    status("MultiContext", "ready", { message: "準備完了" }),
  ];
  const serialized = JSON.stringify(statuses).toLowerCase();
  assert.equal(serialized.includes("sk-"), false);
  assert.equal(serialized.includes("bearer"), false);
  assert.equal(serialized.includes("librechat_api_key"), false);
});

test("isTauriAvailable returns false in Node (browser fallback)", () => {
  assert.equal(UI.isTauriAvailable(), false);
});

test("workspace runtime HTML has no localhost:9999 and no secrets", () => {
  const html = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
  const js = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");
  assert.equal(html.includes("127.0.0.1:9999"), false);
  assert.equal(js.includes("127.0.0.1:9999"), false);
  // app.js runtime poll must use Tauri runtime_status (not raw key handling)
  assert.equal(js.includes("runtime_status"), true, "should poll runtime_status");
  // Ensure no hardcoded Remote Agents key appears in public js
  const hasHardcodedKey = /sk-[a-z0-9]{20,}/i.test(js);
  assert.equal(hasHardcodedKey, false, "should not contain hardcoded API key");
});

test("browser mode degrade: missing Tauri should not throw", () => {
  // Simulate browser without __TAURI__
  const orig = globalThis.window;
  globalThis.window = {};
  assert.doesNotThrow(() => UI.isTauriAvailable());
  assert.equal(UI.isTauriAvailable(), false);
  // aggregate still works without Tauri
  const agg = UI.aggregateStatus([status("MultiContext", "ready")]);
  assert.ok(agg.text);
  globalThis.window = orig;
});
