def main() -> None:
    return_url = PRODUCTION_WEB_APP_URL
    action = ""
    request_date = ""

    try:
        raw_text = _load_text_from_shortcuts()

        # =========================================
        # 一時デバッグ
        # Webアプリ → Pythonistaで実際に何を受け取ったか確認
        # =========================================
        print("")
        print("========== RECEIVED FROM WEB ==========")
        print(raw_text)
        print("=======================================")
        print("")

        try:
            request_source = json.loads(raw_text)
        except (TypeError, json.JSONDecodeError) as error:
            raise InputError(
                "INVALID_JSON",
                "入力JSONの形式が正しくありません。"
            ) from error

        if not isinstance(request_source, dict):
            raise InputError(
                "INVALID_PAYLOAD",
                "JSONオブジェクトを指定してください。"
            )

        # さらに判定結果も表示
        print("========== REQUEST CHECK ==========")
        print("keys:", list(request_source.keys()))
        print("action:", request_source.get("action"))
        print("date:", request_source.get("date"))
        print("appId:", request_source.get("appId"))
        print("returnUrl:", request_source.get("returnUrl"))
        print("selectedRaces exists:", "selectedRaces" in request_source)
        print("===================================")
        print("")

        action = _requested_action(raw_text)
        request_date = str(
            request_source.get("date") or ""
        ).strip()

        return_url = _normalize_return_url(
            request_source.get("returnUrl"),
            request_source.get("appId"),
            request_source.get("returnOrigin"),
        )

        if action == NEWCOMER_LIST_ACTION:

            print("[MODE] collectNewcomerList")

            payload = _normalize_newcomer_payload(
                request_source
            )

            return_url = payload["returnUrl"]

            output = collect_newcomer_list_with_webview(
                payload["date"]
            )

        elif action in MEMO_SYNC_ACTION_ALIASES:

            print("[MODE] syncHorseMemos")

            payload = _normalize_memo_payload(
                request_source
            )

            return_url = payload["returnUrl"]

            output = sync_horse_memos_with_webview(
                payload
            )

        elif action in {"", SELECTED_RACES_ACTION}:

            print("[MODE] collectSelectedRaces")
            print(
                "[DEBUG] action is:",
                repr(action)
            )

            payload = _normalize_payload(
                raw_text
            )

            return_url = payload["returnUrl"]

            output = collect_races(
                payload
            )

        else:

            raise InputError(
                "UNSUPPORTED_ACTION",
                "actionを確認してください。"
            )

    except Exception as error:

        output = {
            "success": False,
            "action": action or None,
            "date": request_date or None,
            "error": _structured_error(error),
        }

    output_json = json.dumps(
        output,
        ensure_ascii=False,
        separators=(",", ":")
    )

    if clipboard is not None:
        try:
            clipboard.set(output_json)
        except Exception:
            pass

    print("")
    print("========== FINAL RESULT ==========")
    print(output_json)
    print("==================================")
    print("")

    _return_to_web_app(
        return_url
    )


if __name__ == "__main__":
    main()
