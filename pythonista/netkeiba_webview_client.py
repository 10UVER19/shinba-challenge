"""認証済みui.WebViewで選択レースを巡回し、出馬表DOMを抽出する。"""

from __future__ import annotations

import json
import re
import threading
from typing import Any, Dict, List, Optional

try:
    import ui
except ImportError:  # PC上の構文・単体テスト用
    ui = None


AUTH_CHECK_URL = "https://regist.sp.netkeiba.com/?rf=navi"
RACE_POLL_INTERVAL = 0.75
MAX_RACE_POLL_ATTEMPTS = 28
VALID_MARKS = {"◎", "◯", "▲", "△", "☆", "注", "✓"}

_RUN_STATE_LOCK = threading.Lock()
_RUNNING = False


class WebViewClientError(Exception):
    def __init__(self, error_type: str, message: str):
        super().__init__(message)
        self.type = error_type


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

  var visibleActions = Array.prototype.slice.call(
    document.querySelectorAll("a, button, [role='button']")
  ).filter(visible);
  var logoutSignals = visibleActions.filter(function (element) {
    var text = clean(element.textContent);
    var href = clean(element.getAttribute("href")).toLowerCase();
    return /ログアウト/.test(text) || /(?:pid|action)=logout|\/logout/.test(href);
  });
  var myPageSignals = visibleActions.filter(function (element) {
    var text = clean(element.textContent);
    var href = clean(element.getAttribute("href")).toLowerCase();
    return /マイページ/.test(text) || /mypage|my_page/.test(href);
  });
  var accountSignals = visibleActions.filter(function (element) {
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
    raceId: raceMatch ? raceMatch[1] : ""
  });
}())
"""


RACE_EXPORT_JS = r"""
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
  var RACE_TIME_SELECTORS = [".Race_Data", ".RaceData01", ".Race_Data01", ".RaceList_NameBox"];
  var RACE_NUMBER_SELECTORS = [".RaceNum", ".Race_Num", ".RaceList_Num"];
  var VENUE_SELECTORS = [".RaceKaisaiWrap .Active a", ".RaceKaisaiWrap .Active", ".RaceList_Data .Active"];
  var JRA_VENUES = {"01": "札幌", "02": "函館", "03": "福島", "04": "新潟",
    "05": "東京", "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉"};

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function firstText(root, selectors) {
    for (var index = 0; index < selectors.length; index += 1) {
      var element = root.querySelector(selectors[index]);
      var text = cleanText(element && element.textContent);
      if (text) return text;
    }
    return "";
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
    var seenTexts = {};

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
      if (/horse/i.test(String(link.getAttribute("href") || link.href || ""))) addElement(link, 5);
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
        var text = cleanText(source.value).replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/のデータベース$/, "").trim();
        if (!isHorseNameLike(text) || seenTexts[text]) return;
        seenTexts[text] = true;
        candidates.push({text: text, score: scoreHorseName(text, element, candidate.priority, source.priority)});
      });
    });
    candidates.sort(function (a, b) { return b.score - a.score || a.text.length - b.text.length; });
    return candidates.length ? candidates[0].text : "";
  }

  function extractHorseId(row) {
    var links = Array.prototype.slice.call(row.querySelectorAll("a[href]"));
    for (var index = 0; index < links.length; index += 1) {
      var href = String(links[index].getAttribute("href") || links[index].href || "");
      if (!/horse/i.test(href)) continue;
      var pathMatch = href.match(/\/horse\/(?:result\/)?(\d{6,})(?:[/?#]|$)/i);
      if (pathMatch) return pathMatch[1];
      var queryMatch = href.match(/[?&](?:horse_id|horseid)=(\d{6,})(?:&|$)/i);
      if (queryMatch) return queryMatch[1];
    }
    return null;
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

  function extractRaceTime(root) {
    for (var index = 0; index < RACE_TIME_SELECTORS.length; index += 1) {
      var text = firstText(root, [RACE_TIME_SELECTORS[index]]);
      var match = text.match(/(?:^|\D)(\d{1,2}):(\d{2})(?:\D|$)/);
      if (match) return ("0" + match[1]).slice(-2) + ":" + match[2];
    }
    return "";
  }

  function extractRaceName(root, raceId) {
    var direct = ["[data-race-name]", ".RaceTitle", ".Race_Name"];
    for (var index = 0; index < direct.length; index += 1) {
      var text = firstText(root, [direct[index]]);
      var match = text.match(/(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\s*(\d{1,2})R/i);
      if (match) return match[1] + Number(match[2]) + "R";
    }
    var venueText = firstText(root, VENUE_SELECTORS);
    var venueMatch = venueText.match(/札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉/);
    var numberText = firstText(root, RACE_NUMBER_SELECTORS);
    var numberMatch = numberText.match(/(\d{1,2})R/i);
    if (venueMatch && numberMatch) return venueMatch[0] + Number(numberMatch[1]) + "R";
    if (/^\d{12}$/.test(raceId)) {
      var venue = JRA_VENUES[raceId.slice(4, 6)];
      var raceNumber = Number(raceId.slice(-2));
      if (venue && raceNumber) return venue + raceNumber + "R";
    }
    return "";
  }

  try {
    var raceMatch = String(location.search || "").match(/[?&]race_id=(\d{12})/);
    var raceId = raceMatch ? raceMatch[1] : "";
    var rows = Array.prototype.slice.call(document.querySelectorAll(".HorseList"))
      .filter(function (row) {
        return row.querySelector(".HorseInfo, [class*='Umaban'], .Horse_Select");
      });
    var numberCount = 0;
    var nameCount = 0;
    var markControlCount = 0;
    var horses = [];

    rows.forEach(function (row) {
      var number = extractHorseNumber(row);
      var name = extractHorseName(row);
      var horseId = extractHorseId(row);
      var control = row.querySelector(
        ".selectBox.expanded, .selectBox, .Horse_Select select, select[name*='mark']"
      );
      var mark = extractMark(row);
      if (typeof number === "number" && isFinite(number)) numberCount += 1;
      if (name) nameCount += 1;
      if (control) markControlCount += 1;
      if (mark && typeof number === "number" && isFinite(number) && name) {
        horses.push({horseId: horseId, number: number, name: name, mark: mark});
      }
    });

    return JSON.stringify({
      ok: true,
      raceId: raceId,
      raceName: extractRaceName(document, raceId),
      raceTime: extractRaceTime(document),
      horseRowCount: rows.length,
      horseNumberCount: numberCount,
      horseNameCount: nameCount,
      markControlCount: markControlCount,
      horses: horses
    });
  } catch (error) {
    return JSON.stringify({ok: false});
  }
}())
"""


def _parse_javascript_json(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    parsed: Any = json.loads(str(value))
    if isinstance(parsed, str):
        parsed = json.loads(parsed)
    return parsed if isinstance(parsed, dict) else None


def _race_error(race: Dict[str, str], error_type: str, message: str) -> Dict[str, Any]:
    return {
        "raceId": race["raceId"],
        "raceName": race["raceName"],
        "error": {"type": error_type, "message": message},
    }


_UI_VIEW_BASE = ui.View if ui is not None else object


class RaceCollectorView(_UI_VIEW_BASE):
    def __init__(self, controller: "WebViewRaceCollector") -> None:
        if ui is None:
            raise WebViewClientError("WEBVIEW_UNAVAILABLE", "Pythonistaのui.WebViewを利用できません。")
        super().__init__()
        self.controller = controller
        self.name = "新馬戦チャレンジ"
        self.background_color = "white"

        self.title_label = ui.Label()
        self.title_label.text = "出馬表を取得しています"
        self.title_label.font = ("<system-bold>", 16)
        self.title_label.alignment = ui.ALIGN_CENTER
        self.title_label.background_color = "#F4F6FA"
        self.title_label.text_color = "#093494"
        self.add_subview(self.title_label)

        self.progress_label = ui.Label()
        self.progress_label.font = ("<system>", 14)
        self.progress_label.alignment = ui.ALIGN_CENTER
        self.progress_label.background_color = "#F4F6FA"
        self.progress_label.text_color = "#222222"
        self.add_subview(self.progress_label)

        self.webview = ui.WebView()
        self.webview.scales_page_to_fit = True
        self.webview_delegate = RaceCollectorDelegate(controller)
        self.webview.delegate = self.webview_delegate
        self.add_subview(self.webview)

        self.retry_button = ui.Button(title="認証状態を再確認")
        self.retry_button.background_color = "#093494"
        self.retry_button.tint_color = "white"
        self.retry_button.font = ("<system-bold>", 15)
        self.retry_button.action = controller.retry_auth_check
        self.retry_button.hidden = True
        self.add_subview(self.retry_button)

    def layout(self) -> None:
        title_height = 34
        progress_height = 32
        button_space = 58 if not self.retry_button.hidden else 0
        self.title_label.frame = (0, 0, self.width, title_height)
        self.progress_label.frame = (0, title_height, self.width, progress_height)
        self.webview.frame = (
            0,
            title_height + progress_height,
            self.width,
            max(0, self.height - title_height - progress_height - button_space),
        )
        self.retry_button.frame = (12, self.height - 52, self.width - 24, 44)

    def will_close(self) -> None:
        self.controller.handle_view_closed()


class RaceCollectorDelegate:
    def __init__(self, controller: "WebViewRaceCollector") -> None:
        self.controller = controller

    def webview_should_start_load(self, webview: Any, url: str, nav_type: int) -> bool:
        return True

    def webview_did_start_load(self, webview: Any) -> None:
        self.controller.handle_load_started()

    def webview_did_finish_load(self, webview: Any) -> None:
        self.controller.handle_load_finished()

    def webview_did_fail_load(
        self, webview: Any, error_code: int, error_message: str
    ) -> None:
        self.controller.handle_load_failed(error_code)


class WebViewRaceCollector:
    def __init__(self, payload: Dict[str, Any]) -> None:
        if ui is None:
            raise WebViewClientError("WEBVIEW_UNAVAILABLE", "Pythonistaのui.WebViewを利用できません。")
        self.payload = payload
        self.selected: List[Dict[str, str]] = payload["selectedRaces"]
        self.races: List[Dict[str, Any]] = []
        self.errors: List[Dict[str, Any]] = []
        self.current_index = 0
        self.done = False
        self.mode = "checking_auth"
        self.auth_poll_scheduled = False
        self.race_poll_token = 0
        self.race_poll_attempt = 0
        self.last_dom_result: Optional[Dict[str, Any]] = None
        self.view = RaceCollectorView(self)
        self.webview = self.view.webview

    @property
    def current_race(self) -> Optional[Dict[str, str]]:
        if 0 <= self.current_index < len(self.selected):
            return self.selected[self.current_index]
        return None

    def run(self) -> Dict[str, Any]:
        self.view.progress_label.text = "認証状態を確認しています…"
        self.view.present("full_screen", orientations=["portrait"])
        self.webview.load_url(AUTH_CHECK_URL)
        self.view.wait_modal()
        return self.build_output()

    def evaluate_json(self, javascript: str) -> Optional[Dict[str, Any]]:
        try:
            return _parse_javascript_json(self.webview.eval_js(javascript))
        except Exception:
            return None

    def set_retry_visible(self, visible: bool) -> None:
        self.view.retry_button.hidden = not visible
        self.view.layout()

    def set_progress(self, message: str) -> None:
        self.view.progress_label.text = message

    def handle_load_started(self) -> None:
        if self.done:
            return
        race = self.current_race
        if race and self.mode == "loading_race":
            self.set_progress(
                f"{self.current_index + 1} / {len(self.selected)} {race['raceName']}"
            )

    def handle_load_finished(self) -> None:
        if not self.done:
            ui.delay(self.inspect_current_page, 0.15)

    def handle_load_failed(self, error_code: int) -> None:
        if self.done or int(error_code) == -999:
            return
        if self.mode in {"loading_race", "polling_race"} and self.current_race:
            self.fail_current("WEBVIEW_LOAD_FAILED", "出馬表ページの読み込みに失敗しました。")
        else:
            self.mode = "waiting_login"
            self.set_retry_visible(True)
            self.set_progress("認証ページを読み込めません。再確認してください。")

    def inspect_current_page(self) -> None:
        if self.done:
            return
        try:
            info = self.evaluate_json(AUTH_STATE_JS)
            if not info:
                self.mode = "waiting_login"
                self.set_retry_visible(True)
                self.set_progress("ページ状態を確認できません。再確認してください。")
                return
            current = self.current_race
            if (
                current
                and info.get("host") in {"race.sp.netkeiba.com", "race.netkeiba.com"}
                and info.get("raceId") == current["raceId"]
            ):
                self.start_race_polling()
                return
            self.handle_auth_state(str(info.get("authState") or "unknown"))
        except Exception:
            self.finish_with_remaining_error(
                "WEBVIEW_STATE_ERROR", "WebViewのページ状態を確認できませんでした。"
            )

    def handle_auth_state(self, auth_state: str) -> None:
        if self.done:
            return
        if auth_state == "authenticated":
            if self.mode in {"loading_race", "polling_race"}:
                return
            self.set_retry_visible(False)
            self.load_current_race()
            return

        self.mode = "waiting_login"
        self.set_retry_visible(True)
        if auth_state == "login_required":
            self.view.title_label.text = "netkeibaへログインしてください"
            self.set_progress("ログイン後、自動的に出馬表取得へ進みます。")
        else:
            self.view.title_label.text = "認証状態を確認してください"
            self.set_progress("ログイン画面なら手動ログイン後、再確認してください。")
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
            self.inspect_current_page()
        except Exception:
            self.finish_with_remaining_error(
                "WEBVIEW_STATE_ERROR", "認証状態を再確認できませんでした。"
            )

    def load_current_race(self) -> None:
        if self.done:
            return
        race = self.current_race
        if race is None:
            self.finish()
            return

        self.mode = "loading_race"
        self.auth_poll_scheduled = False
        self.race_poll_token += 1
        self.race_poll_attempt = 0
        self.last_dom_result = None
        self.view.title_label.text = "出馬表を取得しています"
        self.set_progress(
            f"{self.current_index + 1} / {len(self.selected)} {race['raceName']}"
        )
        try:
            # 認証Cookieは読まない。印表示モード用の既知Cookieだけを設定する。
            self.webview.eval_js(
                "document.cookie='mark_mode=mark; path=/; max-age=31536000; "
                "domain=.netkeiba.com'; 'ok';"
            )
            self.webview.load_url(race["raceUrl"])
        except Exception:
            self.fail_current("WEBVIEW_LOAD_FAILED", "出馬表ページを開けませんでした。")

    def start_race_polling(self) -> None:
        if self.done:
            return
        if self.mode == "polling_race":
            return
        self.mode = "polling_race"
        self.race_poll_token += 1
        self.race_poll_attempt = 0
        token = self.race_poll_token
        ui.delay(lambda: self.poll_current_race(token), 0.45)

    def poll_current_race(self, token: int) -> None:
        if self.done or self.mode != "polling_race" or token != self.race_poll_token:
            return
        self.race_poll_attempt += 1
        data = self.evaluate_json(RACE_EXPORT_JS)
        if data and data.get("ok"):
            self.last_dom_result = data
            row_count = int(data.get("horseRowCount") or 0)
            controls_ready = int(data.get("markControlCount") or 0) >= row_count > 0
            rows_ready = (
                int(data.get("horseNumberCount") or 0) == row_count
                and int(data.get("horseNameCount") or 0) == row_count
            )
            if controls_ready and rows_ready and data.get("horses"):
                self.complete_current(data)
                return

        if self.race_poll_attempt >= MAX_RACE_POLL_ATTEMPTS:
            self.fail_current_from_timeout(self.last_dom_result)
            return
        ui.delay(lambda: self.poll_current_race(token), RACE_POLL_INTERVAL)

    def fail_current_from_timeout(self, data: Optional[Dict[str, Any]]) -> None:
        row_count = int(data.get("horseRowCount") or 0) if data else 0
        if row_count == 0:
            self.fail_current("HORSE_ROWS_NOT_FOUND", "制限時間内に.HorseListを取得できませんでした。")
        elif int(data.get("horseNumberCount") or 0) < row_count:
            self.fail_current("HORSE_NUMBER_NOT_FOUND", "一部の馬番を取得できませんでした。")
        elif int(data.get("horseNameCount") or 0) < row_count:
            self.fail_current("HORSE_NAME_NOT_FOUND", "一部の馬名を取得できませんでした。")
        elif int(data.get("markControlCount") or 0) < row_count:
            self.fail_current("MARK_CONTROLS_NOT_READY", "印入力DOMの準備が完了しませんでした。")
        else:
            self.fail_current("NO_VALID_MARKS", "有効な印が1頭も設定されていません。")

    def complete_current(self, data: Dict[str, Any]) -> None:
        race = self.current_race
        if race is None:
            self.finish()
            return
        if str(data.get("raceId") or "") != race["raceId"]:
            self.fail_current("RACE_ID_MISMATCH", "読み込んだ出馬表のraceIdが選択内容と一致しません。")
            return

        race_name = str(data.get("raceName") or "").strip()
        race_time = str(data.get("raceTime") or "").strip()
        if not race_name:
            self.fail_current("RACE_NAME_NOT_FOUND", "競馬場名とR番号を取得できませんでした。")
            return
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", race_time):
            self.fail_current("RACE_TIME_NOT_FOUND", "発走時刻を取得できませんでした。")
            return
        if race_name != race["raceName"]:
            self.fail_current("RACE_NAME_MISMATCH", "読み込んだレース名が選択内容と一致しません。")
            return

        horses: List[Dict[str, Any]] = []
        for source in data.get("horses") or []:
            if not isinstance(source, dict):
                continue
            mark = str(source.get("mark") or "").strip().replace("○", "◯")
            number = source.get("number")
            name = str(source.get("name") or "").strip()
            horse_id = str(source.get("horseId") or "").strip() or None
            if mark == "消" or mark not in VALID_MARKS:
                continue
            if not isinstance(number, (int, float)) or int(number) != number:
                self.fail_current("INVALID_HORSE_NUMBER", "取得した馬番が正しくありません。")
                return
            if not name:
                self.fail_current("HORSE_NAME_NOT_FOUND", f"馬番{int(number)}の馬名を取得できませんでした。")
                return
            horses.append({"horseId": horse_id, "number": int(number), "name": name, "mark": mark})

        if not horses:
            self.fail_current("NO_VALID_MARKS", "有効な印が1頭も設定されていません。")
            return
        if sum(1 for horse in horses if horse["mark"] == "◎") > 1:
            self.fail_current("DUPLICATE_HONMEI", "◎が2頭以上設定されています。")
            return

        self.races.append({
            "raceName": race_name,
            "raceTime": race_time,
            "raceId": race["raceId"],
            "raceUrl": race.get("raceUrl", ""),
            "raceLabel": race.get("raceLabel", ""),
            "horses": horses,
            "rating": {"expectation": 0, "level": 0, "value": 0},
        })
        self.advance_to_next_race()

    def fail_current(self, error_type: str, message: str) -> None:
        race = self.current_race
        if race is not None:
            self.errors.append(_race_error(race, error_type, message))
        self.advance_to_next_race()

    def advance_to_next_race(self) -> None:
        if self.done:
            return
        self.current_index += 1
        self.race_poll_token += 1
        self.race_poll_attempt = 0
        self.last_dom_result = None
        if self.current_index >= len(self.selected):
            self.finish()
        else:
            ui.delay(self.load_current_race, 0.3)

    def finish_with_remaining_error(self, error_type: str, message: str) -> None:
        for race in self.selected[self.current_index:]:
            self.errors.append(_race_error(race, error_type, message))
        self.current_index = len(self.selected)
        self.finish()

    def finish(self) -> None:
        if self.done:
            return
        self.done = True
        self.mode = "done"
        self.set_retry_visible(False)
        self.view.title_label.text = "取得が完了しました"
        self.set_progress(f"成功 {len(self.races)}件 / 失敗 {len(self.errors)}件")
        ui.delay(self.view.close, 0.6)

    def handle_view_closed(self) -> None:
        if self.done:
            return
        error_type = (
            "AUTHENTICATION_NOT_CONFIRMED"
            if self.mode == "waiting_login"
            else "USER_CANCELLED"
        )
        message = (
            "netkeibaの認証状態を確認できませんでした。"
            if error_type == "AUTHENTICATION_NOT_CONFIRMED"
            else "ユーザー操作により取得を中止しました。"
        )
        for race in self.selected[self.current_index:]:
            self.errors.append(_race_error(race, error_type, message))
        self.current_index = len(self.selected)
        self.done = True
        self.mode = "done"

    def build_output(self) -> Dict[str, Any]:
        self.races.sort(key=lambda race: (race["raceTime"], race["raceId"]))
        return {
            "success": not self.errors and len(self.races) == len(self.selected),
            "date": self.payload["date"],
            "races": self.races,
            "errors": self.errors,
        }


def collect_races_with_webview(payload: Dict[str, Any]) -> Dict[str, Any]:
    global _RUNNING
    with _RUN_STATE_LOCK:
        if _RUNNING:
            raise WebViewClientError("ALREADY_RUNNING", "出馬表取得はすでに実行中です。")
        _RUNNING = True
    try:
        return WebViewRaceCollector(payload).run()
    finally:
        with _RUN_STATE_LOCK:
            _RUNNING = False
