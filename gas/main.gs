// ==========================================
// スマホの相談士 — 統合版 v7.0
//
// v7.0 変更点(プレ会員特典機能 + 困りごとDB報告日時修正):
//   ★ isPreLaunchPeriod 関数追加(6/8〜6/10判定)
//   ★ handlePreMemberBenefit 関数追加(プレ会員特典使用処理)
//   ★ registerKomariFromKarte: 「相談日時」→「報告日時」修正済
//   ★ Part2: LINE困りごとDB登録部分 「報告日時」修正済
//   ★ Part2: follow イベントでプレ会員自動登録 + 通知LINE
//   ★ Part2: 予約処理でhandlePreMemberBenefit呼出
//   ★ Part2: オーナー通知メールにプレ会員特典使用表示
//   ★ Part3: replyMyPage会員ステータスを3パターン表示
//
// v6.9.1 機能(流入トラッキング統合):
//   - upsertCustomerMaster に source プロパティ対応
//   - handleWebForm に流入経路取り込み処理
//   - generateSourceReport / setSourceReportTrigger
//
// v6.9 機能(karte v2 対応):
//   - upsertCustomerMaster に新プロパティ4つ追加
//     (対象者・自宅Wi-Fi・SIM構成・申込区分)
//   - LINE表示名による顧客検索ロジック追加
//   - karte送信時に困りごとDB自動転記
//
// v6.8 機能(セキュリティ強化):
//   - レート制限・画像サイズ制限・1日10件制限・NGワード検知
// ==========================================

const props = PropertiesService.getScriptProperties();
const NOTION_API_KEY     = props.getProperty("NOTION_API_KEY");
const DIAGNOSIS_DB_ID    = "333b9755785480acb1a2e46850b5edca";
const CUSTOMER_MASTER_ID = "34cb9755785480df9465d156cd572bd9";
const 困りごとDB_ID       = "34eb9755785480ea912ed485d1a23c39";
const MAP_DATABASE_ID    = props.getProperty("MAP_DATABASE_ID");
const MAP_SHEET_ID       = props.getProperty("MAP_SHEET_ID");
const IMAGE_FOLDER_ID    = props.getProperty("IMAGE_FOLDER_ID");

const FREE_SLOT_MAX_PER_MONTH = 3;

const MAX_IMAGE_BASE64_SIZE = 5 * 1024 * 1024;
const MAX_DAILY_CHIIKI_POSTS = 10;
const MAX_DAILY_KOMARI = 10;

// Task 2: NGワードを2層化
//   NG_WORDS_REJECT: 即拒否（URL短縮・露骨な詐欺定型）
//   NG_WORDS_WARN  : 受理＋運営者通知（誤検知リスクある語彙、初期はwarn運用）
// NG_WORDS（後方互換）は NG_WORDS_REJECT を参照。containsNGWord() は引き続き reject 層のみ判定。
const NG_WORDS_REJECT = [
  'bit.ly/', 'tinyurl.com/', 't.co/', 'goo.gl/', 'ow.ly/',
  '必ず儲か', '元本保証', '当選しました', '高額当選',
  '無料プレゼント当選', '高額バイト'
];
const NG_WORDS_WARN = [
  '副業', 'パパ活', '在宅で稼', '不労所得',
  'FX自動', '仮想通貨で稼', '出会い系'
];
const NG_WORDS = NG_WORDS_REJECT;

function notionHeaders() {
  return {
    "Content-Type":   "application/json",
    "Authorization":  "Bearer " + NOTION_API_KEY,
    "Notion-Version": "2022-06-28"
  };
}

// ==========================================
// 🌟 v7.0: プレ会員機能ヘルパー
// ==========================================

// プレローンチ期間判定(2026-06-08 21:00 〜 2026-06-10 23:59 JST)
function isPreLaunchPeriod() {
  const now   = new Date(new Date().getTime() + 9*60*60*1000);
  const start = new Date('2026-06-08T21:00:00+09:00');
  const end   = new Date('2026-06-10T23:59:59+09:00');
  return now >= start && now <= end;
}

// プレ会員特典の使用処理
//   - 電話番号 or LINE_userid で顧客マスターを検索
//   - プレ会員 = ON かつ 特典使用済み = OFF なら → 使用済みフラグON
//   - 特典使用済みの場合は警告メール
function handlePreMemberBenefit(data) {
  try {
    let filter;
    if (data.tel) {
      const cleanTel = (data.tel || '').replace(/[^\d]/g, '');
      filter = { property: "電話番号", rich_text: { contains: cleanTel } };
    } else if (data.lineUserId) {
      filter = { property: "LINE_userid", rich_text: { equals: data.lineUserId } };
    } else {
      console.warn('[プレ会員特典] 電話番号・LINE_userid なし → スキップ');
      return;
    }

    const searchRes = UrlFetchApp.fetch(
      "https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
      {
        method: "post", headers: notionHeaders(),
        payload: JSON.stringify({ filter: filter, page_size: 1 }),
        muteHttpExceptions: true
      }
    );

    if (searchRes.getResponseCode() !== 200) {
      console.error('[プレ会員特典] 顧客検索失敗 HTTP ' + searchRes.getResponseCode());
      return;
    }

    const results = JSON.parse(searchRes.getContentText()).results;
    if (!results || results.length === 0) {
      console.warn('[プレ会員特典] 該当顧客が見つかりませんでした');
      return;
    }

    const page  = results[0];
    const props = page.properties;

    // プレ会員フラグ確認
    const isPreMember = props["プレ会員"] && props["プレ会員"].checkbox;
    if (!isPreMember) {
      console.warn('[プレ会員特典] プレ会員ではありません: ' + (data.name || ''));
      return;
    }

    // 特典使用済みかどうか
    const isAlreadyUsed = props["プレ会員特典使用済み"] && props["プレ会員特典使用済み"].checkbox;
    if (isAlreadyUsed) {
      console.warn('[プレ会員特典] 既に使用済み: ' + (data.name || ''));
      try {
        MailApp.sendEmail(
          Session.getEffectiveUser().getEmail(),
          '【⚠️ 警告】プレ会員特典の二重使用試行',
          'お名前: ' + (data.name || '不明') + '\n' +
          '電話: '   + (data.tel  || '不明') + '\n' +
          '日時: '   + (data.date || '') + ' ' + (data.time || '') + '\n\n' +
          '※既に特典使用済みの方から「プレ会員特典使用」チェック付きで予約が入りました。\n' +
          '当日の対応をご確認ください。'
        );
      } catch(e) { console.error('警告メール送信エラー: ' + e); }
      return;
    }

    // 特典使用済みフラグをON
    const jstNow   = new Date(new Date().getTime() + 9*60*60*1000);
    const todayStr = jstNow.toISOString().substring(0, 10);

    const updateRes = UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + page.id, {
      method: "patch", headers: notionHeaders(),
      payload: JSON.stringify({
        properties: {
          "プレ会員特典使用済み": { checkbox: true },
          "プレ会員特典使用日":   { date: { start: todayStr } }
        }
      }),
      muteHttpExceptions: true
    });

    if (updateRes.getResponseCode() === 200) {
      console.log('[プレ会員特典] ✅ 特典使用確定: ' + (data.name || '') + ' (' + todayStr + ')');
    } else {
      console.error('[プレ会員特典] 特典使用フラグ更新失敗 HTTP ' + updateRes.getResponseCode());
    }
  } catch(e) {
    console.error('[プレ会員特典] 例外: ' + e);
  }
}

// ==========================================
// 🔒 セキュリティヘルパー
// ==========================================

function checkRateLimit(identifier, maxCount, windowSec) {
  maxCount  = maxCount  || 20;
  windowSec = windowSec || 60;
  const cache = CacheService.getScriptCache();
  const key   = "rl_" + identifier;
  const count = parseInt(cache.get(key) || "0");
  if (count >= maxCount) {
    console.warn("⚠️ レート制限超過: " + identifier + " (" + count + "/" + maxCount + ")");
    return true;
  }
  cache.put(key, String(count + 1), windowSec);
  return false;
}

function checkDailyLimit(userId, action, maxPerDay) {
  maxPerDay = maxPerDay || 10;
  if (!userId) return false;
  const today = new Date(new Date().getTime() + 9*60*60*1000).toISOString().substring(0,10);
  const cache = CacheService.getScriptCache();
  const key   = "daily_" + action + "_" + userId + "_" + today;
  const count = parseInt(cache.get(key) || "0");
  if (count >= maxPerDay) {
    console.warn("⚠️ 1日の上限超過: " + userId + " / " + action + " (" + count + "/" + maxPerDay + ")");
    return true;
  }
  cache.put(key, String(count + 1), 86400);
  return false;
}

function containsNGWord(text) {
  if (!text || NG_WORDS.length === 0) return false;
  const lowText = String(text).toLowerCase();
  for (var i = 0; i < NG_WORDS.length; i++) {
    if (lowText.indexOf(NG_WORDS[i].toLowerCase()) !== -1) {
      console.warn("⚠️ NGワード検知: " + NG_WORDS[i]);
      return true;
    }
  }
  return false;
}

// ==========================================
// 🔒 Task 2: セキュリティ強化（入力検証・トークン・異常通知）
// ==========================================
// 設計方針：
//   - 既存の handleWebForm / handleChiikiPost / handleOshiraseReaction の
//     振り分けは壊さない。
//   - 入力検証は PAYLOAD_SCHEMAS をテーブル化し validatePayload_() に集約。
//   - 既存の name>100 等の散発チェックは据置（二重防御）。
//   - severity 既定は 'warn'（受理＋通知）。ローンチ初期に誤拒否を避ける。
//     reject 指定のフィールドのみ即拒否。
//   - 異常検知時は運営者LINEへ Push（60秒/reason 単位のクールダウン）。
//   - verifyLineSignature は当面 true 返却を維持しつつ「失敗だったケース」を観測通知。

// 標準キャリア候補（DB設計タスクの値域と整合）
const STANDARD_CARRIERS = [
  'docomo', 'au', 'SoftBank', 'Rakuten Mobile',
  'ahamo', 'povo', 'LINEMO', 'UQ mobile', 'Y!mobile', 'その他'
];

// 地域SNS カテゴリ（chiiki.html のラジオ値域）
const CHIIKI_CATEGORIES = [
  'グルメ', '景色', 'イベント', '注意', 'お得情報', 'お店', 'その他'
];

// formType 別のスキーマ。
//   required:  必須フィールド
//   type:      'string' | 'number' | 'enum' | 'boolean' | 'string_or_number'
//   maxLen:    文字列の最大長（バイトではなく String.length）
//   min/max:   数値の境界
//   values:    enum の許容値
//   ngword:    chiiki_post 等で NG ワード判定対象にする
//   severity:  'reject'（即拒否）| 'warn'（受理＋通知のみ）。省略時は 'warn'。
const PAYLOAD_SCHEMAS = {
  // karte.html submitKarte: karteData
  karte: {
    name:           { required: true,  type: 'string', maxLen: 100, severity: 'reject' },
    tel:            { required: true,  type: 'string', maxLen: 20,  severity: 'reject' },
    email:          { required: false, type: 'string', maxLen: 254 },
    lineName:       { required: false, type: 'string', maxLen: 100 },
    carrier:        { required: false, type: 'string', maxLen: 50 },
    device:         { required: false, type: 'string', maxLen: 100 },
    battery:        { required: false, type: 'string', maxLen: 20 },
    storage:        { required: false, type: 'string', maxLen: 50 },
    buyTime:        { required: false, type: 'string', maxLen: 50 },
    target:         { required: false, type: 'string', maxLen: 30 },
    wifi:           { required: false, type: 'string', maxLen: 50 },
    simConfig:      { required: false, type: 'string', maxLen: 30 },
    contractType:   { required: false, type: 'string', maxLen: 50 },
    propCarrier:    { required: false, type: 'string', maxLen: 50 },
    propPlanName:   { required: false, type: 'string', maxLen: 100 },
    discounts:      { required: false, type: 'string', maxLen: 500 },
    nextFollow:     { required: false, type: 'string', maxLen: 500 },
    currentCost:    { required: false, type: 'string_or_number', min: 0, max: 999999 },
    proposedCost:   { required: false, type: 'string_or_number', min: 0, max: 999999 },
    savingCost:     { required: false, type: 'string_or_number', min: -999999, max: 999999 },
    appUsed:        { required: false, type: 'string', maxLen: 2000 },
    appTransfer:    { required: false, type: 'string', maxLen: 2000 },
    purpose:        { required: false, type: 'string', maxLen: 300 },
    memo:           { required: false, type: 'string', maxLen: 5000 },
    callOptionCur:  { required: false, type: 'string', maxLen: 100 },
    callOptionProp: { required: false, type: 'string', maxLen: 100 },
    source:         { required: false, type: 'string', maxLen: 100 }
  },
  // karte.html simData (= karteData + formType='simulation')
  simulation: {
    name:         { required: true,  type: 'string', maxLen: 100, severity: 'reject' },
    tel:          { required: true,  type: 'string', maxLen: 20,  severity: 'reject' },
    carrier:      { required: false, type: 'string', maxLen: 50 },
    propCarrier:  { required: false, type: 'string', maxLen: 50 },
    propPlanName: { required: false, type: 'string', maxLen: 100 },
    discounts:    { required: false, type: 'string', maxLen: 500 },
    currentCost:  { required: false, type: 'string_or_number', min: 0, max: 999999 },
    proposedCost: { required: false, type: 'string_or_number', min: 0, max: 999999 },
    savingCost:   { required: false, type: 'string_or_number', min: -999999, max: 999999 },
    device:       { required: false, type: 'string', maxLen: 100 }
  },
  // karte.html appReq (= karteData + formType='app_check') / app-check.html send()
  // app-check.html standalone は name/tel を送らないため required は外す。
  app_check: {
    appUsed:     { required: false, type: 'string', maxLen: 2000 },
    appTransfer: { required: false, type: 'string', maxLen: 2000 },
    name:        { required: false, type: 'string', maxLen: 100 },
    tel:         { required: false, type: 'string', maxLen: 20 }
  },
  // subscribe.html → main.gs handleWebForm (formType:'subscription' 分岐)
  subscription: {
    name:    { required: true,  type: 'string', maxLen: 100, severity: 'reject' },
    tel:     { required: false, type: 'string', maxLen: 20 },
    lineName:{ required: false, type: 'string', maxLen: 100 },
    plan:    { required: false, type: 'string', maxLen: 50 },
    cycle:   { required: false, type: 'string', maxLen: 20 },
    payment: { required: false, type: 'string', maxLen: 30 },
    amount:  { required: false, type: 'string_or_number', min: 0, max: 999999 }
  },
  // index.html answers（formType なし。token+name+detail で診断送信）
  diagnosis: {
    name:   { required: true,  type: 'string', maxLen: 100, severity: 'reject' },
    tel:    { required: false, type: 'string', maxLen: 20 },
    detail: { required: false, type: 'string', maxLen: 1000 },
    q1:     { required: false, type: 'string', maxLen: 100 },
    q2:     { required: false, type: 'string', maxLen: 100 },
    source: { required: false, type: 'string', maxLen: 100 }
  },
  // reserve fallback（main.gs に届いた場合のみ。本番 reserve.html は別 GAS）
  reserve: {
    name:  { required: true,  type: 'string', maxLen: 100, severity: 'reject' },
    tel:   { required: true,  type: 'string', maxLen: 20,  severity: 'reject' },
    email: { required: false, type: 'string', maxLen: 254 },
    menu:  { required: false, type: 'string', maxLen: 100 },
    date:  { required: true,  type: 'string', maxLen: 30,  severity: 'reject' },
    time:  { required: true,  type: 'string', maxLen: 30,  severity: 'reject' },
    price: { required: false, type: 'string_or_number', min: 0, max: 999999 }
  },
  // chiiki.html 投稿
  chiiki_post: {
    category:     { required: true,  type: 'enum', values: CHIIKI_CATEGORIES, severity: 'reject' },
    title:        { required: false, type: 'string', maxLen: 100, ngword: true },
    address:      { required: false, type: 'string', maxLen: 300, ngword: true },
    lat:          { required: false, type: 'string_or_number', min: -90,  max: 90 },
    lng:          { required: false, type: 'string_or_number', min: -180, max: 180 },
    userId:       { required: false, type: 'string', maxLen: 100 },
    displayName:  { required: false, type: 'string', maxLen: 100 },
    imageMime:    { required: false, type: 'enum', values: ['image/jpeg', 'image/png', 'image/webp'] }
    // imageBase64 は別途 MAX_IMAGE_BASE64_SIZE で既存チェック済み
  },
  // chiiki.html いいね
  chiiki_like: {
    recordDate: { required: true,  type: 'string', maxLen: 50, severity: 'reject' },
    lat:        { required: false, type: 'string_or_number', min: -90, max: 90 },
    liked:      { required: false, type: 'boolean' }
  },
  // oshirase.html リアクション
  oshirase_reaction: {
    pubDate:      { required: true,  type: 'string', maxLen: 50,  severity: 'reject' },
    title:        { required: true,  type: 'string', maxLen: 200, severity: 'reject' },
    reactionType: { required: true,  type: 'enum',   values: ['interest', 'helpful'], severity: 'reject' },
    action:       { required: true,  type: 'enum',   values: ['add', 'remove'],       severity: 'reject' },
    userId:       { required: false, type: 'string', maxLen: 100 }
  }
};

/**
 * payload を formType 別スキーマで検証。
 * @return {ok: bool, errors: [{field, reason}], severity: 'reject'|'warn'}
 *   ok=false かつ severity='reject' → 即拒否
 *   ok=false かつ severity='warn'   → 受理＋運営者通知
 *   ok=true                         → 通常処理
 */
function validatePayload_(formType, data) {
  const schema = PAYLOAD_SCHEMAS[formType];
  if (!schema) {
    // 未定義スキーマは観測のみ（拒否しない）
    return { ok: true };
  }
  const errors = [];
  let worstSeverity = 'warn';

  Object.keys(schema).forEach(function (field) {
    const rule = schema[field];
    const v = data[field];
    const presentRaw = (v !== undefined && v !== null && v !== '');

    if (rule.required && !presentRaw) {
      errors.push({ field: field, reason: 'required_missing' });
      if (rule.severity === 'reject') worstSeverity = 'reject';
      return;
    }
    if (!presentRaw) return;

    switch (rule.type) {
      case 'string':
        if (typeof v !== 'string') {
          errors.push({ field: field, reason: 'type_not_string' });
          if (rule.severity === 'reject') worstSeverity = 'reject';
          return;
        }
        if (rule.maxLen && v.length > rule.maxLen) {
          errors.push({ field: field, reason: 'maxlen_exceeded(' + v.length + '>' + rule.maxLen + ')' });
          if (rule.severity === 'reject') worstSeverity = 'reject';
          return;
        }
        break;
      case 'number': {
        const n = Number(v);
        if (!isFinite(n)) {
          errors.push({ field: field, reason: 'type_not_number' });
          if (rule.severity === 'reject') worstSeverity = 'reject';
          return;
        }
        if (rule.min !== undefined && n < rule.min) errors.push({ field: field, reason: 'below_min' });
        if (rule.max !== undefined && n > rule.max) errors.push({ field: field, reason: 'above_max' });
        break;
      }
      case 'string_or_number': {
        // 既存フロントは Number か文字列の数値で送ってくる
        const n = Number(v);
        if (!isFinite(n)) {
          errors.push({ field: field, reason: 'not_numeric' });
          if (rule.severity === 'reject') worstSeverity = 'reject';
          return;
        }
        if (rule.min !== undefined && n < rule.min) errors.push({ field: field, reason: 'below_min' });
        if (rule.max !== undefined && n > rule.max) errors.push({ field: field, reason: 'above_max' });
        break;
      }
      case 'enum':
        if (rule.values.indexOf(v) === -1) {
          errors.push({ field: field, reason: 'enum_mismatch(' + String(v).substring(0, 30) + ')' });
          if (rule.severity === 'reject') worstSeverity = 'reject';
        }
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push({ field: field, reason: 'type_not_boolean' });
        break;
    }
  });

  if (errors.length === 0) return { ok: true };
  return { ok: false, errors: errors, severity: worstSeverity };
}

/**
 * トークン照合。
 *   ok=true legacy=false: 新トークン一致
 *   ok=true legacy=true : 旧トークン（移行期間中）一致 → 1日1回まで運営者通知
 *   ok=false           : 拒否
 */
function isTokenValid_(token) {
  const current = props.getProperty('SECRET_TOKEN');
  const legacy  = props.getProperty('SECRET_TOKEN_LEGACY');
  if (current && token === current) return { ok: true, legacy: false };
  if (legacy  && token === legacy)  return { ok: true, legacy: true  };
  return { ok: false };
}

/**
 * NGワード判定（2層）。
 *   reject 層に1つでも該当 → reject:true
 *   reject に該当せず warn 層に該当 → warn:true
 */
function checkNGWords_(text) {
  if (!text) return { reject: false, warn: false, matched: '' };
  const lowText = String(text).toLowerCase();
  for (var i = 0; i < NG_WORDS_REJECT.length; i++) {
    if (lowText.indexOf(NG_WORDS_REJECT[i].toLowerCase()) !== -1) {
      return { reject: true, warn: false, matched: NG_WORDS_REJECT[i] };
    }
  }
  for (var j = 0; j < NG_WORDS_WARN.length; j++) {
    if (lowText.indexOf(NG_WORDS_WARN[j].toLowerCase()) !== -1) {
      return { reject: false, warn: true, matched: NG_WORDS_WARN[j] };
    }
  }
  return { reject: false, warn: false, matched: '' };
}

/**
 * 任意の LINE userId に対する Push API ヘルパー（汎用）。
 * addMachiPoint 内の Push 実装パターンを共通化したもの。
 */
function pushToLine_(userId, messages) {
  try {
    const LINE_TOKEN = props.getProperty('LINE_ACCESS_TOKEN');
    if (!LINE_TOKEN || !userId) return;
    const msgs = Array.isArray(messages) ? messages : [messages];
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_TOKEN },
      payload: JSON.stringify({ to: userId, messages: msgs }),
      muteHttpExceptions: true
    });
  } catch (e) {
    console.error('pushToLine_ error: ' + e);
  }
}

/**
 * 運営者OAへ Push（OPERATOR_USER_ID は ScriptProperties に要登録）。
 */
function pushToOperator_(messages) {
  const operatorId = props.getProperty('OPERATOR_USER_ID');
  if (!operatorId) {
    console.warn('pushToOperator_: OPERATOR_USER_ID 未設定のためスキップ');
    return;
  }
  pushToLine_(operatorId, messages);
}

/**
 * 異常検知通知。同一 reason は60秒に1回まで（洪水防止）。
 *   reason: 'invalid_token' | 'legacy_token_used' | 'rate_exceeded'
 *         | 'ngword_blocked' | 'ngword_warn' | 'validation_failed'
 *         | 'webhook_signature_failed'
 *   details: { formType?, identifier?, fieldErrors?, snippet?, matched? }
 */
function pushAnomalyAlert_(reason, details) {
  try {
    const cache = CacheService.getScriptCache();
    const key = 'anomaly_' + reason;
    if (cache.get(key)) return;
    cache.put(key, '1', 60);

    const flex = buildAnomalyFlex_(reason, details || {});
    pushToOperator_(flex);
    console.warn('🔔 anomaly_alert: ' + reason + ' details=' + JSON.stringify(details || {}).substring(0, 300));
  } catch (e) {
    console.error('pushAnomalyAlert_ error: ' + e);
  }
}

function buildAnomalyFlex_(reason, details) {
  const jstNow = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
  const ts = jstNow.toISOString().replace('T', ' ').substring(0, 19);
  const reasonLabel = {
    invalid_token:            '🚫 不正トークン',
    legacy_token_used:        '⚠️ 旧トークン使用',
    rate_exceeded:            '⛔ レート上限超過',
    ngword_blocked:           '🚫 NGワード（拒否）',
    ngword_warn:              '⚠️ NGワード（要観察）',
    validation_failed:        '⚠️ 入力検証失敗',
    webhook_signature_failed: '⚠️ LINE署名検証失敗'
  }[reason] || ('⚠️ ' + reason);

  const bodyContents = [
    { type: 'text', text: reasonLabel, weight: 'bold', size: 'md', wrap: true },
    { type: 'text', text: ts + ' JST',  size: 'xs', color: '#888888' }
  ];
  if (details.formType)   bodyContents.push({ type: 'text', text: 'formType: ' + details.formType, size: 'sm', wrap: true });
  if (details.identifier) bodyContents.push({ type: 'text', text: 'id: ' + String(details.identifier).substring(0, 60), size: 'sm', wrap: true });
  if (details.matched)    bodyContents.push({ type: 'text', text: 'matched: ' + String(details.matched).substring(0, 60), size: 'sm', wrap: true });
  if (details.fieldErrors && details.fieldErrors.length) {
    const err = details.fieldErrors.slice(0, 5).map(function (e) { return '- ' + e.field + ': ' + e.reason; }).join('\n');
    bodyContents.push({ type: 'text', text: err, size: 'xs', wrap: true, color: '#555555' });
  }
  if (details.snippet) {
    bodyContents.push({ type: 'text', text: 'snippet: ' + String(details.snippet).substring(0, 180), size: 'xs', wrap: true, color: '#888888' });
  }

  return {
    type: 'flex',
    altText: '[異常検知] ' + reasonLabel,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents }
    }
  };
}

// ==========================================
// 既存ヘルパー
// ==========================================

function isRateLimited(identifier) {
  const cache = CacheService.getScriptCache();
  const key   = "rate_" + identifier;
  const count = parseInt(cache.get(key) || "0");
  if (count >= 10) return true;
  cache.put(key, String(count + 1), 60);
  return false;
}

function tryLockSlot(dateStr, timeStr) {
  if (!dateStr || !timeStr) return true;
  const cache = CacheService.getScriptCache();
  const key   = "slot_" + dateStr.replace(/\s/g,'') + "_" + timeStr.replace(/\s/g,'');
  if (cache.get(key)) return false;
  cache.put(key, "locked", 300);
  return true;
}

function verifyLineSignature(rawBody, signature) {
  try {
    const secret = props.getProperty("LINE_CHANNEL_SECRET");
    if (!secret || !signature) {
      // Task 2: 観測のみ（戻り値は当面 true 維持。本来 false だった事象を通知）
      pushAnomalyAlert_('webhook_signature_failed', { snippet: 'secret_or_signature_missing' });
      return true;
    }
    const hash = Utilities.computeHmacSha256Signature(
      Utilities.newBlob(rawBody).getBytes(),
      Utilities.newBlob(secret).getBytes()
    );
    const match = Utilities.base64Encode(hash) === signature;
    if (!match) {
      pushAnomalyAlert_('webhook_signature_failed', { snippet: 'hash_mismatch' });
    }
    return match;
  } catch (e) {
    console.error("Signature error: " + e);
    pushAnomalyAlert_('webhook_signature_failed', { snippet: 'exception:' + String(e).substring(0, 100) });
    return true;
  }
}

function replyToLine(replyToken, messageText) {
  try {
    const LINE_TOKEN = props.getProperty("LINE_ACCESS_TOKEN");
    if (!LINE_TOKEN || !replyToken) return;
    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
      method: "post",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
      payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: "text", text: messageText }] }),
      muteHttpExceptions: true
    });
  } catch (e) { console.error("LINE Reply Error: " + e); }
}

function sendFlexCarousel(replyToken, introText, altText, bubbles) {
  const LINE_TOKEN = props.getProperty("LINE_ACCESS_TOKEN");
  const messages = [];
  if (introText) messages.push({ type: "text", text: introText });
  messages.push({ type: "flex", altText: altText, contents: { type: "carousel", contents: bubbles } });
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
    method: "post",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
    payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
    muteHttpExceptions: true
  });
}

function makeBubble(title, body, buttonLabel, buttonAction) {
  return {
    type: "bubble", size: "kilo",
    header: {
      type: "box", layout: "vertical",
      contents: [{ type: "text", text: title, weight: "bold", size: "sm", color: "#ffffff", wrap: true }],
      backgroundColor: "#249496", paddingAll: "12px"
    },
    body: {
      type: "box", layout: "vertical",
      contents: [{ type: "text", text: body, size: "xs", color: "#555555", wrap: true, margin: "none" }],
      paddingAll: "12px"
    },
    footer: {
      type: "box", layout: "vertical",
      contents: [{ type: "button", action: buttonAction, style: "primary", color: "#249496", height: "sm" }],
      paddingAll: "10px", spacing: "none"
    }
  };
}

function makeMyPageBubble(headerColor, headerIcon, headerTitle, rows, footerBtn) {
  var safeRows = rows || [];
  const contents = safeRows.map(function(row) {
    if (!row) return { type: "separator", margin: "sm" };
    if (row.type === 'separator') return { type: "separator", margin: "sm" };
    var labelText = (row.label && String(row.label).length > 0) ? String(row.label) : "　";
    var valueText = (row.value && String(row.value).length > 0) ? String(row.value) : "未設定";
    return {
      type: "box", layout: "horizontal", margin: "sm",
      contents: [
        { type: "text", text: labelText, size: "xs", color: "#888888", flex: 3, wrap: true },
        { type: "text", text: valueText, size: "xs", color: "#1a2a40", flex: 5, wrap: true, weight: row.bold ? "bold" : "regular" }
      ]
    };
  });
  const bubble = {
    type: "bubble", size: "kilo",
    header: {
      type: "box", layout: "horizontal", paddingAll: "12px",
      backgroundColor: headerColor,
      contents: [
        { type: "text", text: headerIcon, size: "xl", flex: 0 },
        { type: "text", text: headerTitle, weight: "bold", size: "sm", color: "#ffffff", margin: "md", wrap: true }
      ]
    },
    body: {
      type: "box", layout: "vertical", paddingAll: "12px",
      contents: contents
    }
  };
  if (footerBtn) {
    bubble.footer = {
      type: "box", layout: "vertical", paddingAll: "10px",
      contents: [{ type: "button", action: footerBtn, style: "primary", color: headerColor, height: "sm" }]
    };
  }
  return bubble;
}

// ==========================================
// upsertCustomerMaster (v6.9.1: 流入経路対応)
// ==========================================
function upsertCustomerMaster(params) {
  const tel = (params.tel || "").replace(/[^\d]/g, "");
  if (!tel) { console.log("電話番号なし → スキップ"); return null; }
  const jstNow   = new Date(new Date().getTime() + 9*60*60*1000);
  const todayStr = jstNow.toISOString().substring(0, 10);
  let existingPageId = null;
  try {
    const searchRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
      { method: "post", headers: notionHeaders(),
        payload: JSON.stringify({ filter: { property: "電話番号", rich_text: { contains: tel } } }),
        muteHttpExceptions: true });
    if (searchRes.getResponseCode() === 200) {
      const results = JSON.parse(searchRes.getContentText()).results;
      if (results && results.length > 0) existingPageId = results[0].id;
    }
  } catch (e) { console.error("顧客マスター検索例外: " + e); }

  if (existingPageId) {
    try {
      const updatePayload = { properties: { "最終来店日": { date: { start: todayStr } } } };
      if (params.email)      updatePayload.properties["メールアドレス"]    = { rich_text: [{ text: { content: params.email } }] };
      if (params.lineUserId) {
        updatePayload.properties["LINE_userid"]      = { rich_text: [{ text: { content: params.lineUserId } }] };
        updatePayload.properties["LINE_displayName"] = { rich_text: [{ text: { content: params.lineDisplayName || '' } }] };
      }
      if (params.lineName)      updatePayload.properties["LINE_displayName"] = { rich_text: [{ text: { content: params.lineName } }] };
      if (params.carrier)       updatePayload.properties["利用キャリア"]      = { rich_text: [{ text: { content: params.carrier } }] };
      if (params.device)        updatePayload.properties["利用端末"]          = { rich_text: [{ text: { content: params.device } }] };
      if (params.battery)       updatePayload.properties["バッテリー状態"]    = { rich_text: [{ text: { content: params.battery } }] };
      if (params.storage)       updatePayload.properties["ストレージ空き"]    = { rich_text: [{ text: { content: params.storage } }] };
      if (params.buyTime)       updatePayload.properties["買い替え時期"]      = { rich_text: [{ text: { content: params.buyTime } }] };
      if (params.appUsed)       updatePayload.properties["利用中アプリ"]      = { rich_text: [{ text: { content: params.appUsed } }] };
      if (params.appTransfer)   updatePayload.properties["移行必須アプリ"]    = { rich_text: [{ text: { content: params.appTransfer } }] };
      if (params.karteDate)     updatePayload.properties["スマホカルテ更新日"]= { date: { start: params.karteDate } };
      if (params.currentCost  !== undefined) updatePayload.properties["現在の月額"]  = { number: params.currentCost };
      if (params.proposedCost !== undefined) updatePayload.properties["提案後月額"]  = { number: params.proposedCost };
      if (params.savingCost   !== undefined) updatePayload.properties["月額節約額"]  = { number: params.savingCost };
      if (params.propCarrier)   updatePayload.properties["提案キャリア"]      = { rich_text: [{ text: { content: params.propCarrier } }] };
      if (params.propPlanName)  updatePayload.properties["提案プラン名"]      = { rich_text: [{ text: { content: params.propPlanName } }] };
      if (params.discounts)     updatePayload.properties["適用割引"]          = { rich_text: [{ text: { content: params.discounts } }] };
      if (params.nextFollow)    updatePayload.properties["次回フォロー予定"]  = { rich_text: [{ text: { content: params.nextFollow } }] };

      // ★ v6.9: 新プロパティ4つ
      if (params.target)        updatePayload.properties["対象者"]            = { select: { name: params.target } };
      if (params.wifi)          updatePayload.properties["自宅Wi-Fi"]         = { rich_text: [{ text: { content: params.wifi } }] };
      if (params.simConfig)     updatePayload.properties["SIM構成"]           = { select: { name: params.simConfig } };
      if (params.contractType)  updatePayload.properties["申込区分"]          = { rich_text: [{ text: { content: params.contractType } }] };

      // ★ v6.9.1: 流入経路
      if (params.source)        updatePayload.properties["流入経路"]          = { select: { name: params.source } };

      UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + existingPageId, {
        method: "patch", headers: notionHeaders(), payload: JSON.stringify(updatePayload), muteHttpExceptions: true
      });
    } catch (e) { console.error("顧客マスター更新エラー: " + e); }
    if (params.historyText) {
      try {
        UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + existingPageId + "/children", {
          method: "patch", headers: notionHeaders(),
          payload: JSON.stringify({ children: [{ object: "block", type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: "▶ " + todayStr + "  " + params.historyText } }] }
          }]}), muteHttpExceptions: true
        });
      } catch (e) { console.error("顧客マスター履歴追記エラー: " + e); }
    }
    return existingPageId;
  } else {
    try {
      const createPayload = {
        parent: { database_id: CUSTOMER_MASTER_ID },
        properties: {
          "氏名":           { title:     [{ text: { content: params.name || "未入力" } }] },
          "電話番号":       { rich_text: [{ text: { content: params.tel  || "" } }] },
          "初回登録日":     { date:      { start: todayStr } },
          "最終来店日":     { date:      { start: todayStr } },
          "対応ステータス": { select:    { name: "新規" } }
        }
      };
      if (params.email)      createPayload.properties["メールアドレス"]  = { rich_text: [{ text: { content: params.email } }] };
      if (params.lineUserId) {
        createPayload.properties["LINE_userid"]      = { rich_text: [{ text: { content: params.lineUserId } }] };
        createPayload.properties["LINE_displayName"] = { rich_text: [{ text: { content: params.lineDisplayName || '' } }] };
      }
      if (params.lineName)     createPayload.properties["LINE_displayName"] = { rich_text: [{ text: { content: params.lineName } }] };
      if (params.carrier)      createPayload.properties["利用キャリア"]   = { rich_text: [{ text: { content: params.carrier } }] };
      if (params.device)       createPayload.properties["利用端末"]       = { rich_text: [{ text: { content: params.device } }] };
      // ★ 案②: 既存更新ブロックと等価になるよう、新規作成時にも書き込む9項目
      if (params.battery)      createPayload.properties["バッテリー状態"] = { rich_text: [{ text: { content: params.battery } }] };
      if (params.storage)      createPayload.properties["ストレージ空き"] = { rich_text: [{ text: { content: params.storage } }] };
      if (params.buyTime)      createPayload.properties["買い替え時期"]   = { rich_text: [{ text: { content: params.buyTime } }] };
      if (params.appUsed)      createPayload.properties["利用中アプリ"]   = { rich_text: [{ text: { content: params.appUsed } }] };
      if (params.appTransfer)  createPayload.properties["移行必須アプリ"] = { rich_text: [{ text: { content: params.appTransfer } }] };
      if (params.karteDate)    createPayload.properties["スマホカルテ更新日"] = { date: { start: params.karteDate } };
      if (params.currentCost  !== undefined) createPayload.properties["現在の月額"] = { number: params.currentCost };
      if (params.proposedCost !== undefined) createPayload.properties["提案後月額"] = { number: params.proposedCost };
      if (params.savingCost   !== undefined) createPayload.properties["月額節約額"] = { number: params.savingCost };
      if (params.propCarrier)  createPayload.properties["提案キャリア"]   = { rich_text: [{ text: { content: params.propCarrier } }] };
      if (params.propPlanName) createPayload.properties["提案プラン名"]   = { rich_text: [{ text: { content: params.propPlanName } }] };
      if (params.discounts)    createPayload.properties["適用割引"]       = { rich_text: [{ text: { content: params.discounts } }] };
      if (params.nextFollow)   createPayload.properties["次回フォロー予定"] = { rich_text: [{ text: { content: params.nextFollow } }] };

      // ★ v6.9: 新プロパティ4つ
      if (params.target)       createPayload.properties["対象者"]        = { select: { name: params.target } };
      if (params.wifi)         createPayload.properties["自宅Wi-Fi"]      = { rich_text: [{ text: { content: params.wifi } }] };
      if (params.simConfig)    createPayload.properties["SIM構成"]        = { select: { name: params.simConfig } };
      if (params.contractType) createPayload.properties["申込区分"]      = { rich_text: [{ text: { content: params.contractType } }] };

      // ★ v6.9.1: 流入経路
      if (params.source)       createPayload.properties["流入経路"]      = { select: { name: params.source } };

      const createRes = UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
        method: "post", headers: notionHeaders(), payload: JSON.stringify(createPayload), muteHttpExceptions: true
      });
      if (createRes.getResponseCode() === 200) {
        const newPageId = JSON.parse(createRes.getContentText()).id;
        if (params.historyText) {
          UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + newPageId + "/children", {
            method: "patch", headers: notionHeaders(),
            payload: JSON.stringify({ children: [{ object: "block", type: "paragraph",
              paragraph: { rich_text: [{ type: "text", text: { content: "▶ " + todayStr + "  " + params.historyText } }] }
            }]}), muteHttpExceptions: true
          });
        }
        return newPageId;
      }
    } catch (e) { console.error("顧客マスター新規作成例外: " + e); }
  }
  return null;
}

// ==========================================
// upsertCustomerMasterByLineId (v6.9.1: 流入経路対応)
// ==========================================
function upsertCustomerMasterByLineId(data) {
  if (!data.lineUserId) return null;
  const jstNow   = new Date(new Date().getTime() + 9*60*60*1000);
  const todayStr = jstNow.toISOString().substring(0, 10);

  let existingPageId = null;
  try {
    const searchRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
      { method: "post", headers: notionHeaders(),
        payload: JSON.stringify({ filter: { property: "LINE_userid", rich_text: { equals: data.lineUserId } } }),
        muteHttpExceptions: true });
    if (searchRes.getResponseCode() === 200) {
      const results = JSON.parse(searchRes.getContentText()).results;
      if (results && results.length > 0) existingPageId = results[0].id;
    }
  } catch(e) { console.error("LINE ID検索エラー: " + e); }

  const historyText = "【スマホ診断】キャリア:" + (data.q1||'不明') + " 料金:" + (data.q2||'不明') +
    (data.q6 ? " 買替:" + data.q6 : '') + " 名前:" + (data.name||'未入力');

  if (existingPageId) {
    try {
      const updatePayload = {
        properties: {
          "最終来店日":       { date: { start: todayStr } },
          "LINE_displayName": { rich_text: [{ text: { content: data.lineDisplayName || '' } }] },
        }
      };
      if (data.name  && data.name.length > 0)  updatePayload.properties["氏名"] = { title: [{ text: { content: data.name } }] };
      if (data.tel   && data.tel.length > 0)   updatePayload.properties["電話番号"] = { rich_text: [{ text: { content: data.tel } }] };
      if (data.email && data.email.length > 0) updatePayload.properties["メールアドレス"] = { rich_text: [{ text: { content: data.email } }] };
      if (data.q1)   updatePayload.properties["利用キャリア"] = { rich_text: [{ text: { content: data.q1 } }] };

      // ★ v6.9.1: 流入経路
      if (data.source) updatePayload.properties["流入経路"] = { select: { name: data.source } };

      UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + existingPageId, {
        method: "patch", headers: notionHeaders(), payload: JSON.stringify(updatePayload), muteHttpExceptions: true
      });
      UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + existingPageId + "/children", {
        method: "patch", headers: notionHeaders(),
        payload: JSON.stringify({ children: [{ object: "block", type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "▶ " + todayStr + "  " + historyText } }] }
        }]}), muteHttpExceptions: true
      });
    } catch(e) { console.error("LINE ID更新エラー: " + e); }
    return existingPageId;
  } else {
    try {
      const createPayload = {
        parent: { database_id: CUSTOMER_MASTER_ID },
        properties: {
          "氏名":             { title:     [{ text: { content: data.name || data.lineDisplayName || "(LINE診断)" } }] },
          "LINE_userid":      { rich_text: [{ text: { content: data.lineUserId } }] },
          "LINE_displayName": { rich_text: [{ text: { content: data.lineDisplayName || '' } }] },
          "初回登録日":       { date:      { start: todayStr } },
          "最終来店日":       { date:      { start: todayStr } },
          "対応ステータス":   { select:    { name: "新規" } }
        }
      };
      if (data.tel   && data.tel.length > 0)   createPayload.properties["電話番号"]      = { rich_text: [{ text: { content: data.tel } }] };
      if (data.email && data.email.length > 0) createPayload.properties["メールアドレス"]  = { rich_text: [{ text: { content: data.email } }] };
      if (data.q1)   createPayload.properties["利用キャリア"] = { rich_text: [{ text: { content: data.q1 } }] };

      // ★ v6.9.1: 流入経路
      if (data.source) createPayload.properties["流入経路"] = { select: { name: data.source } };

      const createRes = UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
        method: "post", headers: notionHeaders(), payload: JSON.stringify(createPayload), muteHttpExceptions: true
      });
      if (createRes.getResponseCode() === 200) {
        const newPageId = JSON.parse(createRes.getContentText()).id;
        UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + newPageId + "/children", {
          method: "patch", headers: notionHeaders(),
          payload: JSON.stringify({ children: [{ object: "block", type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: "▶ " + todayStr + "  " + historyText } }] }
          }]}), muteHttpExceptions: true
        });
        return newPageId;
      }
    } catch(e) { console.error("LINE ID新規作成エラー: " + e); }
  }
  return null;
}

// ==========================================
// ★ v6.9: LINE表示名で顧客検索
// ==========================================
function findCustomerByLineDisplayName(displayName) {
  if (!displayName) return null;
  try {
    const searchRes = UrlFetchApp.fetch(
      "https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
      { method: "post", headers: notionHeaders(),
        payload: JSON.stringify({ 
          filter: { property: "LINE_displayName", rich_text: { equals: displayName } },
          page_size: 1
        }),
        muteHttpExceptions: true }
    );
    if (searchRes.getResponseCode() === 200) {
      const results = JSON.parse(searchRes.getContentText()).results;
      if (results && results.length > 0) {
        console.log('[findCustomerByLineDisplayName] 発見: ' + displayName);
        return results[0].id;
      }
    }
    return null;
  } catch(e) {
    console.warn('findCustomerByLineDisplayName エラー: ' + e);
    return null;
  }
}

// ==========================================
// ★ v6.9: karte送信時に困りごとDB自動転記
// ==========================================
function registerKomariFromKarte(data, customerPageId) {
  if (!困りごとDB_ID) {
    console.warn('困りごとDB_ID 未設定のため転記スキップ');
    return;
  }
  
  try {
    const jstNow = new Date(new Date().getTime() + 9*60*60*1000);
    const jstISO = jstNow.toISOString().replace('Z', '+09:00');
    
    let komariText = '';
    if (data.purpose)     komariText += '【相談目的】' + data.purpose + '\n';
    if (data.memo)        komariText += '【相談メモ】' + data.memo + '\n';
    if (data.historyText) komariText += '【対応内容】' + data.historyText;
    if (!komariText) komariText = '対面カルテ作成';

    const titleText = komariText.replace(/\n/g, ' ').substring(0, 100);

    const properties = {
      '困りごと内容':   { title:     [{ text: { content: titleText } }] },
      '相談日時':       { date:      { start: jstISO } },
      '受付経路':       { select:    { name: '対面カルテ' } },
      '対応ステータス': { select:    { name: '対応済み' } }
    };

    if (customerPageId) {
      properties['顧客マスター'] = {
        relation: [{ id: customerPageId }]
      };
    }

    if (komariText.length > 0) {
      properties['詳細'] = {
        rich_text: [{ text: { content: komariText.substring(0, 2000) } }]
      };
    }

    UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
      method: "post", 
      headers: notionHeaders(),
      payload: JSON.stringify({
        parent: { database_id: 困りごとDB_ID },
        properties: properties
      }),
      muteHttpExceptions: true
    });
    
    console.log('[registerKomariFromKarte] 困りごとDB登録完了: ' + titleText);
  } catch(e) {
    console.warn('registerKomariFromKarte エラー: ' + e);
  }
}

// ==========================================
// ▼ doGet
// ==========================================
function doGet(e) {
  const ua = (e.parameter && e.parameter.userAgent) || 'unknown';
  const fp = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, ua)
              .map(function(b){ return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').substring(0, 12);
  
  if (checkRateLimit("get_" + fp, 20, 60)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: "Too many requests. Please try again later."
    })).setMimeType(ContentService.MimeType.JSON);
  }

  const action = e && e.parameter && e.parameter.action;
  if (action === 'getFreeSlot') {
    const slot = getFreeSlotCount();
    return ContentService.createTextOutput(JSON.stringify(slot)).setMimeType(ContentService.MimeType.JSON);
  }
  if (action === 'getMapData')      return getMapData();
  if (action === 'getOshiraseData') return getOshiraseData();
  if (action === 'getChiikiData') {
    const callback = e && e.parameter && e.parameter.callback;
    const result   = getChiikiData();
    if (callback) {
      return ContentService.createTextOutput(callback + '(' + result.getContent() + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return result;
  }
  if (action === 'chiikiPost') return handleChiikiPostGet(e.parameter);
  try {
    const calendar = CalendarApp.getDefaultCalendar();
    const today    = new Date();
    const endDate  = new Date();
    endDate.setDate(today.getDate() + 15);
    const busySlots = calendar.getEvents(today, endDate).map(function(ev) {
      return { start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime() };
    });
    return ContentService.createTextOutput(JSON.stringify({ status: "success", busy: busySlots })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleChiikiPostGet(params) {
  try {
    return handleChiikiPost({
      formType: 'chiiki_post', category: params.category||'', title: params.title||'',
      lat: params.lat||0, lng: params.lng||0, address: params.address||'',
      userId: params.userId||'', displayName: params.displayName||'',
      imageBase64: params.imageBase64||'', imageMime: params.imageMime||''
    });
  } catch(e) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: e.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function getMapData() {
  try {
    if (!MAP_SHEET_ID) throw new Error("MAP_SHEET_ID 未設定");
    const ss    = SpreadsheetApp.openById(MAP_SHEET_ID);
    const sheet = ss.getSheetByName("防犯記録");
    if (!sheet) return ContentService.createTextOutput(JSON.stringify({ status: "success", records: [] })).setMimeType(ContentService.MimeType.JSON);
    const rows    = sheet.getDataRange().getValues();
    const records = [];
    const startRow = (rows[0] && String(rows[0][0]).includes('報告')) ? 1 : 0;
    for (let i = startRow; i < rows.length; i++) {
      const row = rows[i];
      const lat = parseFloat(row[3]), lng = parseFloat(row[4]);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) continue;
      records.push({ date: row[0] ? String(row[0]).substring(0,19) : '', title: row[1]||'巡回ポイント', address: row[2]||'', lat, lng, url: row[5]||'', userId: row[6]||'', displayName: row[7]||'' });
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "success", records })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

function getChiikiData() {
  const cache  = CacheService.getScriptCache();
  const cached = cache.get('chiiki_data');
  if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
  try {
    if (!MAP_SHEET_ID) throw new Error("MAP_SHEET_ID 未設定");
    const ss    = SpreadsheetApp.openById(MAP_SHEET_ID);
    const sheet = ss.getSheetByName("地域発見記録");
    if (!sheet) {
      const empty = JSON.stringify({ status: "success", records: [] });
      cache.put('chiiki_data', empty, 360);
      return ContentService.createTextOutput(empty).setMimeType(ContentService.MimeType.JSON);
    }
    const EXPIRE_DAYS = { 'グルメ': 90, '発見・景色': 365, '困りごと': 30, 'イベント': 60 };
    const DEFAULT_EXPIRE_DAYS = 180;
    const now     = new Date();
    const rows    = sheet.getDataRange().getValues();
    const records = [];
    const startRow = (rows[0] && String(rows[0][0]).includes('報告')) ? 1 : 0;
    for (let i = startRow; i < rows.length; i++) {
      const row = rows[i];
      const lat = parseFloat(row[4]), lng = parseFloat(row[5]);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) continue;
      const approved = row[11];
      if (approved === false || String(approved).toUpperCase() === 'FALSE') continue;
      const postDate   = new Date(row[0]);
      const diffDays   = (now - postDate) / (1000 * 60 * 60 * 24);
      const category   = row[1] || '';
      const expireDays = EXPIRE_DAYS[category] !== undefined ? EXPIRE_DAYS[category] : DEFAULT_EXPIRE_DAYS;
      if (diffDays > expireDays && String(approved).toUpperCase() !== 'TRUE') continue;
      records.push({
        date: row[0] ? String(row[0]).substring(0,19) : '', category, title: row[2]||'地域発見',
        address: row[3]||'', lat, lng, url: row[6]||'', userId: row[7]||'', displayName: row[8]||'',
        imageUrl: row[9]||'', likes: parseInt(row[10]||0)
      });
    }
    const result = JSON.stringify({ status: "success", records });
    cache.put('chiiki_data', result, 360);
    return ContentService.createTextOutput(result).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// ▼ doPost
// ==========================================
function doPost(e) {
  try {
    const rawBody     = e.postData ? e.postData.contents : '';
    const contentType = e.postData ? (e.postData.type || '') : '';
    let postData;
    if (contentType.indexOf('multipart') !== -1) {
      try {
        const match = rawBody.match(/name="data"\r?\n\r?\n([\s\S]*?)(?:\r?\n--)/);
        postData = (match && match[1]) ? JSON.parse(match[1].trim()) : JSON.parse(rawBody);
      } catch(e) { return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Parse failed" })).setMimeType(ContentService.MimeType.JSON); }
    } else {
      try { postData = JSON.parse(rawBody); }
      catch(e) { return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Invalid JSON" })).setMimeType(ContentService.MimeType.JSON); }
    }
    if (postData.events && postData.events.length > 0) {
      const signature = (e.parameter && e.parameter["X-Line-Signature"]) || (e.headers && e.headers["X-Line-Signature"]) || "";
      if (!verifyLineSignature(rawBody, signature)) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Invalid signature" })).setMimeType(ContentService.MimeType.JSON);
      }
      return handleLineEvent(postData.events[0]);
    }
    if (postData.formType === 'oshirase_reaction') return handleOshiraseReaction(postData);
    if (postData.formType === 'chiiki_post') return handleChiikiPost(postData);
    if (postData.formType === 'chiiki_like') return handleChiikiLike(postData);
    return handleWebForm(postData);
  } catch (error) {
    console.error("doPost Error: " + error.message);
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// handleChiikiPost / uploadImageToDrive / handleChiikiLike
// (v6.9から変更なし、省略せずに継続)
// ==========================================
function handleChiikiPost(data) {
  try {
    // Task 2: スキーマ検証
    const vr = validatePayload_('chiiki_post', data);
    if (!vr.ok) {
      if (vr.severity === 'reject') {
        pushAnomalyAlert_('validation_failed', {
          formType: 'chiiki_post',
          identifier: (data.userId || 'unknown').substring(0, 60),
          fieldErrors: vr.errors,
          snippet: String(data.title || '').substring(0, 80)
        });
        return ContentService.createTextOutput(JSON.stringify({
          status: "error", message: "Invalid input"
        })).setMimeType(ContentService.MimeType.JSON);
      }
      pushAnomalyAlert_('validation_failed', {
        formType: 'chiiki_post',
        identifier: (data.userId || 'unknown').substring(0, 60),
        fieldErrors: vr.errors,
        snippet: String(data.title || '').substring(0, 80)
      });
    }

    if (data.imageBase64 && data.imageBase64.length > MAX_IMAGE_BASE64_SIZE) {
      console.warn("⚠️ 画像サイズ超過: " + Math.round(data.imageBase64.length/1024/1024) + "MB");
      return ContentService.createTextOutput(JSON.stringify({
        status: "error",
        message: "画像サイズが大きすぎます(5MB以下にしてください)"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (data.userId && checkDailyLimit(data.userId, 'chiiki_post', MAX_DAILY_CHIIKI_POSTS)) {
      pushAnomalyAlert_('rate_exceeded', {
        formType: 'chiiki_post',
        identifier: data.userId
      });
      return ContentService.createTextOutput(JSON.stringify({
        status: "error",
        message: "本日の投稿上限に達しました(1日10件まで)"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Task 2: NGワード判定を2層化（reject 即拒否、warn 受理＋通知）
    const ngTitle   = checkNGWords_(data.title);
    const ngAddress = checkNGWords_(data.address);
    if (ngTitle.reject || ngAddress.reject) {
      console.warn("⚠️ NGワード投稿を拒否: " + data.userId);
      pushAnomalyAlert_('ngword_blocked', {
        formType: 'chiiki_post',
        identifier: (data.userId || 'unknown').substring(0, 60),
        matched: (ngTitle.reject ? ngTitle.matched : ngAddress.matched),
        snippet: String(data.title || '').substring(0, 80)
      });
      return ContentService.createTextOutput(JSON.stringify({
        status: "error",
        message: "投稿内容に不適切な表現が含まれています"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    if (ngTitle.warn || ngAddress.warn) {
      pushAnomalyAlert_('ngword_warn', {
        formType: 'chiiki_post',
        identifier: (data.userId || 'unknown').substring(0, 60),
        matched: (ngTitle.warn ? ngTitle.matched : ngAddress.matched),
        snippet: String(data.title || '').substring(0, 80)
      });
    }

    const jstNow = new Date(new Date().getTime() + 9*60*60*1000);
    const jstISO = jstNow.toISOString().replace('Z', '+09:00');
    let imageUrl = '';
    if (data.imageBase64 && data.imageMime) imageUrl = uploadImageToDrive(data.imageBase64, data.imageMime, jstNow);
    if (!MAP_SHEET_ID) throw new Error("MAP_SHEET_ID 未設定");
    const ss    = SpreadsheetApp.openById(MAP_SHEET_ID);
    let   sheet = ss.getSheetByName("地域発見記録");
    if (!sheet) {
      sheet = ss.insertSheet("地域発見記録");
      sheet.appendRow(['報告日時','カテゴリ','地点名','住所','緯度','経度','GoogleマップURL','LINEユーザーID','表示名','画像URL','いいね数','公開']);
    }
    const lat = parseFloat(data.lat || 0);
    const lng = parseFloat(data.lng || 0);
    sheet.appendRow([jstISO, data.category||'', data.title||'地域発見', data.address||'', lat, lng,
      (lat && lng) ? "https://www.google.com/maps?q=" + lat + "," + lng : '',
      data.userId||'', data.displayName||'', imageUrl, 0, false]);
    if (data.userId) {
      try {
        const searchRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
          { method: "post", headers: notionHeaders(),
            payload: JSON.stringify({ filter: { property: "LINE_userid", rich_text: { equals: data.userId } } }),
            muteHttpExceptions: true });
        if (searchRes.getResponseCode() === 200) {
          const results = JSON.parse(searchRes.getContentText()).results;
          if (results.length > 0) {
            const pageId = results[0].id;
            UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + pageId + "/children", {
              method: "patch", headers: notionHeaders(),
              payload: JSON.stringify({ children: [{ object: "block", type: "paragraph",
                paragraph: { rich_text: [{ type: "text", text: { content:
                  "▶ " + jstNow.toISOString().substring(0,10) + "  【まちなか発見】" + (data.category||'') + " / " + (data.title||'地域発見')
                }}]}}]}), muteHttpExceptions: true
            });
            UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + pageId, {
              method: "patch", headers: notionHeaders(),
              payload: JSON.stringify({ properties: { "最終来店日": { date: { start: jstNow.toISOString().substring(0,10) } } } }),
              muteHttpExceptions: true
            });
          }
        }
      } catch(e) { console.error("顧客マスター履歴追記エラー: " + e); }
      addMachiPoint(data.userId, 3, "まちなか発見投稿(LIFF)");
    }
    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
        "【まちなか発見】承認待ち投稿あり：" + (data.title || data.category || ''),
        "新しい投稿が届きました。\n\nカテゴリ：" + (data.category||'') + "\nタイトル：" + (data.title||'') +
        "\n投稿者：" + (data.displayName||'不明') + "\n日時：" + jstISO +
        "\n\nhttps://docs.google.com/spreadsheets/d/" + MAP_SHEET_ID);
    } catch(e) { console.error("承認通知メール送信エラー: " + e); }
    CacheService.getScriptCache().remove('chiiki_data');
    return ContentService.createTextOutput(JSON.stringify({ status: "success", imageUrl })).setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    console.error("handleChiikiPost エラー: " + e);
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: e.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function uploadImageToDrive(base64Data, mimeType, jstNow) {
  try {
    const folderId = props.getProperty("IMAGE_FOLDER_ID");
    if (!folderId) throw new Error("IMAGE_FOLDER_ID 未設定");
    const decoded = Utilities.base64Decode(base64Data);
    const blob    = Utilities.newBlob(decoded, mimeType);
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const ts  = jstNow.getFullYear() + ("0"+(jstNow.getMonth()+1)).slice(-2) + ("0"+jstNow.getDate()).slice(-2) +
                "_" + ("0"+jstNow.getHours()).slice(-2) + ("0"+jstNow.getMinutes()).slice(-2) + ("0"+jstNow.getSeconds()).slice(-2);
    blob.setName("chiiki_" + ts + "." + ext);
    const folder = DriveApp.getFolderById(folderId);
    const file   = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w800";
  } catch(e) { console.error("uploadImageToDrive エラー: " + e); return ''; }
}

function handleChiikiLike(data) {
  try {
    // Task 2: スキーマ検証
    const vr = validatePayload_('chiiki_like', data);
    if (!vr.ok) {
      if (vr.severity === 'reject') {
        pushAnomalyAlert_('validation_failed', {
          formType: 'chiiki_like', fieldErrors: vr.errors
        });
        return ContentService.createTextOutput(JSON.stringify({
          status: "error", message: "Invalid input"
        })).setMimeType(ContentService.MimeType.JSON);
      }
      pushAnomalyAlert_('validation_failed', {
        formType: 'chiiki_like', fieldErrors: vr.errors
      });
    }

    if (!MAP_SHEET_ID) throw new Error("MAP_SHEET_ID 未設定");
    const ss    = SpreadsheetApp.openById(MAP_SHEET_ID);
    const sheet = ss.getSheetByName("地域発見記録");
    if (sheet) {
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]).substring(0,19) === String(data.recordDate).substring(0,19) &&
            parseFloat(rows[i][4]) === parseFloat(data.lat)) {
          const currentLikes = parseInt(rows[i][10] || 0);
          sheet.getRange(i + 1, 11).setValue(data.liked ? currentLikes + 1 : Math.max(0, currentLikes - 1));
          break;
        }
      }
    }
  } catch(e) { console.error("いいね更新エラー: " + e); }
  CacheService.getScriptCache().remove('chiiki_data');
  return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// ★ handleLineEvent (v6.9から変更なし)
// (Part2でも継続する handleLineEvent と handleWebForm は分割します)
// 
// 続きは gas_v6_9_1_part2.gs を参照
// ==========================================
// ==========================================
// GAS v6.9.1 Part2
// (Part1の続き。Part1とPart2をGASエディタに連続して貼り付け)
// ==========================================

// ==========================================
// ★ handleLineEvent
// ==========================================
function handleLineEvent(event) {
  const now        = new Date();
  const jstNow     = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const jstISO     = jstNow.toISOString().replace('Z', '+09:00');
  const replyToken = event.replyToken || "";
  const userId     = (event.source && event.source.userId) || "";
  const LINE_TOKEN = props.getProperty("LINE_ACCESS_TOKEN");

  if (event.type === 'follow') {
    let displayName = '';
    try {
      if (LINE_TOKEN && userId) {
        const pr = UrlFetchApp.fetch("https://api.line.me/v2/bot/profile/" + userId, { headers: { "Authorization": "Bearer " + LINE_TOKEN }, muteHttpExceptions: true });
        if (pr.getResponseCode() === 200) displayName = JSON.parse(pr.getContentText()).displayName || '';
      }
    } catch (e) { console.error("Profile取得エラー: " + e); }
    try {
      const searchRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
        { method: "post", headers: notionHeaders(),
          payload: JSON.stringify({ filter: { property: "LINE_userid", rich_text: { equals: userId } } }),
          muteHttpExceptions: true });
      const existing = searchRes.getResponseCode() === 200 ? JSON.parse(searchRes.getContentText()).results : [];
      if (existing.length === 0) {
        const todayStr = jstNow.toISOString().substring(0, 10);
        const isPreLaunch = isPreLaunchPeriod();  // ★ v7.0: プレ期間判定
        UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
          method: "post", headers: notionHeaders(),
          payload: JSON.stringify({ parent: { database_id: CUSTOMER_MASTER_ID }, properties: {
            "氏名":             { title:     [{ text: { content: displayName || "(LINE登録)" } }] },
            "LINE_userid":      { rich_text: [{ text: { content: userId } }] },
            "LINE_displayName": { rich_text: [{ text: { content: displayName } }] },
            "初回登録日":       { date: { start: todayStr } },
            "最終来店日":       { date: { start: todayStr } },
            "対応ステータス":   { select: { name: "新規" } },
            "プレ会員":         { checkbox: isPreLaunch }
          }}), muteHttpExceptions: true
        });

        // ★ v7.0: プレ会員登録の場合は専用LINEメッセージをpush
        if (isPreLaunch && LINE_TOKEN && userId) {
          try {
            UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
              method: "post",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
              payload: JSON.stringify({
                to: userId,
                messages: [{
                  type: "text",
                  text: "🌟 プレ会員にご登録いただきありがとうございます！\n\n" +
                        "【プレ会員特典】\n" +
                        "✅ 特典①：次回のご相談が1回無料\n" +
                        "✅ 特典②：マイページにプレ会員バッジ表示\n\n" +
                        "予約フォームに「プレ会員特典を使用する」のチェック欄がありますので、\n" +
                        "ご予約の際にチェックをお忘れなく😊\n\n" +
                        "▶ ご予約はこちら\n" +
                        "https://white-shadow1210.github.io/sumaho-shindan/reserve.html"
                }]
              }),
              muteHttpExceptions: true
            });
            console.log('[プレ会員] 登録通知push送信完了: ' + displayName);
          } catch(e) { console.error('プレ会員push送信エラー: ' + e); }
        }
      }
    } catch (e) { console.error("フォロー仮登録エラー: " + e); }
    return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  }

  if (event.type === 'postback') {
    const pbData = (event.postback && event.postback.data) || '';
    function replyWithQuickReply(text, items) {
      UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
        method: "post",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
        payload: JSON.stringify({ replyToken, messages: [{ type: "text", text, quickReply: { items } }] }),
        muteHttpExceptions: true
      });
    }
    if (pbData === 'helpmap_start') {
      replyWithQuickReply("🆘 どんなことでお困りですか？\nカテゴリを選んでください👇", [
        { type: "action", action: { type: "message", label: "📱 スマホ・パソコン", text: "困りごと：スマホ・パソコン" } },
        { type: "action", action: { type: "message", label: "🔧 家の中の困りごと", text: "困りごと：家の中" } },
        { type: "action", action: { type: "message", label: "🛒 買い物・外出",     text: "困りごと：買い物・外出" } },
        { type: "action", action: { type: "message", label: "🌿 庭・外回り",       text: "困りごと：庭・外回り" } },
        { type: "action", action: { type: "message", label: "💬 その他",           text: "困りごと：その他" } }
      ]);
    } else if (pbData === 'supporter_start') {
      replyWithQuickReply("📱 スマホのどんなことでお困りですか？\n選んでください👇", [
        { type: "action", action: { type: "message", label: "📱 基本操作",           text: "スマホ相談：基本操作" } },
        { type: "action", action: { type: "message", label: "📷 写真・カメラ",       text: "スマホ相談：写真・カメラ" } },
        { type: "action", action: { type: "message", label: "💳 ペイ・決済",         text: "スマホ相談：ペイ・決済" } },
        { type: "action", action: { type: "message", label: "💬 LINE・メール",       text: "スマホ相談：LINE・メール" } },
        { type: "action", action: { type: "message", label: "🔒 詐欺・セキュリティ", text: "スマホ相談：詐欺・セキュリティ" } }
      ]);
    } else if (pbData === 'chiiki_post_start') {
      replyWithQuickReply("📍 地域の発見を教えてください！\nカテゴリを選んでください👇", [
        { type: "action", action: { type: "message", label: "🌸 発見・景色", text: "地域発見：発見・景色" } },
        { type: "action", action: { type: "message", label: "🍜 グルメ",     text: "地域発見：グルメ" } },
        { type: "action", action: { type: "message", label: "⚠️ 困りごと",   text: "地域発見：困りごと" } },
        { type: "action", action: { type: "message", label: "🎉 イベント",   text: "地域発見：イベント" } }
      ]);
    } else if (pbData === 'mypage_start') {
      replyMyPage(userId, replyToken);
    } else if (pbData === 'tab_noop' || pbData === 'switch_to_menu_a' || pbData === 'switch_to_menu_b') {
      console.log("postback: " + pbData);
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  }

  if (event.type === 'message' && event.message && event.message.type === 'location') {
    const loc = event.message;
    let displayName = '';
    try {
      if (LINE_TOKEN && userId) {
        const pr = UrlFetchApp.fetch("https://api.line.me/v2/bot/profile/" + userId, { headers: { "Authorization": "Bearer " + LINE_TOKEN }, muteHttpExceptions: true });
        if (pr.getResponseCode() === 200) displayName = JSON.parse(pr.getContentText()).displayName || '';
      }
    } catch (e) { console.error("Profile取得エラー: " + e); }
    try {
      if (!MAP_DATABASE_ID) throw new Error("MAP_DATABASE_ID 未設定");
      UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
        method: "post", headers: notionHeaders(),
        payload: JSON.stringify({ parent: { database_id: MAP_DATABASE_ID }, properties: {
          "地点名":   { title:     [{ text: { content: loc.title || "巡回ポイント" } }] },
          "座標":     { rich_text: [{ text: { content: (loc.latitude||"") + ", " + (loc.longitude||"") } }] },
          "住所":     { rich_text: [{ text: { content: loc.address || "住所不明" } }] },
          "詳細内容": { rich_text: [{ text: { content: "公式LINEより送信" + (displayName ? " / " + displayName : "") } }] },
          "報告日時": { date: { start: jstISO } }
        }}), muteHttpExceptions: true
      });
    } catch (e) { console.error("Notion Map Error: " + e); }
    try {
      const ss    = SpreadsheetApp.openById(MAP_SHEET_ID);
      let   sheet = ss.getSheetByName("防犯記録") || ss.insertSheet("防犯記録");
      sheet.appendRow([jstISO, loc.title||"巡回ポイント", loc.address||"住所不明", loc.latitude||"", loc.longitude||"",
        "https://www.google.com/maps?q=" + (loc.latitude||"") + "," + (loc.longitude||""), userId, displayName]);
    } catch (e) { console.error("Sheet Error: " + e); }
    try {
      const searchRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
        { method: "post", headers: notionHeaders(),
          payload: JSON.stringify({ filter: { property: "LINE_userid", rich_text: { equals: userId } } }),
          muteHttpExceptions: true });
      if (searchRes.getResponseCode() === 200) {
        const results = JSON.parse(searchRes.getContentText()).results;
        if (results.length > 0) {
          UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + results[0].id, {
            method: "patch", headers: notionHeaders(),
            payload: JSON.stringify({ properties: {
              "LINE_displayName": { rich_text: [{ text: { content: displayName } }] },
              "最終来店日":       { date: { start: jstNow.toISOString().substring(0,10) } }
            }}), muteHttpExceptions: true
          });
        }
      }
    } catch (e) { console.error("顧客マスター位置情報更新エラー: " + e); }
    const pendingCategory = CacheService.getUserCache().get('chiiki_category_' + userId);
    if (pendingCategory) {
      try {
        const ss2    = SpreadsheetApp.openById(MAP_SHEET_ID);
        let   sheet2 = ss2.getSheetByName("地域発見記録");
        if (!sheet2) { sheet2 = ss2.insertSheet("地域発見記録"); sheet2.appendRow(['報告日時','カテゴリ','地点名','住所','緯度','経度','GoogleマップURL','LINEユーザーID','表示名']); }
        sheet2.appendRow([jstISO, pendingCategory, loc.title||"地域発見", loc.address||"住所不明",
          loc.latitude||"", loc.longitude||"", "https://www.google.com/maps?q=" + (loc.latitude||"") + "," + (loc.longitude||""), userId, displayName]);
        CacheService.getUserCache().remove('chiiki_category_' + userId);
        replyToLine(replyToken, "📍 ありがとうございます！\n" + pendingCategory + " としてマップに反映しました🗺️");
      } catch(e) { replyToLine(replyToken, "📍 位置情報を受け取りました！ありがとうございます😊"); }
    } else {
      replyToLine(replyToken, "📍 位置情報ありがとうございます！\n\n続いて、現場の状況を写真と文章で教えてください。");
    }
    addMachiPoint(userId, 1, "位置情報送信");
  }

  else if (event.type === 'message' && event.message && event.message.type === 'image') {
    const folderId = props.getProperty("IMAGE_FOLDER_ID");
    let   saveSuccess = false;
    try {
      const imgRes = UrlFetchApp.fetch("https://api-data.line.me/v2/bot/message/" + event.message.id + "/content",
        { method: "get", headers: { "Authorization": "Bearer " + LINE_TOKEN }, muteHttpExceptions: true });
      if (imgRes.getResponseCode() === 200) {
        const ts = jstNow.getFullYear() + ("0"+(jstNow.getMonth()+1)).slice(-2) + ("0"+jstNow.getDate()).slice(-2) +
                   "_" + ("0"+jstNow.getHours()).slice(-2) + ("0"+jstNow.getMinutes()).slice(-2) + ("0"+jstNow.getSeconds()).slice(-2);
        DriveApp.getFolderById(folderId).createFile(imgRes.getBlob().setName("line_img_" + ts + ".jpg"));
        saveSuccess = true;
      }
    } catch (e) { console.error("Image Save Error: " + e); }
    replyToLine(replyToken, saveSuccess ? "📸 写真を受け取りました！\n内容を確認次第、対応いたします。" : "📸 写真を受け取りました！");
  }

  else if (event.type === 'message' && event.message && event.message.type === 'text') {
    const text       = event.message.text || '';
    const reserveUrl = "https://white-shadow1210.github.io/sumaho-shindan/reserve.html?menu=" + encodeURIComponent("スマホ整理・お悩み相談");

    if (text === 'マイページ' || text === 'まいぺーじ' || text.includes('マイページ')) {
      replyMyPage(userId, replyToken);
    } else if (text === 'カルテ確認' || text === 'かるて確認' || text === 'カルテをみる' || text.includes('カルテ確認')) {
      replyKarteQuick(userId, replyToken);
    } else if (text.includes('スマホカルテ')) {
      replyToLine(replyToken, "📋 スマホカルテはマイページからご確認いただけます。\n\nリッチメニューの「マイページ」をタップするか\n「カルテ確認」と送信してください！");
    } else if (text.startsWith('困りごと：')) {
      if (checkDailyLimit(userId, 'komari', MAX_DAILY_KOMARI)) {
        replyToLine(replyToken, "申し訳ありません。本日の相談上限(10件)に達しました。\n明日また受け付けます😊");
        return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
      }
      if (containsNGWord(text)) {
        replyToLine(replyToken, "メッセージ内容を確認させていただきます。少々お待ちください🙏");
        return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
      }

      const cat = text.replace('困りごと：', '');
      CacheService.getUserCache().put('komari_cat_' + userId, cat, 300);
      const flexDefs = {
        'スマホ・パソコン': [
          { title: '📱 操作・設定がわからない', body: 'アプリの使い方、Wi-Fi設定、文字サイズなど\n一緒に画面を見ながら確認します！', detail: 'スマホ操作・設定' },
          { title: '🔋 動きが遅い・固まる',     body: 'アプリや容量が原因のことが多いです。\n直接確認するのが一番早いです！',       detail: 'スマホ動作不良' },
          { title: '📶 繋がらない・通信の問題', body: 'Wi-Fi・モバイルデータ・電波など\n原因の切り分けが必要です。',             detail: '通信トラブル' }
        ],
        '家の中': [
          { title: '💡 電球・電気まわり', body: '照明の交換や電気系統のお困りですね。\nまずブレーカーを確認してみてください！', detail: '電気まわり' },
          { title: '🚰 水まわり・排水',   body: '水漏れや詰まりは早めの対応が大切です。\n急ぎの場合はお電話ください！',           detail: '水まわり' },
          { title: '🔧 その他の修理',     body: 'ドアや棚など家の中の修理・不具合。\n状況を教えていただければ対応します！',       detail: '家の修理' }
        ],
        '買い物・外出': [
          { title: '🛒 買い物の付き添い', body: 'スーパーや病院への同行もお任せください。\n日時・場所を教えてください！', detail: '買い物付き添い' },
          { title: '🚗 移動・送迎',       body: '外出が難しい方もお気軽にご相談ください。\n日時・行き先を教えてください！', detail: '移動送迎' },
          { title: '📦 荷物・重い物',     body: '重い荷物の運搬・移動のお手伝いします。\n内容・場所を教えてください！', detail: '荷物運搬' }
        ],
        '庭・外回り': [
          { title: '🌿 草むしり・庭の手入れ', body: '雑草や庭木の手入れをお手伝いします。\n広さ・希望日を教えてください！', detail: '草むしり庭手入れ' },
          { title: '🍂 落ち葉・ゴミ片付け',   body: '季節の落ち葉や不用品の片付けも\nお任せください！',                   detail: '落ち葉片付け' },
          { title: '🏠 外壁・フェンスの不具合', body: '外回りの修理・不具合のご相談。\n状況を教えていただければ対応します！', detail: '外回り修理' }
        ],
        'その他': [
          { title: '📋 書類・手続きのこと',         body: '役所の手続きや書類の書き方など\nできる範囲でサポートします！', detail: '書類手続き' },
          { title: '👥 近所・人間関係のこと',       body: 'ご近所トラブルや人間関係のお悩み。\nまず話を聞かせてください！', detail: '近所人間関係' },
          { title: '💬 うまく説明できない・その他', body: 'どんな小さなことでも大丈夫です。\nお気軽にご相談ください！', detail: 'その他' }
        ]
      };
      const cards = flexDefs[cat] || [{ title: '💬 詳しく教える', body: 'どんな内容でもお気軽にご相談ください！', detail: cat }];
      const bubbles = cards.map(function(c) {
        return makeBubble(c.title, c.body, "これで相談する", { type: "message", label: "これで相談する", text: "困りごと詳細：" + c.detail });
      });
      sendFlexCarousel(replyToken, "「" + cat + "」のお困りですね😊\n当てはまる内容を選んでください👇", "困りごとの内容を選んでください", bubbles);
      addMachiPoint(userId, 2, "困りごと相談：" + cat);

    } else if (text.startsWith('困りごと詳細：')) {
      if (containsNGWord(text)) {
        replyToLine(replyToken, "メッセージ内容を確認させていただきます。少々お待ちください🙏");
        return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
      }

      const detail = text.replace('困りごと詳細：', '');
      const cat    = CacheService.getUserCache().get('komari_cat_' + userId) || '不明';
      const solutionMsg = {
        'スマホ操作・設定':   "📱 操作・設定のお困りには\n\n✅ 「設定」→「アクセシビリティ」で文字サイズを変更できます\n✅ Wi-Fiは「設定」→「Wi-Fi」から接続できます\n✅ アプリは長押しして削除できます\n\n上記で解決しましたか？",
        'スマホ動作不良':     "🔋 動作が遅い・固まる場合は\n\n✅ 使っていないアプリを完全に閉じてみてください\n✅ 本体を再起動(電源OFF→ON)してみてください\n✅ ストレージの空き容量を確認してみてください\n\n上記で解決しましたか？",
        '通信トラブル':       "📶 繋がらない場合は\n\n✅ 機内モードをON→OFFに切り替えてみてください\n✅ Wi-Fiの場合はルーターを再起動してみてください\n✅ 電波の強い場所へ移動してみてください\n\n上記で解決しましたか？",
        '電気まわり':         "💡 電気まわりのお困りには\n\n✅ まずブレーカーが落ちていないか確認してください\n✅ 電球切れの場合は型番をメモして購入できます\n\n上記で解決しましたか？",
        '水まわり':           "🚰 水まわりのお困りには\n\n✅ 水漏れの場合はまず止水栓を閉めてください\n✅ 排水の詰まりはパイプクリーナーで改善する場合があります\n\n上記で解決しましたか？",
        '家の修理':           "🔧 家の修理のお困りには\n\n状況の写真を撮っておくと業者への説明がスムーズです。\n西舘が対応できる場合はお伺いします😊\n\n解決の目処が立ちましたか？",
        '買い物付き添い':     "🛒 買い物の付き添いご希望ですね😊\n\n日時・場所・行き先を教えていただければ調整します！",
        '移動送迎':           "🚗 移動・送迎のご希望ですね😊\n\n日時・出発地・目的地を教えていただければ調整します！",
        '荷物運搬':           "📦 荷物運搬のご希望ですね😊\n\n内容・場所・希望日を教えていただければ確認します！",
        '草むしり庭手入れ':   "🌿 草むしり・庭の手入れのご希望ですね😊\n\n広さ・場所・希望日を教えていただければ調整します！",
        '落ち葉片付け':       "🍂 落ち葉・ゴミ片付けのご希望ですね😊\n\n場所・量・希望日を教えていただければ調整します！",
        '外回り修理':         "🏠 外回りの修理のご相談ですね😊\n\n状況の写真を撮っておくと確認がスムーズです！",
        '書類手続き':         "📋 書類・手続きのお困りには\n\n✅ 役所の手続きは窓口でも丁寧に教えてもらえます\n✅ 一緒に付き添いもできます😊\n\n上記で解決しましたか？",
        '近所人間関係':       "👥 近所・人間関係のご相談ですね😊\n\nまず状況を詳しく聞かせてください。\n一緒に解決策を考えましょう！",
        'その他':             "💬 どんなことでもお気軽にご相談ください😊\n\n詳しい状況をテキストで送ってください。\n西舘が確認次第ご連絡します！"
      };
      const msg = solutionMsg[detail] || "「" + detail + "」のお困りですね😊\n\n詳しい状況を教えてください。";
      try {
        UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
          method: "post", headers: notionHeaders(),
          payload: JSON.stringify({
            parent: { database_id: 困りごとDB_ID },
            properties: {
              "困りごと内容":   { title:     [{ text: { content: cat + "：" + detail } }] },
              "LINE_userid":    { rich_text: [{ text: { content: userId } }] },
              "相談日時":       { date:      { start: jstISO } },
              "対応ステータス": { select:    { name: "未対応" } },
              "受付経路":       { select:    { name: "LINE" } }
            }
          }), muteHttpExceptions: true
        });
      } catch(e) { console.error("困りごとDB登録エラー: " + e); }
      try {
        const searchRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
          { method: "post", headers: notionHeaders(),
            payload: JSON.stringify({ filter: { property: "LINE_userid", rich_text: { equals: userId } } }),
            muteHttpExceptions: true });
        if (searchRes.getResponseCode() === 200) {
          const results = JSON.parse(searchRes.getContentText()).results;
          if (results.length > 0) {
            UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + results[0].id + "/children", {
              method: "patch", headers: notionHeaders(),
              payload: JSON.stringify({ children: [{ object: "block", type: "paragraph",
                paragraph: { rich_text: [{ type: "text", text: { content:
                  "▶ " + jstNow.toISOString().substring(0,10) + "  【困りごと相談】" + cat + "：" + detail
                }}]}}]}), muteHttpExceptions: true
            });
          }
        }
      } catch(e) { console.error("困りごと顧客マスター記録エラー: " + e); }
      try {
        MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
          "【困りごと相談】新着：" + cat + "：" + detail,
          "カテゴリ：" + cat + "\n詳細：" + detail + "\nLINE ID：" + userId + "\n日時：" + jstISO
        );
      } catch(e) {}
      UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
        method: "post",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
        payload: JSON.stringify({
          replyToken: replyToken,
          messages: [{
            type: "text", text: msg,
            quickReply: {
              items: [
                { type: "action", action: { type: "message", label: "✅ 解決した！",       text: "困りごと解決：" + cat + "：" + detail } },
                { type: "action", action: { type: "uri",     label: "📋 予約して相談する",  uri: reserveUrl } },
                { type: "action", action: { type: "message", label: "💬 詳しく状況を送る",  text: "困りごと状況送信：" + cat + "：" + detail } }
              ]
            }
          }]
        }),
        muteHttpExceptions: true
      });

    } else if (text.startsWith('困りごと解決：')) {
      replyToLine(replyToken, "解決できて良かったです！😊\n\nまた何かお困りのことがあれば、いつでもご相談ください🌿\n\n📞 西舘：080-8012-1720");
    } else if (text.startsWith('困りごと状況送信：')) {
      replyToLine(replyToken, "ありがとうございます😊\n\n詳しい状況をこのトークに送ってください。\n📍 場所の写真や位置情報もあると助かります！\n\n内容を確認次第、西舘がご連絡します。\n📞 お急ぎの場合:080-8012-1720");
    } else if (text.startsWith('スマホ相談：')) {
      if (checkDailyLimit(userId, 'sumaho', MAX_DAILY_KOMARI)) {
        replyToLine(replyToken, "申し訳ありません。本日の相談上限(10件)に達しました。\n明日また受け付けます😊");
        return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
      }

      const cat = text.replace('スマホ相談：', '');
      CacheService.getUserCache().put('sumaho_cat_' + userId, cat, 300);
      const smartphoneFlex = {
        '基本操作': [
          { title: '📝 文字入力・変換',    body: 'キーボードの切り替えや変換の方法を\n一緒に確認しましょう！',           detail: '基本操作_文字入力' },
          { title: '📶 Wi-Fi・ネット接続', body: 'Wi-Fiに繋がらない・遅いなど\n設定を一緒に確認します！',             detail: '基本操作_WiFi' },
          { title: '🔊 音・画面の設定',    body: '音量・着信音・画面の明るさなど\n使いやすく設定しましょう！',           detail: '基本操作_音量画面' }
        ],
        '写真・カメラ': [
          { title: '📷 写真の撮り方',      body: 'きれいに撮るコツや設定を\n一緒に確認しましょう！',                   detail: '写真_撮り方' },
          { title: '🖼️ 写真の整理・保存',  body: '写真が多くなりすぎた・どこにあるかわからない\n一緒に整理しましょう！', detail: '写真_整理保存' },
          { title: '☁️ バックアップ',      body: 'iCloud・Googleフォトの設定をしましょう！',                         detail: '写真_バックアップ' }
        ],
        'ペイ・決済': [
          { title: '💳 PayPay・d払いの設定',   body: 'スマホ決済の初期設定や使い方を\n安全に確認しましょう！',           detail: 'ペイ_設定' },
          { title: '🔒 セキュリティ・暗証番号', body: '決済アプリのセキュリティ確認をしましょう！',                     detail: 'ペイ_セキュリティ' },
          { title: '❓ 使い方がわからない',    body: 'お店でのかざし方や明細の確認方法を\n一緒に覚えましょう！',         detail: 'ペイ_使い方' }
        ],
        'LINE・メール': [
          { title: '📲 LINE引き継ぎ・移行', body: '機種変更前に必ず確認！\nLINEのデータを安全に移行しましょう。',       detail: 'LINE_引き継ぎ' },
          { title: '💬 LINEの使い方',       body: 'スタンプ・グループ・通話など\nLINEをもっと便利に使いましょう！',       detail: 'LINE_使い方' },
          { title: '📧 メールの設定・受信',  body: 'メールが届かない・送れないなど\n設定を一緒に確認しましょう！',         detail: 'メール_設定' }
        ],
        '詐欺・セキュリティ': [
          { title: '⚠️ 怪しいメッセージ',    body: '少しでも不安な場合はすぐご相談ください！',                           detail: '詐欺_メッセージ' },
          { title: '🔐 ウイルス・不審な画面', body: '「ウイルスに感染しました」等の表示が出た場合\nすぐにご連絡ください！', detail: '詐欺_ウイルス' },
          { title: '🛡️ パスワード・乗っ取り', body: 'アカウントの乗っ取りや\nパスワード管理の見直しをしましょう！',       detail: '詐欺_パスワード' }
        ]
      };
      const cards = smartphoneFlex[cat] || [{ title: '💬 相談する', body: '詳しい状況を教えてください。', detail: cat }];
      const bubbles = cards.map(function(c) {
        return makeBubble(c.title, c.body, "これを相談する", { type: "message", label: "これを相談する", text: "スマホ詳細相談：" + c.detail });
      });
      sendFlexCarousel(replyToken, "「" + cat + "」についてですね😊\n詳しい内容を選んでください👇", "スマホのお困りの内容を選んでください", bubbles);

    } else if (text.startsWith('スマホ詳細相談：')) {
      const detail = text.replace('スマホ詳細相談：', '');
      const cat    = CacheService.getUserCache().get('sumaho_cat_' + userId) || 'スマホ相談';
      const smartphoneSolutions = {
        '基本操作_文字入力':   "📝 文字入力のお困りには\n\n✅ キーボードは地球儀マークで切り替えられます\n✅ 変換候補は上にスワイプして選べます\n✅ 音声入力はマイクマークをタップで使えます\n\n上記で解決しましたか？",
        '基本操作_WiFi':       "📶 Wi-Fi接続のお困りには\n\n✅「設定」→「Wi-Fi」でネットワークを選択できます\n✅ パスワードはルーターの裏面に記載されています\n✅ 繋がらない場合はルーターを再起動してみてください\n\n上記で解決しましたか？",
        '基本操作_音量画面':   "🔊 音・画面設定のお困りには\n\n✅ 音量は本体横のボタンで調整できます\n✅ 画面の明るさは「設定」→「画面表示と明るさ」から変更できます\n\n上記で解決しましたか？",
        '写真_撮り方':         "📷 写真撮影のコツ\n\n✅ 画面をタップするとピントが合います\n✅ 両手でしっかり持って撮ると手ブレを防げます\n✅ 明るい場所で撮るとキレイに撮れます\n\n上記で解決しましたか？",
        '写真_整理保存':       "🖼️ 写真整理のお困りには\n\n✅ アルバムを作って分類すると整理しやすいです\n✅ 不要な写真はまとめて選択して削除できます\n✅ 直接お会いして一緒に整理しましょう！\n\n上記で解決しましたか？",
        '写真_バックアップ':   "☁️ バックアップのお困りには\n\n✅ iPhoneはiCloud、AndroidはGoogleフォトが便利です\n✅ Wi-Fi接続時に自動バックアップを設定しましょう\n\n上記で解決しましたか？",
        'ペイ_設定':           "💳 ペイ・決済の設定には\n\n直接お会いして安全に設定することをお勧めします😊\n\n一緒に設定しますか？",
        'ペイ_セキュリティ':   "🔒 セキュリティのご確認\n\n✅ 決済アプリは必ず公式アプリを使用してください\n✅ 暗証番号は他人に教えないようにしましょう\n\n上記で解決しましたか？",
        'ペイ_使い方':         "❓ ペイの使い方\n\n直接お店で使う練習をするのが一番わかりやすいです😊\n\n予約して練習しますか？",
        'LINE_引き継ぎ':       "📲 LINE引き継ぎは機種変更前に必ず確認！\n\n⚠️ 失敗するとトークが消える場合があるため\n直接一緒に作業することを強くお勧めします！\n\n予約して対応しますか？",
        'LINE_使い方':         "💬 LINEの使い方\n\n✅ スタンプは「+」→「スタンプ」から送れます\n✅ グループ通話は「音声通話」で複数人が参加できます\n\n上記で解決しましたか？",
        'メール_設定':         "📧 メールのお困りには\n\n✅ 迷惑メールフォルダを確認してみてください\n✅ 送信できない場合はパスワードの再確認を\n\n上記で解決しましたか？",
        '詐欺_メッセージ':     "⚠️ 怪しいメッセージへの対応\n\n✅ 不審なURLは絶対にタップしないでください\n✅ 少しでも不安な場合はスクショを撮って相談を！\n\n上記で解決しましたか？",
        '詐欺_ウイルス':       "🔐 不審な画面が出た場合\n\n✅ 「ウイルス感染」等の表示は偽物がほとんどです\n✅ 表示されたURLや番号に絶対に連絡しないでください\n✅ ブラウザを閉じて、すぐにご相談ください！",
        '詐欺_パスワード':     "🛡️ パスワード管理のお困りには\n\n✅ パスワードは定期的に変更しましょう\n✅ 同じパスワードの使い回しは危険です\n\n上記で解決しましたか？"
      };
      const msg = smartphoneSolutions[detail] || "「" + detail + "」についてですね😊\n\n詳しい状況を教えていただけると、より適切にサポートできます。\n\n上記で解決しましたか？";
      UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
        method: "post",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
        payload: JSON.stringify({
          replyToken: replyToken,
          messages: [{
            type: "text", text: msg,
            quickReply: {
              items: [
                { type: "action", action: { type: "message", label: "✅ 解決した！",      text: "スマホ相談解決：" + cat + "：" + detail } },
                { type: "action", action: { type: "uri",     label: "📋 予約して相談する", uri: "https://white-shadow1210.github.io/sumaho-shindan/reserve.html?menu=" + encodeURIComponent("スマホ整理・お悩み相談") } },
                { type: "action", action: { type: "message", label: "💬 詳しく状況を送る", text: "スマホ状況送信：" + cat + "：" + detail } }
              ]
            }
          }]
        }),
        muteHttpExceptions: true
      });

    } else if (text.startsWith('スマホ相談解決：')) {
      replyToLine(replyToken, "解決できて良かったです！😊\n\nまた何かお困りのことがあれば、いつでもご相談ください。\n\n📞 西舘：080-8012-1720");
    } else if (text.startsWith('スマホ状況送信：')) {
      replyToLine(replyToken, "ありがとうございます😊\n\n詳しい状況をこのトークに送ってください。\n📸 画面のスクリーンショットがあると助かります！\n\n内容を確認次第、西舘がご連絡します。\n📞 お急ぎの場合:080-8012-1720");
    } else if (text.startsWith('地域発見：')) {
      const cat = text.replace('地域発見：', '');
      CacheService.getUserCache().put('chiiki_category_' + userId, cat, 300);
      replyToLine(replyToken, cat + " を選んでいただきありがとうございます！\n\n📍 現在地(位置情報)を送ってください。\n続けて写真もあると嬉しいです😊\n\n※「＋」→「位置情報」から送れます。");
      addMachiPoint(userId, 3, "地域発見投稿：" + cat);
    } else if (text === 'カルテ診断完了') {
      linkLineIdToCustomer(userId, replyToken, LINE_TOKEN, jstNow);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// B. Web フォーム処理 (v6.9.1: 流入トラッキング統合)
// ==========================================
function handleWebForm(data) {
  // Task 2: トークン照合（新+旧 併用）
  const tokenCheck = isTokenValid_(data.token);
  if (!tokenCheck.ok) {
    pushAnomalyAlert_('invalid_token', {
      formType: data.formType || 'diagnosis',
      identifier: (data.name || data.lineUserId || 'unknown').substring(0, 60)
    });
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Unauthorized" })).setMimeType(ContentService.MimeType.JSON);
  }
  if (tokenCheck.legacy) {
    // 旧トークン使用：受理しつつ運営者通知（60秒/1回）
    pushAnomalyAlert_('legacy_token_used', {
      formType: data.formType || 'diagnosis',
      identifier: (data.name || data.lineUserId || 'unknown').substring(0, 60)
    });
  }

  const identifier = (data.name || "unknown").substring(0, 20);
  if (isRateLimited(identifier)) {
    pushAnomalyAlert_('rate_exceeded', {
      formType: data.formType || 'diagnosis',
      identifier: identifier
    });
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Too many requests" })).setMimeType(ContentService.MimeType.JSON);
  }

  // Task 2: スキーマ検証
  //   formType 解決：明示 formType を優先。なければ date+time で reserve、その他は diagnosis 扱い。
  var resolvedFormType = data.formType;
  if (!resolvedFormType) {
    if (data.date && data.time) resolvedFormType = 'reserve';
    else                        resolvedFormType = 'diagnosis';
  }
  const vr = validatePayload_(resolvedFormType, data);
  if (!vr.ok) {
    if (vr.severity === 'reject') {
      pushAnomalyAlert_('validation_failed', {
        formType: resolvedFormType,
        identifier: identifier,
        fieldErrors: vr.errors
      });
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Invalid input" })).setMimeType(ContentService.MimeType.JSON);
    }
    // warn 既定：受理＋通知のみ
    pushAnomalyAlert_('validation_failed', {
      formType: resolvedFormType,
      identifier: identifier,
      fieldErrors: vr.errors
    });
  }

  // 既存散発チェック（据置・二重防御）
  if (data.name   && data.name.length   > 100)  return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Invalid input" })).setMimeType(ContentService.MimeType.JSON);
  if (data.detail && data.detail.length > 1000) return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Invalid input" })).setMimeType(ContentService.MimeType.JSON);

  // ★ v6.9.1: 流入経路の正規化(英数字とアンダースコア・ハイフンのみ許可)
  var cleanSource = '';
  if (data.source && typeof data.source === 'string') {
    cleanSource = data.source.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50);
    if (cleanSource.length > 0) {
      console.log('[流入トラッキング] source=' + cleanSource);
    }
  }

  const jstNow   = new Date(new Date().getTime() + (9 * 60 * 60 * 1000));
  const jstISO   = jstNow.toISOString().replace('Z', '+09:00');
  const todayStr = jstNow.toISOString().substring(0, 10);
  if (data.date && data.time && !tryLockSlot(data.date, data.time)) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "SLOT_CONFLICT" })).setMimeType(ContentService.MimeType.JSON);
  }

  // サブスク申し込み → Notionに自動反映
  if (data.formType === 'subscription') {
    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
        '【かかりつけ登録】新着申込：' + (data.name||'不明') + '様',
        'お名前：' + (data.name||'') + '\nLINE名：' + (data.lineName||'') + '\n電話番号：' + (data.tel||'') +
        '\nプラン：' + (data.plan||'') + '(' + (data.cycle||'') + ')\nお支払い：' + (data.payment||'') +
        '\n金額：¥' + (data.amount||'') + '\n受信日時：' + jstISO +
        (cleanSource ? '\n流入経路：' + cleanSource : '') +
        '\n\n▼ 対応手順\n1. お支払い確認\n2. Notionは自動で「かかりつけ会員」フラグONされています\n3. LINEで会員パスワードを送付'
      );
    } catch(e) { console.error('サブスク申込メールエラー: ' + e); }

    if (data.tel) {
      try {
        const cleanTel = data.tel.replace(/[^\d]/g,"");
        const searchRes = UrlFetchApp.fetch(
          "https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
          { method: "post", headers: notionHeaders(),
            payload: JSON.stringify({
              filter: { property: "電話番号", rich_text: { contains: cleanTel } }
            }), muteHttpExceptions: true }
        );
        if (searchRes.getResponseCode() === 200) {
          const results = JSON.parse(searchRes.getContentText()).results;
          if (results.length > 0) {
            const pageId = results[0].id;
            const updateProps = {
              "かかりつけ会員": { checkbox: true },
              "対応ステータス": { select: { name: "会員" } }
            };
            if (cleanSource) updateProps["流入経路"] = { select: { name: cleanSource } };
            UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + pageId, {
              method: "patch", headers: notionHeaders(),
              payload: JSON.stringify({ properties: updateProps }), muteHttpExceptions: true
            });
            UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + pageId + "/children", {
              method: "patch", headers: notionHeaders(),
              payload: JSON.stringify({ children: [{ object: "block", type: "paragraph",
                paragraph: { rich_text: [{ type: "text", text: { content:
                  "▶ " + todayStr + "  【かかりつけ会員登録】" + (data.plan||'') + " " + (data.cycle||'') + " ¥" + (data.amount||'') +
                  (cleanSource ? " 流入:" + cleanSource : '')
                }}]}}]}), muteHttpExceptions: true
            });
            console.log("サブスク会員自動反映: " + cleanTel + " → 顧客マスター更新");
          } else {
            const createPayload = {
              parent: { database_id: CUSTOMER_MASTER_ID },
              properties: {
                "氏名":           { title:     [{ text: { content: data.name || "未入力" } }] },
                "電話番号":       { rich_text: [{ text: { content: data.tel  || "" } }] },
                "初回登録日":     { date:      { start: todayStr } },
                "最終来店日":     { date:      { start: todayStr } },
                "対応ステータス": { select:    { name: "会員" } },
                "かかりつけ会員": { checkbox:  true }
              }
            };
            if (cleanSource) createPayload.properties["流入経路"] = { select: { name: cleanSource } };
            UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
              method: "post", headers: notionHeaders(),
              payload: JSON.stringify(createPayload), muteHttpExceptions: true
            });
            console.log("サブスク会員 新規作成: " + cleanTel);
          }
        }
      } catch(e) { console.error("サブスク会員自動反映エラー: " + e); }
    }
    return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
  }

  let customerMasterPageId = null;
  if (data.tel) {
    let historyText = "";
    const upsertParams = {
      name: data.name||'', tel: data.tel||'', email: data.email||'',
      lineUserId: data.lineUserId||'', lineDisplayName: data.lineDisplayName||'',
      lineName: data.lineName||'',
      source: cleanSource  // ★ v6.9.1: 流入経路
    };

    if (data.formType === 'app_check') {
      historyText = "【アプリチェック】利用中: " + (data.appUsed||"なし") + " / 移行必須: " + (data.appTransfer||"なし");
      upsertParams.appUsed     = data.appUsed     || '';
      upsertParams.appTransfer = data.appTransfer || '';
      upsertParams.karteDate   = todayStr;

    } else if (data.formType === 'karte') {
      historyText = data.historyText || (
        "【スマホカルテ更新】" +
        (data.carrier ? "現在:" + data.carrier + " " : "") +
        (data.device  ? "端末:" + data.device  + " " : "") +
        (data.battery ? "バッテリー:" + data.battery + " " : "") +
        (data.propCarrier ? "→提案:" + data.propCarrier + " " + (data.propPlanName||'') : "") +
        (Number(data.savingCost) > 0 ? " 節約:¥" + Number(data.savingCost).toLocaleString() + "/月" : "")
      );
      
      upsertParams.carrier      = data.carrier      || '';
      upsertParams.device       = data.device       || '';
      upsertParams.battery      = data.battery      || '';
      upsertParams.storage      = data.storage      || '';
      upsertParams.buyTime      = data.buyTime      || '';
      upsertParams.karteDate    = todayStr;
      upsertParams.appUsed      = data.appUsed      || '';
      upsertParams.appTransfer  = data.appTransfer  || '';
      upsertParams.currentCost  = Number(data.currentCost)  || 0;
      upsertParams.proposedCost = Number(data.proposedCost) || 0;
      upsertParams.savingCost   = Number(data.savingCost)   || 0;
      upsertParams.propCarrier  = data.propCarrier  || '';
      upsertParams.propPlanName = data.propPlanName || '';
      upsertParams.discounts    = data.discounts    || '';
      upsertParams.nextFollow   = data.nextFollow   || '';
      upsertParams.target       = data.target       || '';
      upsertParams.wifi         = data.wifi         || '';
      upsertParams.simConfig    = data.simConfig    || '';
      upsertParams.contractType = data.contractType || '';

    } else if (data.formType === 'simulation') {
      historyText = "【料金シミュレーション】" + (data.carrier||'') + " 現状:¥" + (data.currentCost||0) + " → 提案後:¥" + (data.proposedCost||0) + " 月額節約:¥" + (data.savingCost||0);
      upsertParams.carrier      = data.carrier      || '';
      upsertParams.currentCost  = Number(data.currentCost)  || 0;
      upsertParams.proposedCost = Number(data.proposedCost) || 0;
      upsertParams.savingCost   = Number(data.savingCost)   || 0;
      upsertParams.device       = data.device || '';
      upsertParams.propCarrier  = data.propCarrier  || '';
      upsertParams.propPlanName = data.propPlanName || '';
      upsertParams.discounts    = data.discounts    || '';

    } else if (data.date && data.time) {
      historyText = "【予約】" + data.date + " " + data.time + "〜 " + (data.menu||'') + " " + (data.price === 0 ? "無料" : "¥" + Number(data.price||0).toLocaleString());
      if (data.usePreMemberBenefit) historyText += " [🌟プレ会員特典使用]";
      if (data.lineUserId) addMachiPoint(data.lineUserId, 5, "予約送信");

      // ★ v7.0: プレ会員特典の使用処理
      if (data.usePreMemberBenefit === true) {
        try {
          handlePreMemberBenefit(data);
        } catch(preErr) {
          console.error('[プレ会員特典] 呼出エラー: ' + preErr);
        }
      }

    } else {
      historyText = "【スマホ診断】" + (data.q1 ? "キャリア:" + data.q1 : '') + (data.q2 ? " 料金:" + data.q2 : '');
      if (cleanSource) historyText += ' [流入:' + cleanSource + ']';
      upsertParams.carrier = data.q1 || '';
      if (data.lineUserId) addMachiPoint(data.lineUserId, 3, "スマホ診断送信");

      const cleanTel = (data.tel || '').replace(/[^\d]/g, '');
      if (cleanTel.length >= 10) {
        CacheService.getScriptCache().put('diag_latest_tel', cleanTel, 3600);
        CacheService.getScriptCache().put('diag_tel_' + cleanTel, '1', 3600);
        console.log("Cache保存: diag_latest_tel = " + cleanTel);
      }
    }
    upsertParams.historyText = historyText;
    customerMasterPageId = upsertCustomerMaster(upsertParams);
  }

  // ★ v6.9: karte v2 LINE表示名フォールバック検索
  if (!customerMasterPageId && data.formType === 'karte' && data.lineName) {
    customerMasterPageId = findCustomerByLineDisplayName(data.lineName);
    if (customerMasterPageId) {
      console.log('[karte v2] LINE表示名で既存顧客を発見し紐付け: ' + data.lineName);
      try {
        const updatePayload = { properties: {} };
        if (data.name)        updatePayload.properties["氏名"]              = { title: [{ text: { content: data.name } }] };
        if (data.tel)         updatePayload.properties["電話番号"]          = { rich_text: [{ text: { content: data.tel } }] };
        if (data.email)       updatePayload.properties["メールアドレス"]    = { rich_text: [{ text: { content: data.email } }] };
        if (data.carrier)     updatePayload.properties["利用キャリア"]      = { rich_text: [{ text: { content: data.carrier } }] };
        if (data.device)      updatePayload.properties["利用端末"]          = { rich_text: [{ text: { content: data.device } }] };
        if (data.battery)     updatePayload.properties["バッテリー状態"]    = { rich_text: [{ text: { content: data.battery } }] };
        if (data.storage)     updatePayload.properties["ストレージ空き"]    = { rich_text: [{ text: { content: data.storage } }] };
        if (data.buyTime)     updatePayload.properties["買い替え時期"]      = { rich_text: [{ text: { content: data.buyTime } }] };
        if (data.propCarrier) updatePayload.properties["提案キャリア"]      = { rich_text: [{ text: { content: data.propCarrier } }] };
        if (data.propPlanName)updatePayload.properties["提案プラン名"]      = { rich_text: [{ text: { content: data.propPlanName } }] };
        if (data.discounts)   updatePayload.properties["適用割引"]          = { rich_text: [{ text: { content: data.discounts } }] };
        if (data.nextFollow)  updatePayload.properties["次回フォロー予定"]  = { rich_text: [{ text: { content: data.nextFollow } }] };
        if (data.target)      updatePayload.properties["対象者"]            = { select: { name: data.target } };
        if (data.wifi)        updatePayload.properties["自宅Wi-Fi"]          = { rich_text: [{ text: { content: data.wifi } }] };
        if (data.simConfig)   updatePayload.properties["SIM構成"]            = { select: { name: data.simConfig } };
        if (data.contractType)updatePayload.properties["申込区分"]          = { rich_text: [{ text: { content: data.contractType } }] };
        if (cleanSource)      updatePayload.properties["流入経路"]          = { select: { name: cleanSource } };
        if (data.currentCost  !== undefined) updatePayload.properties["現在の月額"]  = { number: Number(data.currentCost) || 0 };
        if (data.proposedCost !== undefined) updatePayload.properties["提案後月額"]  = { number: Number(data.proposedCost) || 0 };
        if (data.savingCost   !== undefined) updatePayload.properties["月額節約額"]  = { number: Number(data.savingCost) || 0 };
        if (data.appUsed)     updatePayload.properties["利用中アプリ"]      = { rich_text: [{ text: { content: data.appUsed } }] };
        if (data.appTransfer) updatePayload.properties["移行必須アプリ"]    = { rich_text: [{ text: { content: data.appTransfer } }] };
        updatePayload.properties["最終来店日"]       = { date: { start: todayStr } };
        updatePayload.properties["スマホカルテ更新日"] = { date: { start: todayStr } };
        
        UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + customerMasterPageId, {
          method: "patch", headers: notionHeaders(), payload: JSON.stringify(updatePayload), muteHttpExceptions: true
        });
        
        if (data.historyText) {
          UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + customerMasterPageId + "/children", {
            method: "patch", headers: notionHeaders(),
            payload: JSON.stringify({ children: [{ object: "block", type: "paragraph",
              paragraph: { rich_text: [{ type: "text", text: { content: "▶ " + todayStr + "  " + data.historyText } }] }
            }]}), muteHttpExceptions: true
          });
        }
      } catch(e) { console.error('LINE表示名紐付け更新エラー: ' + e); }
    }
  }

  if (!customerMasterPageId && data.lineUserId) {
    const lineData = Object.assign({}, data, { source: cleanSource });
    customerMasterPageId = upsertCustomerMasterByLineId(lineData);
  }

  if (data.formType === 'karte' && customerMasterPageId) {
    try {
      registerKomariFromKarte(data, customerMasterPageId);
    } catch(komariErr) {
      console.warn('困りごとDB転記エラー(カルテ保存は成功): ' + komariErr);
    }
  }

  if (data.formType === 'app_check') return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  if (data.formType === 'karte')      return ContentService.createTextOutput(JSON.stringify({ status: "success", customerPageId: customerMasterPageId })).setMimeType(ContentService.MimeType.JSON);
  if (data.formType === 'simulation') return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  if (data.formType === 'chiiki_like') return handleChiikiLike(data);

  const payload = { parent: { database_id: DIAGNOSIS_DB_ID }, properties: {} };
  if (data.name) payload.properties["name"] = { title: [{ text: { content: data.name } }] };
  let typeName = data.menu || "総合診断";
  let durationMinutes = 90, priceText = "3,300円〜";
  if      (data.consult_type === "plan"   || (data.menu && data.menu.includes("プラン")))     { typeName = "プラン相談";       durationMinutes = 90;  priceText = "5,500円 (税込)"; }
  else if (data.consult_type === "device" || (data.menu && data.menu.includes("データ移行"))) { typeName = "機種変更";         durationMinutes = 120; priceText = "11,000円 (税込)"; }
  else if (data.consult_type === "other"  || (data.menu && data.menu.includes("整理")))       { typeName = "その他・不具合";   durationMinutes = 60;  priceText = "3,300円 (税込)"; }
  else if (data.menu && data.menu.includes("健康診断")) { typeName = "スマホ健康診断";   durationMinutes = 30; priceText = "無料"; }
  else if (data.menu && data.menu.includes("定期点検")) { typeName = "定期点検サポート"; durationMinutes = 45; priceText = "会員無料"; }
  if (data.price !== undefined && data.price !== null) {
    priceText = data.price === 0 ? "無料" : "¥" + Number(data.price).toLocaleString() + " (税込)";
  }
  payload.properties["相談種別"] = { select: { name: typeName } };
  payload.properties["受信日時"] = { date:   { start: jstISO } };
  if (data.detail) payload.properties["Q8_相談詳細"]     = { rich_text: [{ text: { content: data.detail } }] };
  if (data.q1)     payload.properties["Q1_携帯会社"]      = { select:    { name: data.q1 } };
  if (data.q2)     payload.properties["Q2_毎月の支払額"]  = { select:    { name: data.q2 } };
  if (data.q4)     payload.properties["Q4_通話スタイル"]  = { select:    { name: data.q4 } };
  if (data.q5)     payload.properties["Q5_ネット環境"]    = { select:    { name: data.q5 } };
  if (data.q6)     payload.properties["Q6_買い替え時期"]  = { select:    { name: data.q6 } };
  if (data.q3 && data.q3.length > 0) payload.properties["Q3_データ通信量"] = { multi_select: data.q3.map(i => ({ name: i })) };
  if (data.q7 && data.q7.length > 0) payload.properties["Q7_気になること"] = { multi_select: data.q7.map(i => ({ name: i })) };
  if (data.tel)        payload.properties["電話番号"]      = { rich_text: [{ text: { content: data.tel   } }] };
  if (data.email)      payload.properties["メールアドレス"] = { rich_text: [{ text: { content: data.email } }] };
  if (customerMasterPageId) payload.properties["顧客マスター"] = { relation: [{ id: customerMasterPageId }] };
  if (data.lineUserId) payload.properties["LINE_userid"]    = { rich_text: [{ text: { content: data.lineUserId } }] };

  if (data.date && data.time) {
    try {
      const calendar = CalendarApp.getDefaultCalendar();
      const dateStr  = data.date.replace(/-/g,'/').replace(/年/g,'/').replace(/月/g,'/').replace(/日/g,'').trim();
      const timeStr  = data.time.replace(/時/g,':').replace(/分/g,'').trim();
      const start    = new Date(dateStr + " " + timeStr);
      if (!isNaN(start.getTime())) {
        const end = new Date(start.getTime() + ((durationMinutes + 30) * 60 * 1000));
        calendar.createEvent("【スマホ相談】" + (data.name||'不明') + "様", start, end, {
          description: "メニュー: " + typeName + "\n電話: " + (data.tel||'なし') + "\nメール: " + (data.email||'なし') + "\n詳細: " + (data.detail||'なし') +
                       (cleanSource ? "\n流入経路: " + cleanSource : '')
        });
      }
    } catch (e) { console.error("Calendar Error: " + e); }
  }
  if (data.email) {
    try {
      MailApp.sendEmail(data.email, "【スマホの相談士】ご予約を承りました",
        (data.name||'お客様') + " 様\n\nご予約ありがとうございます。\n\n【日時】" + (data.date||'---') + " " + (data.time||'') + " 〜\n【メニュー】" + (data.menu||typeName) +
        "\n【料金目安】" + priceText + "\n【お電話番号】" + (data.tel||'---') + "\n\nスマホの相談士　西舘(櫻井)\n電話：080-8012-1720"
      );
    } catch (e) { console.error("User Email Error: " + e); }
  }
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), "【新着】" + (data.name||'不明') + "様(" + priceText + ")",
      "お名前: " + (data.name||'なし') + "\n日時: " + (data.date||'なし') + " " + (data.time||'') + "〜\n" +
      "メニュー: " + (data.menu||typeName) + "\n料金: " + priceText + "\n電話: " + (data.tel||'なし') +
      "\nメール: " + (data.email||'なし') + "\n詳細: " + (data.detail||'なし') + "\n受信日時: " + jstISO +
      (cleanSource ? "\n★流入経路: " + cleanSource : '') +
      (data.usePreMemberBenefit ? "\n🌟 プレ会員特典使用あり (要無料対応)" : '') +
      (customerMasterPageId ? "\n\n★顧客マスター紐付け: 完了" : "\n\n★顧客マスター紐付け: 電話番号なし(スキップ)")
    );
  } catch (e) { console.error("Owner Email Error: " + e); }
  try {
    const notionRes = UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
      method: "post", headers: notionHeaders(), payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    if (notionRes.getResponseCode() !== 200) console.error("Notion エラー: " + notionRes.getContentText());
  } catch (e) { console.error("Notion Error: " + e); }
  return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// その他関数(getFreeSlotCount, KML, replyKarteQuick, replyMyPage,
//          linkLineIdToCustomer, addMachiPoint, リッチメニュー,
//          街のお知らせ, リアクション, listTriggers)
// → v6.9から変更なし、Part1冒頭のコメントの通り
//
// ★ v6.9.1 新規追加関数: generateSourceReport / setSourceReportTrigger
// ==========================================

// ==========================================
// ★ v6.9.1: 流入経路レポート(週次自動メール)
// ==========================================
function generateSourceReport() {
  try {
    var results = [];
    var hasMore = true;
    var nextCursor = null;
    
    while (hasMore) {
      var payload = { page_size: 100 };
      if (nextCursor) payload.start_cursor = nextCursor;
      
      var res = UrlFetchApp.fetch(
        "https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
        {
          method: "post",
          headers: notionHeaders(),
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        }
      );
      
      if (res.getResponseCode() !== 200) {
        console.error("Notion取得エラー: " + res.getContentText());
        break;
      }
      
      var data = JSON.parse(res.getContentText());
      results = results.concat(data.results || []);
      hasMore = data.has_more;
      nextCursor = data.next_cursor;
    }
    
    var sourceCounts = {};
    var sourceMembers = {};
    var sourceFirstDates = {};
    
    results.forEach(function(page) {
      var p = page.properties;
      var src = (p["流入経路"] && p["流入経路"].select) 
        ? p["流入経路"].select.name 
        : "direct(チラシ無し)";
      var isMember = (p["かかりつけ会員"] && p["かかりつけ会員"].checkbox) || false;
      var firstDate = (p["初回登録日"] && p["初回登録日"].date)
        ? p["初回登録日"].date.start : '';
      
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      if (isMember) sourceMembers[src] = (sourceMembers[src] || 0) + 1;
      if (!sourceFirstDates[src] || firstDate < sourceFirstDates[src]) {
        sourceFirstDates[src] = firstDate;
      }
    });
    
    var sorted = Object.keys(sourceCounts).sort(function(a, b) {
      return sourceCounts[b] - sourceCounts[a];
    });
    
    var lines = ['【流入経路レポート】' + new Date().toLocaleDateString('ja-JP'), ''];
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('順位  流入経路              来訪  会員  転換率');
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    
    sorted.forEach(function(src, i) {
      var c = sourceCounts[src];
      var m = sourceMembers[src] || 0;
      var rate = c > 0 ? Math.round((m / c) * 1000) / 10 : 0;
      var rank = ('  ' + (i + 1)).slice(-2);
      var srcPad = (src + '                    ').substring(0, 20);
      var cPad = ('   ' + c).slice(-4);
      var mPad = ('   ' + m).slice(-4);
      var rPad = ('     ' + rate).slice(-5) + '%';
      lines.push(rank + '.  ' + srcPad + cPad + mPad + '   ' + rPad);
    });
    
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push('合計: ' + results.length + '名');
    lines.push('会員: ' + Object.values(sourceMembers).reduce(function(a,b){return a+b;}, 0) + '名');
    lines.push('');
    lines.push('── 改善のヒント ──');
    lines.push('・転換率が高い場所 → チラシ追加配布を検討');
    lines.push('・来訪0の場所 → 設置場所の見直し or チラシ刷新');
    
    var body = lines.join('\n');
    console.log(body);
    
    MailApp.sendEmail(
      Session.getEffectiveUser().getEmail(),
      '【流入レポート】' + new Date().toLocaleDateString('ja-JP'),
      body
    );
    
    return body;
    
  } catch(e) {
    console.error('generateSourceReport エラー: ' + e);
    return null;
  }
}

function setSourceReportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'generateSourceReport') {
      ScriptApp.deleteTrigger(t);
    }
  });
  
  ScriptApp.newTrigger('generateSourceReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .create();
  
  console.log('✅ 流入レポート週次トリガー設定完了(毎週月曜9時)');
}


// ==========================================
// 以下、v6.9 から変更なしの既存関数群
// ==========================================

// ==========================================
// GAS v6.9.1 Part 3 (Part2の続き)
// Part1・Part2の後ろに連結して貼り付けてください
// 
// 含まれる関数:
//   - getFreeSlotCount
//   - generateAndSaveKML / xmlEscape / setKMLTrigger
//   - authTest
//   - replyKarteQuick
//   - replyMyPage
//   - linkLineIdToCustomer
//   - addMachiPoint
//   - customerMasterTest / testKarteV2
//   - setupRichMenus / createRichMenu / uploadImageFromDrive
//   - buildMenuConfig / deleteAllRichMenus_
//   - resetRichMenuAliases / listRichMenus
//   - getOshiraseData / getSampleOshiraseItems
//   - clearOshiraseCache / clearChiikiCache
//   - autoUpdateOshirase / setOshiraseTrigger
//   - handleOshiraseReaction / listTriggers
// ==========================================

function getFreeSlotCount() {
  try {
    const now = new Date(new Date().getTime() + 9*60*60*1000);
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const firstDay = y + "-" + m + "-01";

    const searchRes = UrlFetchApp.fetch(
      "https://api.notion.com/v1/databases/" + DIAGNOSIS_DB_ID + "/query",
      { method: "post", headers: notionHeaders(),
        payload: JSON.stringify({
          filter: {
            and: [
              { property: "相談種別", select: { equals: "スマホ健康診断" } },
              { property: "受信日時", date: { on_or_after: firstDay } }
            ]
          },
          page_size: 100
        }),
        muteHttpExceptions: true }
    );
    if (searchRes.getResponseCode() !== 200) {
      return { max: FREE_SLOT_MAX_PER_MONTH, used: 0, remaining: FREE_SLOT_MAX_PER_MONTH };
    }
    const used = JSON.parse(searchRes.getContentText()).results.length;
    return {
      max:       FREE_SLOT_MAX_PER_MONTH,
      used:      used,
      remaining: Math.max(0, FREE_SLOT_MAX_PER_MONTH - used)
    };
  } catch(e) {
    console.error("getFreeSlotCount エラー: " + e);
    return { max: FREE_SLOT_MAX_PER_MONTH, used: 0, remaining: FREE_SLOT_MAX_PER_MONTH };
  }
}

// ==========================================
// KML 生成
// ==========================================
function generateAndSaveKML() {
  try {
    const ss    = SpreadsheetApp.openById(MAP_SHEET_ID);
    const sheet = ss.getSheetByName("防犯記録");
    if (!sheet) throw new Error("防犯記録シートなし");
    const rows     = sheet.getDataRange().getValues();
    const startRow = (rows[0] && String(rows[0][0]).includes('報告')) ? 1 : 0;
    let   placemarks = '';
    for (let i = startRow; i < rows.length; i++) {
      const row = rows[i];
      const lat = parseFloat(row[3]), lng = parseFloat(row[4]);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) continue;
      placemarks += '  <Placemark>\n    <n>' + xmlEscape(String(row[1]||'巡回ポイント')) + '</n>\n' +
        '    <description><![CDATA[住所: ' + xmlEscape(String(row[2]||'')) + '<br>日時: ' + xmlEscape(String(row[0]||'').substring(0,19)) + ']]></description>\n' +
        '    <Point><coordinates>' + lng + ',' + lat + ',0</coordinates></Point>\n  </Placemark>\n';
    }
    const kml = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n  <n>スマホの相談士 防犯パトロール記録</n>\n' + placemarks + '</Document>\n</kml>';
    const folder = DriveApp.getFolderById(IMAGE_FOLDER_ID);
    const files  = folder.getFilesByName('bohan_patrol.kml');
    if (files.hasNext()) { files.next().setContent(kml); } else { folder.createFile('bohan_patrol.kml', kml, 'application/vnd.google-earth.kml+xml'); }
  } catch (err) { console.error("generateAndSaveKML Error: " + err); }
}
function xmlEscape(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function setKMLTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'generateAndSaveKML') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('generateAndSaveKML').timeBased().everyDays(1).atHour(3).create();
}

// ==========================================
// 動作テスト
// ==========================================
function authTest() {
  const myEmail = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(myEmail, "【GAS承認テスト v6.9】設定確認", [
    "このメールが届いていれば MailApp の権限は正常です。",
    "", "── スクリプトプロパティ確認 ──",
    "NOTION_API_KEY      : " + (props.getProperty("NOTION_API_KEY")     ? "✅ 設定済" : "❌ 未設定"),
    "MAP_SHEET_ID        : " + (props.getProperty("MAP_SHEET_ID")        ? "✅ 設定済" : "❌ 未設定"),
    "IMAGE_FOLDER_ID     : " + (props.getProperty("IMAGE_FOLDER_ID")     ? "✅ 設定済" : "❌ 未設定"),
    "LINE_ACCESS_TOKEN   : " + (props.getProperty("LINE_ACCESS_TOKEN")   ? "✅ 設定済" : "❌ 未設定"),
    "", "── DBハードコード確認 ──",
    "DIAGNOSIS_DB_ID    : " + DIAGNOSIS_DB_ID,
    "CUSTOMER_MASTER_ID : " + CUSTOMER_MASTER_ID,
    "困りごとDB_ID      : " + 困りごとDB_ID
  ].join("\n"));
}

// ==========================================
// カルテ確認クイック返信
// ==========================================
function replyKarteQuick(userId, replyToken) {
  const LINE_TOKEN = props.getProperty("LINE_ACCESS_TOKEN");
  if (!LINE_TOKEN || !userId) return;
  try {
    const searchRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
      { method: "post", headers: notionHeaders(),
        payload: JSON.stringify({ filter: { property: "LINE_userid", rich_text: { equals: userId } } }),
        muteHttpExceptions: true });
    if (searchRes.getResponseCode() !== 200) { replyToLine(replyToken, "カルテ情報を取得できませんでした。"); return; }
    const results = JSON.parse(searchRes.getContentText()).results;
    if (!results || results.length === 0) {
      replyToLine(replyToken, "📋 カルテ情報がまだ登録されていません。\n\n対面でのヒアリング後に記録されます😊");
      return;
    }
    const p = results[0].properties;
    function safeText(prop)  { try { return (prop && prop.rich_text && prop.rich_text[0]) ? prop.rich_text[0].plain_text : ""; } catch(e) { return ""; } }
    function safeTitle(prop) { try { return (prop && prop.title && prop.title[0]) ? prop.title[0].plain_text : ""; } catch(e) { return ""; } }
    function safeNum(prop)   { try { return (prop && prop.number !== null && prop.number !== undefined) ? prop.number : null; } catch(e) { return null; } }
    function safeDate(prop)  { try { return (prop && prop.date) ? prop.date.start : null; } catch(e) { return null; } }

    const name        = safeTitle(p["氏名"])           || "未設定";
    const carrier     = safeText(p["利用キャリア"])     || "未記録";
    const device      = safeText(p["利用端末"])         || "未記録";
    const battery     = safeText(p["バッテリー状態"])   || "未記録";
    const storage     = safeText(p["ストレージ空き"])   || "未記録";
    const curCost     = safeNum(p["現在の月額"]);
    const propCost    = safeNum(p["提案後月額"]);
    const saveCost    = safeNum(p["月額節約額"]);
    const propCarrier = safeText(p["提案キャリア"])     || "";
    const propPlan    = safeText(p["提案プラン名"])     || "";
    const discounts   = safeText(p["適用割引"])         || "";
    const nextFollow  = safeText(p["次回フォロー予定"]) || "";
    const appTrans    = safeText(p["移行必須アプリ"])   || "未記録";
    const appUsed     = safeText(p["利用中アプリ"])     || "未記録";
    const karteDate   = safeDate(p["スマホカルテ更新日"]);

    const reserveUrl = "https://white-shadow1210.github.io/sumaho-shindan/reserve.html";

    const c1 = makeMyPageBubble(
      "#249496", "🩺", "スマホカルテ",
      [
        { label: "氏名",         value: name },
        { label: "キャリア",     value: carrier },
        { label: "端末",         value: device },
        { type: "separator" },
        { label: "バッテリー",   value: battery },
        { label: "ストレージ",   value: storage },
        { label: "更新日",       value: karteDate ? karteDate.replace(/-/g,"/") : "未実施" }
      ],
      { type: "uri", label: "定期点検を予約する", uri: reserveUrl }
    );

    const hasSim = curCost !== null;
    const c2 = makeMyPageBubble(
      "#e67e22", "💰", "料金シミュレーション",
      hasSim ? [
        { label: "現在月額",     value: "¥" + Number(curCost).toLocaleString(), bold: true },
        { label: "提案後月額",   value: "¥" + Number(propCost||0).toLocaleString(), bold: true },
        { label: "月額節約額",   value: "¥" + Number(saveCost||0).toLocaleString() + "/月", bold: true },
        { label: "年間節約額",   value: "¥" + (Number(saveCost||0)*12).toLocaleString() },
        { type: "separator" },
        { label: "提案キャリア", value: propCarrier || "未記入" },
        { label: "提案プラン",   value: propPlan    || "未記入" },
        { label: "適用割引",     value: discounts   || "なし" }
      ] : [
        { label: "状態", value: "料金シミュレーション未実施" }
      ],
      { type: "uri", label: "プラン相談を予約する", uri: reserveUrl }
    );

    const c3 = makeMyPageBubble(
      "#8e44ad", "📦", "アプリ・フォロー",
      [
        { label: "移行必須アプリ", value: appTrans.length > 50 ? appTrans.substring(0,50)+"…" : appTrans, bold: true },
        { label: "利用中アプリ",   value: appUsed.length > 50 ? appUsed.substring(0,50)+"…" : appUsed },
        { type: "separator" },
        { label: "次回フォロー",   value: nextFollow || "未設定", bold: !!nextFollow }
      ],
      { type: "uri", label: "データ移行を相談する", uri: reserveUrl + "?menu=" + encodeURIComponent("完全データ移行パック") }
    );

    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
      method: "post",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [
          { type: "text", text: "📋 " + name + " さんのカルテ情報です😊" },
          {
            type: "flex",
            altText: name + " さんのカルテ確認",
            contents: { type: "carousel", contents: [c1, c2, c3] }
          }
        ]
      }),
      muteHttpExceptions: true
    });
  } catch(e) {
    console.error("replyKarteQuick エラー: " + e);
    replyToLine(replyToken, "カルテ情報の取得中にエラーが発生しました。しばらく経ってから再度お試しください。");
  }
}

// ==========================================
// マイページ → Flex Messageカルーセル6枚
// ==========================================
function replyMyPage(userId, replyToken) {
  const LINE_TOKEN = props.getProperty("LINE_ACCESS_TOKEN");
  if (!LINE_TOKEN || !userId) return;
  try {
    const searchRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
      { method: "post", headers: notionHeaders(),
        payload: JSON.stringify({ filter: { property: "LINE_userid", rich_text: { equals: userId } } }),
        muteHttpExceptions: true });
    if (searchRes.getResponseCode() !== 200) { replyToLine(replyToken, "マイページを取得できませんでした。しばらく経ってから再度お試しください。"); return; }
    const results = JSON.parse(searchRes.getContentText()).results;
    if (!results || results.length === 0) {
      try {
        const todayStr2 = new Date(new Date().getTime() + 9*60*60*1000).toISOString().substring(0, 10);
        let dispName2 = '';
        try {
          const pr2 = UrlFetchApp.fetch("https://api.line.me/v2/bot/profile/" + userId,
            { headers: { "Authorization": "Bearer " + LINE_TOKEN }, muteHttpExceptions: true });
          if (pr2.getResponseCode() === 200) dispName2 = JSON.parse(pr2.getContentText()).displayName || '';
        } catch(e2) {}
        if (dispName2) {
          UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
            method: "post", headers: notionHeaders(),
            payload: JSON.stringify({ parent: { database_id: CUSTOMER_MASTER_ID }, properties: {
              "氏名":             { title:     [{ text: { content: dispName2 } }] },
              "LINE_userid":      { rich_text: [{ text: { content: userId } }] },
              "LINE_displayName": { rich_text: [{ text: { content: dispName2 } }] },
              "初回登録日":       { date: { start: todayStr2 } },
              "最終来店日":       { date: { start: todayStr2 } },
              "対応ステータス":   { select: { name: "新規" } }
            }}), muteHttpExceptions: true
          });
          replyToLine(replyToken,
            "📋 " + dispName2 + " さんのマイページを作成しました！😊\n\n" +
            "━━━━━━━━━━━━━━━━\n" +
            "📱 無料スマホ診断を受けると\n" +
            "　 キャリア・料金プランが記録されます\n\n" +
            "📋 WEB予約をすると\n" +
            "　 来店履歴が記録されます\n\n" +
            "🩺 対面でカルテを記入すると\n" +
            "　 端末・バッテリー・節約額が見られます\n" +
            "━━━━━━━━━━━━━━━━\n\n" +
            "まずは無料診断からどうぞ😊"
          );
        } else {
          replyToLine(replyToken,
            "📋 マイページ\n\nまだ情報が登録されていません。\n\n" +
            "【登録方法】\n" +
            "✅ 無料スマホ診断に回答する\n" +
            "✅ WEB予約フォームで予約する\n\n" +
            "いずれかをご利用ください😊"
          );
        }
      } catch(e3) {
        replyToLine(replyToken, "📋 マイページ\n\nまだ情報が登録されていません。\n\n無料スマホ診断または予約フォームをご利用ください😊");
      }
      return;
    }
    const page = results[0];
    const p    = page.properties;

    function safeText(prop)  { try { return (prop && prop.rich_text && prop.rich_text[0]) ? prop.rich_text[0].plain_text : ""; } catch(e) { return ""; } }
    function safeTitle(prop) { try { return (prop && prop.title && prop.title[0]) ? prop.title[0].plain_text : ""; } catch(e) { return ""; } }
    function safeSelect(prop){ try { return (prop && prop.select) ? prop.select.name : ""; } catch(e) { return ""; } }
    function safeDate(prop)  { try { return (prop && prop.date) ? prop.date.start : null; } catch(e) { return null; } }
    function safeNum(prop)   { try { return (prop && prop.number !== undefined) ? prop.number : null; } catch(e) { return null; } }
    function safeCheck(prop) { try { return (prop && prop.checkbox) ? true : false; } catch(e) { return false; } }

    const name       = safeTitle(p["氏名"])        || "未設定";
    const points     = safeNum(p["ポイント"])       || 0;
    const firstDate  = safeDate(p["初回登録日"]);
    const lastDate   = safeDate(p["最終来店日"]);
    const status     = safeSelect(p["対応ステータス"]) || "未設定";
    const isMember   = safeCheck(p["かかりつけ会員"]);
    const carrier    = safeText(p["利用キャリア"])  || safeSelect(p["Q1_携帯会社"]) || "未記録";
    var monthly  = safeSelect(p["Q2_毎月の支払額"]) || "";
    var buyTime  = safeSelect(p["Q6_買い替え時期"]) || null;
    var netEnv   = safeSelect(p["Q5_ネット環境"])   || "";

    if (!monthly || !buyTime || !netEnv) {
      try {
        var diagRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + DIAGNOSIS_DB_ID + "/query", {
          method: "post", headers: notionHeaders(),
          payload: JSON.stringify({
            filter: { property: "LINE_userid", rich_text: { equals: userId } },
            sorts: [{ property: "受信日時", direction: "descending" }],
            page_size: 1
          }),
          muteHttpExceptions: true
        });
        if (diagRes.getResponseCode() === 200) {
          var diagResults = JSON.parse(diagRes.getContentText()).results;
          if (diagResults && diagResults.length > 0) {
            var dp = diagResults[0].properties;
            if (!monthly) monthly = safeSelect(dp["Q2_毎月の支払額"]) || "未記録";
            if (!buyTime) buyTime = safeSelect(dp["Q6_買い替え時期"]) || null;
            if (!netEnv)  netEnv  = safeSelect(dp["Q5_ネット環境"])   || "未記録";
          }
        }
      } catch(diagErr) { console.error("診断回答DB取得エラー: " + diagErr); }
    }
    if (!monthly) monthly = "未記録";
    if (!netEnv)  netEnv  = "未記録";

    const curCost    = safeNum(p["現在の月額"]);
    const propCost   = safeNum(p["提案後月額"]);
    const saveCost   = safeNum(p["月額節約額"]);
    const propCarrier = safeText(p["提案キャリア"])     || "";
    const propPlan    = safeText(p["提案プラン名"])     || "";
    const discounts   = safeText(p["適用割引"])         || "";
    const nextFollow  = safeText(p["次回フォロー予定"]) || "";
    const device      = safeText(p["利用端末"])         || "未記録";
    const battery     = safeText(p["バッテリー状態"])   || "未記録";
    const storage     = safeText(p["ストレージ空き"])   || "未記録";
    const karteDate   = safeDate(p["スマホカルテ更新日"]);
    const appUsed     = safeText(p["利用中アプリ"])     || "未記録";
    const appTrans    = safeText(p["移行必須アプリ"])   || "未記録";

    const blocksRes = UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + page.id + "/children?page_size=10",
      { headers: notionHeaders(), muteHttpExceptions: true });
    let historyLines = [];
    if (blocksRes.getResponseCode() === 200) {
      const blocks = JSON.parse(blocksRes.getContentText()).results || [];
      blocks.slice(-4).reverse().forEach(function(b) {
        try {
          const t = (b && b.paragraph && b.paragraph.rich_text && b.paragraph.rich_text[0]) ? b.paragraph.rich_text[0].plain_text : "";
          if (t) historyLines.push(t);
        } catch(e) {}
      });
    }

    const milestones    = [10, 20, 30, 50];
    const nextMilestone = milestones.find(m => m > points) || null;
    const ptToNext      = nextMilestone ? (nextMilestone - points) : 0;
    const couponMap     = { 10:"次回10%割引", 20:"まちの発見者バッジ", 30:"次回30%割引", 50:"サポーター認定証" };
    const buyMap = {
      "２年以内":   "比較的新しい（あと2〜3年）",
      "２〜４年以内": "そろそろ検討時期",
      "４年以上":   "⚠️ 買い替え時期です！",
      "わからない": "診断でチェックしましょう"
    };
    const reserveUrl = "https://white-shadow1210.github.io/sumaho-shindan/reserve.html";

    // ★ v7.0: プレ会員状態判定
    const isPreMember = safeCheck(p["プレ会員"]);
    const isPreUsed   = safeCheck(p["プレ会員特典使用済み"]);

    // 会員ステータスを3パターンで表示
    let memberStatusValue;
    let memberStatusBold;
    if (isPreMember && !isPreUsed) {
      memberStatusValue = "🌟 プレ会員（無料相談1回あり）";
      memberStatusBold  = true;
    } else if (isPreMember && isPreUsed) {
      memberStatusValue = "✨ プレ会員（特典使用済）";
      memberStatusBold  = false;
    } else if (isMember) {
      memberStatusValue = "⭐ かかりつけ会員";
      memberStatusBold  = true;
    } else {
      memberStatusValue = status;
      memberStatusBold  = false;
    }

    const card1 = makeMyPageBubble(
      "#1a2a40", "👤", "基本情報",
      [
        { label: "お名前",       value: name },
        { label: "会員ステータス", value: memberStatusValue, bold: memberStatusBold },
        { label: "初回登録日",   value: firstDate ? firstDate.replace(/-/g,"/") : "未設定" },
        { label: "最終来店日",   value: lastDate  ? lastDate.replace(/-/g,"/")  : "未設定" },
        { type: "separator" },
        { label: "ポイント",     value: points + "pt", bold: true },
        { label: "次の特典",     value: nextMilestone ? "あと" + ptToNext + "ptで " + couponMap[nextMilestone] : "🎉 最高ランク達成！" }
      ],
      { type: "uri", label: "予約する", uri: reserveUrl }
    );

    const card2 = makeMyPageBubble(
      "#249496", "📱", "スマホ診断結果",
      [
        { label: "キャリア",     value: carrier },
        { label: "月額支払い",   value: monthly },
        { label: "自宅ネット",   value: netEnv },
        { type: "separator" },
        { label: "利用端末",     value: device },
        { label: "買い替え目安", value: buyTime ? buyMap[buyTime] || buyTime : "未診断" },
        { label: "カルテ更新日", value: karteDate ? karteDate.replace(/-/g,"/") : "未実施" }
      ],
      { type: "message", label: "診断を更新する", text: "マイページ" }
    );

    const hasSim = curCost !== undefined && curCost !== null;
    const simRows = hasSim ? [
      { label: "現在の月額",   value: "¥" + Number(curCost).toLocaleString(), bold: true },
      { label: "提案後月額",   value: "¥" + Number(propCost||0).toLocaleString(), bold: true },
      { type: "separator" },
      { label: "月額節約額",   value: "¥" + Number(saveCost||0).toLocaleString() + "/月", bold: true },
      { label: "年間節約額",   value: "¥" + (Number(saveCost||0) * 12).toLocaleString() + "/年" },
      { label: "2年間節約額",  value: "¥" + (Number(saveCost||0) * 24).toLocaleString() + "/2年" },
      { type: "separator" },
      { label: "提案キャリア", value: propCarrier || "未記入" },
      { label: "提案プラン",   value: propPlan    || "未記入" },
      { label: "適用割引",     value: discounts.length > 30 ? discounts.substring(0,30)+"…" : (discounts || "なし") }
    ] : [
      { label: "状態", value: "料金シミュレーションが未実施です" },
      { label: "",     value: "対面でシミュレーターを使って計算します" }
    ];
    const card3 = makeMyPageBubble(
      "#e67e22", "💰", "料金シミュレーション",
      simRows,
      { type: "uri", label: hasSim ? "プラン相談を予約する" : "シミュレーションを依頼する", uri: reserveUrl }
    );

    const card4 = makeMyPageBubble(
      "#27ae60", "🩺", "スマホカルテ",
      [
        { label: "利用端末",     value: device },
        { label: "バッテリー",   value: battery },
        { label: "ストレージ",   value: storage },
        { type: "separator" },
        { label: "買い替え目安", value: buyTime ? buyMap[buyTime] || buyTime : "未診断" },
        { label: "カルテ更新日", value: karteDate ? karteDate.replace(/-/g,"/") : "未実施（対面時に記録）" }
      ],
      { type: "uri", label: "定期点検を予約する", uri: reserveUrl + "?menu=" + encodeURIComponent("【会員限定】定期点検サポート") }
    );

    const hasApp = appUsed !== "未記録" || appTrans !== "未記録";
    const card5 = makeMyPageBubble(
      "#8e44ad", "📦", "アプリチェック結果",
      hasApp ? [
        { label: "移行必須アプリ", value: appTrans, bold: true },
        { type: "separator" },
        { label: "利用中アプリ",   value: appUsed.length > 60 ? appUsed.substring(0,60) + "…" : appUsed },
        { label: "カルテ更新日",   value: karteDate ? karteDate.replace(/-/g,"/") : "未実施" }
      ] : [
        { label: "状態", value: "アプリチェックが未実施です" },
        { label: "",     value: "機種変更前にアプリの引き継ぎ確認をしましょう！" }
      ],
      { type: "uri", label: "データ移行を相談する", uri: reserveUrl + "?menu=" + encodeURIComponent("完全データ移行パック") }
    );

    const historyRows = historyLines.length > 0
      ? historyLines.map(function(h) { return { label: "", value: h.length > 40 ? h.substring(0,40) + "…" : h }; })
      : [{ label: "履歴", value: "まだ記録がありません" }];
    const card6 = makeMyPageBubble(
      "#249496", "🏆", "まちつながり履歴",
      [
        { label: "ポイント合計", value: points + "pt", bold: true },
        { label: "次の特典",    value: nextMilestone ? "あと" + ptToNext + "ptで " + couponMap[nextMilestone] : "🎉 最高ランク達成！" },
        { type: "separator" },
        ...historyRows,
        { type: "separator" },
        { label: "獲得チャンス", value: "診断+3pt / 予約+5pt / 発見投稿+3pt" },
        { label: "次回フォロー", value: nextFollow || "未設定" }
      ],
      null
    );

    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
      method: "post",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LINE_TOKEN },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [
          { type: "text", text: name + " さんのマイページです😊\n左右にスクロールして確認できます👇" },
          {
            type: "flex",
            altText: name + " さんのマイページ",
            contents: { type: "carousel", contents: [card1, card2, card3, card4, card5, card6] }
          }
        ]
      }),
      muteHttpExceptions: true
    });
  } catch(e) {
    console.error("replyMyPage エラー: " + e);
    replyToLine(replyToken, "マイページの取得中にエラーが発生しました。しばらく経ってから再度お試しください。");
  }
}

// ==========================================
// カルテ診断完了 → LINE IDを顧客マスターに紐付ける
// ==========================================
function linkLineIdToCustomer(userId, replyToken, LINE_TOKEN, jstNow) {
  try {
    const todayStr = jstNow.toISOString().substring(0, 10);

    const searchByLine = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
      { method: "post", headers: notionHeaders(),
        payload: JSON.stringify({ filter: { property: "LINE_userid", rich_text: { equals: userId } } }),
        muteHttpExceptions: true });
    if (searchByLine.getResponseCode() === 200) {
      const lineResults = JSON.parse(searchByLine.getContentText()).results;
      if (lineResults && lineResults.length > 0) {
        addMachiPoint(userId, 3, "スマホ診断完了");
        replyMyPage(userId, replyToken);
        return;
      }
    }

    let displayName = '';
    try {
      const pr = UrlFetchApp.fetch("https://api.line.me/v2/bot/profile/" + userId,
        { headers: { "Authorization": "Bearer " + LINE_TOKEN }, muteHttpExceptions: true });
      if (pr.getResponseCode() === 200) displayName = JSON.parse(pr.getContentText()).displayName || '';
    } catch(e) { console.error("Profile取得エラー: " + e); }

    let linked = false;
    let linkedPageId = null;

    const cachedTel = CacheService.getScriptCache().get('diag_latest_tel');
    console.log("Cache検索: diag_latest_tel → " + cachedTel);

    if (cachedTel && cachedTel.length > 0) {
      try {
        const searchByTel = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
          { method: "post", headers: notionHeaders(),
            payload: JSON.stringify({
              filter: {
                and: [
                  { property: "電話番号",   rich_text: { contains: cachedTel } },
                  { property: "LINE_userid", rich_text: { is_empty: true } }
                ]
              },
              sorts: [{ property: "初回登録日", direction: "descending" }],
              page_size: 1
            }),
            muteHttpExceptions: true });
        if (searchByTel.getResponseCode() === 200) {
          const telResults = JSON.parse(searchByTel.getContentText()).results;
          if (telResults && telResults.length > 0) {
            linkedPageId = telResults[0].id;
            UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + linkedPageId, {
              method: "patch", headers: notionHeaders(),
              payload: JSON.stringify({ properties: {
                "LINE_userid":      { rich_text: [{ text: { content: userId } }] },
                "LINE_displayName": { rich_text: [{ text: { content: displayName } }] },
                "最終来店日":       { date: { start: todayStr } }
              }}), muteHttpExceptions: true
            });
            UrlFetchApp.fetch("https://api.notion.com/v1/blocks/" + linkedPageId + "/children", {
              method: "patch", headers: notionHeaders(),
              payload: JSON.stringify({ children: [{ object: "block", type: "paragraph",
                paragraph: { rich_text: [{ type: "text", text: { content:
                  "▶ " + todayStr + "  【LINE ID紐付け完了】電話番号で照合 → " + displayName
                }}]}}]}), muteHttpExceptions: true
            });
            linked = true;
            console.log("電話番号で紐付け成功: " + cachedTel + " → " + userId);

            try {
              const searchDupLine = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
                { method: "post", headers: notionHeaders(),
                  payload: JSON.stringify({
                    filter: {
                      and: [
                        { property: "LINE_userid",  rich_text: { equals: userId } },
                        { property: "電話番号",     rich_text: { is_empty: true } }
                      ]
                    }
                  }),
                  muteHttpExceptions: true });
              if (searchDupLine.getResponseCode() === 200) {
                const dupResults = JSON.parse(searchDupLine.getContentText()).results;
                dupResults.forEach(function(dupPage) {
                  UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + dupPage.id, {
                    method: "patch", headers: notionHeaders(),
                    payload: JSON.stringify({ archived: true }),
                    muteHttpExceptions: true
                  });
                  console.log("重複行を削除: " + dupPage.id);
                });
              }
            } catch(dupErr) { console.error("重複行削除エラー: " + dupErr); }

            CacheService.getScriptCache().remove('diag_latest_tel');
          }
        }
      } catch(e) { console.error("電話番号検索エラー: " + e); }
    }

    if (!linked) {
      try {
        const searchLineDup = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
          { method: "post", headers: notionHeaders(),
            payload: JSON.stringify({
              filter: { property: "LINE_userid", rich_text: { equals: userId } }
            }),
            muteHttpExceptions: true });
        if (searchLineDup.getResponseCode() === 200) {
          const dupRes = JSON.parse(searchLineDup.getContentText()).results;
          if (dupRes && dupRes.length > 0) {
            linkedPageId = dupRes[0].id;
            UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + linkedPageId, {
              method: "patch", headers: notionHeaders(),
              payload: JSON.stringify({ properties: {
                "最終来店日": { date: { start: todayStr } }
              }}), muteHttpExceptions: true
            });
            linked = true;
          }
        }
      } catch(e) { console.error("仮登録行更新エラー: " + e); }
    }

    if (!linked) {
      try {
        UrlFetchApp.fetch("https://api.notion.com/v1/pages", {
          method: "post", headers: notionHeaders(),
          payload: JSON.stringify({ parent: { database_id: CUSTOMER_MASTER_ID }, properties: {
            "氏名":             { title:     [{ text: { content: displayName || "（LINE診断）" } }] },
            "LINE_userid":      { rich_text: [{ text: { content: userId } }] },
            "LINE_displayName": { rich_text: [{ text: { content: displayName } }] },
            "初回登録日":       { date: { start: todayStr } },
            "最終来店日":       { date: { start: todayStr } },
            "対応ステータス":   { select: { name: "新規" } }
          }}), muteHttpExceptions: true
        });
      } catch(e) { console.error("新規仮登録エラー: " + e); }
    }

    addMachiPoint(userId, 3, "スマホ診断完了");
    replyMyPage(userId, replyToken);

  } catch(e) {
    console.error("linkLineIdToCustomer エラー: " + e);
    replyToLine(replyToken, "診断結果を受け取りました！\n\nLINEカルテを作成中です。しばらくお待ちください😊");
  }
}

// ==========================================
// まちつながりポイント付与
// ==========================================
function addMachiPoint(userId, pointsToAdd, reason) {
  if (!userId || !pointsToAdd) return;
  const LINE_TOKEN = props.getProperty("LINE_ACCESS_TOKEN");
  try {
    const searchRes = UrlFetchApp.fetch("https://api.notion.com/v1/databases/" + CUSTOMER_MASTER_ID + "/query",
      { method: "post", headers: notionHeaders(),
        payload: JSON.stringify({ filter: { property: "LINE_userid", rich_text: { equals: userId } } }),
        muteHttpExceptions: true });
    if (searchRes.getResponseCode() !== 200) return;
    const results = JSON.parse(searchRes.getContentText()).results;
    if (!results || results.length === 0) return;
    const page          = results[0];
    const currentPoints = (page.properties["ポイント"] && page.properties["ポイント"].number) ? page.properties["ポイント"].number : 0;
    const newPoints     = currentPoints + pointsToAdd;
    const today         = new Date(new Date().getTime() + 9*60*60*1000).toISOString().substring(0, 10);
    UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + page.id, {
      method: "patch", headers: notionHeaders(),
      payload: JSON.stringify({ properties: { "ポイント": { number: newPoints }, "最終ポイント付与日": { date: { start: today } } } }),
      muteHttpExceptions: true
    });
    console.log("ポイント付与: " + reason + " +" + pointsToAdd + "pt（累計:" + newPoints + "pt）");
    const milestones = [
      { pt: 10, msg: "🎉 まちつながりポイントが10ptに達しました！\n\n✨ 特典：次回ご相談時に10%割引クーポンをプレゼント！\n\nご予約の際に「10ptクーポン」とお伝えください😊" },
      { pt: 20, msg: "🌟 まちつながりポイントが20ptに達しました！\n\n🏅 「まちの発見者」バッジを贈ります！" },
      { pt: 30, msg: "🎊 まちつながりポイントが30ptに達しました！\n\n✨ 特典：次回ご相談時に30%割引クーポンをプレゼント！" },
      { pt: 50, msg: "🏆 まちつながりポイントが50ptに達しました！\n\n🎖️「吉田町サポーター認定証」を贈ります！" }
    ];
    for (const m of milestones) {
      if (currentPoints < m.pt && newPoints >= m.pt) {
        // Task 2: 共通 pushToLine_ に統合（旧: 直接 UrlFetchApp.fetch していた箇所）
        pushToLine_(userId, { type: "text", text: m.msg });
        break;
      }
    }
  } catch(e) { console.error("addMachiPoint エラー: " + e); }
}

function customerMasterTest() {
  const testPageId = upsertCustomerMaster({
    name:"テスト 太郎", tel:"090-0000-0001", email:"test@test.com",
    lineUserId:"U_test_12345", lineDisplayName:"テスト太郎LINE",
    historyText:"【テスト】GAS v6.9 動作確認 " + new Date().toISOString().substring(0,16)
  });
  console.log("customerMasterTest 完了: pageId=" + testPageId);
}

// ==========================================
// karte v2 動作テスト
// ==========================================
function testKarteV2() {
  console.log('===== karte v2 動作テスト =====');
  
  const testData = {
    token: 'smaho2026sakurai',
    formType: 'karte',
    name: 'テスト v2 太郎',
    tel: '090-0000-9999',
    email: 'testv2@test.com',
    lineName: 'テスト太郎LINE',
    carrier: 'docomo',
    device: 'iPhone 15',
    battery: '85',
    storage: '50GB / 256GB',
    buyTime: '２年以内',
    currentCost: 8800,
    proposedCost: 4500,
    savingCost: 4300,
    propCarrier: 'ahamo',
    propPlanName: 'ahamo（30GB）',
    discounts: 'dカード割引',
    nextFollow: '3ヶ月後に操作確認',
    target: '本人',
    wifi: 'ドコモ光',
    simConfig: '1枚',
    contractType: 'プラン変更',
    purpose: '相談、プラン見直し',
    appUsed: 'LINE、PayPay',
    appTransfer: 'LINE',
    memo: 'テスト用データです',
    historyText: 'v2動作テスト：iPhone15確認、ahamo変更案内、月4300円節約'
  };
  
  const result = handleWebForm(testData);
  console.log('テスト結果: ' + result.getContent());
  console.log('Notionの顧客マスターと困りごとDBを確認してください');
}

// ==========================================
// リッチメニュー セットアップ
// ==========================================
// リッチメニュー画像（2500×1686・1枚6ボタン版）の Drive ファイルID
const MENU_FILE_ID = "14L3wTKx0zUdLlyfaFG6cSiaXs0SYv8M-";
const SITE = "https://white-shadow1210.github.io/sumaho-shindan";

// 1枚6ボタン版のセットアップ。
//   - 全ユーザーのデフォルト紐付け解除
//   - 旧 alias（a/b）の掃除
//   - 既存リッチメニュー全削除（重複防止）
//   - 新メニュー作成 + 画像アップロード + デフォルト設定
//   - RICHMENU_ID を保存。旧 RICHMENU_A_ID / RICHMENU_B_ID は削除
function setupRichMenus() {
  const LINE_TOKEN = props.getProperty("LINE_ACCESS_TOKEN");
  if (!LINE_TOKEN) { console.error("❌ LINE_ACCESS_TOKEN が未設定です"); return; }

  // 1) 既存のデフォルト紐付け解除
  try {
    UrlFetchApp.fetch("https://api.line.me/v2/bot/user/all/richmenu",
      { method: "delete", headers: { "Authorization": "Bearer " + LINE_TOKEN }, muteHttpExceptions: true });
  } catch(e) {}

  // 2) 旧 alias 掃除（タブ切替用 a/b を削除）
  try { resetRichMenuAliases(); } catch(e) { console.error("alias cleanup error: " + e); }

  // 3) 既存リッチメニュー全削除（重複防止）
  deleteAllRichMenus_(LINE_TOKEN);

  // 4) 新メニュー作成 + 画像アップロード
  const menuId = createRichMenu(LINE_TOKEN, buildMenuConfig());
  if (!menuId) { console.error("❌ メニュー作成失敗"); return; }
  if (!uploadImageFromDrive(LINE_TOKEN, menuId, MENU_FILE_ID)) {
    console.error("❌ メニュー画像アップロード失敗"); return;
  }

  // 5) 全ユーザーのデフォルトに設定
  UrlFetchApp.fetch("https://api.line.me/v2/bot/user/all/richmenu/" + menuId,
    { method: "post", headers: { "Authorization": "Bearer " + LINE_TOKEN }, muteHttpExceptions: true });

  // 6) Properties 保存（旧 A/B キーはクリーンアップ）
  props.setProperty("RICHMENU_ID", menuId);
  try { props.deleteProperty("RICHMENU_A_ID"); } catch(e) {}
  try { props.deleteProperty("RICHMENU_B_ID"); } catch(e) {}

  console.log("=== セットアップ完了 === RICHMENU_ID:" + menuId);
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      "【リッチメニュー】1枚6ボタン版 セットアップ完了",
      "RichMenuId: " + menuId);
  } catch(e) {}
}

function createRichMenu(token, config) {
  try {
    const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu", { method: "post", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, payload: JSON.stringify(config), muteHttpExceptions: true });
    return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()).richMenuId : null;
  } catch(e) { return null; }
}

function uploadImageFromDrive(token, richMenuId, fileId) {
  try {
    const res = UrlFetchApp.fetch("https://api-data.line.me/v2/bot/richmenu/" + richMenuId + "/content",
      { method: "post", headers: { "Authorization": "Bearer " + token, "Content-Type": "image/png" }, payload: DriveApp.getFileById(fileId).getBlob().getBytes(), muteHttpExceptions: true });
    return res.getResponseCode() === 200;
  } catch(e) { return false; }
}

// 1枚6ボタン版の config。
//   画像: 2500×1686
//   見出し帯: y=0〜210（areas に含めない＝タップ不感）
//   上段: y=210, height=687  ／ 下段: y=897, height=789
//   列幅: 835 / 831 / 834  ／  合計縦 210+687+789=1686 ✓  横 835+831+834=2500 ✓
function buildMenuConfig() {
  return {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: "スマホサポート_6ボタン",
    chatBarText: "スマホサポート",
    areas: [
      // 上段：まずは無料診断 / 料金・メニュー / WEBで予約する
      { bounds: { x: 0,    y: 210, width: 835, height: 687 }, action: { type: "uri", uri: SITE + "/index.html"   } },
      { bounds: { x: 835,  y: 210, width: 831, height: 687 }, action: { type: "uri", uri: SITE + "/prices.html"  } },
      { bounds: { x: 1666, y: 210, width: 834, height: 687 }, action: { type: "uri", uri: SITE + "/reserve.html" } },
      // 下段：初めての方へ / マイページ / 直接相談
      { bounds: { x: 0,    y: 897, width: 835, height: 789 }, action: { type: "uri",      uri:  SITE + "/about.html" } },
      { bounds: { x: 835,  y: 897, width: 831, height: 789 }, action: { type: "postback", data: "mypage_start", displayText: "マイページ" } },
      { bounds: { x: 1666, y: 897, width: 834, height: 789 }, action: { type: "message",  text: "直接相談" } }
    ]
  };
}

// 既存リッチメニューを全削除（重複防止）。setupRichMenus 内から呼ばれる。
function deleteAllRichMenus_(token) {
  try {
    const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu/list",
      { headers: { "Authorization": "Bearer " + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return;
    const menus = JSON.parse(res.getContentText()).richmenus || [];
    menus.forEach(function(m) {
      try {
        UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu/" + m.richMenuId,
          { method: "delete", headers: { "Authorization": "Bearer " + token }, muteHttpExceptions: true });
        console.log("既存メニュー削除: " + m.richMenuId + " (" + (m.name || '') + ")");
      } catch(e) { console.error("delete error: " + e); }
    });
  } catch (e) { console.error("deleteAllRichMenus_ error: " + e); }
}

function resetRichMenuAliases() {
  const LINE_TOKEN = props.getProperty("LINE_ACCESS_TOKEN");
  ["richmenu-alias-a", "richmenu-alias-b"].forEach(aliasId => {
    try { UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu/alias/" + aliasId, { method: "delete", headers: { "Authorization": "Bearer " + LINE_TOKEN }, muteHttpExceptions: true }); }
    catch(e) {}
  });
}

function listRichMenus() {
  const LINE_TOKEN = props.getProperty("LINE_ACCESS_TOKEN");
  console.log(UrlFetchApp.fetch("https://api.line.me/v2/bot/richmenu/list", { headers: { "Authorization": "Bearer " + LINE_TOKEN }, muteHttpExceptions: true }).getContentText());
}

// ==========================================
// 街のお知らせ機能
// ==========================================
function getOshiraseData() {
  const cache  = CacheService.getScriptCache();
  const cached = cache.get('oshirase_data');
  if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);

  const allItems = [];
  const now = new Date();

  try {
    if (!MAP_SHEET_ID) throw new Error("MAP_SHEET_ID 未設定");
    const ss    = SpreadsheetApp.openById(MAP_SHEET_ID);
    const sheet = ss.getSheetByName('街のお知らせ');
    if (sheet) {
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row[0]) continue;
        const pubDate = new Date(row[0]);
        if (isNaN(pubDate.getTime())) continue;

        const endDateRaw = row[7] || null;
        let endDate = null;
        if (endDateRaw) {
          endDate = new Date(endDateRaw);
          if (isNaN(endDate.getTime())) endDate = null;
        }

        const category = String(row[1]||'other');

        if (category === 'event' && endDate && endDate < now) continue;

        if (category === 'news') {
          const diffDays = (now - pubDate) / (1000 * 60 * 60 * 24);
          if (diffDays > 30) continue;
        }

        allItems.push({
          title:        String(row[2]||''),
          link:         String(row[4]||''),
          description:  String(row[3]||'').substring(0,120),
          pubDate:      pubDate.toISOString(),
          sourceName:   String(row[5]||'手動入力'),
          sourceIcon:   String(row[6]||''),
          category:     category,
          isManual:     true,
          endDate:      endDate ? endDate.toISOString() : null,
          interestCount: parseInt(row[8]||0),
          helpfulCount:  parseInt(row[9]||0)
        });
      }
    }
  } catch(e) { console.error('スプレッドシートお知らせ取得エラー: ' + e); }

  if (allItems.length === 0) {
    const sample = JSON.stringify({ status: 'success', items: getSampleOshiraseItems() });
    cache.put('oshirase_data', sample, 1800);
    return ContentService.createTextOutput(sample).setMimeType(ContentService.MimeType.JSON);
  }

  allItems.sort(function(a, b) {
    function getScore(item) {
      const pub   = new Date(item.pubDate || 0);
      const diffH = (now - pub) / (1000 * 60 * 60);
      if (diffH <= 24) return { priority: 3, sub: pub.getTime() };
      if (item.category === 'event' && item.endDate) {
        const daysLeft = (new Date(item.endDate) - now) / (1000 * 60 * 60 * 24);
        return { priority: 2, sub: -daysLeft };
      }
      return { priority: 1, sub: pub.getTime() };
    }
    const sa = getScore(a), sb = getScore(b);
    if (sa.priority !== sb.priority) return sb.priority - sa.priority;
    return sb.sub - sa.sub;
  });

  const result = JSON.stringify({ status: 'success', items: allItems.slice(0,50) });
  cache.put('oshirase_data', result, 1800);
  return ContentService.createTextOutput(result).setMimeType(ContentService.MimeType.JSON);
}

function getSampleOshiraseItems() {
  return [
    { title:'【お知らせ】スプレッドシートに記事を追加してください', link:'',
      description:'「街のお知らせ」シートの2行目以降に記事を入力すると、ここに表示されます。',
      pubDate: new Date().toISOString(), sourceName:'システム', sourceIcon:'', category:'news' }
  ];
}

function clearOshiraseCache() {
  CacheService.getScriptCache().remove('oshirase_data');
  console.log('お知らせキャッシュをクリアしました');
}

function clearChiikiCache() {
  CacheService.getScriptCache().remove('chiiki_data');
  console.log('地域発見キャッシュをクリアしました');
}

function autoUpdateOshirase() {
  try {
    console.log('お知らせ自動更新 開始');
    CacheService.getScriptCache().remove('oshirase_data');

    const allItems = [];
    const now = new Date();

    try {
      if (MAP_SHEET_ID) {
        const ss    = SpreadsheetApp.openById(MAP_SHEET_ID);
        const sheet = ss.getSheetByName('街のお知らせ');
        if (sheet) {
          const rows = sheet.getDataRange().getValues();
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row[0]) continue;
            const pubDate = new Date(row[0]);
            if (isNaN(pubDate.getTime())) continue;

            const endDateRaw = row[7] || null;
            let endDate = null;
            if (endDateRaw) {
              endDate = new Date(endDateRaw);
              if (isNaN(endDate.getTime())) endDate = null;
            }
            const category = String(row[1]||'other');
            if (category === 'event' && endDate && endDate < now) continue;
            if (category === 'news') {
              const diffDays = (now - pubDate) / (1000 * 60 * 60 * 24);
              if (diffDays > 30) continue;
            }

            allItems.push({
              title:       String(row[2]||''),
              link:        String(row[4]||''),
              description: String(row[3]||'').substring(0,120),
              pubDate:     pubDate.toISOString(),
              sourceName:  String(row[5]||'手動入力'),
              sourceIcon:  String(row[6]||''),
              category:    category,
              isManual:    true,
              endDate:     endDate ? endDate.toISOString() : null
            });
          }
          console.log('手入力データ: ' + allItems.length + '件');
        }
      }
    } catch(e) { console.error('手入力データ取得エラー: ' + e); }

    if (allItems.length === 0) {
      console.log('取得データなし');
      return;
    }

    allItems.sort(function(a, b) { return new Date(b.pubDate||0) - new Date(a.pubDate||0); });
    const result = JSON.stringify({ status: 'success', items: allItems.slice(0, 50) });
    CacheService.getScriptCache().put('oshirase_data', result, 1800);
    console.log('お知らせキャッシュ更新完了: 合計' + allItems.length + '件');

  } catch(e) {
    console.error('autoUpdateOshirase エラー: ' + e);
  }
}

function setOshiraseTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'autoUpdateOshirase') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('autoUpdateOshirase')
    .timeBased()
    .everyHours(6)
    .create();
  console.log('✅ お知らせ自動更新トリガーを設定しました（6時間ごと）');
}

// ==========================================
// 街のお知らせ リアクション機能
// ==========================================
function handleOshiraseReaction(data) {
  try {
    // Task 2: スキーマ検証
    const vr = validatePayload_('oshirase_reaction', data);
    if (!vr.ok) {
      if (vr.severity === 'reject') {
        pushAnomalyAlert_('validation_failed', {
          formType: 'oshirase_reaction',
          identifier: (data.userId || 'unknown').substring(0, 60),
          fieldErrors: vr.errors
        });
        return ContentService.createTextOutput(JSON.stringify({
          status: "error", message: "Invalid input"
        })).setMimeType(ContentService.MimeType.JSON);
      }
      pushAnomalyAlert_('validation_failed', {
        formType: 'oshirase_reaction',
        identifier: (data.userId || 'unknown').substring(0, 60),
        fieldErrors: vr.errors
      });
    }

    if (!MAP_SHEET_ID) throw new Error("MAP_SHEET_ID 未設定");

    if (data.userId && checkDailyLimit(data.userId, 'oshirase_react', 100)) {
      pushAnomalyAlert_('rate_exceeded', {
        formType: 'oshirase_reaction',
        identifier: data.userId
      });
      return ContentService.createTextOutput(JSON.stringify({
        status: "error",
        message: "本日のリアクション上限に達しました"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const ss    = SpreadsheetApp.openById(MAP_SHEET_ID);
    const sheet = ss.getSheetByName('街のお知らせ');
    if (!sheet) throw new Error("街のお知らせシートなし");

    const rows = sheet.getDataRange().getValues();
    
    if (rows[0].length < 10 || !rows[0][8] || !rows[0][9]) {
      sheet.getRange(1, 9).setValue('興味あり数');
      sheet.getRange(1, 10).setValue('参考になった数');
    }

    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      const rowDate  = rows[i][0] ? new Date(rows[i][0]).toISOString() : '';
      const rowTitle = String(rows[i][2] || '');
      const reqDate  = data.pubDate ? new Date(data.pubDate).toISOString() : '';
      
      if (rowDate === reqDate && rowTitle === String(data.title || '')) {
        targetRow = i + 1;
        break;
      }
    }
    if (targetRow < 0) {
      return ContentService.createTextOutput(JSON.stringify({ 
        status: "error", message: "対象のお知らせが見つかりません" 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const colIndex = data.reactionType === 'helpful' ? 10 : 9;
    const currentCount = parseInt(sheet.getRange(targetRow, colIndex).getValue() || 0);
    const delta = data.action === 'add' ? 1 : -1;
    const newCount = Math.max(0, currentCount + delta);
    sheet.getRange(targetRow, colIndex).setValue(newCount);

    CacheService.getScriptCache().remove('oshirase_data');

    return ContentService.createTextOutput(JSON.stringify({ 
      status: "success", 
      reactionType: data.reactionType, 
      newCount: newCount 
    })).setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    console.error("handleOshiraseReaction エラー: " + e);
    return ContentService.createTextOutput(JSON.stringify({ 
      status: "error", message: e.toString() 
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    console.log(t.getHandlerFunction() + ' / ' + t.getTriggerSource() + ' / ' + t.getEventType());
  });
  console.log('合計: ' + triggers.length + '件');
}
