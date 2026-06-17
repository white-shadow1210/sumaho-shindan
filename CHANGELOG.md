# Changelog

スマホ相談士サイトの変更履歴。リリースされていない変更は `[未リリース]` セクションに記録する。GAS本体はリポジトリ外のため、GAS変更分も別途 Git でバージョン管理することを推奨。

---

## [未リリース]

### 2026-06-17  Google Maps API キー差し替え（漏洩対応）
- GitHub Secret scanning で検出された「Google API Key #1」漏洩への対応
- 旧キー `AIzaSyDeC5...Rienk` → 新キー `AIzaSyBISDa...eE48I` に置換（4箇所）
  - `chiiki.html:350`（定数定義）／ `chiiki.html:714`（SDK script src）
  - `map.html:313`（CONFIG内定義）／ `map.html:636`（SDK script src）
- 旧キー残存：grep 全件 → **0件**（リポジトリ全体）
- 新キーは Google Cloud 側で以下の制限が事前設定済み：
  - アプリ制限：ウェブサイト `https://white-shadow1210.github.io/*`
  - API制限：Maps JavaScript API / Geocoding API / Places API / Places API (New)
- GAS / Notion / トークン / 他HTML：変更なし
- デプロイ：静的HTMLのみ → **GitHub Pages反映で完了**（GAS再デプロイ不要）
- マージ後の手動手順（龍之介）：地図動作確認 → Google Cloud で旧キーをrevoke → GitHub Secret scanning alert を「Close as → revoked」

### 2026-06-16  Task 2: ポイント特典を名誉系に統一 + 閾値を [20, 30, 40, 60] へ
- `gas/main.gs` のマイルストーン制度から **割引クーポンを完全撤廃**し、名誉系（バッジ・認定証）のみに統一
- 閾値変更：`[10, 20, 30, 50]` → `[20, 30, 40, 60]`
- 新ラベル（バッジ名は仮置き）：
  - **20pt** 「まちの仲間」バッジ
  - **30pt** 「まちの発見者」バッジ
  - **40pt** 「まちの常連さん」バッジ
  - **60pt** 「吉田町サポーター認定証」
- 変数名リネーム：`couponMap` → `milestoneMap`（実態と名称の乖離を解消）。参照側2箇所（card3 / card6 の「次の特典」表示）も同時更新
- `addMachiPoint` 内の到達お祝いメッセージ4件を新閾値・新ラベルに置換。`10%割引クーポン` / `30%割引クーポン` / `10ptクーポン` 文言は完全削除
- 維持：到達push のロジック（`currentPoints < m.pt && newPoints >= m.pt` 判定）、`pushToLine_` 経由の送信、「獲得チャンス」表示（実際の付与ルール）、料金プラン関連の「適用割引」、プレ会員バッジ
- デプロイ：doPost 経路の変更のため **Web再デプロイ必須**

### 2026-06-16  Task 1: 署名ノイズ抑制 + 友だち追加通知の新設
- **(A) `verifyLineSignature` の通知ノイズ抑制**：`!secret || !signature` の単一分岐を2つに分割
  - `!secret`（LINE_CHANNEL_SECRET 未設定＝本物の設定ミス）：snippet を `channel_secret_missing` に変更して通知維持
  - `!signature`（GAS doPost が HTTP ヘッダーを読めず常時発生）：通知抑制、戻り値 `true` のみ
  - hash不一致 / 例外 の通知は無変更
- **(B) follow イベントで新規登録時に運営者へ通知**：`if (existing.length === 0)` 内の Notion ページ作成直後に `pushToOperator_({ type:'text', text:'🎉 新しい友だちが追加されました：' + displayName })` を追加
  - 既存ユーザーの再フォロー時は発火しない（`existing.length === 0` の中で実行）
  - Notion ページ作成と独立した try/catch で、通知失敗が後続のプレ会員 push やフォロー処理を止めない
- 影響：すべて追加・分岐分割のみ。既存挙動（戻り値、Notion 書込み、プレ会員 push）は無変更
- デプロイ：doPost 経路の変更のため **Web再デプロイ必須**

### 2026-06-16  Task 3: 診断ポイントの二重付与を1回に統一
- `gas/main.gs` 内、`handleWebForm` の診断分岐から `addMachiPoint(data.lineUserId, 3, "スマホ診断送信")` を削除（1行）
- 背景：1回の診断で `"スマホ診断送信"`（フォーム送信時 +3）と `"スマホ診断完了"`（LINEで「カルテ診断完了」送信時 +3）の両方が発火し、合計 +6 が付与されていた
- 維持：`linkLineIdToCustomer` 内の2箇所（相互排他）の `"スマホ診断完了"` +3 は残置 → 1回の診断で +3 単発に統一
- 残置：`historyText` 生成、`upsertCustomerMaster` 呼び出し、Cache 保存（`diag_latest_tel` / `diag_tel_*`）はすべて無変更
- 他の `addMachiPoint` 呼び出し（地域発見 +3 / 位置情報 +1 / 困りごと相談 +2 / 予約 +5 / まちなか発見 +3）にも一切影響なし
- デプロイ：doPost 経路の変更のため **Web再デプロイ必須**

claude/richmenu-6button
### 2026-06-10  リッチメニュー1枚6ボタン化（タブ撤去）
- `gas/main.gs` のリッチメニュー関連を、メニューA/B + タブ切替 から **1枚6ボタン構成**に置換
- 定数：`MENU_A_FILE_ID` / `MENU_B_FILE_ID` を撤去し、`MENU_FILE_ID = "14L3wTKx0zUdLlyfaFG6cSiaXs0SYv8M-"` に一本化
- 関数：
  - `setupRichMenus()` を 1枚版に書き換え：デフォルト解除 → alias 掃除 → 既存メニュー全削除 → 新メニュー作成 + 画像アップ + デフォルト設定 → `RICHMENU_ID` を Properties 保存 + 旧 A/B キー削除
  - `buildMenuAConfig` / `buildMenuBConfig` を撤去し、`buildMenuConfig()` 新設（2500×1686、見出し帯 y=0〜210 はタップ不感、6ボタンのみ）
  - `deleteAllRichMenus_(token)` 新設（既存リッチメニュー全削除ヘルパー）
- ボタン配置：上段 [無料診断 / 料金・メニュー / WEB予約]、下段 [初めての方へ / マイページ / 直接相談]
- 座標：列幅 835 / 831 / 834（合計2500）／ 縦 210 + 687 + 789（合計1686）
- 維持：`createRichMenu` / `uploadImageFromDrive` / `resetRichMenuAliases` / `listRichMenus` 無変更。postback ハンドラの `tab_noop` / `switch_to_menu_a` / `switch_to_menu_b` 分岐は no-op として残置
- デプロイ：Web アプリ再デプロイ**不要**。GAS エディタ反映後 `setupRichMenus()` を1回実行するだけで反映
### 2026-06-11  karte.html 送信1本化（顧客マスター行重複の解消）
- `submitKarte()` 内で行っていた3送信（karte / simulation / app_check）を **karte 1本に統合**
- 削除：`var simData = ...` / simData fetch / `if (apps.used || apps.transfer)` ブロック（appReq 定義 + fetch）
- 維持：`karteData` 送信、`var apps = getAppSummary()`、try/catch 構造、成功オーバーレイ表示、ボタン状態復帰
- 背景：GAS側で電話番号のハイフン差により照合が失敗 → 3送信がそれぞれ別の顧客マスター行を作成 → バッテリー/ストレージ等のデータが複数行に散る不具合
- 影響：simulation / app_check の Notion 書込みは karteData 1本にすべて含まれる（料金/端末/アプリ全項目）ため、機能欠落なし
- スコープ：karte.html のみ。GAS / Notion / トークン変更なし
main

### 2026-06-08  upsertCustomerMaster 新規作成ブロックに欠落9項目を追加（案②）
- `gas/main.gs` の `upsertCustomerMaster` 関数 内、**新規作成（createPayload）ブロック**に以下9項目を追加：
  - バッテリー状態 / ストレージ空き / 買い替え時期 / 利用中アプリ / 移行必須アプリ
  - スマホカルテ更新日 / 現在の月額 / 提案後月額 / 月額節約額
- 目的：既存ページ更新ブロックと書き込み内容を等価にし、「カルテ初回送信＝Notion新規作成」のケースで未記録になる構造的欠落を解消
- 影響：追加のみ（既存挙動は破壊しない）。構文チェック OK
- 龍之介手作業：GAS エディタに反映＋既存デプロイ更新（デプロイURL不変厳守）

### 2026-06-08  karte.html トークン置換（マイページ未反映バグの修正・案①）
- karte.html:1233 のハードコード値 `smaho2026sakurai` を新トークン `1d9dc0f0780a4fe18a8d46ddfac6971d` に置換
- 原因：karte.html だけ Task 2 のフロント置換から漏れていた → 旧トークンで送信 → GAS で Unauthorized 拒否 → device/battery/storage/cost 等が一切 Notion に書き込まれず、マイページが「未記録」表示
- 影響範囲：karte.html 1ファイル1行のみ
- 確認：grep で `smaho2026sakurai` 残存ゼロ、新トークン1ヶ所

### 2026-06-03  Task 2 GASセキュリティ強化（実装）
- `gas/main.gs` を Git 管理下に取り込み（origin/main をマージ）
- NG_WORDS を2層化（NG_WORDS_REJECT / NG_WORDS_WARN）。NG_WORDS は後方互換で REJECT を参照
- 新規構成：
  - 定数：`STANDARD_CARRIERS`, `CHIIKI_CATEGORIES`, `PAYLOAD_SCHEMAS`（8 formType）
  - 関数：`validatePayload_`, `isTokenValid_`, `checkNGWords_`, `pushToLine_`,
    `pushToOperator_`, `pushAnomalyAlert_`, `buildAnomalyFlex_`
- 既存関数の拡張：
  - `handleWebForm`：トークン照合を `isTokenValid_` 経由（新+旧併用ロジック）、スキーマ検証、各拒否点で `pushAnomalyAlert_` フック
  - `handleChiikiPost`：スキーマ検証＋NGワードを `checkNGWords_` の2層判定に
  - `handleChiikiLike` / `handleOshiraseReaction`：スキーマ検証フック
  - `verifyLineSignature`：戻り値は据置、失敗ケースのみ観測通知
  - `addMachiPoint`：内部 Push を `pushToLine_` に置換（DRY化、挙動互換）
- severity 既定は `warn`（受理＋通知）。enum/必須漏れ等の構造的エラーのみ `reject`
- フロント7ファイルへの実トークン置換・デプロイは龍之介が手作業で実施
- 置換対象（フロントの `token: 'smaho2026sakurai'` 出現箇所）：
  - `karte.html:1144`（grep `smaho2026sakurai` で確認）
  - `index.html:425`（`SECRET_TOKEN` 定数経由）
  - `app-check.html:338`
  - `reserve.html` / `chiiki.html` / `oshirase.html` / `map.html` は別GASまたは token送信なし → 主たる置換対象は karte / index / app-check の3ファイル

### 2026-06-01  karte.html 通話オプション/60歳以上割 追加（フロント）
- 料金タブに通話オプション欄を追加（プラン単位の出し分け・1つ選択・合計に加算）
- Y!mobile / UQ の割引先頭に「60歳以上割（-1,100）」を追加
- payload(formType:'karte') に callOptionCur / callOptionProp を追加
- メモに「現在通話 / 提案通話」を記録

### 2026-06-01  Task1 DB設計FIX（設計のみ・未実装）
- 6DB設計を確定。③ Plan Breakdown に call_option / call_option_fee を追加し monthly_total 式を更新
- ⑤ App Migration の karte リレーション先を「カルテ履歴DB」に修正
- ⑤ App Migration の app_name 候補を karte.html 実14アプリ＋その他に統一
- ② Karte History / ③ Plan Breakdown の carrier Select 候補を標準化
- DB作成方法は GAS 自動生成を採用（実行はローンチ後）
- `gas/notion-db-setup.gs` を新規追加（6DB生成スクリプト・作成順序：DB → Relation → Formula → Rollup → Reverse rename）
- `CHANGELOG.md` を新規追加
