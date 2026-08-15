"""選択した複数レースを取得し、Webアプリ用JSONを標準出力へ返す。"""

from __future__ import annotations

import json
import ipaddress
import os
import re
import sys
import webbrowser
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse, urlunparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

try:
    import appex
except ImportError:  # PC上の構文・単体テスト用
    appex = None

try:
    import clipboard
except ImportError:  # PC上の構文・単体テスト用
    clipboard = None

from netkeiba_newcomer_client import collect_newcomer_list_with_webview
from netkeiba_webview_client import collect_races_with_webview
from netkeiba_memo_client import sync_horse_memos_with_webview


DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RACE_TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
RACE_ID_PATTERN = re.compile(r"^\d{12}$")
WEB_APP_RETURN_PARAMETER = "pythonistaResult"
RETURN_TO_SAFARI_ENABLED = True
NEWCOMER_LIST_ACTION = "collectNewcomerList"
MEMO_SYNC_ACTION = "syncHorseMemos"
WEB_APP_ID = "shinba-challenge"
LEGACY_WEB_APP_IDS = {WEB_APP_ID, "shinba-challenge-v2"}
PRODUCTION_WEB_APP_ORIGIN = "https://10uver19.github.io"
PRODUCTION_WEB_APP_URL = f"{PRODUCTION_WEB_APP_ORIGIN}/shinba-challenge/"


class InputError(Exception):
    def __init__(self, error_type: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.type = error_type
        self.details = details or None


def _load_text_from_shortcuts() -> str:
    if len(sys.argv) > 1:
        argument = sys.argv[1]
        if os.path.isfile(argument):
            with open(argument, "r", encoding="utf-8") as input_file:
                return input_file.read()
        return argument
    if appex is not None and appex.is_running_extension():
        shared_text = appex.get_text()
        if shared_text:
            return shared_text
    if clipboard is not None:
        try:
            clipboard_text = clipboard.get()
            if isinstance(clipboard_text, str) and clipboard_text.strip():
                return clipboard_text
        except Exception:
            pass
    raise InputError(
        "INPUT_NOT_FOUND",
        "selectedRaces JSONを引数・共有テキスト・クリップボードのいずれかで渡してください。",
    )


def _is_valid_race_url(url: str, race_id: str) -> bool:
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        query_race_id = (parse_qs(parsed.query).get("race_id") or [""])[0]
    except Exception:
        return False
    return (
        parsed.scheme == "https"
        and host == "race.sp.netkeiba.com"
        and parsed.path == "/race/shutuba.html"
        and query_race_id == race_id
    )


def _resolve_race_url(url: str, race_id: str) -> str:
    if not RACE_ID_PATTERN.fullmatch(race_id):
        raise InputError("INVALID_RACE_ID", "raceIdは12桁で指定してください。")
    normalized_url = str(url or "").strip()
    if not normalized_url:
        normalized_url = (
            "https://race.sp.netkeiba.com/race/shutuba.html"
            f"?race_id={race_id}"
        )
    if not _is_valid_race_url(normalized_url, race_id):
        raise InputError(
            "INVALID_RACE_URL",
            "raceUrlのhost / path / race_idがraceIdと一致しません。",
        )
    return normalized_url


def _normalize_payload(raw_text: str) -> Dict[str, Any]:
    try:
        payload = json.loads(raw_text)
    except (TypeError, json.JSONDecodeError) as error:
        raise InputError("INVALID_JSON", "selectedRaces JSONの形式が正しくありません。") from error
    if not isinstance(payload, dict):
        raise InputError("INVALID_PAYLOAD", "JSONオブジェクトを指定してください。")
    date = str(payload.get("date") or "").strip()
    if not DATE_PATTERN.fullmatch(date):
        raise InputError("INVALID_DATE", "dateはYYYY-MM-DD形式で指定してください。")
    selected = payload.get("selectedRaces")
    if not isinstance(selected, list) or not selected:
        raise InputError("NO_SELECTED_RACES", "selectedRacesを1件以上指定してください。")

    races: List[Dict[str, str]] = []
    seen_ids = set()
    for index, race in enumerate(selected, start=1):
        if not isinstance(race, dict):
            raise InputError("INVALID_SELECTED_RACE", f"{index}件目の選択データが正しくありません。")
        normalized = {
            "raceName": str(race.get("raceName") or "").strip(),
            "raceTime": str(race.get("raceTime") or "").strip(),
            "raceUrl": str(race.get("raceUrl") or "").strip(),
            "raceId": str(race.get("raceId") or "").strip(),
            "raceLabel": str(race.get("raceLabel") or "").strip(),
        }
        if not all(normalized[key] for key in ("raceName", "raceTime", "raceId")):
            raise InputError("INVALID_SELECTED_RACE", f"{index}件目のraceName / raceTime / raceIdを確認してください。")
        if not RACE_TIME_PATTERN.fullmatch(normalized["raceTime"]):
            raise InputError("INVALID_RACE_TIME", f"{index}件目のraceTimeはHH:MM形式で指定してください。")
        if not RACE_ID_PATTERN.fullmatch(normalized["raceId"]):
            raise InputError("INVALID_RACE_ID", f"{index}件目のraceIdは12桁で指定してください。")
        try:
            normalized["raceUrl"] = _resolve_race_url(normalized["raceUrl"], normalized["raceId"])
        except InputError as error:
            raise InputError(error.type, f"{index}件目の{error}") from error
        if normalized["raceId"] in seen_ids:
            raise InputError("DUPLICATE_RACE_ID", f'raceId {normalized["raceId"]} が重複しています。')
        seen_ids.add(normalized["raceId"])
        races.append(normalized)
    races.sort(key=lambda race: (race["raceTime"], race["raceId"]))
    return {
        "date": date,
        "selectedRaces": races,
        "returnUrl": _normalize_return_url(
            payload.get("returnUrl"), payload.get("appId"), payload.get("returnOrigin")
        ),
    }


def _is_private_or_loopback_host(host: str) -> bool:
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        address = ipaddress.ip_address(host)
        return bool(address.is_private or address.is_loopback)
    except ValueError:
        return False


def _normalize_return_url(value: Any, app_id: Any = "", return_origin: Any = "") -> str:
    url = str(value or "").strip()
    if not url:
        return PRODUCTION_WEB_APP_URL
    if str(app_id or "") not in LEGACY_WEB_APP_IDS:
        raise InputError("RETURN_ORIGIN_NOT_ALLOWED", "Webアプリ識別子を確認できません。")
    try:
        parsed = urlparse(url)
    except Exception as error:
        raise InputError("INVALID_RETURN_URL", "Webアプリ復帰URLが正しくありません。") from error
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
        raise InputError("INVALID_RETURN_URL", "Webアプリ復帰URLは認証情報を含まないhttp / https URLにしてください。")
    expected_origin = str(return_origin or "").strip().rstrip("/")
    actual_origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    if expected_origin and expected_origin != actual_origin:
        raise InputError("RETURN_ORIGIN_NOT_ALLOWED", "復帰URLと許可originが一致しません。")
    clean_query = [
        (key, item)
        for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        if key != WEB_APP_RETURN_PARAMETER
    ]
    if parsed.scheme == "https":
        if (
            actual_origin != PRODUCTION_WEB_APP_ORIGIN
            or parsed.path != "/shinba-challenge/"
            or clean_query
        ):
            raise InputError(
                "RETURN_ORIGIN_NOT_ALLOWED",
                "HTTPSの復帰先は新馬戦チャレンジ本番URLだけ許可されます。",
            )
        return PRODUCTION_WEB_APP_URL
    if not _is_private_or_loopback_host(host):
        raise InputError(
            "RETURN_ORIGIN_NOT_ALLOWED",
            "HTTPの復帰先はlocalhostまたはプライベートネットワークだけ許可されます。",
        )
    return urlunparse(parsed._replace(query=urlencode(clean_query), fragment=""))


def _normalize_memo_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    date = str(payload.get("date") or "").strip()
    if not DATE_PATTERN.fullmatch(date):
        raise InputError("INVALID_DATE", "dateはYYYY-MM-DD形式で指定してください。")
    sources = payload.get("memoItems")
    if not isinstance(sources, list) or not sources:
        raise InputError("NO_MEMO_ITEMS", "同期する馬メモがありません。")
    items: List[Dict[str, str]] = []
    seen = set()
    for index, source in enumerate(sources, start=1):
        if not isinstance(source, dict):
            raise InputError("INVALID_MEMO_ITEM", f"{index}件目の馬メモが正しくありません。")
        item = {
            "syncKey": str(source.get("syncKey") or "").strip(),
            "date": str(source.get("date") or "").strip(),
            "raceId": str(source.get("raceId") or "").strip(),
            "raceName": str(source.get("raceName") or "").strip(),
            "horseId": str(source.get("horseId") or "").strip(),
            "horseName": str(source.get("horseName") or "").strip(),
            "memoText": str(source.get("memoText") or "").strip(),
        }
        if item["date"] != date or not RACE_ID_PATTERN.fullmatch(item["raceId"]):
            raise InputError("INVALID_MEMO_ITEM", f"{index}件目の日付 / raceIdが正しくありません。")
        if not re.fullmatch(r"\d{10}", item["horseId"]) or not item["horseName"] or not item["memoText"]:
            raise InputError("INVALID_MEMO_ITEM", f"{index}件目のhorseId / 馬名 / 本文が正しくありません。")
        expected_key = f'{date}:{item["raceId"]}:{item["horseId"]}'
        if item["syncKey"] != expected_key or expected_key in seen:
            raise InputError("INVALID_MEMO_KEY", f"{index}件目のsyncKeyが正しくないか重複しています。")
        seen.add(expected_key)
        items.append(item)
    return {
        "action": MEMO_SYNC_ACTION,
        "date": date,
        "memoItems": items,
        "returnUrl": _normalize_return_url(
            payload.get("returnUrl"), payload.get("appId"), payload.get("returnOrigin")
        ),
    }


def _structured_error(error: Exception) -> Dict[str, Any]:
    return {
        "type": getattr(error, "type", "UNEXPECTED_ERROR"),
        "message": str(error) or "予期しないエラーが発生しました。",
        "details": getattr(error, "details", None),
    }


def collect_races(payload: Dict[str, Any]) -> Dict[str, Any]:
    return collect_races_with_webview(payload)


def _requested_action(raw_text: str) -> str:
    try:
        payload = json.loads(raw_text)
    except (TypeError, json.JSONDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("action") or "").strip()


def _build_web_app_return_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key != WEB_APP_RETURN_PARAMETER
    ]
    query.append((WEB_APP_RETURN_PARAMETER, "1"))
    return urlunparse(parsed._replace(query=urlencode(query)))


def _return_to_web_app(return_url: str) -> bool:
    if not RETURN_TO_SAFARI_ENABLED:
        return False
    target_url = _build_web_app_return_url(return_url or PRODUCTION_WEB_APP_URL)
    try:
        if webbrowser.get("safari").open(target_url):
            return True
    except Exception:
        pass
    try:
        return bool(webbrowser.open(target_url))
    except Exception:
        return False


def main() -> None:
    return_url = PRODUCTION_WEB_APP_URL
    try:
        raw_text = _load_text_from_shortcuts()
        try:
            request_source = json.loads(raw_text)
        except (TypeError, json.JSONDecodeError) as error:
            raise InputError("INVALID_JSON", "入力JSONの形式が正しくありません。") from error
        if not isinstance(request_source, dict):
            raise InputError("INVALID_PAYLOAD", "JSONオブジェクトを指定してください。")
        action = _requested_action(raw_text)
        return_url = _normalize_return_url(
            request_source.get("returnUrl"),
            request_source.get("appId"),
            request_source.get("returnOrigin"),
        )
        if action == NEWCOMER_LIST_ACTION:
            output = collect_newcomer_list_with_webview()
        elif action == MEMO_SYNC_ACTION:
            payload = _normalize_memo_payload(request_source)
            return_url = payload["returnUrl"]
            output = sync_horse_memos_with_webview(payload)
        else:
            payload = _normalize_payload(raw_text)
            return_url = payload["returnUrl"]
            output = collect_races(payload)
    except Exception as error:
        output = {"success": False, "error": _structured_error(error)}
    output_json = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
    if clipboard is not None:
        try:
            clipboard.set(output_json)
        except Exception:
            pass
    # Webアプリへの貼り付け用として、標準出力はJSON 1件だけにする。
    print(output_json)
    # 出力やクリップボード処理の成否にかかわらず、安全な許可済みURLへの復帰を試みる。
    _return_to_web_app(return_url)


if __name__ == "__main__":
    main()
