"""Pythonista WebViewで当日開催中の全開催場から新馬戦一覧を取得する。"""

from __future__ import annotations

import json
import re
import threading
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

try:
    import ui
except ImportError:  # PC上の構文・単体テスト用
    ui = None


NEWCOMER_LIST_START_URL = "https://race.sp.netkeiba.com/?rf=navi"
PAGE_POLL_INTERVAL = 0.75
MAX_PAGE_POLL_ATTEMPTS = 28
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RACE_ID_PATTERN = re.compile(r"^\d{12}$")
RACE_TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
JRA_VENUE_CODES = {f"{number:02d}" for number in range(1, 11)}

_RUN_STATE_LOCK = threading.Lock()
_RUNNING = False


class NewcomerListClientError(Exception):
    def __init__(self, error_type: str, message: str):
        super().__init__(message)
        self.type = error_type


def _build_start_url(expected_date: str) -> str:
    return f"{NEWCOMER_LIST_START_URL}&kaisai_date={expected_date.replace('-', '')}"


def _normalize_venue(source: Any, expected_date: str) -> Optional[Dict[str, str]]:
    if not isinstance(source, dict):
        return None
    code = str(source.get("jyoCd") or "").strip().zfill(2)
    name = str(source.get("venueName") or "").strip()
    venue_url = str(source.get("venueUrl") or "").strip()
    if code not in JRA_VENUE_CODES or not venue_url:
        return None
    try:
        parsed = urlparse(venue_url)
        query = parse_qs(parsed.query)
    except Exception:
        return None
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() != "race.sp.netkeiba.com"
        or parsed.path not in {"", "/"}
        or (query.get("jyo_cd") or [""])[0].zfill(2) != code
    ):
        return None
    compact_date = (query.get("kaisai_date") or [""])[0]
    if compact_date and compact_date != expected_date.replace("-", ""):
        return None
    return {"jyoCd": code, "venueUrl": venue_url, "venueName": name}


def _normalize_race(source: Any, expected_venue_code: str) -> Dict[str, str]:
    if not isinstance(source, dict):
        raise NewcomerListClientError("INVALID_RACE_DATA", "新馬戦データの形式が正しくありません。")
    race_id = str(source.get("raceId") or "").strip()
    race_name = str(source.get("raceName") or "").strip()
    race_time = str(source.get("raceTime") or "").strip()
    race_label = str(source.get("raceLabel") or "").strip()
    if not RACE_ID_PATTERN.fullmatch(race_id):
        raise NewcomerListClientError("INVALID_RACE_ID", "raceIdを12桁で取得できませんでした。")
    if expected_venue_code and race_id[4:6] != expected_venue_code:
        raise NewcomerListClientError("VENUE_MISMATCH", "raceIdの開催場コードが表示中の開催場と一致しません。")
    if (
        not re.fullmatch(r"(?:札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\d{1,2}R", race_name)
        or not RACE_TIME_PATTERN.fullmatch(race_time)
    ):
        raise NewcomerListClientError("INVALID_RACE_DATA", "raceNameまたはraceTimeを取得できませんでした。")
    if "新馬" not in race_label:
        raise NewcomerListClientError("INVALID_RACE_LABEL", "新馬戦ではないレースが含まれています。")
    race_url = f"https://race.sp.netkeiba.com/race/shutuba.html?race_id={race_id}"
    return {
        "raceName": race_name,
        "raceTime": race_time,
        "raceUrl": race_url,
        "raceId": race_id,
        "raceLabel": race_label,
    }


NEWCOMER_PAGE_EXPORT_JS = r"""
(function () {
  "use strict";

  var JRA_VENUES = {"01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京",
    "06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉"};
  var VENUE_CODES = {};
  Object.keys(JRA_VENUES).forEach(function (code) { VENUE_CODES[JRA_VENUES[code]] = code; });
  var SMARTPHONE_RACE_ROW_SELECTORS = [
    ".RaceList_SlideBoxItem .RaceList > li",
    ".RaceList > li",
    ".RaceListMainArea"
  ];
  var DESKTOP_RACE_ROW_SELECTORS = [
    ".RaceList_DataItem",
    ".RaceList_Item",
    ".RaceList_Data li",
    '[class*="RaceList"] li'
  ];
  var RACE_LINK_SELECTORS = [
    '.RaceList_Main_Box > a[href*="race_id="]',
    '.RaceListMainArea a[href*="race_id="]',
    'a[href*="race_id="]',
    'a[href*="race_id%3D"]'
  ];
  var RACE_NUMBER_SELECTORS = [".Race_Num", ".RaceNum", ".RaceList_Item01", '[class*="Race_Num"]'];
  var RACE_TIME_SELECTORS = [".RaceList_Itemtime", ".RaceTime", ".Race_Data", ".RaceData"];
  var RACE_LABEL_SELECTORS = [".Race_Name", ".ItemTitle", ".RaceList_ItemTitle", ".RaceName", ".Race_Label"];
  var VENUE_SELECTORS = [".RaceList_DataTitle", ".RaceList_DataHeader", ".RaceKaisai", ".VenueName"];

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

  function findRaceLink(row) {
    for (var index = 0; index < RACE_LINK_SELECTORS.length; index += 1) {
      var links = Array.prototype.slice.call(row.querySelectorAll(RACE_LINK_SELECTORS[index]));
      var link = links.find(function (candidate) {
        return /race_id(?:=|%3D)\d{12}/i.test(candidate.getAttribute("href") || candidate.href || "");
      });
      if (link) return link;
    }
    return null;
  }

  function raceIdFrom(row) {
    var link = findRaceLink(row);
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

  function venueNavigation() {
    var result = [];
    var seen = {};
    var items = document.querySelectorAll(".jyo_tab li, .jyo_tab [data-jyo_cd], .jyo_tab [data-jyo-cd]");
    Array.prototype.forEach.call(items, function (item) {
      var text = cleanText(item.textContent);
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

  function isRendered(element) {
    if (!element || element.hidden) return false;
    var current = element;
    while (current && current.nodeType === 1) {
      var style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
      current = current.parentElement;
    }
    return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
  }

  function smartphoneRows() {
    if (!document.querySelector(".RaceListMainArea, .RaceList_SlideBoxItem")) return null;
    var result = [];
    var seen = [];
    SMARTPHONE_RACE_ROW_SELECTORS.forEach(function (selector) {
      Array.prototype.forEach.call(document.querySelectorAll(selector), function (candidate) {
        var row = candidate.matches && candidate.matches(".RaceListMainArea") ?
          (candidate.closest("li") || candidate) : candidate;
        var slide = row.closest && row.closest(".RaceList_SlideBoxItem");
        if (slide && !isRendered(slide)) return;
        if (!findRaceLink(row) || seen.indexOf(row) >= 0) return;
        seen.push(row);
        result.push(row);
      });
    });
    return result;
  }

  function desktopRows() {
    var result = [];
    var seen = [];
    DESKTOP_RACE_ROW_SELECTORS.forEach(function (selector) {
      Array.prototype.forEach.call(document.querySelectorAll(selector), function (row) {
        if (seen.indexOf(row) < 0 && findRaceLink(row)) {
          seen.push(row);
          result.push(row);
        }
      });
    });
    if (result.length) return result;
    Array.prototype.forEach.call(document.querySelectorAll('a[href*="race_id="]'), function (link) {
      var row = link.closest("li, article, tr, section, div");
      if (row && seen.indexOf(row) < 0) {
        seen.push(row);
        result.push(row);
      }
    });
    return result;
  }

  function rows() {
    var mobile = smartphoneRows();
    return mobile === null ? desktopRows() : mobile;
  }

  function raceLabel(row) {
    var direct = firstText(row, RACE_LABEL_SELECTORS);
    if (direct) return direct;
    var match = cleanText(row.textContent).match(/(?:\d+歳(?:以上)?\s*)?新馬/);
    return match ? cleanText(match[0]) : "";
  }

  function raceTime(row) {
    var direct = firstText(row, RACE_TIME_SELECTORS);
    var match = (direct + " " + cleanText(row.textContent)).match(/(?:^|\D)(\d{1,2}):(\d{2})(?:\D|$)/);
    return match ? ("0" + match[1]).slice(-2) + ":" + match[2] : "";
  }

  function raceNumber(row, raceId) {
    var direct = firstText(row, RACE_NUMBER_SELECTORS);
    var match = (direct + " " + cleanText(row.textContent)).match(/(?:^|\s)(\d{1,2})R(?:\s|$)/i);
    return match ? Number(match[1]) : Number(String(raceId).slice(-2));
  }

  function venueName(row, raceId) {
    var container = row.closest && (row.closest(".RaceList_DataList, dl, section, article") || row.parentElement);
    var text = container ? firstText(container, VENUE_SELECTORS) : "";
    var match = text.match(/札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉/);
    return match ? match[0] : (JRA_VENUES[String(raceId).slice(4, 6)] || "");
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
      var active = cleanText((document.querySelector(".Tab a.Tab_Active, a.Tab_Active") || {}).textContent);
      var monthDay = active.match(/(\d{1,2})\/(\d{1,2})/);
      if (monthDay) {
        var month = ("0" + monthDay[1]).slice(-2);
        var day = ("0" + monthDay[2]).slice(-2);
        var matchingLink = Array.prototype.slice.call(document.querySelectorAll('a[href*="kaisai_date="]'))
          .find(function (link) {
            var match = String(link.getAttribute("href") || "").match(/kaisai_date=(\d{8})/);
            return match && match[1].slice(-4) === month + day;
          });
        var matchingDate = String(matchingLink && matchingLink.getAttribute("href") || "")
          .match(/kaisai_date=(\d{8})/);
        compact = matchingDate ? matchingDate[1] : "";
        if (!compact) {
          var now = new Date();
          var year = now.getFullYear();
          var candidate = new Date(year, Number(month) - 1, Number(day));
          var difference = candidate.getTime() - now.getTime();
          if (difference > 15552000000) year -= 1;
          if (difference < -15552000000) year += 1;
          compact = String(year) + month + day;
        }
      }
    }
    if (!compact) {
      var today = new Date();
      compact = String(today.getFullYear()) + ("0" + (today.getMonth() + 1)).slice(-2) +
        ("0" + today.getDate()).slice(-2);
    }
    return compact.slice(0, 4) + "-" + compact.slice(4, 6) + "-" + compact.slice(6, 8);
  }

  try {
    var pageRows = rows();
    var currentCode = new URL(location.href).searchParams.get("jyo_cd") || "";
    currentCode = /^\d{1,2}$/.test(currentCode) ? ("0" + Number(currentCode)).slice(-2) : "";
    var races = [];
    var seenRaceIds = {};
    pageRows.forEach(function (row) {
      var labelText = raceLabel(row);
      if (labelText.indexOf("新馬") < 0) return;
      var raceId = raceIdFrom(row);
      if (!/^\d{12}$/.test(raceId) || seenRaceIds[raceId]) return;
      if (currentCode && raceId.slice(4, 6) !== currentCode) return;
      var time = raceTime(row);
      var venue = venueName(row, raceId);
      var number = raceNumber(row, raceId);
      if (!time || !venue || !number) return;
      seenRaceIds[raceId] = true;
      races.push({
        raceName: venue + number + "R",
        raceTime: time,
        raceUrl: "https://race.sp.netkeiba.com/race/shutuba.html?race_id=" + raceId,
        raceId: raceId,
        raceLabel: labelText
      });
    });
    races.sort(function (a, b) { return a.raceTime.localeCompare(b.raceTime); });
    return JSON.stringify({
      ok: true,
      date: pageDate(),
      currentCode: currentCode,
      venueNavigation: venueNavigation(),
      rowCount: pageRows.length,
      races: races
    });
  } catch (error) {
    return JSON.stringify({ok: false, errorType: "PAGE_EXPORT_FAILED"});
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
        self.controller.dispatch_callback("LOAD_FINISHED", self.controller.handle_load_finished)

    def webview_did_fail_load(self, webview: Any, error_code: int, error_message: str) -> None:
        self.controller.dispatch_callback(
            "LOAD_FAILED", lambda: self.controller.handle_load_failed(error_code)
        )


class NewcomerListCollector:
    def __init__(self, expected_date: str) -> None:
        if ui is None:
            raise NewcomerListClientError("WEBVIEW_UNAVAILABLE", "Pythonistaのui.WebViewを利用できません。")
        self.view = NewcomerCollectorView(self)
        self.webview = self.view.webview
        self.phase = "discovering"
        self.done = False
        self.poll_scheduled = False
        self.transition_pending = False
        self.poll_attempt = 0
        self.navigation_token = 0
        self.date = expected_date
        self.expected_date = expected_date
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
        self.webview.load_url(_build_start_url(self.expected_date))
        self.view.wait_modal()
        return self.build_output()

    def evaluate_page(self) -> Optional[Dict[str, Any]]:
        try:
            return _parse_javascript_json(self.webview.eval_js(NEWCOMER_PAGE_EXPORT_JS))
        except Exception:
            return None

    def dispatch_callback(self, stage: str, callback: Any) -> None:
        if self.done:
            return
        try:
            callback()
        except Exception as error:
            print(f"[NEWCOMER] ERROR {stage}_{type(error).__name__}")
            if self.phase == "loading_venue" and self.current_venue is not None:
                self.fail_current_venue("UNEXPECTED_VENUE_ERROR", "開催場一覧の処理中に予期しないエラーが発生しました。")
            else:
                self.finish_with_error("NEWCOMER_LIST_ERROR", "新馬戦一覧の処理中に予期しないエラーが発生しました。")

    def handle_load_finished(self) -> None:
        if self.done or self.poll_scheduled or self.phase == "next_venue":
            return
        self.poll_scheduled = True
        token = self.navigation_token

        def inspect() -> None:
            self.poll_scheduled = False
            self.dispatch_callback("PAGE_INSPECT", lambda: self.inspect_page(token))

        ui.delay(inspect, 0.45)

    def handle_load_failed(self, error_code: int) -> None:
        if self.done or int(error_code) == -999:
            return
        if self.phase == "discovering":
            self.finish_with_error("RACE_LIST_LOAD_FAILED", "当日のレース一覧を開けませんでした。")
        elif self.phase == "loading_venue":
            self.fail_current_venue("VENUE_LOAD_FAILED", "開催場のレース一覧を開けませんでした。")

    def schedule_retry(self, token: int) -> None:
        if self.done or token != self.navigation_token:
            return
        ui.delay(
            lambda: self.dispatch_callback("PAGE_POLL", lambda: self.inspect_page(token)),
            PAGE_POLL_INTERVAL,
        )

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
            page_date = str(data.get("date") or "").strip()
            if page_date != self.expected_date:
                self.finish_with_error("DATE_MISMATCH", "指定日とnetkeibaの開催日が一致しませんでした。")
                return
            navigation = data.get("venueNavigation") or []
            seen = set()
            for source in navigation:
                venue = _normalize_venue(source, self.expected_date)
                if not venue or venue["jyoCd"] in seen:
                    continue
                seen.add(venue["jyoCd"])
                self.venues.append(venue)
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
        if page_date != self.expected_date:
            self.fail_current_venue("DATE_MISMATCH", "開催日が一致しないページを除外しました。")
            return
        try:
            for source in data.get("races") or []:
                race = _normalize_race(source, venue["jyoCd"])
                self.races_by_id[race["raceId"]] = race
        except NewcomerListClientError as error:
            self.fail_current_venue(error.type, str(error))
            return
        self.advance_venue()

    def load_current_venue(self) -> None:
        venue = self.current_venue
        if venue is None:
            self.finish()
            return
        self.phase = "loading_venue"
        self.transition_pending = False
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
        if self.done or self.transition_pending or self.phase == "next_venue":
            return
        venue = self.current_venue or {}
        self.errors.append({
            "venueName": str(venue.get("venueName") or venue.get("jyoCd") or "開催場"),
            "type": error_type,
            "message": message,
        })
        self.advance_venue()

    def advance_venue(self) -> None:
        if self.done or self.transition_pending:
            return
        self.transition_pending = True
        self.phase = "next_venue"
        self.current_index += 1
        self.navigation_token += 1
        if self.current_index >= len(self.venues):
            self.finish()
        else:
            token = self.navigation_token

            def begin_next() -> None:
                if self.done or self.phase != "next_venue" or token != self.navigation_token:
                    return
                self.transition_pending = False
                self.load_current_venue()

            ui.delay(
                lambda: self.dispatch_callback("NEXT_VENUE", begin_next),
                0.5,
            )

    def finish_with_error(self, error_type: str, message: str) -> None:
        self.errors.append({"venueName": "当日一覧", "type": error_type, "message": message})
        self.finish()

    def finish(self) -> None:
        if self.done:
            return
        self.done = True
        self.phase = "done"
        self.transition_pending = True
        self.navigation_token += 1
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
            "action": "collectNewcomerList",
            "date": self.date,
            "races": races,
            "venues": self.venues,
            "errors": self.errors,
        }
        if self.errors:
            output["error"] = {
                "type": "NEWCOMER_LIST_INCOMPLETE",
                "message": "一部の開催場から新馬戦一覧を取得できませんでした。",
                "details": {"errors": self.errors},
            }
        return output


def collect_newcomer_list_with_webview(expected_date: str) -> Dict[str, Any]:
    global _RUNNING
    if not DATE_PATTERN.fullmatch(str(expected_date or "")):
        raise NewcomerListClientError("INVALID_DATE", "dateはYYYY-MM-DD形式で指定してください。")
    with _RUN_STATE_LOCK:
        if _RUNNING:
            raise NewcomerListClientError("ALREADY_RUNNING", "新馬戦一覧取得はすでに実行中です。")
        _RUNNING = True
    try:
        return NewcomerListCollector(expected_date).run()
    finally:
        with _RUN_STATE_LOCK:
            _RUNNING = False
