# 街のスマホ相談士｜Field Operations Knowledge Base

この `docs/` は、コードやサイト実装とは分けて、現場で得た運営知識・相談事例・検証結果を蓄積するための正本です。

## 記録の3層

1. **Field Tests**  
   相談会・地域実証など、「何を試し、何が起き、何を学んだか」を残す。

2. **Case Notes**  
   個人を特定できない形に匿名化した、実際の相談・アフターケア事例を残す。

3. **Operations**  
   個別事例から抽出した、再現可能な相談対応フローや判断基準を標準化する。

## 基本原則

- 個人名・電話番号・住所・所属など、相談者を特定できる情報は保存しない。
- SMSやLINEなど、相談者とのやり取りのスクリーンショット原本は保存しない。
- 数字や結果は、成功に見せるために加工しない。
- 「事実」「解釈」「仮説」「次回アクション」を分けて記録する。
- コード変更は `CHANGELOG.md`、現場知見は `docs/` に分離する。
- 実証は1回で結論を出さず、条件を変えながら比較する。

## 現在の記録

### Field Tests
- [FT-001 西浜スマホ相談会 2026-09-22](./field-tests/FT-001-nishihama-2026-09-22.md)
- [Field Test Template](./field-tests/template.md)

### Case Notes
- [CF-001 iPhone復旧画面から正規サービスへ接続](./case-notes/CF-001-iphone-recovery-escalation.md)

### Operations
- [Consultation Triage v0.1](./operations/consultation-triage-v0.1.md)

---

## サービス定義（現時点）

> 何でも直す人ではなく、まず相談できる人。  
> 自分で解決できることは一緒に。  
> 専門対応が必要なら、適切な場所へつなぐ。  
> **スマホのかかりつけ医。**

この定義は固定ではなく、今後の現場実証を通じて更新する。
