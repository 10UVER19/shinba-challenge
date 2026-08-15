"""netkeiba認証Sessionからユーザー印を取得できるかを1レースで診断する。

このファイルはPythonista 3専用です。認証情報やCookie、APIの生レスポンスは
出力せず、main()の最後に許可された診断JSONだけを1回表示します。
"""

from __future__ import annotations

import json
import re
import time
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urljoin, urlparse

try:
    import dialogs
    import keychain
    import requests
except ImportError:
    dialogs = None
    keychain = None
    requests = None


TARGET_RACE_ID = "202604020502"
TARGET_RACE_NAME = "新潟2R"
LOGIN_PAGE_URL = "https://regist.sp.netkeiba.com/?rf=navi"
RACE_URL = (
    "https://race.sp.netkeiba.com/race/shutuba.html"
    f"?race_id={TARGET_RACE_ID}"
)

KEYCHAIN_SERVICE = "shinba_challenge_netkeiba"
KEYCHAIN_LOGIN_ACCOUNT = "login_id"
KEYCHAIN_PASSWORD_ACCOUNT = "password"

# 保存済みID・パスワードを入れ直すときだけTrueに変更し、実行後はFalseへ戻す。
FORCE_CREDENTIAL_REENTRY = False

REQUEST_TIMEOUT = 25
JSONP_CALLBACK = "shinbaAuthDiagnostic"
IPHONE_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
    "Mobile/15E148 Safari/604.1"
)

# netkeibaの出馬表JavaScriptで特別扱いされる値。
# 98はチェックモード、99は明示的な無印、0は未選択を表すため印数に含めない。
NON_MARK_CODES = {"", "0", "98", "99"}


class LoginFormParser(HTMLParser):
    """ログインページ内のformとinputを標準ライブラリだけで収集する。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms: List[Dict[str, Any]] = []
        self._current: Optional[Dict[str, Any]] = None

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        attributes = {name.lower(): (value or "") for name, value in attrs}
        if tag.lower() == "form":
            self._current = {
                "action": attributes.get("action", ""),
                "method": attributes.get("method", "get").lower(),
                "inputs": [],
            }
            return

        if tag.lower() == "input" and self._current is not None:
            name = attributes.get("name", "").strip()
            if name:
                self._current["inputs"].append({
                    "name": name,
                    "type": attributes.get("type", "text").lower(),
                    "value": attributes.get("value", ""),
                })

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "form" and self._current is not None:
            self.forms.append(self._current)
            self._current = None


def new_result() -> Dict[str, Any]:
    return {
        "loginSuccess": False,
        "loginFinalHost": "",
        "finalHost": "",
        "finalPath": "",
        "formCount": 0,
        "formMethod": "",
        "formActionHost": "",
        "formActionPath": "",
        "inputNames": [],
        "authenticatedMarkerFound": False,
        "markApiStatus": "not_started",
        "markItemCount": 0,
        "targetRaceMarkCount": 0,
        "matchedHorseNumbers": [],
    }


def response_text(response: Any) -> str:
    encoding = response.apparent_encoding or response.encoding or "utf-8"
    response.encoding = encoding
    return response.text


def is_netkeiba_https_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return (
        parsed.scheme == "https"
        and (host == "netkeiba.com" or host.endswith(".netkeiba.com"))
    )


def parse_forms(html: str) -> List[Dict[str, Any]]:
    parser = LoginFormParser()
    parser.feed(html)
    parser.close()
    return parser.forms


def find_credential_input_names(form: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    inputs = form.get("inputs") or []

    password_name: Optional[str] = None
    for item in inputs:
        name = str(item.get("name") or "")
        if name.lower() == "pswd":
            password_name = name
            break
    if password_name is None:
        for item in inputs:
            name = str(item.get("name") or "")
            if item.get("type") == "password" or re.search(r"pass|pswd", name, re.IGNORECASE):
                password_name = name
                break

    login_name: Optional[str] = None
    for item in inputs:
        name = str(item.get("name") or "")
        if name.lower() == "login_id":
            login_name = name
            break
    if login_name is None:
        for item in inputs:
            name = str(item.get("name") or "")
            if item.get("type") == "email" or re.search(
                r"login|user.?id|mail|email", name, re.IGNORECASE
            ):
                login_name = name
                break

    return login_name, password_name


def select_login_form(forms: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for form in forms:
        login_name, password_name = find_credential_input_names(form)
        if login_name and password_name:
            return form
    return None


def select_diagnostic_form(forms: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not forms:
        return None

    def score(form: Dict[str, Any]) -> int:
        inputs = form.get("inputs") or []
        names = " ".join(str(item.get("name") or "") for item in inputs)
        value = 10 if form.get("method") == "post" else 0
        if any(item.get("type") == "password" for item in inputs):
            value += 100
        if re.search(r"pass|pswd", names, re.IGNORECASE):
            value += 60
        if re.search(r"login|user.?id|mail|email", names, re.IGNORECASE):
            value += 30
        return value

    return max(forms, key=score)


def find_login_form(html: str) -> Optional[Dict[str, Any]]:
    return select_login_form(parse_forms(html))


def update_final_location(result: Dict[str, Any], url: str) -> None:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    result["loginFinalHost"] = host
    result["finalHost"] = host
    result["finalPath"] = parsed.path or "/"


def make_login_payload(
    form: Dict[str, Any], login_id: str, password: str
) -> Dict[str, str]:
    payload: Dict[str, str] = {}
    for item in form["inputs"]:
        name = item["name"]
        input_type = item["type"]
        if input_type in {"hidden", "submit"}:
            payload[name] = item["value"]

    login_field_name, password_field_name = find_credential_input_names(form)
    if not login_field_name or not password_field_name:
        raise ValueError("credential_fields_not_found")

    # フォームに存在する入力名へ、認証情報だけをメモリ上で設定する。
    payload[login_field_name] = login_id
    payload[password_field_name] = password
    return payload


def delete_saved_credentials() -> None:
    if keychain is None:
        return
    for account in (KEYCHAIN_LOGIN_ACCOUNT, KEYCHAIN_PASSWORD_ACCOUNT):
        try:
            keychain.delete_password(KEYCHAIN_SERVICE, account)
        except Exception:
            pass


def get_credentials() -> Tuple[Optional[Tuple[str, str]], str]:
    if keychain is None or dialogs is None:
        return None, "pythonista_modules_unavailable"

    if FORCE_CREDENTIAL_REENTRY:
        delete_saved_credentials()

    try:
        login_id = keychain.get_password(KEYCHAIN_SERVICE, KEYCHAIN_LOGIN_ACCOUNT)
        password = keychain.get_password(KEYCHAIN_SERVICE, KEYCHAIN_PASSWORD_ACCOUNT)
    except Exception:
        return None, "keychain_read_failed"

    if login_id and password:
        return (login_id, password), "ready"

    values = dialogs.form_dialog(
        title="netkeiba ログイン情報",
        fields=[
            {
                "type": "email",
                "key": "login_id",
                "title": "ID（メールアドレス）",
            },
            {
                "type": "password",
                "key": "password",
                "title": "パスワード",
            },
        ],
    )
    if values is None:
        return None, "credentials_cancelled"

    login_id = str(values.get("login_id") or "").strip()
    password = str(values.get("password") or "")
    if not login_id or not password:
        return None, "credentials_missing"

    try:
        keychain.set_password(KEYCHAIN_SERVICE, KEYCHAIN_LOGIN_ACCOUNT, login_id)
        keychain.set_password(KEYCHAIN_SERVICE, KEYCHAIN_PASSWORD_ACCOUNT, password)
    except Exception:
        delete_saved_credentials()
        return None, "keychain_write_failed"

    return (login_id, password), "ready"


def login_failed(final_url: str, html: str) -> bool:
    query = parse_qs(urlparse(final_url).query)
    if query.get("error") == ["1"]:
        return True

    normalized = re.sub(r"\s+", "", html)
    failure_phrases = (
        "パスワードが間違っています",
        "ID(メールアドレス)、もしくは、パスワードが間違っています",
        "ID（メールアドレス）、もしくは、パスワードが間違っています",
    )
    if any(phrase in normalized for phrase in failure_phrases):
        return True
    return find_login_form(html) is not None


def has_authenticated_marker(html: str) -> bool:
    return bool(re.search(r"ログアウト|(?:pid|action)=logout|/logout", html, re.IGNORECASE))


def extract_javascript_string(html: str, variable_name: str) -> Optional[str]:
    pattern = re.compile(
        rf"(?:var|let|const)?\s*{re.escape(variable_name)}\s*=\s*(['\"])(.*?)\1",
        re.DOTALL,
    )
    match = pattern.search(html)
    return match.group(2).strip() if match else None


def parse_json_or_jsonp(text: str) -> Dict[str, Any]:
    source = text.lstrip("\ufeff").strip()
    if source.startswith("{"):
        value = json.loads(source)
    else:
        match = re.fullmatch(
            r"[A-Za-z_$][\w.$]*\s*\(\s*(\{.*\})\s*\)\s*;?",
            source,
            re.DOTALL,
        )
        if not match:
            raise ValueError("invalid_jsonp")
        value = json.loads(match.group(1))

    if not isinstance(value, dict):
        raise ValueError("invalid_payload")
    return value


def extract_mark_code(item: Any) -> Optional[str]:
    if not isinstance(item, dict):
        return None
    client_data = item.get("_cd")
    if client_data is None:
        return None
    parts = str(client_data).split("_")
    return parts[-1].strip() if len(parts) >= 2 else None


def diagnose_mark_items(data: Any) -> Tuple[int, int, List[int]]:
    if data is None or data == []:
        return 0, 0, []
    if not isinstance(data, dict):
        raise ValueError("invalid_mark_data")

    matched: List[int] = []
    for item_id, item in data.items():
        match = re.fullmatch(r"\d+", str(item_id).strip())
        mark_code = extract_mark_code(item)
        if not match or mark_code is None or mark_code in NON_MARK_CODES:
            continue

        horse_number = int(match.group(0))
        if 1 <= horse_number <= 18:
            matched.append(horse_number)

    matched = sorted(set(matched))
    return len(data), len(matched), matched


def run_diagnostic() -> Dict[str, Any]:
    result = new_result()
    credentials, credential_status = get_credentials()
    if credentials is None:
        result["markApiStatus"] = credential_status
        return result
    login_id, password = credentials

    if requests is None:
        result["markApiStatus"] = "requests_unavailable"
        return result

    session = requests.Session()
    session.headers.update({
        "User-Agent": IPHONE_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.4",
        "Cache-Control": "no-cache",
    })

    try:
        login_page = session.get(
            LOGIN_PAGE_URL,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        login_page.raise_for_status()
    except Exception:
        result["markApiStatus"] = "login_page_request_failed"
        return result

    login_page_html = response_text(login_page)
    update_final_location(result, login_page.url)
    forms = parse_forms(login_page_html)
    result["formCount"] = len(forms)
    form = select_login_form(forms)
    diagnostic_form = form or select_diagnostic_form(forms)
    if diagnostic_form is not None:
        result["formMethod"] = str(diagnostic_form.get("method") or "").lower()
        result["inputNames"] = list(dict.fromkeys(
            item["name"]
            for item in diagnostic_form["inputs"]
            if item.get("name")
        ))
        diagnostic_action_url = urljoin(
            login_page.url,
            diagnostic_form.get("action") or login_page.url,
        )
        diagnostic_action_location = urlparse(diagnostic_action_url)
        result["formActionHost"] = diagnostic_action_location.hostname or ""
        result["formActionPath"] = diagnostic_action_location.path or "/"
    if form is None:
        result["markApiStatus"] = "login_form_not_found"
        return result

    action_url = urljoin(login_page.url, form.get("action") or login_page.url)
    if form.get("method") != "post" or not is_netkeiba_https_url(action_url):
        result["markApiStatus"] = "untrusted_login_form"
        return result

    payload = make_login_payload(form, login_id, password)
    login_origin = urlparse(login_page.url)
    origin = f"{login_origin.scheme}://{login_origin.netloc}"
    try:
        login_response = session.post(
            action_url,
            data=payload,
            headers={"Referer": login_page.url, "Origin": origin},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        login_response.raise_for_status()
    except Exception:
        result["markApiStatus"] = "login_request_failed"
        return result
    finally:
        # POST本文を保持する変数から認証情報を速やかに外す。
        payload.clear()
        login_id = ""
        password = ""

    update_final_location(result, login_response.url)
    login_html = response_text(login_response)
    result["authenticatedMarkerFound"] = has_authenticated_marker(login_html)
    if login_failed(login_response.url, login_html):
        result["markApiStatus"] = "login_failed"
        return result
    result["loginSuccess"] = True

    # Safari版出馬表と同じ印モードを、netkeiba全サブドメイン向けに設定する。
    session.cookies.set("mark_mode", "mark", domain=".netkeiba.com", path="/")
    try:
        race_response = session.get(
            RACE_URL,
            headers={"Referer": login_response.url},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        race_response.raise_for_status()
    except Exception:
        result["markApiStatus"] = "race_request_failed"
        return result

    if not is_netkeiba_https_url(race_response.url):
        result["markApiStatus"] = "untrusted_race_redirect"
        return result

    race_html = response_text(race_response)
    action_api_url = extract_javascript_string(race_html, "_action_api_url")
    cart_group = extract_javascript_string(race_html, "_shutuba_cart_group")
    if not action_api_url or not cart_group:
        result["markApiStatus"] = "mark_api_config_not_found"
        return result

    action_api_url = urljoin(race_response.url, action_api_url)
    if (
        not is_netkeiba_https_url(action_api_url)
        or cart_group != f"horse_{TARGET_RACE_ID}"
    ):
        result["markApiStatus"] = "invalid_mark_api_config"
        return result

    api_params = {
        "pid": "api_post_social_cart",
        "input": "UTF-8",
        "output": "jsonp",
        "action": "get",
        "group": cart_group,
        "callback": JSONP_CALLBACK,
        "_": str(int(time.time() * 1000)),
    }
    try:
        mark_response = session.get(
            action_api_url,
            params=api_params,
            headers={
                "Referer": race_response.url,
                "Accept": "application/javascript, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        mark_response.raise_for_status()
    except Exception:
        result["markApiStatus"] = "mark_api_request_failed"
        return result

    if not is_netkeiba_https_url(mark_response.url):
        result["markApiStatus"] = "untrusted_mark_api_redirect"
        return result

    try:
        api_payload = parse_json_or_jsonp(response_text(mark_response))
    except Exception:
        result["markApiStatus"] = "invalid_jsonp"
        return result

    api_status = str(api_payload.get("status") or "").strip().upper()
    if api_status == "NG":
        result["markApiStatus"] = "ng"
        return result
    if not api_status:
        result["markApiStatus"] = "missing_status"
        return result

    try:
        item_count, target_count, matched_numbers = diagnose_mark_items(
            api_payload.get("data")
        )
    except Exception:
        result["markApiStatus"] = "invalid_mark_data"
        return result

    result["markItemCount"] = item_count
    result["targetRaceMarkCount"] = target_count
    result["matchedHorseNumbers"] = matched_numbers
    if target_count > 0:
        result["markApiStatus"] = "success"
        result["authenticatedMarkerFound"] = True
    elif item_count == 0:
        result["markApiStatus"] = "success_empty"
    else:
        result["markApiStatus"] = "success_no_target_marks"
    return result


def main() -> None:
    try:
        result = run_diagnostic()
    except Exception:
        # 予期しない例外でも認証情報やHTTP内容を含むtracebackを表示しない。
        result = new_result()
        result["markApiStatus"] = "unexpected_error"
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
