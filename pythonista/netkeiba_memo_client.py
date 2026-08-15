"""Pythonista WebViewの認証済みセッションでnetkeiba馬メモを安全に追記する。"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    import ui
except ImportError:  # PC上の構文・単体テスト用
    ui = None


MEMO_PAGE_URL = "https://db.sp.netkeiba.com/horse/notes.html?id={horse_id}"
POLL_INTERVAL = 0.75
MAX_POLL_ATTEMPTS = 24
_RUN_STATE_LOCK = threading.Lock()
_RUNNING = False


class MemoClientError(Exception):
    def __init__(self, error_type: str, message: str):
        super().__init__(message)
        self.type = error_type


PAGE_STATE_JS = r"""
(function () {
  "use strict";
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function visible(element) {
    if (!element || element.hidden) return false;
    var style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  var bodyText = clean(document.body && document.body.innerText);
  var password = document.querySelector('input[type="password"], input[name*="pswd" i], input[name*="password" i]');
  var loginId = document.querySelector('input[type="email"], input[name*="login" i], input[name*="mail" i]');
  var loginButton = Array.prototype.slice.call(document.querySelectorAll('button, input[type="submit"], a')).some(function (element) {
    return /ログインする|ログイン/.test(clean(element.textContent || element.value));
  });
  var authenticatedText = /ログアウト|マイページ|アカウント情報/.test(bodyText);
  var loginRequired = Boolean(
    (password && (loginId || loginButton)) ||
    (!document.querySelector("textarea") && loginButton && /メモのご利用には無料ID/.test(bodyText))
  );
  var textarea = Array.prototype.slice.call(document.querySelectorAll("textarea")).find(function (element) {
    var hint = clean([element.id, element.name, element.className, element.placeholder].join(" "));
    return visible(element) && (/memo|note|メモ/i.test(hint) || document.querySelectorAll("textarea").length === 1);
  }) || null;
  var id = new URL(location.href).searchParams.get("id") || "";
  return JSON.stringify({
    ok: true,
    host: location.hostname,
    path: location.pathname,
    horseId: id,
    authState: loginRequired ? "login_required" : (authenticatedText || textarea ? "authenticated" : "unknown"),
    textareaFound: Boolean(textarea),
    currentValue: textarea ? String(textarea.value || "") : "",
    limitMessageFound: /登録制限を超えています|メモのご利用には無料ID/.test(bodyText),
    saveSuccessFound: /保存しました|登録しました|更新しました/.test(bodyText)
  });
}())
"""


def _append_and_submit_js(memo_text: str, marker: str) -> str:
    return r"""
(function (memoText, marker) {
  "use strict";
  function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function visible(element) {
    if (!element || element.hidden) return false;
    var style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  var textareas = Array.prototype.slice.call(document.querySelectorAll("textarea"));
  var textarea = textareas.find(function (element) {
    var hint = clean([element.id, element.name, element.className, element.placeholder].join(" "));
    return visible(element) && (/memo|note|メモ/i.test(hint) || textareas.length === 1);
  });
  if (!textarea) return JSON.stringify({ok:false, type:"MEMO_EDITOR_NOT_FOUND"});
  var existing = String(textarea.value || "");
  var markerIndex = existing.indexOf(marker);
  var endMarker = "【/新馬戦チャレンジ】";
  if (markerIndex >= 0) {
    var endIndex = existing.indexOf(endMarker, markerIndex);
    if (endIndex < 0) return JSON.stringify({ok:false, type:"MEMO_BLOCK_END_NOT_FOUND"});
    endIndex += endMarker.length;
    var currentBlock = existing.slice(markerIndex, endIndex);
    if (currentBlock === memoText) return JSON.stringify({ok:true, status:"already_synced"});
    textarea.value = existing.slice(0, markerIndex) + memoText + existing.slice(endIndex);
  } else {
    textarea.value = existing.trim() ? existing.replace(/\s+$/, "") + "\n\n" + memoText : memoText;
  }
  textarea.dispatchEvent(new Event("input", {bubbles:true}));
  textarea.dispatchEvent(new Event("change", {bubbles:true}));
  var form = textarea.form || textarea.closest("form");
  if (!form) return JSON.stringify({ok:false, type:"MEMO_FORM_NOT_FOUND"});
  var buttons = Array.prototype.slice.call(form.querySelectorAll('button, input[type="submit"]'));
  var submit = buttons.find(function (element) {
    return visible(element) && /保存|登録|更新/.test(clean(element.textContent || element.value));
  }) || buttons.find(function (element) { return visible(element) && element.type === "submit"; });
  if (!submit) return JSON.stringify({ok:false, type:"MEMO_SUBMIT_NOT_FOUND"});
  if (typeof form.requestSubmit === "function") form.requestSubmit(submit); else submit.click();
  return JSON.stringify({ok:true, status:"submitted"});
}(%s, %s))
""" % (json.dumps(memo_text, ensure_ascii=False), json.dumps(marker, ensure_ascii=False))


def _parse_json(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    try:
        parsed: Any = json.loads(str(value))
        if isinstance(parsed, str):
            parsed = json.loads(parsed)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


_UI_VIEW_BASE = ui.View if ui is not None else object


class MemoSyncView(_UI_VIEW_BASE):
    def __init__(self, controller: "MemoSyncController") -> None:
        if ui is None:
            raise MemoClientError("WEBVIEW_UNAVAILABLE", "Pythonistaのui.WebViewを利用できません。")
        super().__init__()
        self.controller = controller
        self.name = "netkeiba馬メモ同期"
        self.background_color = "white"
        self.title_label = ui.Label()
        self.title_label.text = "馬メモを同期しています"
        self.title_label.font = ("<system-bold>", 16)
        self.title_label.alignment = ui.ALIGN_CENTER
        self.title_label.background_color = "#F4F6FA"
        self.title_label.text_color = "#093494"
        self.add_subview(self.title_label)
        self.progress_label = ui.Label()
        self.progress_label.font = ("<system>", 14)
        self.progress_label.alignment = ui.ALIGN_CENTER
        self.progress_label.background_color = "#F4F6FA"
        self.add_subview(self.progress_label)
        self.webview = ui.WebView()
        self.webview.scales_page_to_fit = True
        self.webview.delegate = MemoSyncDelegate(controller)
        self.add_subview(self.webview)

    def layout(self) -> None:
        self.title_label.frame = (0, 0, self.width, 36)
        self.progress_label.frame = (0, 36, self.width, 32)
        self.webview.frame = (0, 68, self.width, max(0, self.height - 68))

    def will_close(self) -> None:
        self.controller.handle_close()


class MemoSyncDelegate:
    def __init__(self, controller: "MemoSyncController") -> None:
        self.controller = controller

    def webview_should_start_load(self, webview: Any, url: str, nav_type: int) -> bool:
        return True

    def webview_did_start_load(self, webview: Any) -> None:
        self.controller.handle_load_started()

    def webview_did_finish_load(self, webview: Any) -> None:
        self.controller.schedule_inspection(0.35)

    def webview_did_fail_load(self, webview: Any, error_code: int, error_message: str) -> None:
        if int(error_code) != -999:
            self.controller.fail_current("WEBVIEW_LOAD_FAILED", "馬メモページを読み込めませんでした。")


class MemoSyncController:
    def __init__(self, payload: Dict[str, Any]) -> None:
        if ui is None:
            raise MemoClientError("WEBVIEW_UNAVAILABLE", "Pythonistaのui.WebViewを利用できません。")
        self.payload = payload
        self.items: List[Dict[str, str]] = payload["memoItems"]
        self.results: List[Dict[str, Any]] = []
        self.index = 0
        self.done = False
        self.submitted = False
        self.save_navigation_seen = False
        self.poll_attempt = 0
        self.poll_token = 0
        self.view = MemoSyncView(self)
        self.webview = self.view.webview

    @property
    def current(self) -> Optional[Dict[str, str]]:
        return self.items[self.index] if 0 <= self.index < len(self.items) else None

    def run(self) -> Dict[str, Any]:
        self.view.present("full_screen", orientations=["portrait"])
        self.load_current()
        self.view.wait_modal()
        return self.output()

    def set_progress(self) -> None:
        item = self.current
        if item:
            self.view.progress_label.text = f"{self.index + 1} / {len(self.items)} {item['horseName']}"

    def load_current(self) -> None:
        item = self.current
        if self.done or item is None:
            self.finish()
            return
        self.submitted = False
        self.save_navigation_seen = False
        self.poll_attempt = 0
        self.poll_token += 1
        self.set_progress()
        self.webview.load_url(MEMO_PAGE_URL.format(horse_id=item["horseId"]))

    def handle_load_started(self) -> None:
        if self.submitted:
            self.save_navigation_seen = True

    def schedule_inspection(self, delay: float = POLL_INTERVAL) -> None:
        if self.done:
            return
        token = self.poll_token
        ui.delay(lambda: self.inspect(token), delay)

    def inspect(self, token: int) -> None:
        if self.done or token != self.poll_token or not self.current:
            return
        self.poll_attempt += 1
        state = _parse_json(self.webview.eval_js(PAGE_STATE_JS))
        if not state:
            self.retry_or_fail("MEMO_STATE_UNAVAILABLE", "馬メモ画面の状態を確認できませんでした。")
            return
        if state.get("authState") == "login_required":
            self.view.title_label.text = "netkeibaへログインしてください"
            self.view.progress_label.text = "ログイン後、自動的に同期を再開します。"
            self.schedule_inspection(1.0)
            return
        if state.get("horseId") != self.current["horseId"]:
            self.retry_or_fail("HORSE_ID_MISMATCH", "対象馬と表示ページが一致しません。")
            return
        marker = self.current["memoText"].splitlines()[0]
        current_value = str(state.get("currentValue") or "")
        if marker and marker in current_value:
            if not self.submitted or self.save_navigation_seen or state.get("saveSuccessFound"):
                self.complete_current("synced")
                return
            self.retry_or_fail("MEMO_SAVE_NOT_CONFIRMED", "馬メモの保存完了を確認できませんでした。")
            return
        if not state.get("textareaFound"):
            if state.get("limitMessageFound"):
                self.fail_current("MEMO_LIMIT_OR_LOGIN_REQUIRED", "馬メモの利用条件または登録上限を確認してください。")
            else:
                self.retry_or_fail("MEMO_EDITOR_NOT_FOUND", "馬メモ入力欄が見つかりません。DOM変更の可能性があります。")
            return
        if not self.submitted:
            result = _parse_json(self.webview.eval_js(_append_and_submit_js(self.current["memoText"], marker)))
            if not result or not result.get("ok"):
                self.fail_current(str(result and result.get("type") or "MEMO_SUBMIT_FAILED"), "馬メモを保存する操作要素を確認できませんでした。")
                return
            if result.get("status") == "already_synced":
                self.complete_current("synced")
                return
            self.submitted = True
            self.poll_attempt = 0
        self.schedule_inspection()

    def retry_or_fail(self, error_type: str, message: str) -> None:
        if self.poll_attempt >= MAX_POLL_ATTEMPTS:
            self.fail_current(error_type, message)
        else:
            self.schedule_inspection()

    def complete_current(self, status: str) -> None:
        item = self.current
        if item:
            self.results.append({"syncKey": item["syncKey"], "raceId": item["raceId"], "horseId": item["horseId"], "status": status, "syncedAt": _utc_now(), "error": None})
        self.advance()

    def fail_current(self, error_type: str, message: str) -> None:
        item = self.current
        if item:
            self.results.append({"syncKey": item["syncKey"], "raceId": item["raceId"], "horseId": item["horseId"], "status": "error", "syncedAt": None, "error": {"type": error_type, "message": message}})
        self.advance()

    def advance(self) -> None:
        self.index += 1
        self.poll_token += 1
        if self.index >= len(self.items):
            self.finish()
        else:
            ui.delay(self.load_current, 0.3)

    def finish(self) -> None:
        if self.done:
            return
        self.done = True
        succeeded = sum(1 for item in self.results if item["status"] == "synced")
        self.view.title_label.text = "馬メモ同期が完了しました"
        self.view.progress_label.text = f"成功 {succeeded}頭 / 失敗 {len(self.results) - succeeded}頭"
        ui.delay(self.view.close, 0.8)

    def handle_close(self) -> None:
        if self.done:
            return
        while self.current:
            self.fail_current("USER_CANCELLED", "ユーザー操作により同期を中止しました。")
        self.done = True

    def output(self) -> Dict[str, Any]:
        errors = [item for item in self.results if item["status"] != "synced"]
        return {"action": "syncHorseMemos", "success": not errors and len(self.results) == len(self.items), "date": self.payload["date"], "items": self.results, "errors": errors}


def sync_horse_memos_with_webview(payload: Dict[str, Any]) -> Dict[str, Any]:
    global _RUNNING
    with _RUN_STATE_LOCK:
        if _RUNNING:
            raise MemoClientError("ALREADY_RUNNING", "馬メモ同期はすでに実行中です。")
        _RUNNING = True
    try:
        return MemoSyncController(payload).run()
    finally:
        with _RUN_STATE_LOCK:
            _RUNNING = False
