# Changelog

スマホ相談士サイトの変更履歴。リリースされていない変更は `[未リリース]` セクションに記録する。GAS本体はリポジトリ外のため、GAS変更分も別途 Git でバージョン管理することを推奨。

---

## [未リリース]

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
