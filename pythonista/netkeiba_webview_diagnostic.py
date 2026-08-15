"""Pythonista ui.WebViewでnetkeiba認証状態と1レースの印DOMを診断する。

認証情報はコードから送信せず、必要な場合はWebView上でユーザー自身が入力する。
Cookie値・入力内容・ページ本文は取得結果へ含めない。
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

import ui


AUTH_CHECK_URL = "https://regist.sp.netkeiba.com/?rf=navi"
TARGET_RACE_ID = "202604020502"
TARGET_RACE_NAME = "新潟2R"
RACE_URL = (
    "https://race.sp.netkeiba.com/race/shutuba.html"
    f"?race_id={TARGET_RACE_ID}"
)

RACE_POLL_INTERVAL = 0.75
MAX_RACE_POLL_ATTEMPTS = 28
STATE_FILE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    ".netkeiba_webview_diagnostic_state.json",
)


AUTH_STATE_JS = r"""
(function () {
  "use strict";

  function visible(element) {
    if (!element) return false;
    var style = window.getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      rect.width > 0 && rect.height > 0;
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  var inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
  var passwordInputs = inputs.filter(function (element) {
    var name = clean(element.name).toLowerCase();
    return visible(element) &&
      (String(element.type).toLowerCase() === "password" || /pass|pswd/.test(name));
  });
  var loginIdInputs = inputs.filter(function (element) {
    var name = clean(element.name).toLowerCase();
    var type = String(element.type).toLowerCase();
    return visible(element) &&
      (type === "email" || /login|user.?id|mail|email/.test(name));
  });

  var actionElements = Array.prototype.slice.call(
    document.querySelectorAll("button, input[type='submit'], a")
  ).filter(visible);
  var loginButtons = actionElements.filter(function (element) {
    return /ログイン(?:する)?|login/i.test(clean(element.textContent || element.value));
  });
  var loginForms = Array.prototype.slice.call(document.querySelectorAll("form"))
    .filter(function (form) {
      return visible(form) && form.querySelector("input[type='password']") &&
        (form.querySelector("input[type='email']") ||
         Array.prototype.some.call(form.querySelectorAll("input"), function (input) {
           return /login|user.?id|mail|email/i.test(clean(input.name));
         }) ||
         Array.prototype.some.call(form.querySelectorAll("button, input[type='submit']"), function (button) {
           return /ログイン(?:する)?|login/i.test(clean(button.textContent || button.value));
         }));
    });

  var visibleLinksAndButtons = Array.prototype.slice.call(
    document.querySelectorAll("a, button, [role='button']")
  ).filter(visible);
  var logoutSignals = visibleLinksAndButtons.filter(function (element) {
    var text = clean(element.textContent);
    var href = clean(element.getAttribute("href")).toLowerCase();
    return /ログアウト/.test(text) || /(?:pid|action)=logout|\/logout/.test(href);
  });
  var myPageSignals = visibleLinksAndButtons.filter(function (element) {
    var text = clean(element.textContent);
    var href = clean(element.getAttribute("href")).toLowerCase();
    return /マイページ/.test(text) || /mypage|my_page/.test(href);
  });
  var accountSignals = visibleLinksAndButtons.filter(function (element) {
    var text = clean(element.textContent);
    var href = clean(element.getAttribute("href")).toLowerCase();
    return /会員情報|アカウント情報|登録情報/.test(text) ||
      /account|member_info|change_id/.test(href);
  });

  var loginRequired = passwordInputs.length > 0 &&
    (loginIdInputs.length > 0 || loginButtons.length > 0 || loginForms.length > 0);
  var authenticated = logoutSignals.length > 0 &&
    (myPageSignals.length > 0 || accountSignals.length > 0) &&
    passwordInputs.length === 0;
  var authState = authenticated ? "authenticated" :
    (loginRequired ? "login_required" : "unknown");

  var raceMatch = String(location.search || "").match(/[?&]race_id=(\d{12})/);
  return JSON.stringify({
    authState: authState,
    host: String(location.hostname || ""),
    path: String(location.pathname || "/"),
    raceId: raceMatch ? raceMatch[1] : "",
    readyState: String(document.readyState || ""),
    loginSignalCount: passwordInputs.length + loginIdInputs.length +
      loginButtons.length + loginForms.length,
    authenticatedSignalCount: logoutSignals.length + myPageSignals.length +
      accountSignals.length
  });
}())
"""


RACE_DIAGNOSTIC_JS = r"""
(function () {
  "use strict";

  var VALID_MARKS = {"◎": true, "◯": true, "▲": true, "△": true,
    "☆": true, "注": true, "✓": true};
  var HORSE_NAME_SELECTORS = [
    '.HorseInfo a[href*="/horse/"]',
    '.HorseInfo a[href*="horse"]',
    ".HorseInfo .HorseName",
    ".HorseInfo a",
    'a[href*="db.netkeiba.com/horse/"]',
    'a[href*="horse"]',
    ".HorseName",
    '[class*="HorseName"]',
    '[class*="horse_name"]',
    '[class*="Horse_Name"]'
  ];

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeMark(value) {
    var mark = cleanText(value).replace("○", "◯");
    if (mark === "✔") mark = "✓";
    return VALID_MARKS[mark] ? mark : null;
  }

  function extractHorseNumber(row) {
    var umaban = row.querySelector('[class*="Umaban"], .Umaban');
    var fromText = parseInt(cleanText(umaban && umaban.textContent), 10);
    if (isFinite(fromText)) return fromText;

    var classText = Array.prototype.map.call(row.querySelectorAll("*"), function (element) {
      return String(element.className || "");
    }).join(" ");
    var classMatch = classText.match(/(?:^|\s)Umaban(\d+)(?:\s|$)/);
    if (classMatch) return parseInt(classMatch[1], 10);

    for (var number = 1; number <= 40; number += 1) {
      var legacy = row.querySelector(".Waku" + number);
      if (legacy) {
        var legacyText = parseInt(cleanText(legacy.textContent), 10);
        return isFinite(legacyText) ? legacyText : number;
      }
    }
    return null;
  }

  function isHorseNameLike(text) {
    if (!text || text.length < 2 || text.length > 40) return false;
    if (/^[\d０-９\s.,+\-()（）]+$/.test(text)) return false;
    if (/^[☆★◎◯○▲△注✓✔消\-—_→←▶◀●○□■◇◆♘♞]+$/.test(text)) return false;
    if (!/[A-Za-zぁ-んァ-ヶー一-龠々]/.test(text)) return false;
    var compact = text.replace(/\s+/g, "");
    return ["馬情報", "競走馬情報", "詳細", "プロフィール", "お気に入り馬登録",
      "お気に入り", "登録", "編集", "馬メモ", "画像", "写真"].indexOf(compact) < 0;
  }

  function scoreHorseName(text, element, selectorPriority, sourcePriority) {
    var href = String(element.getAttribute("href") || element.href || "").toLowerCase();
    var className = String(element.className || "").toLowerCase();
    var score = selectorPriority * 4 + sourcePriority;
    if (href.indexOf("/horse/") >= 0) score += 100;
    else if (href.indexOf("horse") >= 0) score += 70;
    if (/horsename|horse_name|horse-name/.test(className)) score += 45;
    if (element.closest && element.closest(".HorseInfo")) score += 30;
    if (/^[ァ-ヶー]+$/.test(text.replace(/\s+/g, ""))) score += 24;
    else if (/[ぁ-んァ-ヶー一-龠々A-Za-z]/.test(text)) score += 15;
    if (text.length >= 2 && text.length <= 18) score += 18;
    if (!/\s/.test(text)) score += 8;
    if (/お気に入り|プロフィール|登録|編集|詳細/.test(text)) score -= 80;
    return score;
  }

  function extractHorseName(row) {
    var candidates = [];
    var candidateElements = [];
    var seenElements = [];

    function addElement(element, priority) {
      if (!element || seenElements.indexOf(element) >= 0) return;
      seenElements.push(element);
      candidateElements.push({element: element, priority: priority});
    }

    HORSE_NAME_SELECTORS.forEach(function (selector, index) {
      Array.prototype.forEach.call(row.querySelectorAll(selector), function (element) {
        addElement(element, HORSE_NAME_SELECTORS.length - index);
      });
    });
    Array.prototype.forEach.call(row.querySelectorAll("a"), function (link) {
      if (/horse/i.test(String(link.getAttribute("href") || link.href || ""))) {
        addElement(link, 5);
      }
    });

    candidateElements.forEach(function (candidate) {
      var element = candidate.element;
      var sources = [
        {value: element.textContent, priority: 25},
        {value: element.getAttribute("aria-label"), priority: 18},
        {value: element.getAttribute("title"), priority: 16},
        {value: element.getAttribute("data-horse-name") || element.getAttribute("data-name"), priority: 15}
      ];
      Array.prototype.forEach.call(element.querySelectorAll("img[alt], span, strong, b"), function (child) {
        sources.push({value: child.textContent || child.getAttribute("alt"), priority: 30});
      });
      sources.forEach(function (source) {
        var text = cleanText(source.value)
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/のデータベース$/, "").trim();
        if (!isHorseNameLike(text)) return;
        candidates.push({
          text: text,
          score: scoreHorseName(text, element, candidate.priority, source.priority)
        });
      });
    });

    candidates.sort(function (a, b) {
      return b.score - a.score || a.text.length - b.text.length;
    });
    return candidates.length ? candidates[0].text : "";
  }

  function extractMark(row) {
    var element = row.querySelector(
      ".selectBox.expanded, .selectBox, .Horse_Select select, select[name*='mark']"
    );
    if (!element) return null;
    var rawValue = element.textContent;
    if (String(element.tagName).toUpperCase() === "SELECT") {
      var selected = element.options && element.selectedIndex >= 0 ?
        element.options[element.selectedIndex] : null;
      rawValue = cleanText(selected && selected.textContent) || element.value;
    }
    return normalizeMark(rawValue);
  }

  try {
    var rows = Array.prototype.slice.call(document.querySelectorAll(".HorseList"))
      .filter(function (row) {
        return row.querySelector(".HorseInfo, [class*='Umaban'], .Horse_Select");
      });
    var numberCount = 0;
    var nameCount = 0;
    var markControlCount = 0;
    var markedNumbers = [];

    rows.forEach(function (row) {
      var number = extractHorseNumber(row);
      var name = extractHorseName(row);
      var control = row.querySelector(
        ".selectBox.expanded, .selectBox, .Horse_Select select, select[name*='mark']"
      );
      var mark = extractMark(row);
      if (typeof number === "number" && isFinite(number)) numberCount += 1;
      if (name) nameCount += 1;
      if (control) markControlCount += 1;
      if (mark && typeof number === "number" && isFinite(number)) markedNumbers.push(number);
    });
    markedNumbers = markedNumbers.filter(function (number, index, values) {
      return values.indexOf(number) === index;
    }).sort(function (a, b) { return a - b; });

    return JSON.stringify({
      ok: true,
      horseRowCount: rows.length,
      horseNumberCount: numberCount,
      horseNameCount: nameCount,
      markControlCount: markControlCount,
      markedHorseCount: markedNumbers.length,
      matchedHorseNumbers: markedNumbers
    });
  } catch (error) {
    return JSON.stringify({ok: false});
  }
}())
"""


def new_result() -> Dict[str, Any]:
    return {
        "webViewLoaded": False,
        "authState": "unknown",
        "loginStateDetected": False,
        "loginUiShown": False,
        "sessionPersisted": None,
        "persistenceCheck": "first_run",
        "raceLoaded": False,
        "horseRowCount": 0,
        "horseNumberCount": 0,
        "horseNameCount": 0,
        "markControlCount": 0,
        "markedHorseCount": 0,
        "matchedHorseNumbers": [],
    }


def parse_javascript_json(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    parsed: Any = json.loads(str(value))
    if isinstance(parsed, str):
        parsed = json.loads(parsed)
    return parsed if isinstance(parsed, dict) else None


def load_persistence_marker() -> Dict[str, Any]:
    try:
        with open(STATE_FILE_PATH, "r", encoding="utf-8") as file:
            value = json.load(file)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def save_persistence_marker() -> None:
    # 認証情報やCookieは保存しない。再起動を識別する非機密状態だけを保存する。
    value = {
        "authenticatedObserved": True,
        "processId": os.getpid(),
    }
    try:
        with open(STATE_FILE_PATH, "w", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        pass


class DiagnosticRootView(ui.View):
    def __init__(self, controller: "WebViewDiagnosticController") -> None:
        super().__init__()
        self.controller = controller
        self.name = "netkeiba WebView診断"
        self.background_color = "white"

        self.status_label = ui.Label()
        self.status_label.background_color = "#F4F6FA"
        self.status_label.text_color = "#222222"
        self.status_label.font = ("<system>", 13)
        self.status_label.number_of_lines = 2
        self.status_label.alignment = ui.ALIGN_CENTER
        self.add_subview(self.status_label)

        self.webview = ui.WebView()
        self.webview.scales_page_to_fit = True
        self.webview.delegate = WebViewDelegate(controller)
        self.add_subview(self.webview)

        self.retry_button = ui.Button(title="認証状態を再確認")
        self.retry_button.background_color = "#093494"
        self.retry_button.tint_color = "white"
        self.retry_button.font = ("<system-bold>", 15)
        self.retry_button.action = controller.retry_auth_check
        self.add_subview(self.retry_button)

    def layout(self) -> None:
        status_height = 58
        button_height = 46
        self.status_label.frame = (0, 0, self.width, status_height)
        self.retry_button.frame = (
            12,
            self.height - button_height - 8,
            self.width - 24,
            button_height,
        )
        self.webview.frame = (
            0,
            status_height,
            self.width,
            max(0, self.height - status_height - button_height - 16),
        )

    def will_close(self) -> None:
        self.controller.handle_view_closed()


class WebViewDelegate:
    def __init__(self, controller: "WebViewDiagnosticController") -> None:
        self.controller = controller

    def webview_should_start_load(self, webview: ui.WebView, url: str, nav_type: int) -> bool:
        return True

    def webview_did_start_load(self, webview: ui.WebView) -> None:
        self.controller.handle_load_started()

    def webview_did_finish_load(self, webview: ui.WebView) -> None:
        self.controller.handle_load_finished()

    def webview_did_fail_load(
        self, webview: ui.WebView, error_code: int, error_message: str
    ) -> None:
        self.controller.handle_load_failed(error_code)


class WebViewDiagnosticController:
    def __init__(self) -> None:
        self.result = new_result()
        self.previous_marker = load_persistence_marker()
        self.persistence_evaluated = False
        self.done = False
        self.mode = "checking_auth"
        self.auth_poll_scheduled = False
        self.race_poll_token = 0
        self.race_poll_attempt = 0
        self.root = DiagnosticRootView(self)
        self.webview = self.root.webview
        self.set_status("認証状態を確認しています…")

    def set_status(self, message: str) -> None:
        try:
            self.root.status_label.text = message
        except Exception:
            pass

    def present(self) -> None:
        self.root.present(
            "full_screen",
            orientations=["portrait"],
        )
        self.webview.load_url(AUTH_CHECK_URL)

    def evaluate_json(self, javascript: str) -> Optional[Dict[str, Any]]:
        try:
            return parse_javascript_json(self.webview.eval_js(javascript))
        except Exception:
            return None

    def handle_load_started(self) -> None:
        if self.done:
            return
        if self.mode == "loading_race":
            self.set_status(f"{TARGET_RACE_NAME}を読み込んでいます…")

    def handle_load_finished(self) -> None:
        if self.done:
            return
        self.result["webViewLoaded"] = True
        ui.delay(self.inspect_current_page, 0.15)

    def handle_load_failed(self, error_code: int) -> None:
        if self.done or int(error_code) == -999:
            return
        self.set_status("ページ読み込みに失敗しました。再確認をタップしてください。")

    def inspect_current_page(self) -> None:
        if self.done:
            return
        try:
            info = self.evaluate_json(AUTH_STATE_JS)
            if not info:
                self.set_status("ページ状態を確認できません。再確認をタップしてください。")
                return

            if (
                info.get("host") == "race.sp.netkeiba.com"
                and info.get("raceId") == TARGET_RACE_ID
            ):
                self.start_race_polling()
                return
            self.handle_auth_state(str(info.get("authState") or "unknown"))
        except Exception:
            self.finish()

    def evaluate_persistence(self, initial_auth_state: str) -> None:
        if self.persistence_evaluated:
            return
        self.persistence_evaluated = True

        previously_authenticated = bool(
            self.previous_marker.get("authenticatedObserved")
        )
        previous_process_id = self.previous_marker.get("processId")
        current_process_id = os.getpid()
        if not previously_authenticated:
            self.result["persistenceCheck"] = "first_run"
            return

        process_changed = previous_process_id != current_process_id
        if initial_auth_state == "login_required":
            self.result["sessionPersisted"] = False
            self.result["persistenceCheck"] = (
                "not_persisted_after_restart" if process_changed
                else "not_shared_with_new_webview"
            )
        elif initial_auth_state == "authenticated" and process_changed:
            self.result["sessionPersisted"] = True
            self.result["persistenceCheck"] = "confirmed_after_restart"
        elif initial_auth_state == "authenticated":
            self.result["persistenceCheck"] = "restart_required"
        else:
            self.result["persistenceCheck"] = (
                "inconclusive_after_restart" if process_changed else "restart_required"
            )

    def handle_auth_state(self, auth_state: str) -> None:
        if self.done or self.mode in {"loading_race", "polling_race"}:
            return
        if auth_state not in {"authenticated", "login_required", "unknown"}:
            auth_state = "unknown"

        self.evaluate_persistence(auth_state)
        self.result["authState"] = auth_state
        self.result["loginStateDetected"] = auth_state != "unknown"

        if auth_state == "authenticated":
            save_persistence_marker()
            self.set_status("ログイン済みを確認しました。診断レースへ進みます。")
            self.load_target_race()
            return

        self.mode = "waiting_login"
        if auth_state == "login_required":
            self.result["loginUiShown"] = True
            self.set_status("未ログインです。下の画面から通常どおりログインしてください。")
        else:
            self.set_status(
                "認証状態を安全に判定できません。ログイン画面なら手動ログイン後、再確認してください。"
            )
        self.schedule_auth_poll()

    def schedule_auth_poll(self) -> None:
        if self.done or self.auth_poll_scheduled:
            return
        self.auth_poll_scheduled = True

        def poll() -> None:
            self.auth_poll_scheduled = False
            if self.done or self.mode != "waiting_login":
                return
            self.inspect_current_page()
            if not self.done and self.mode == "waiting_login":
                self.schedule_auth_poll()

        ui.delay(poll, 1.0)

    def retry_auth_check(self, sender: Any) -> None:
        if self.done:
            return
        try:
            if self.mode in {"loading_race", "polling_race"}:
                self.webview.reload()
            else:
                self.inspect_current_page()
        except Exception:
            self.finish()

    def load_target_race(self) -> None:
        if self.done:
            return
        self.mode = "loading_race"
        self.auth_poll_scheduled = False
        self.race_poll_token += 1
        self.race_poll_attempt = 0
        try:
            # 認証Cookieは読まない。表示モード用の既知Cookieだけを設定する。
            self.webview.eval_js(
                "document.cookie='mark_mode=mark; path=/; max-age=31536000; "
                "domain=.netkeiba.com'; 'ok';"
            )
            self.webview.load_url(RACE_URL)
        except Exception:
            self.finish()

    def start_race_polling(self) -> None:
        if self.done:
            return
        if self.mode != "polling_race":
            self.mode = "polling_race"
            self.race_poll_token += 1
            self.race_poll_attempt = 0
        token = self.race_poll_token
        self.set_status(f"{TARGET_RACE_NAME}の馬番・馬名・印DOMを確認しています…")
        ui.delay(lambda: self.poll_race(token), 0.45)

    def poll_race(self, token: int) -> None:
        if self.done or self.mode != "polling_race" or token != self.race_poll_token:
            return
        self.race_poll_attempt += 1
        try:
            data = self.evaluate_json(RACE_DIAGNOSTIC_JS)
            if data and data.get("ok"):
                row_count = int(data.get("horseRowCount") or 0)
                self.result["horseRowCount"] = row_count
                self.result["horseNumberCount"] = int(data.get("horseNumberCount") or 0)
                self.result["horseNameCount"] = int(data.get("horseNameCount") or 0)
                self.result["markControlCount"] = int(data.get("markControlCount") or 0)
                self.result["markedHorseCount"] = int(data.get("markedHorseCount") or 0)
                numbers = data.get("matchedHorseNumbers") or []
                self.result["matchedHorseNumbers"] = sorted({
                    int(number)
                    for number in numbers
                    if isinstance(number, (int, float)) and 1 <= int(number) <= 18
                })
                self.result["raceLoaded"] = row_count > 0

                if self.result["markedHorseCount"] > 0:
                    self.finish()
                    return

            if self.race_poll_attempt >= MAX_RACE_POLL_ATTEMPTS:
                self.finish()
                return
            ui.delay(lambda: self.poll_race(token), RACE_POLL_INTERVAL)
        except Exception:
            self.finish()

    def finish(self) -> None:
        if self.done:
            return
        self.done = True
        self.mode = "done"
        if self.result["markedHorseCount"] > 0:
            self.set_status("診断が完了しました。結果JSONを表示します。")
        else:
            self.set_status("診断を終了します。結果JSONを確認してください。")
        try:
            ui.delay(self.root.close, 0.5)
        except Exception:
            pass

    def handle_view_closed(self) -> None:
        if not self.done:
            self.done = True
            self.mode = "done"


def main() -> None:
    result = new_result()
    try:
        controller = WebViewDiagnosticController()
        controller.present()
        controller.root.wait_modal()
        result = controller.result
    except Exception:
        pass
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
