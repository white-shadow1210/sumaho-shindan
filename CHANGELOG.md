# Changelog

スマホ相談士サイトの変更履歴。リリースされていない変更は `[未リリース]` セクションに記録する。GAS本体はリポジトリ外のため、GAS変更分も別途 Git でバージョン管理することを推奨。

---

## [未リリース]

### 2026-10-22  セキュリティ強化(1/3): LINE紐付けの保護(PR-A)
- **何が守られたか**: 他人の電話番号を知っているだけで、自分のLINEアカウントをその人の顧客マスターへ勝手に紐付け、LINEの「マイページ」でその人の情報を見られてしまう脆弱性を修正。
- `index.html`の診断フォーム送信時に`liff.getIDToken()`を取得して送信するようにし、GAS側で`https://api.line.me/oauth2/v2.1/verify`に照会して検証済みの`sub`と一致した場合だけ`lineUserId`を信頼する(`verifyLineIdToken_` / `resolveVerifiedLineUserId_`)。検証できない(トークン無し・期限切れ・不一致)場合は`lineUserId`を「なし」として扱うが、**診断フォームの送信自体は止めない**。IDトークンはNotion・メール・ログのいずれにも保存しない。
- **診断フォーム(index.html、公開・匿名)は、電話番号による既存顧客への自動紐付けを完全に廃止**。既存顧客の特定は「IDトークン検証済みのLINE_useridの完全一致」のみで行う(`upsertCustomerMasterByLineId`。2件以上の一致はあいまいとして更新せずオーナー通知)。電話番号が既存顧客と0件一致(重複なし)のときだけ、安全な新規顧客レコードを作成する。電話番号が既存顧客と1件以上一致したときは、顧客レコードを一切更新・作成せず(LINE_userid・表示名・端末情報等も含めて不変)、診断回答自体は必ず保存したうえで、オーナーへ「電話番号一致・要確認」をメール通知する(電話番号は末尾4桁のみ表示)。紐付けはオーナーがNotionで手動で行う。
- **karte.html・app-check.html・料金シミュレーション・予約フォーム(スタッフが対面で使う既存機能)は、電話番号による既存顧客の検索・更新を従来どおり維持**。これらの顧客マスター更新時も、`LINE_userid`の上書き保護(既存が空なら紐付け、同じならOK、異なる場合は上書きせずオーナー通知)は適用される。
- **診断自動返信(PR #35)のLINE宛先決定から、電話番号によるフォールバック(`findLineUserIdByPhone_`)を完全に削除**。宛先は「フォーム送信時の検証済みlineUserId」または「カルテ診断完了 #受付ID」での紐付けのみ。宛先が無い場合は【要連絡・LINE送信不可】としてオーナーへ通知し、自動送信は行わない(2時間後などの自動送信の仕組み自体は維持)。
- 予約フォーム(`data.date`+`data.time`)のポイント付与(`addMachiPoint`)は、この検証とは無関係の既存仕様のため**今回は対象外**(raw `lineUserId`を使い続ける)。
- 新しいScript Property `LINE_LOGIN_CHANNEL_ID`(LINEログイン(LIFF)チャネルのChannel ID)を追加。設定手順はPR本文に記載。
- `params.lineName`(karte.htmlの「LINE名」手入力欄)によるLINE_displayName上書きを調査。LIFFの自動取得ではなくスタッフの対面入力のため、今回の攻撃経路とは別物と判断し、未変更。
- **調査のみ(今回は実装しない)**: `chiiki.html`の投稿機能(`handleChiikiPost`)は、未検証の`liff.getProfile().userId`を信じて顧客マスターへ履歴追記・ポイント付与しており、同種のリスクがある(別PRで対応予定)。`oshirase.html`はリアクション回数制限のキーとしてのみ使用し顧客マスターへの書き込みはないため低リスク。`prices.html`はStripeの`client_reference_id`に設定するだけでGAS側が読み戻すコードは存在せず、リスクなし。詳細はPR本文に記載。
- `node --test tests/regression.test.cjs`：140件合格(前回までの125件 + 新規15件)。電話番号の正規化同一性、LINE_useridの上書き保護テーブル、診断フォームでの電話番号一致時の非紐付け+オーナー通知+保存成功、正規LINE認証+他人の電話番号でも他人のレコードを一切読み書きしないこと、LINE_userid完全一致のあいまい検出、自動返信の電話番号フォールバック廃止、IDトークンが一切保存されないことを検証。
- `mitsumori.html`・`gas/mitsumori-save.gs`は無変更。Notionへの新しい書き込み・削除は追加していない（既存の書き込み条件を厳しくしただけ）。

### 2026-10-19  スマホ診断の結果を「メール確認 → LINE自動返信」で返す
- 無料スマホ診断(`index.html`)の回答直後、お客様のLINEには「受付メッセージ」だけを送り(日中/19時以降で文面を分ける)、同時にオーナーのメールへ「回答内容・判定タイプ・LINE返信文の案・自動送信予定時刻」を送るようにした。
- 判定ロジック(付録1の6タイプ)・ワンポイント(付録3、最大2つ)・返信文(付録2)は、すべて純粋関数として実装(`judgeDiagnosisType_` / `buildDiagnosisOnePoints_` / `buildDiagnosisMessage_`)。
- オーナーがメールに返信すると、内容(OK/保留/差し替え/それ以外の文章)に従ってLINE公式から結果を送る。返信が無ければ、回答から2時間後(9:00〜18:59の回答)、または翌朝9:00(19:00〜翌8:59の回答)に、案のまま自動送信する。静穏時間(21:00〜8:59)中の返信は翌朝9:00まで持ち越し、それ以外は即時反映(日中も同様)。
- 返信メールの引用部分(Gmail/iPhone・iPadメール双方の代表的な形式)を取り除き、オーナーが書いた部分だけを判定に使う。オーナー以外からの返信は無視する。
- LINE送り先は、フォーム送信時の`lineUserId` → 「カルテ診断完了 #受付ID」イベントでの紐付け → 電話番号での顧客マスター照合(読み取りのみ)の順で決める。`index.html`は、`lineUserId`が取れなかった場合**だけ**、LINE送信文言に受付IDを付ける一行だけを変更(取れている場合の動作は無変更)。
- 送信待ち情報は、既存の`MAP_SHEET_ID`のスプレッドシートに新しいシート「診断自動返信」を作って保存(新しいScript Propertyは`OWNER_EMAIL`のみ追加)。地図・お知らせ・地域発見の公開APIはこのシートを一切読まない。
- Gmailでの送信・返信確認のため`GmailApp`を新たに使用(権限の再承認が必要。手順はPRに記載)。5分おきの新しい時間主導トリガーを1つ追加。
- `node --test tests/regression.test.cjs`：125件合格(前回までの71件 + 新規54件)。判定表の全タイプ・境界ケース、時間帯境界、静穏時間の例外、返信解析(OK/保留/差し替え/コメント・引用除去)、二重送信防止、LINE送信不可判定、公開APIからの新シート非参照を検証。
- `mitsumori.html`・`gas/mitsumori-save.gs`は無変更。Notionへの書き込み・削除は一切行っていない（読み取りのみ）。

### 2026-10-16  マイページ(LINE)のカルーセルをシンプル化(カードの一時非表示)
- LINEマイページに出るカードを「基本情報」「スマホ診断結果」「ご家族の見積もり」の3種類だけにした。「料金シミュレーション」「スマホカルテ」「アプリチェック結果」「まちつながり履歴」（TownOSのデータ修復中のため）「スマホ遍歴」は一時非表示。「基本情報」カードの「ポイント」「次の特典」の2行も、まちつながり履歴と同じデータのため同時に非表示。
- **削除ではなく非表示**。非表示にするカードを作る処理・データの読み取りコードはすべて残した。`gas/main.gs`先頭の`MYPAGE_CARD_VISIBILITY`定数1か所で、各カードのON/OFFを切り替えられる（trueに変えるだけで復活）。
- 「まちつながり履歴」専用のNotion読み出し（blocks/children API）は、カード非表示中は実行しないようにした（他の非表示カードはいずれも既存の顧客マスター読み出しの範囲内のデータのみを使うため、追加の無駄な読み出しはこの1箇所のみだった）。
- LINE Flexカルーセルの1メッセージ最大12枚への対応で使っている「ご家族の見積もり」カードの上限（5枚）は、非表示のカードを将来戻したときも安全なように変更していない。
- 「カルテ確認」キーワードで呼ばれる`replyKarteQuick`（マイページとは別の入口）が、スマホカルテ・料金シミュレーション相当のカードを単独で表示する仕組みのまま残っていることを確認。今回は変更せず、PRで報告のみ。
- `node --test tests/regression.test.cjs`：71件合格(前回までの65件 + 新規6件)。カード一覧の内容、基本情報の行の出し分け、設定ONでの復元、診断・見積もりデータが無い場合、12枚上限、顧客マスター未登録時の非クラッシュを検証。

### 2026-10-16  マイページ(LINE)のカードに「続柄・お名前」を表示
- マイページの「ご家族の見積もり」カードを、**「保存1件の中のfamily[0]だけ=1枚」から「家族1人=カード1枚」**に作り変えた。各カードの「最終作成日」の直下に、見積もり入力画面の「続柄・お名前」欄の値（例:「本人」「お父様」「長女様」）を1行表示する。
- 値が空・空白のみ・未入力時の自動プレースホルダー「（お名前未記入）」のときは行を出さない。改行・制御文字は除去し、40文字を超える場合は切り詰める。
- 入力画面(`mitsumori.html`)・保存GAS(`gas/mitsumori-save.gs`)は無変更。見積もり保存時に送られる`family[].meigi`を読み出すだけで実現でき、Notionに新しい列は不要だった。
- LINE Flexカルーセルの1メッセージ最大12枚の制約に対応：card1〜card7で既に7枚使っているため、家族カードは最大5枚まで。6人以上の家族が1回の見積もりに含まれる場合は、5枚目のカード末尾に「ほか○名は対面でご確認ください」と案内し、6人目以降のカードは作らない。
- 集計ロジックを純粋関数に分離（`sanitizeRelationName_` / `buildMitsumoriPersonRows_` / `selectDisplayedFamilyMembers_`）し、`tests/`で単体テスト。
- `node --test tests/regression.test.cjs`：65件合格(第3弾までの53件 + 新規12件)。値あり/なし・空白のみ・長い文字列・改行混入・フィールド欠落(古い保存データ)・カード枚数の12枚上限・Flex Bubble JSONの構造検証を含む。

### 2026-10-XX(Merge日)  LP改修(不安解消の追加)+「データ移行パック」名称の全ページ統一(第3弾)
- LP(`machi-sumaho-soudanshi.html`)に、利用前の不安を減らす情報を追加（ファーストビューの補足・実績バッジ・「乗り換えなくても大丈夫です」・相談事例の注記・料金の無料範囲の説明・各メニューの「相談後に残るもの」・データ移行パックの範囲・携帯ショップとの違いの比較表・6ステップの相談の流れ・「ご安心ください」ボックス・よくある質問7件・「これから取り組みたいこと」）。すべて追加のみで、既存の文言・リンク・計測コード(閲覧ビーコン・line_click・scroll50/90・端末判定・src引き継ぎ)は無変更。
- メニュー名「完全データ移行パック」を「データ移行パック」にサイト全体で統一。`prices.html`・`reserve.html`・`subscribe.html`・`jigyo_lp.html`・`kosodate.lp.html`・`biyoushitsu.lp.html`・`machi-sumaho-soudanshi.html`（本文JSON-LD含む）・`gas/main.gs`（表記のみ、判定ロジックは無変更）を更新。顧問プランの特典から「LINEでの操作質問・相談が無料」を削除（`prices.html`・`subscribe.html`・LP）。
- **計測への影響**：この改修でLPが長くなったため、Merge日以降のスクロール到達率(50%/90%)は、それ以前の数値と単純比較しない。
- `node --test tests/regression.test.cjs`：53件合格(第2弾までの45件 + 新規8件)。名称の残存チェック、FAQ件数、計測コードの残存、ASCII制約、非公開要素の混入防止を検証。
- ヘッドレスChromiumでモバイル(360/390/430)・タブレット(768)・デスクトップ(1280)の横スクロールなし・コンソールエラーなし・FAQ開閉動作・計測ビーコン(view/scroll50/scroll90/line_click)の発火を確認。

### 2026-10-08  LPの行動記録(LINE追加クリック・端末・スクロール)+ 週次メール拡張(第2弾)
- LP(`machi-sumaho-soudanshi.html`)のLINE友だち追加ボタンのクリック、スクロール到達(50%/90%)を、既存の「LP閲覧ログ」に追記するようになった。ボタンのhrefは無変更。重複防止はlocalStorage（使えない場合はページ表示中のみメモリで代用）。
- 端末種別(ios/android/pc/other)を`navigator.userAgent`から判定して送信。userAgent自体は送らない。
- 本体GAS(`gas/main.gs`)の`doGet?action=pv`に`type`(view/line_click/scroll50/scroll90、既定view)・`dev`(ios/android/pc/other、既定other)を追加。既存の`type`なし呼び出しは従来どおり`view`として記録される(後方互換)。
- 1時間あたりの書き込み上限を200件→600件に引き上げ(1閲覧あたり最大4行になるため)。
- 週次の流入レポートメールに4節を追加：①LINE友だち追加ボタン(click率)、②スクロール到達(50%/90%)、③端末の内訳、④時間帯別の閲覧数(JST)。既存の累計表・「閲覧→新規」節は無変更。
- 「閲覧」はLP閲覧ログの`種別`がview(空欄の既存行も含む)の行のみで数える。イベント行(line_click/scroll50/scroll90)を閲覧数に混ぜない。
- LP閲覧ログの取得は1回にまとめ、新設した5節すべてで使い回す。取得に失敗しても累計表は通常どおり送信し、各節には「取得失敗」と書く。
- `node --test tests/regression.test.cjs`：45件合格(第1弾までの34件 + 新規11件)。新設の集計関数(`aggregateWeeklyEventCounts_` / `buildWeeklyRateRows_` / `buildWeeklyScrollRows_` / `aggregateWeeklyDeviceBreakdown_` / `buildDeviceBreakdownRows_` / `aggregateWeeklyHourlyViews_`)を単体テスト。種別・端末が空の既存行の後方互換、イベント行が閲覧数に混ざらないことも検証。
- 反映順序：GAS(`gas/main.gs`)を先に更新し、その後にLPをMergeする。順序を逆にすると新しい記録が古いGASで「view」として記録され、閲覧数が水増しされる。`gas/mitsumori-save.gs`(保存GAS)は無変更。

### 2026-10-07  LP閲覧ログ + 週次メール拡張
- LP(`machi-sumaho-soudanshi.html`)が表示時に1回だけ、流入経路(`?src=`)を新規Notion DB「LP閲覧ログ」に記録するビーコンを追加。同日の同一端末からの再送はしない。個人を特定する情報は送らない。
- 本体GAS(`gas/main.gs`)の`doGet`に`action=pv`を追加。既存のレート制限より前で処理し、ビーコンが実際のアクセスと上限を共有しないようにした。1時間あたりの書き込み上限(200件)を設定。
- 既存の`doGet`の他の分岐(`getFreeSlot`/`getMapData`/`getOshiraseData`/`getChiikiData`/`chiikiPost`/`searchCustomer`/カレンダー)・`handleWebForm`は無変更。
- 週次の流入レポートメール(`generateSourceReport`、毎週月曜9時、宛先・件名は無変更)に「今週(直近7日)」の節を追加。流入経路ごとの閲覧数・新規登録数・会員数・閲覧→新規の割合(%)を表示。既存の累計表はそのまま残す。
- LP閲覧ログの取得に失敗しても、既存の累計表は通常どおり送信し、その節には「取得失敗」と書く。
- `node --test tests/regression.test.cjs`：34件合格(既存23件 + 新規11件)。純粋な集計関数(`aggregateWeeklySignups_` / `aggregateWeeklyPageViews_` / `buildWeeklyReportRows_`)を単体テスト。実際のNotion・LINEにはアクセスしない。
- 反映順序：GAS(`gas/main.gs`)を先に更新し、その後にLPをMerge する。`gas/mitsumori-save.gs`(保存GAS)は無変更。

### 2026-09-17  レビュー改善 第1弾：保存確認・予約表示・診断連携の取り違え防止
- 診断完了メッセージから共有の「最後の電話番号」を用いてLINEを紐付ける処理を撤去。未連携・重複は手動確認へ案内し、自動作成・統合・アーカイブをしない。
- 診断完了メッセージだけでのポイント自動付与を停止。本人と受付を一度だけ検証できる仕組みを追加するまで再開しない。
- Notion検索・書込み失敗を成功扱いしない。LINE表示名による保存失敗時の別顧客へのフォールバックを撤去。
- 診断・カルテ・予約・アプリチェックは、読み取れるJSON応答の `confirmed:true` を確認してから完了を表示。旧GASの `status:success` だけでは完了扱いしない。
- 顧客を識別できないアプリチェックは保存成功を返さない。単独ページの本人連携は次段階のため、現状は担当者への共有を案内する。
- カレンダー取得失敗時は空き枠を表示せず、再読込みを案内。古い選択もクリア。
- 会員ログイン前にメニューを選んでも20%割引を正しく計算。予約履歴の端末保存は、応答確認後だけ行う。
- 見積もりJSONの途中切断を廃止し、Notionの複数rich_textへ全文を分割保存。
- 診断の空白氏名・長すぎる相談文を送信前に検査。診断・アプリチェックの拡大禁止を解除。
- 顧客情報や予約を読み書きせず、ブラウザから応答を読めるか確認する `?action=health` を追加。
- `node --test tests/regression.test.cjs`：22件合格。実際のNotion・LINE・決済にはアクセスしない回帰テスト。
- 反映条件・制約：`docs/review-fixes-phase1.md`。GAS main と見積保存用GASの更新が必要。これだけで認証・予約重複を含むレビュー全項目が解決するわけではない。

### 2026-06-17  マイページ card4 の「買い替え目安」反映不具合を修正
- 症状：カルテで選んだ「買い替え時期の目安」がマイページ card2 / card4 に反映されない
- 原因（3つの不整合の組み合わせ）：
  - **プロパティ名**：書込み側は `「買い替え時期」`、読取り側は `「Q6_買い替え時期」`
  - **型**：書込みは rich_text、読取りは `safeSelect`（select型を期待）
  - **値の語彙**：カルテは `"⚠️ ４年以上"`（絵文字付き）、`buyMap` は `"４年以上"`（絵文字なし）
- 修正（3点・案 C）：
  - `karte.html:354`：ラジオ選択肢 `"⚠️ ４年以上"` → `"４年以上"`（語彙統一）
  - `replyMyPage` の buyTime 取得を **カルテ rich_text 優先 → 診断 select フォールバック** に変更：`safeText(p["買い替え時期"]) || safeSelect(p["Q6_買い替え時期"])`
  - `buyMap` に `"⚠️ ４年以上"` エイリアスを追加（過去の絵文字付き保存データを救済）
- スコープ：「買い替え時期」のみ修正。類似 disconnect の横断調査は次タスク
- Notion プロパティ：**変更なし**（既存「買い替え時期」rich_text と「Q6_買い替え時期」select の両方を活用）
- デプロイ：karte.html → GitHub Pages 反映 ／ gas/main.gs → **Web再デプロイ必須**（replyMyPage 経路変更）

### 2026-06-17  スマホ遍歴タイムラインをマイページ card7 に表示
- カルテのタイムラインを Notion 顧客マスターの **「スマホ遍歴」** rich_text プロパティに専用保存し、マイページのカルーセル7枚目に表示
- **karte.html**：
  - `getTimelineData()` の結果を **年順（古→新）でソート + 空エントリ除去** ＋ 年なしは末尾
  - `timelineText`（改行区切り文字列）を payload の `timeline` フィールドとして新規送信
  - memo 内の「スマホ遍歴：...」も**フェイルセーフとして据置**（GAS未デプロイ期間の情報落ち回避）
- **GAS `handleWebForm` karte 分岐**：`upsertParams.timeline = data.timeline` を追加
- **GAS `upsertCustomerMaster`**：update / create 両ブロックに `params.timeline` を「スマホ遍歴」プロパティへ書込み（既存 `memoToRichText_` を流用して 2000文字超は自動分割）
- **GAS `replyMyPage`**：
  - 新ヘルパー `safeRichText(prop)` を追加（複数 chunk の rich_text を連結して取得）
  - 新 **card7 「📲 スマホ遍歴」**（紫系 `#6c5ce7`）をカルーセルに追加。**10件まで表示**＋超過分は「…他N件」表示。データなしは「まだ記録がありません」表示
  - カルーセル枚数：6 → 7（LINE仕様上限12枚なので余裕）
- 前提：Notion 顧客マスターDB に「スマホ遍歴」プロパティ（テキスト型 = rich_text）を事前に手動追加済み
- デプロイ：karte.html → GitHub Pages 自動反映 ／ gas/main.gs → **Web再デプロイ必須**（doPost と LINE event 両経路を変更）

### 2026-06-17  カルテ memo を Notion 顧客マスター「メモ」プロパティに反映
- カルテ送信時の `data.memo`（5種類連結：基本メモ / 端末メモ / シムメモ / 今日サマリ / タイムライン / 割引）を、Notion 顧客マスターの **「メモ」** rich_text プロパティに書き込み
- 共通ヘルパー `memoToRichText_(memo)` 新設：Notion の text オブジェクト 2000文字制限に備え、2000文字ごとに自動分割（長文でも 400 サイレント失敗回避）
- `upsertCustomerMaster` の update / create **両ブロックに対称的に書込み**（PR #2 案② で確立した対称性原則を踏襲）
- `handleWebForm` の karte 分岐に `upsertParams.memo = data.memo || ''` を追加
- 設計：**最新を上書き保持**（顧客マスターは最新状態を表す原則・履歴は引き続き困りごとDB に `【相談メモ】` として残置）
- 表示：**マイページには表示しない**（内部メモ扱い・`replyMyPage` は無変更）
- 前提：Notion 顧客マスターDB に「メモ」プロパティ（テキスト型 = rich_text）を事前に手動追加済み
- デプロイ：doPost 経路の変更のため **Web再デプロイ必須**

### 2026-06-17  フォーム電話番号入力案内を「ハイフンなし」誘導に統一
- 対象3ファイル：`karte.html` / `index.html` / `reserve.html`
- 各電話番号入力欄に以下5点を一括適用：
  - `placeholder`：`090-XXXX-XXXX` / `例：090-1234-5678` → `09012345678` / `例：09012345678`
  - `inputmode="numeric"`（スマホで数字キーパッド優先表示）
  - `maxlength="11"`（携帯番号11桁を上限）
  - `oninput="this.value=this.value.replace(/[^0-9]/g,'')"`（数字以外を入力時に自動削除）
  - サブテキスト「※ ハイフンなしの半角数字でご入力ください」
- index.html は旧 `[^0-9\-]` の oninput でハイフンを許可していた箇所を `[^0-9]` に強化
- スコープ：静的HTMLのみ。GAS / Notion / トークン変更なし
- バックエンドの `normalizeTel_()`（PR #8）との二重防御：フロントで弾けなかった全角等の例外もGAS側で再正規化されるので安全
- デプロイ：GitHub Pages反映で完了。**GAS再デプロイ不要**

### 2026-06-17  電話番号のハイフン統一（新規書込みのみ・既存データmigrationは別PR予定）
- 共通ヘルパー `normalizeTel_(tel)` を新設：全角数字 `０-９` → 半角 → 非数字（ハイフン・空白・括弧等）除去
- 既存の散発的なインライン `.replace(/[^\d]/g, ...)`（4箇所）を `normalizeTel_()` に統一（挙動互換・一元管理）
  - `handlePreMemberBenefit` / `upsertCustomerMaster`（検索） / サブスク handler（検索） / 診断 fallback（Cache）
- Notion「電話番号」プロパティへの書込み6箇所すべてを `normalizeTel_()` 経由に変更
  - `upsertCustomerMaster` 新規 / `upsertCustomerMasterByLineId` 更新・新規 / handleWebForm サブスク・カルテLINE紐付け / `registerKomariFromKarte`
- 背景：書込み側が正規化されておらず、検索側（`contains: 数字のみ`）と不整合 → 「090-1234-5678」保存済みレコードへの「09012345678」フィルターが一致せず重複行を生む根本原因だった
- 影響：**新規以降の書込みはハイフン無し統一**。既存ハイフン付きレコードは別PRの一括migrationで対応予定（DRY_RUN付き）
- Notion プロパティ：型・列名すべて据置（rich_text のまま）
- デプロイ：doPost 経路の変更のため **Web再デプロイ必須**


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
