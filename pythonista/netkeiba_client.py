"""netkeiba出馬表を順番に取得するHTTPクライアント。"""

from __future__ import annotations

from typing import Any, Dict, Optional

import requests


DEFAULT_TIMEOUT = 20
IPHONE_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
    "Mobile/15E148 Safari/604.1"
)


class NetkeibaClientError(Exception):
    """HTTP取得時の構造化エラー。"""

    def __init__(self, error_type: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.type = error_type
        self.details = details or None


class NetkeibaClient:
    """1つのSessionで複数レースを取得する。Safari Cookieは自動共有されない。"""

    def __init__(self, timeout: int = DEFAULT_TIMEOUT):
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": IPHONE_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.4",
            "Cache-Control": "no-cache",
        })

    def get_html(self, url: str) -> str:
        if not isinstance(url, str) or not url.startswith(("https://race.sp.netkeiba.com/", "https://race.netkeiba.com/")):
            raise NetkeibaClientError("INVALID_RACE_URL", "netkeibaの出馬表URLではありません。", {"url": url})
        try:
            response = self.session.get(url, timeout=self.timeout)
            response.raise_for_status()
        except requests.Timeout as error:
            raise NetkeibaClientError("HTTP_TIMEOUT", "出馬表の取得がタイムアウトしました。", {"url": url}) from error
        except requests.RequestException as error:
            raise NetkeibaClientError("HTTP_REQUEST_FAILED", "出馬表のHTTP取得に失敗しました。", {
                "url": url,
                "reason": str(error),
            }) from error

        response.encoding = response.apparent_encoding or response.encoding or "utf-8"
        html = response.text
        if not html.strip():
            raise NetkeibaClientError("EMPTY_RESPONSE", "出馬表HTMLが空です。", {"url": url})
        return html
