# iPhone本番運用

## 通常の起動方法

推奨：Safariで `https://10uver19.github.io/shinba-challenge/` を開き、共有 →「ホーム画面に追加」を実行します。以後はホーム画面の「新馬戦チャレンジ」から開始できます。

Safariのお気に入りから本番URLを直接開いても利用できます。旧「新馬戦取得」および旧「Pythonista起動」ショートカットは通常運用では使用しません。

通常運用ではホーム画面のPWAアイコンまたはSafariの本番URLから開始し、Webアプリが必要なときだけPythonistaを起動します。requestには `appId: "shinba-challenge"` と本番 `returnUrl` が入り、処理後は `?pythonistaResult=1` を付けたGitHub Pagesへ復帰します。

復帰直後のClipboard API自動読込がiOSに拒否された場合は、画面の「Pythonistaの取得結果を読み込む」を1回押します。通常運用でJSONの手動貼り付けは不要です。

PWAとして使う場合は本番URLをSafariで開き、共有 →「ホーム画面に追加」を実行します。この場合はホーム画面のPWAアイコンだけでも開始できます。

## Pythonistaへ配置する本番ファイル

同じフォルダへ次を配置します。

- `shinba_challenge.py`
- `netkeiba_newcomer_client.py`
- `netkeiba_webview_client.py`
- `netkeiba_memo_client.py`

既存の診断ファイルは通常運用では起動しません。

## HTTP版からHTTPS版への履歴移行

1. 旧HTTP版で「バックアップを書き出す」
2. HTTPS版を開く
3. 「履歴のバックアップ / 復元」→「バックアップを読み込む」
4. 日付件数と過去Storyを確認

同じ日付だけ更新され、ほかの日付は保持されます。
