/**
 * notion-db-setup.gs
 *
 * Notion 6DB generator for スマホ相談士 (Task 1 deliverable).
 * One-shot execution. Run AFTER launch, NOT during this task.
 *
 * ---
 * Setup:
 *   1. In Notion, create a parent page and share it with your Internal Integration.
 *   2. In the Apps Script editor → Project Settings → Script Properties, set:
 *      - NOTION_TOKEN          : "secret_..." (integration token)
 *      - NOTION_PARENT_PAGE_ID : the parent page id (32 hex chars, no dashes)
 *   3. Run setupNotionDatabases() once.
 *   4. Resulting database ids will be saved into Script Properties:
 *      DB_CUSTOMER_ID / DB_KARTE_ID / DB_PLAN_ID /
 *      DB_TIMELINE_ID / DB_APP_ID / DB_AI_LOG_ID
 *
 * ---
 * Creation order (strict, per Task 1 spec):
 *   Phase 1: Create all 6 DBs with non-relation / non-rollup / non-formula props
 *   Phase 2: Add relations (dual_property; relies on target DBs existing)
 *   Phase 3: Add formulas (depend on source props existing)
 *   Phase 4: Add rollups (depend on relations + cross-DB formula targets)
 *   Phase 5: Rename auto-generated reverse relation properties to spec names
 *
 * ---
 * IMPORTANT — Plan rollup limitation:
 *   The spec calls for curTotal / propTotal to be Rollups filtered by
 *   plan_type=current / proposed on the same `plans` relation. Notion API
 *   rollups have NO filter parameter, so a single relation can't yield
 *   separated totals via Rollup alone.
 *   This script implements curTotal / propTotal as plain Number fields,
 *   to be populated by handleKarteV2 (application code) when each Plan
 *   record is created. savingMonthly Formula still works.
 *
 * ---
 * Idempotency:
 *   If DB_CUSTOMER_ID is already set, the script aborts. To re-run from a
 *   clean state, manually clear the DB_*_ID script properties first.
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// ===== Standard option sets =====
const CARRIERS = [
  'docomo', 'au', 'SoftBank', 'Rakuten Mobile',
  'ahamo', 'povo', 'LINEMO', 'UQ mobile', 'Y!mobile', 'その他'
];

const PURPOSES = ['機種変更', '料金見直し', 'データ移行', 'トラブル', '相談', '乗換え'];

const TARGETS = ['本人', '親', '子', '家族', 'その他'];
const WIFI    = ['あり', 'なし', '不明'];
const SIM     = ['物理SIM', 'eSIM', 'デュアル', '不明'];

const BUY_TIMES      = ['〜半年', '半年〜1年', '1〜2年', '2〜3年', '3年以上'];
const CONTRACT_TYPES = ['新規', '機種変更', 'MNP', '番号そのまま乗換'];
const OS_ACCOUNT     = ['把握', '一部把握', '不明'];
const CARRIER_MAIL   = ['使用中', '持ち出し中', '不要', '不明'];
const BACKUP         = ['iCloud', 'Googleフォト', 'LINE', '連絡先', 'なし'];
const EMERGENCY      = ['確認済', '未確認', '不要'];
const SUB_LINE       = ['あり', 'なし', '検討中'];

const PLAN_TYPE = ['current', 'proposed'];
const DISCOUNTS = ['家族割', '光セット', '学割', '紹介', 'カードまとめ', '60歳以上割', 'その他'];

const APPS = [
  'LINE', 'PayPay', 'Google系', 'Facebook', 'Instagram',
  '銀行アプリ', '音楽アプリ', '動画アプリ', 'Amazon', '楽天系',
  'メルカリ', 'ゲームアプリ', '仕事アプリ', '医療・健康', 'その他'
];
const APP_STATUS = ['利用中', '移行必須', '移行完了', '不要'];

const AI_STATUS         = ['draft', 'edited', 'sent', 'rejected'];
const AI_MODEL          = ['haiku-4-5', 'sonnet-4-6'];
const AI_PROMPT_VERSION = ['v1', 'v2'];
const AI_RATING         = ['★1', '★2', '★3', '★4', '★5'];

function selOpts(arr) {
  return arr.map(function (name) { return { name: name }; });
}

// ===== Phase 1 property builders =====

function customerBaseProps() {
  return {
    name:        { title: {} },
    tel:         { phone_number: {} },
    email:       { email: {} },
    lineName:    { rich_text: {} },
    lineUserId:  { rich_text: {} },
    target:      { select: { options: selOpts(TARGETS) } },
    wifi:        { select: { options: selOpts(WIFI) } },
    simConfig:   { select: { options: selOpts(SIM) } },
    purpose:     { multi_select: { options: selOpts(PURPOSES) } },
    // source は流入経路。値は運用で増えるため、初期は空の Select で作成し、
    // handleKarteV2 側で未知の値が来たら schema を PATCH して option を追加する想定。
    source:      { select: { options: [] } },
    created_at:  { created_time: {} },
    updated_at:  { last_edited_time: {} }
  };
}

function karteBaseProps() {
  return {
    karte_id:     { title: {} },
    visit_date:   { date: {} },
    purpose:      { multi_select: { options: selOpts(PURPOSES) } },
    carrier:      { select: { options: selOpts(CARRIERS) } },
    device:       { rich_text: {} },
    battery:      { number: { format: 'number' } }, // 0-100 整数で運用
    storage:      { rich_text: {} },
    buyTime:      { select: { options: selOpts(BUY_TIMES) } },
    contractType: { select: { options: selOpts(CONTRACT_TYPES) } },
    osAccount:    { select: { options: selOpts(OS_ACCOUNT) } },
    carrierMail:  { select: { options: selOpts(CARRIER_MAIL) } },
    backup:       { multi_select: { options: selOpts(BACKUP) } },
    emergency:    { select: { options: selOpts(EMERGENCY) } },
    subLine:      { select: { options: selOpts(SUB_LINE) } },
    basicMemo:    { rich_text: {} },
    deviceMemo:   { rich_text: {} },
    todaySummary: { rich_text: {} },
    nextFollow:   { rich_text: {} },
    // ↓ Rollup不可のため Number で運用（ファイル冒頭コメント参照）
    curTotal:     { number: { format: 'yen' } },
    propTotal:    { number: { format: 'yen' } }
  };
}

function planBaseProps() {
  return {
    plan_id:            { title: {} },
    plan_type:          { select: { options: selOpts(PLAN_TYPE) } },
    carrier:            { select: { options: selOpts(CARRIERS) } },
    plan_name:          { rich_text: {} },
    base_fee:           { number: { format: 'yen' } },
    discounts:          { multi_select: { options: selOpts(DISCOUNTS) } },
    discount_total:     { number: { format: 'yen' } },
    call_option:        { rich_text: {} },
    call_option_fee:    { number: { format: 'yen' } },
    device_installment: { number: { format: 'yen' } },
    other_cost:         { number: { format: 'yen' } },
    sim_memo:           { rich_text: {} }
    // monthly_total Formula は Phase 3 で追加
  };
}

function timelineBaseProps() {
  return {
    timeline_id: { title: {} },
    year:        { number: { format: 'number' } },
    device_name: { rich_text: {} },
    memo:        { rich_text: {} }
  };
}

function appBaseProps() {
  return {
    app_id:   { title: {} },
    app_name: { select: { options: selOpts(APPS) } },
    status:   { select: { options: selOpts(APP_STATUS) } }
  };
}

function aiLogBaseProps() {
  return {
    draft_id:        { title: {} },
    input_payload:   { rich_text: {} },
    draft_text:      { rich_text: {} },
    edited_text:     { rich_text: {} },
    edited_diff:     { rich_text: {} },
    status:          { select: { options: selOpts(AI_STATUS) } },
    sent_at:         { date: {} },
    prompt_version:  { select: { options: selOpts(AI_PROMPT_VERSION) } },
    model:           { select: { options: selOpts(AI_MODEL) } },
    input_tokens:    { number: { format: 'number' } },
    output_tokens:   { number: { format: 'number' } },
    cost_jpy:        { number: { format: 'yen' } },
    operator_rating: { select: { options: selOpts(AI_RATING) } }
  };
}

// ===== Main =====

function setupNotionDatabases() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('NOTION_TOKEN');
  const parentPageId = props.getProperty('NOTION_PARENT_PAGE_ID');
  if (!token || !parentPageId) {
    throw new Error('Set NOTION_TOKEN and NOTION_PARENT_PAGE_ID in Script Properties first.');
  }
  if (props.getProperty('DB_CUSTOMER_ID')) {
    throw new Error('Already initialized. To re-run, clear DB_*_ID script properties first.');
  }

  console.log('=== Phase 1: Creating 6 databases (base properties only) ===');
  const customerId = createDb_(token, parentPageId, 'Customer Master', customerBaseProps());
  const karteId    = createDb_(token, parentPageId, 'Karte History',   karteBaseProps());
  const planId     = createDb_(token, parentPageId, 'Plan Breakdown',  planBaseProps());
  const timelineId = createDb_(token, parentPageId, 'Phone Timeline',  timelineBaseProps());
  const appId      = createDb_(token, parentPageId, 'App Migration',   appBaseProps());
  const aiLogId    = createDb_(token, parentPageId, 'AI Reply Log',    aiLogBaseProps());

  props.setProperty('DB_CUSTOMER_ID', customerId);
  props.setProperty('DB_KARTE_ID',    karteId);
  props.setProperty('DB_PLAN_ID',     planId);
  props.setProperty('DB_TIMELINE_ID', timelineId);
  props.setProperty('DB_APP_ID',      appId);
  props.setProperty('DB_AI_LOG_ID',   aiLogId);

  console.log('=== Phase 2: Adding relations ===');
  // [sourceDb, sourceProp, targetDb, intendedReverseName]
  const RELATIONS = [
    [karteId,    'customer', customerId, 'karte'],
    [planId,     'karte',    karteId,    'plans'],
    [timelineId, 'customer', customerId, 'timeline'],
    [appId,      'karte',    karteId,    'apps'],
    [aiLogId,    'customer', customerId, 'ai_log_customer'],
    [aiLogId,    'karte',    karteId,    'ai_log']
  ];
  RELATIONS.forEach(function (r) {
    addRelation_(token, r[0], r[1], r[2], r[3]);
  });

  console.log('=== Phase 3: Adding formulas ===');
  addFormula_(token, planId, 'monthly_total',
    'prop("base_fee") + prop("discount_total") + prop("call_option_fee") + prop("device_installment") + prop("other_cost")'
  );
  addFormula_(token, karteId, 'savingMonthly',
    'prop("curTotal") - prop("propTotal")'
  );

  console.log('=== Phase 4: Adding rollups (customer-side aggregates) ===');
  addRollup_(token, customerId, 'karte_count',  'karte', 'karte_id',      'count');
  addRollup_(token, customerId, 'latest_visit', 'karte', 'visit_date',    'latest_date');
  addRollup_(token, customerId, 'total_saving', 'karte', 'savingMonthly', 'sum');

  console.log('=== Phase 5: Verifying / renaming reverse relation names ===');
  RELATIONS.forEach(function (r) {
    // sourceDb から見て propName が source 側。target 側に自動生成された
    // reverse property の名前を intendedReverseName にそろえる。
    ensureReverseRelationName_(token, r[2], r[0], r[3]);
  });

  console.log('\n✅ All 6 DBs created and configured.');
  console.log('Database IDs saved in Script Properties:');
  ['DB_CUSTOMER_ID','DB_KARTE_ID','DB_PLAN_ID','DB_TIMELINE_ID','DB_APP_ID','DB_AI_LOG_ID']
    .forEach(function (k) { console.log('  ' + k + ' = ' + props.getProperty(k)); });
}

// ===== Notion API helpers =====

function createDb_(token, parentPageId, title, properties) {
  const res = fetchNotion_(token, 'POST', '/databases', {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: title } }],
    properties: properties
  });
  console.log('Created DB "' + title + '": ' + res.id);
  return res.id;
}

function addRelation_(token, dbId, propName, targetDbId, syncedReverseName) {
  // Notion の現行APIでは synced_property_name を作成時に指定できないケースがあるため、
  // ここでは dual_property: {} で作成し、Phase 5 で reverse 名を rename する。
  const properties = {};
  properties[propName] = {
    relation: {
      database_id: targetDbId,
      type: 'dual_property',
      dual_property: {}
    }
  };
  fetchNotion_(token, 'PATCH', '/databases/' + dbId, { properties: properties });
  console.log('Added relation ' + dbId + '.' + propName + ' → ' + targetDbId
    + ' (intended reverse: ' + syncedReverseName + ')');
}

function addRollup_(token, dbId, propName, relationPropName, rollupPropName, fn) {
  const properties = {};
  properties[propName] = {
    rollup: {
      relation_property_name: relationPropName,
      rollup_property_name: rollupPropName,
      function: fn
    }
  };
  fetchNotion_(token, 'PATCH', '/databases/' + dbId, { properties: properties });
  console.log('Added rollup ' + dbId + '.' + propName + ' = ' + fn + '(' + relationPropName + '.' + rollupPropName + ')');
}

function addFormula_(token, dbId, propName, expression) {
  const properties = {};
  properties[propName] = { formula: { expression: expression } };
  fetchNotion_(token, 'PATCH', '/databases/' + dbId, { properties: properties });
  console.log('Added formula ' + dbId + '.' + propName);
}

/**
 * targetDbId の中から、sourceDbId への relation を持つプロパティを探し、
 * 名前が intendedName と異なれば rename する。
 */
function ensureReverseRelationName_(token, targetDbId, sourceDbId, intendedName) {
  const db = fetchNotion_(token, 'GET', '/databases/' + targetDbId, null);
  const props = db.properties || {};
  let currentName = null;
  Object.keys(props).forEach(function (name) {
    const p = props[name];
    if (p.type === 'relation'
        && p.relation
        && p.relation.database_id === sourceDbId
        && name !== intendedName) {
      // 既に intendedName のプロパティが別に存在しないことを確認
      if (!props[intendedName]) {
        currentName = name;
      }
    }
  });
  if (currentName) {
    const properties = {};
    properties[currentName] = { name: intendedName };
    fetchNotion_(token, 'PATCH', '/databases/' + targetDbId, { properties: properties });
    console.log('Renamed reverse relation ' + targetDbId + '.' + currentName + ' → ' + intendedName);
  } else {
    console.log('Reverse relation on ' + targetDbId + ' already named correctly (or not found).');
  }
}

function fetchNotion_(token, method, path, body) {
  const opts = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };
  if (body) opts.payload = JSON.stringify(body);
  const res = UrlFetchApp.fetch(NOTION_API + path, opts);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Notion API ' + method + ' ' + path + ' failed (' + code + '): ' + text);
  }
  return JSON.parse(text);
}
