"""STEP3の抽出条件を再利用したnetkeiba出馬表HTMLパーサー。"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from bs4 import BeautifulSoup, Tag


VALID_MARKS = {"◎", "◯", "▲", "△", "☆", "注", "✓"}
MARK_ALIASES = {"○": "◯", "✔": "✓"}
HORSE_NAME_SELECTORS = (
    '.HorseInfo a[href*="/horse/"]',
    '.HorseInfo a[href*="horse"]',
    ".HorseInfo .HorseName",
    ".HorseInfo a",
    'a[href*="db.netkeiba.com/horse/"]',
    'a[href*="horse"]',
    ".HorseName",
    '[class*="HorseName"]',
    '[class*="horse_name"]',
    '[class*="Horse_Name"]',
)
MARK_SELECTORS = (
    ".selectBox.expanded",
    ".selectBox",
    ".Horse_Select select",
    'select[name*="mark"]',
)


class RaceParseError(Exception):
    """HTML解析時の構造化エラー。"""

    def __init__(self, error_type: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.type = error_type
        self.details = details or None


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_mark(value: Any) -> Optional[str]:
    mark = MARK_ALIASES.get(clean_text(value), clean_text(value))
    if mark == "消":
        return None
    return mark if mark in VALID_MARKS else None


def extract_horse_number(row: Tag) -> Optional[int]:
    element = row.select_one('[class*="Umaban"], .Umaban')
    match = re.search(r"\d+", clean_text(element.get_text(" ", strip=True) if element else ""))
    if match:
        return int(match.group(0))

    for element in row.find_all(True):
        class_text = " ".join(element.get("class", []))
        match = re.search(r"(?:^|\s)Umaban(\d+)(?:\s|$)", class_text)
        if match:
            return int(match.group(1))
        match = re.search(r"(?:^|\s)Waku(\d+)(?:\s|$)", class_text)
        if match:
            text_match = re.search(r"\d+", clean_text(element.get_text(" ", strip=True)))
            return int(text_match.group(0)) if text_match else int(match.group(1))
    return None


def _is_horse_name_like(text: str) -> bool:
    if len(text) < 2 or len(text) > 40:
        return False
    if re.fullmatch(r"[\d０-９\s.,+\-()（）]+", text):
        return False
    if re.fullmatch(r"[☆★◎◯○▲△注✓✔消\-—_→←▶◀●□■◇◆♘♞]+", text):
        return False
    if not re.search(r"[A-Za-zぁ-んァ-ヶー一-龠々]", text):
        return False
    compact = re.sub(r"\s+", "", text)
    return compact not in {
        "馬情報", "競走馬情報", "詳細", "プロフィール", "お気に入り馬登録",
        "お気に入り", "登録", "編集", "馬メモ", "画像", "写真",
    }


def _score_horse_name(text: str, element: Tag, selector_priority: int, source_priority: int) -> int:
    href = clean_text(element.get("href", "")).lower()
    class_name = " ".join(element.get("class", [])).lower()
    score = selector_priority * 4 + source_priority
    if "/horse/" in href:
        score += 100
    elif "horse" in href:
        score += 70
    if any(value in class_name for value in ("horsename", "horse_name", "horse-name")):
        score += 45
    if element.find_parent(class_="HorseInfo"):
        score += 30
    if re.fullmatch(r"[ァ-ヶー]+", re.sub(r"\s+", "", text)):
        score += 24
    elif re.search(r"[ぁ-んァ-ヶー一-龠々A-Za-z]", text):
        score += 15
    if 2 <= len(text) <= 18:
        score += 18
    if not re.search(r"\s", text):
        score += 8
    if re.search(r"お気に入り|プロフィール|登録|編集|詳細", text):
        score -= 80
    return score


def extract_horse_name(row: Tag, number: int) -> str:
    candidate_elements: List[Tuple[Tag, int]] = []
    seen_elements = set()

    def add_element(element: Optional[Tag], priority: int) -> None:
        if element is None or id(element) in seen_elements:
            return
        seen_elements.add(id(element))
        candidate_elements.append((element, priority))

    for index, selector in enumerate(HORSE_NAME_SELECTORS):
        for element in row.select(selector):
            add_element(element, len(HORSE_NAME_SELECTORS) - index)
    for link in row.find_all("a", href=True):
        if "horse" in clean_text(link.get("href")).lower():
            add_element(link, 5)

    candidates: List[Tuple[int, str]] = []
    seen_candidates = set()
    for element, selector_priority in candidate_elements:
        sources: List[Tuple[Any, int]] = [
            (element.get_text(" ", strip=True), 25),
            (element.get("aria-label"), 18),
            (element.get("title"), 16),
            (element.get("data-horse-name") or element.get("data-name"), 15),
        ]
        for child in element.select("img[alt], span, strong, b"):
            sources.append((child.get_text(" ", strip=True) or child.get("alt"), 30))
        for raw_value, source_priority in sources:
            text = clean_text(raw_value).replace("\u200b", "").replace("\ufeff", "")
            text = re.sub(r"のデータベース$", "", text).strip()
            if not _is_horse_name_like(text) or text in seen_candidates:
                continue
            seen_candidates.add(text)
            candidates.append((_score_horse_name(text, element, selector_priority, source_priority), text))

    if not candidates:
        links = [{
            "textContent": clean_text(link.get_text(" ", strip=True)),
            "href": clean_text(link.get("href")),
            "className": " ".join(link.get("class", [])),
        } for link in row.find_all("a")]
        raise RaceParseError("HORSE_NAME_NOT_FOUND", f"馬番{number}の馬名を取得できませんでした。", {
            "number": number,
            "links": links,
        })
    candidates.sort(key=lambda item: (-item[0], len(item[1])))
    return candidates[0][1]


def _mark_text(element: Tag) -> str:
    if element.name == "select":
        selected = element.select_one("option[selected]")
        if selected:
            return clean_text(selected.get_text(" ", strip=True))
        value = clean_text(element.get("value"))
        if value:
            return value
        # 生HTMLにselected属性がない場合、初期選択肢しか判定できないため空印を優先する。
        option = element.find("option")
        return clean_text(option.get_text(" ", strip=True) if option else "")
    return clean_text(element.get_text(" ", strip=True))


def extract_mark(row: Tag) -> Tuple[Optional[str], bool]:
    for selector in MARK_SELECTORS:
        element = row.select_one(selector)
        if element:
            return normalize_mark(_mark_text(element)), True
    return None, False


def get_horse_rows(soup: BeautifulSoup) -> List[Tag]:
    rows = []
    for row in soup.select(".HorseList"):
        if row.select_one('.HorseInfo, [class*="Umaban"], .Horse_Select'):
            rows.append(row)
    return rows


def parse_race_html(html: str, expected: Dict[str, Any]) -> Dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    rows = get_horse_rows(soup)
    if not rows:
        raise RaceParseError("HORSE_ROWS_NOT_FOUND", ".HorseListを取得できませんでした。")

    horses: List[Dict[str, Any]] = []
    mark_control_count = 0
    for index, row in enumerate(rows, start=1):
        number = extract_horse_number(row)
        if number is None:
            raise RaceParseError("HORSE_NUMBER_NOT_FOUND", f"{index}行目の馬番を取得できませんでした。", {"row": index})
        name = extract_horse_name(row, number)
        mark, has_control = extract_mark(row)
        if has_control:
            mark_control_count += 1
        if mark:
            horses.append({"number": number, "name": name, "mark": mark})

    if mark_control_count == 0:
        raise RaceParseError(
            "AUTHENTICATED_MARKS_UNAVAILABLE",
            "出馬表HTMLに印入力DOMがありません。PythonistaのHTTP通信へSafariのログイン状態が共有されていない可能性があります。",
            {"horseRows": len(rows)},
        )
    if not horses:
        raise RaceParseError("NO_VALID_MARKS", "有効な印が1頭も設定されていません。")
    if sum(1 for horse in horses if horse["mark"] == "◎") > 1:
        raise RaceParseError("DUPLICATE_HONMEI", "◎が2頭以上設定されています。")

    return {
        "raceName": clean_text(expected.get("raceName")),
        "raceTime": clean_text(expected.get("raceTime")),
        "raceId": clean_text(expected.get("raceId")),
        "horses": horses,
    }
