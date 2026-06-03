# Changelog

スマホ相談士サイトの変更履歴。リリースされていない変更は `[未リリース]` セクションに記録する。GAS本体はリポジトリ外のため、GAS変更分も別途 Git でバージョン管理することを推奨。

---

## [未リリース]

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
