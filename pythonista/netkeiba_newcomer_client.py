"""Pythonista WebViewで当日開催中の全開催場から新馬戦一覧を取得する。"""

from __future__ import annotations

import json
import threading
from typing import Any, Dict, List, Optional

try:
    import ui
except ImportError:  # PC上の構文・単体テスト用
    ui = None


NEWCOMER_LIST_START_URL = "https://race.sp.netkeiba.com/?rf=navi"
PAGE_POLL_INTERVAL = 0.75
MAX_PAGE_POLL_ATTEMPTS = 28

_RUN_STATE_LOCK = threading.Lock()
_RUNNING = False


class NewcomerListClientError(Exception):
    def __init__(self, error_type: str, message: str):
        super().__init__(message)
        self.type = error_type


NEWCOMER_PAGE_EXPORT_JS = r"""
(function () {
  "use strict";

  var JRA_VENUES = {"01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京",
    "06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉"};
  var VENUE_CODES = {};
  Object.keys(JRA_VENUES).forEach(function (code) { VENUE_CODES[JRA_VENUES[code]] = code; });
  var ROW_SELECTORS = [
    ".RaceList_SlideBoxItem .RaceList > li",
    ".RaceList > li",
    ".RaceListMainArea",
    ".RaceList_DataItem",
    ".RaceList_Item"
  ];

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function rendered(element) {
    if (!element || element.hidden) return false;
    var current = element;
    while (current && current.nodeType === 1) {
      var style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
      current = current.parentElement;
    }
    return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
  }

  function raceLink(row) {
    var links = Array.prototype.slice.call(row.querySelectorAll("a"));
    return links.find(function (link) {
      return /race_id(?:=|%3D)\d{12}/i.test(link.getAttribute("href") || link.href || "");
    }) || null;
  }

  function raceIdFrom(row) {
    var link = raceLink(row);
    var href = link ? (link.getAttribute("href") || link.href || "") : "";
    var match = href.match(/race_id(?:=|%3D)(\d{12})/i);
    return match ? match[1] : "";
  }

  function venueUrl(code) {
    var url = new URL(location.href);
    url.searchParams.set("jyo_cd", code);
    url.hash = "";
    return url.href;
  }

  function venues() {
    var result = [];
    var seen = {};
    var items = document.querySelectorAll(".jyo_tab li, .jyo_tab [data-jyo_cd], .jyo_tab [data-jyo-cd]");
    Array.prototype.forEach.call(items, function (item) {
      var text = clean(item.textContent);
      var nameMatch = text.match(/札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉/);
      var name = nameMatch ? nameMatch[0] : "";
      var link = item.querySelector("a");
      var href = (link && link.getAttribute("href")) || item.getAttribute("href") || "";
      var idMatch = String(item.id || "").match(/cd(\d{1,2})/i);
      var hrefMatch = href.match(/[?&]jyo_cd=(\d{1,2})/i);
      var raw = item.getAttribute("data-jyo_cd") || item.getAttribute("data-jyo-cd") ||
        (idMatch && idMatch[1]) || (hrefMatch && hrefMatch[1]) || VENUE_CODES[name] || "";
      var code = /^\d{1,2}$/.test(raw) ? ("0" + Number(raw)).slice(-2) : "";
      if (!code || seen[code]) return;
      seen[code] = true;
      result.push({venueName: name || JRA_VENUES[code] || "", venueUrl: venueUrl(code), jyoCd: code});
    });
    if (!result.length) {
      var current = new URL(location.href).searchParams.get("jyo_cd") || "";
      var code = /^\d{1,2}$/.test(current) ? ("0" + Number(current)).slice(-2) : "";
      if (code) result.push({venueName: JRA_VENUES[code] || "", venueUrl: venueUrl(code), jyoCd: code});
    }
    return result;
  }

  function pageDate() {
    var urlDate = new URL(location.href).searchParams.get("kaisai_date") || "";
    var compact = /^\d{8}$/.test(urlDate) ? urlDate : "";
    if (!compact) {
      var selected = document.querySelector(
        '[aria-selected="true"] a[href*="kaisai_date="], .ui-tabs-active a[href*="kaisai_date="], .Active a[href*="kaisai_date="]'
      );
      var selectedMatch = String(selected && selected.getAttribute("href") || "").match(/kaisai_date=(\d{8})/);
      compact = selectedMatch ? selectedMatch[1] : "";
    }
    if (!compact) {
      var active = clean((document.querySelector(".Tab a.Tab_Active, a.Tab_Active") || {}).textContent);
      var monthDay = active.match(/(\d{1,2})\/(\d{1,2})/);
      if (monthDay) {
        var now = new Date();
        var year = now.getFullYear();
        var month = ("0" + monthDay[1]).slice(-2);
        var day = ("0" + monthDay[2]).slice(-2);
        var candidate = new Date(year, Number(month) - 1, Number(day));
        var difference = candidate.getTime() - now.getTime();
        if (difference > 15552000000) year -= 1;
        if (difference < -15552000000) year += 1;
        compact = String(year) + month + day;
      }
    }
    if (!compact) {
      var today = new Date();
      compact = String(today.getFullYear()) + ("0" + (today.getMonth() + 1)).slice(-2) +
        ("0" + today.getDate()).slice(-2);
    }
    return compact.slice(0, 4) + "-" + compact.slice(4, 6) + "-" + compact.slice(6, 8);
  }

  function rows() {
    var result = [];
    var seen = [];
    ROW_SELECTORS.forEach(function (selector) {
      Array.prototype.forEach.call(document.querySelectorAll(selector), function (candidate) {
        var row = candidate.matches && candidate.matches(".RaceListMainArea") ?
          (candidate.closest("li") || candidate) : candidate;
        if (!rendered(row) || !raceLink(row) || seen.indexOf(row) >= 0) return;
        seen.push(row);
        result.push(row);
      });
    });
    return result;
  }

  try {
    var pageRows = rows();
    var currentCode = new URL(location.href).searchParams.get("jyo_cd") || "";
    currentCode = /^\d{1,2}$/.test(currentCode) ? ("0" + Number(currentCode)).slice(-2) : "";
    var races = [];
    var seenRaceIds = {};
    pageRows.forEach(function (row) {
      var labelText = clean(row.textContent);
      if (labelText.indexOf("新馬") < 0) return;
      var raceId = raceIdFrom(row);
      if (!/^\d{12}$/.test(raceId) || seenRaceIds[raceId]) return;
      if (currentCode && raceId.slice(4, 6) !== currentCode) return;
      var timeMatch = labelText.match(/(?:^|\D)(\d{1,2}):(\d{2})(?:\D|$)/);
      if (!timeMatch) return;
      var venueName = JRA_VENUES[raceId.slice(4, 6)] || "";
      var raceNumber = Number(raceId.slice(-2));
      if (!venueName || !raceNumber) return;
      var labelMatch = labelText.match(/(?:\d+歳(?:以上)?\s*)?新馬/);
      seenRaceIds[raceId] = true;
      races.push({
        raceName: venueName + raceNumber + "R",
        raceTime: ("0" + timeMatch[1]).slice(-2) + ":" + timeMatch[2],
        raceUrl: new URL("/race/shutuba.html?race_id=" + raceId, location.origin).href,
        raceId: raceId,
        raceLabel: labelMatch ? clean(labelMatch[0]) : "新馬"
      });
    });
    races.sort(function (a, b) { return a.raceTime.localeCompare(b.raceTime); });
    return JSON.stringify({
      ok: true,
      date: pageDate(),
      currentCode: currentCode,
      venueNavigation: venues(),
      rowCount: pageRows.length,
      races: races
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


_UI_VIEW_BASE = ui.View if ui is not None else object


class NewcomerCollectorView(_UI_VIEW_BASE):
    def __init__(self, controller: "NewcomerListCollector") -> None:
        if ui is None:
            raise NewcomerListClientError("WEBVIEW_UNAVAILABLE", "Pythonistaのui.WebViewを利用できません。")
        super().__init__()
        self.controller = controller
        self.name = "新馬戦チャレンジ"
        self.background_color = "white"

        self.title_label = ui.Label()
        self.title_label.text = "当日の新馬戦一覧を取得しています"
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
        self.webview_delegate = NewcomerCollectorDelegate(controller)
        self.webview.delegate = self.webview_delegate
        self.add_subview(self.webview)

    def layout(self) -> None:
        title_height = 36
        progress_height = 32
        self.title_label.frame = (0, 0, self.width, title_height)
        self.progress_label.frame = (0, title_height, self.width, progress_height)
        self.webview.frame = (0, title_height + progress_height, self.width, self.height - title_height - progress_height)

    def will_close(self) -> None:
        self.controller.handle_view_closed()


class NewcomerCollectorDelegate:
    def __init__(self, controller: "NewcomerListCollector") -> None:
        self.controller = controller

    def webview_should_start_load(self, webview: Any, url: str, nav_type: int) -> bool:
        return True

    def webview_did_start_load(self, webview: Any) -> None:
        pass

    def webview_did_finish_load(self, webview: Any) -> None:
        self.controller.handle_load_finished()

    def webview_did_fail_load(self, webview: Any, error_code: int, error_message: str) -> None:
        self.controller.handle_load_failed(error_code)


class NewcomerListCollector:
    def __init__(self) -> None:
        if ui is None:
            raise NewcomerListClientError("WEBVIEW_UNAVAILABLE", "Pythonistaのui.WebViewを利用できません。")
        self.view = NewcomerCollectorView(self)
        self.webview = self.view.webview
        self.phase = "discovering"
        self.done = False
        self.poll_scheduled = False
        self.poll_attempt = 0
        self.navigation_token = 0
        self.date = ""
        self.venues: List[Dict[str, str]] = []
        self.current_index = -1
        self.races_by_id: Dict[str, Dict[str, str]] = {}
        self.errors: List[Dict[str, str]] = []

    @property
    def current_venue(self) -> Optional[Dict[str, str]]:
        if 0 <= self.current_index < len(self.venues):
            return self.venues[self.current_index]
        return None

    def run(self) -> Dict[str, Any]:
        self.view.progress_label.text = "開催場を確認しています…"
        self.view.present("full_screen", orientations=["portrait"])
        self.webview.load_url(NEWCOMER_LIST_START_URL)
        self.view.wait_modal()
        return self.build_output()

    def evaluate_page(self) -> Optional[Dict[str, Any]]:
        try:
            return _parse_javascript_json(self.webview.eval_js(NEWCOMER_PAGE_EXPORT_JS))
        except Exception:
            return None

    def handle_load_finished(self) -> None:
        if self.done or self.poll_scheduled:
            return
        self.poll_scheduled = True
        token = self.navigation_token

        def inspect() -> None:
            self.poll_scheduled = False
            self.inspect_page(token)

        ui.delay(inspect, 0.45)

    def handle_load_failed(self, error_code: int) -> None:
        if self.done or int(error_code) == -999:
            return
        if self.phase == "discovering":
            self.finish_with_error("RACE_LIST_LOAD_FAILED", "当日のレース一覧を開けませんでした。")
        else:
            self.fail_current_venue("VENUE_LOAD_FAILED", "開催場のレース一覧を開けませんでした。")

    def schedule_retry(self, token: int) -> None:
        if self.done or token != self.navigation_token:
            return
        ui.delay(lambda: self.inspect_page(token), PAGE_POLL_INTERVAL)

    def inspect_page(self, token: int) -> None:
        if self.done or token != self.navigation_token:
            return
        self.poll_attempt += 1
        data = self.evaluate_page()
        ready = bool(data and data.get("ok") and int(data.get("rowCount") or 0) > 0)
        if not ready:
            if self.poll_attempt >= MAX_PAGE_POLL_ATTEMPTS:
                if self.phase == "discovering":
                    self.finish_with_error("RACE_LIST_NOT_READY", "当日のレース一覧を確認できませんでした。")
                else:
                    self.fail_current_venue("VENUE_LIST_NOT_READY", "開催場のレース一覧を確認できませんでした。")
                return
            self.schedule_retry(token)
            return

        if self.phase == "discovering":
            self.date = str(data.get("date") or "").strip()
            navigation = data.get("venueNavigation") or []
            seen = set()
            for venue in navigation:
                if not isinstance(venue, dict):
                    continue
                code = str(venue.get("jyoCd") or "").strip()
                url = str(venue.get("venueUrl") or "").strip()
                name = str(venue.get("venueName") or "").strip()
                if not code or not url or code in seen:
                    continue
                seen.add(code)
                self.venues.append({"jyoCd": code, "venueUrl": url, "venueName": name})
            if not self.venues:
                self.finish_with_error("VENUE_NAV_NOT_FOUND", "当日開催中の開催場を確認できませんでした。")
                return
            self.current_index = 0
            self.load_current_venue()
            return

        venue = self.current_venue
        if venue is None:
            self.finish()
            return
        current_code = str(data.get("currentCode") or "").strip()
        if current_code and current_code != venue["jyoCd"]:
            if self.poll_attempt >= MAX_PAGE_POLL_ATTEMPTS:
                self.fail_current_venue("VENUE_MISMATCH", "表示中の開催場を確認できませんでした。")
            else:
                self.schedule_retry(token)
            return
        page_date = str(data.get("date") or "").strip()
        if self.date and page_date and page_date != self.date:
            self.fail_current_venue("DATE_MISMATCH", "開催日が一致しないページを除外しました。")
            return
        for race in data.get("races") or []:
            if not isinstance(race, dict):
                continue
            race_id = str(race.get("raceId") or "").strip()
            if race_id:
                self.races_by_id[race_id] = race
        self.advance_venue()

    def load_current_venue(self) -> None:
        venue = self.current_venue
        if venue is None:
            self.finish()
            return
        self.phase = "loading_venue"
        self.navigation_token += 1
        self.poll_attempt = 0
        self.poll_scheduled = False
        self.view.progress_label.text = (
            f"{self.current_index + 1} / {len(self.venues)} "
            f"{venue.get('venueName') or venue['jyoCd']}"
        )
        try:
            self.webview.load_url(venue["venueUrl"])
        except Exception:
            self.fail_current_venue("VENUE_LOAD_FAILED", "開催場のレース一覧を開けませんでした。")

    def fail_current_venue(self, error_type: str, message: str) -> None:
        venue = self.current_venue or {}
        self.errors.append({
            "venueName": str(venue.get("venueName") or venue.get("jyoCd") or "開催場"),
            "type": error_type,
            "message": message,
        })
        self.advance_venue()

    def advance_venue(self) -> None:
        if self.done:
            return
        self.current_index += 1
        if self.current_index >= len(self.venues):
            self.finish()
        else:
            ui.delay(self.load_current_venue, 0.25)

    def finish_with_error(self, error_type: str, message: str) -> None:
        self.errors.append({"venueName": "当日一覧", "type": error_type, "message": message})
        self.finish()

    def finish(self) -> None:
        if self.done:
            return
        self.done = True
        self.phase = "done"
        self.view.title_label.text = "新馬戦一覧の取得が完了しました"
        self.view.progress_label.text = f"新馬戦 {len(self.races_by_id)}件"
        ui.delay(self.view.close, 0.6)

    def handle_view_closed(self) -> None:
        if self.done:
            return
        self.errors.append({
            "venueName": "当日一覧",
            "type": "USER_CANCELLED",
            "message": "ユーザー操作により一覧取得を中止しました。",
        })
        self.done = True
        self.phase = "done"

    def build_output(self) -> Dict[str, Any]:
        races = sorted(
            self.races_by_id.values(),
            key=lambda race: (str(race.get("raceTime") or ""), str(race.get("raceId") or "")),
        )
        output: Dict[str, Any] = {
            "success": not self.errors,
            "date": self.date,
            "races": races,
            "errors": self.errors,
        }
        if self.errors:
            output["error"] = {
                "type": "NEWCOMER_LIST_INCOMPLETE",
                "message": "一部の開催場から新馬戦一覧を取得できませんでした。",
                "details": {"errors": self.errors},
            }
        return output


def collect_newcomer_list_with_webview() -> Dict[str, Any]:
    global _RUNNING
    with _RUN_STATE_LOCK:
        if _RUNNING:
            raise NewcomerListClientError("ALREADY_RUNNING", "新馬戦一覧取得はすでに実行中です。")
        _RUNNING = True
    try:
        return NewcomerListCollector().run()
    finally:
        with _RUN_STATE_LOCK:
            _RUNNING = False
