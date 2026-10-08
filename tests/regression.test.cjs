// Run: node --test tests/regression.test.cjs
// All network and Google services are mocked. Never contacts production.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const main = read('gas/main.gs');
const estimateGas = read('gas/mitsumori-save.gs');
const reserve = read('reserve.html');
const quiet = { log() {}, warn() {}, error() {} };
// Objects returned from inside a vm context belong to that realm, so plain
// deepEqual fails on prototype identity even when the structure matches.
// Round-trip through JSON (as the existing health-endpoint tests already do)
// to compare by value only.
const plain = v => JSON.parse(JSON.stringify(v));
const response = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
function gas(extra = {}) {
  const ctx = vm.createContext({ console: quiet,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'test-only' }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    ...extra });
  vm.runInContext(main, ctx);
  return ctx;
}
function element() {
  return { classList: { add() {} }, style: {}, innerHTML: '', innerText: '', value: '', disabled: false };
}
function reserveContext(extra = {}) {
  const elements = new Map();
  const ctx = vm.createContext({ console: quiet,
    document: { getElementById: id => {
      if (!elements.has(id)) elements.set(id, element()); return elements.get(id);
    }, querySelectorAll: () => [] }, ...extra });
  vm.runInContext('let isMemberMode=false; let selected={}; let calendarMatrix=[]; const CALENDAR_GAS_URL="mock";'+
    reserve.slice(reserve.indexOf('    function enableMemberMode()'), reserve.indexOf('    let calendarMatrix'))+
    reserve.slice(reserve.indexOf('    async function generateCalendar()'), reserve.indexOf('    function handleSlotClick(')), ctx);
  return { ctx, elements };
}

test('all inline scripts and GAS files parse', () => {
  for (const name of fs.readdirSync(root).filter(n => n.endsWith('.html'))) {
    for (const [, attrs, script] of read(name).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
      if (type && !/^(?:text|application)\/javascript$/i.test(type) && type.toLowerCase() !== 'module') continue;
      new vm.Script(script, { filename: name });
    }
  }
  for (const name of fs.readdirSync(path.join(root, 'gas'))) new vm.Script(read('gas/'+name), { filename: name });
});

test('estimate health endpoint reports chunked storage without touching Notion', () => {
  let fetches = 0;
  const ctx = vm.createContext({
    console: quiet,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'test-only' }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    UrlFetchApp: { fetch() { fetches++; throw Error('health must not contact Notion'); } }
  });
  vm.runInContext(estimateGas, ctx);
  const result = JSON.parse(ctx.doGet({ parameter: { action: 'health' } }).text);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    version: 'phase1',
    capabilities: { chunkedRichText: true }
  });
  assert.equal(fetches, 0);
});

test('health endpoint advertises readable confirmed responses without touching customer data', () => {
  const ctx = gas({
    Utilities: {
      DigestAlgorithm: { MD5: 'md5' },
      computeDigest: () => [1, 2, 3, 4, 5, 6]
    }
  });
  ctx.checkRateLimit = () => false;
  const result = JSON.parse(ctx.doGet({ parameter: { action: 'health' } }).text);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: 'success',
    version: 'phase1',
    capabilities: { confirmedFormResponse: true }
  });
});

for (const count of [0, 2]) test(`LINE completion with ${count} matches never writes or displays another card`, () => {
  const calls = [], replies = [];
  const ctx = gas({ UrlFetchApp: { fetch: (url, options) => {
    calls.push({ url, options });
    return response(200, { results: Array.from({ length: count }, (_, i) => ({ id: 'fake-'+i })) });
  } }, CacheService: { getScriptCache() { throw Error('Must not read shared phone cache'); } } });
  ctx.replyMyPage = () => assert.fail('Must not show a card');
  ctx.replyToLine = (_, text) => replies.push(text);
  ctx.linkLineIdToCustomer('person-A', 'reply', 'token', new Date());
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/query'));
  assert.equal(replies.length, 1);
});
test('LINE completion with one existing match preserves card access without mutation', () => {
  let shown = 0;
  const ctx = gas({ UrlFetchApp: { fetch: () => response(200, { results: [{ id: 'fake' }], has_more: false }) } });
  ctx.replyMyPage = () => shown++;
  ctx.linkLineIdToCustomer('person-A', 'reply', 'token', new Date());
  assert.equal(shown, 1);
});
test('LINE lookup failure is not described as successful receipt', () => {
  let message;
  const ctx = gas({ UrlFetchApp: { fetch: () => response(500, {}) } });
  ctx.replyToLine = (_, text) => { message = text; };
  ctx.linkLineIdToCustomer('person-A', 'reply', 'token', new Date());
  assert.match(message, /確認できません/);
});

for (const fn of ['upsertCustomerMaster', 'upsertCustomerMasterByLineId']) {
  test(`${fn}: failed lookup does not create duplicate customer`, () => {
    let calls = 0;
    const ctx = gas({ UrlFetchApp: { fetch: () => { calls++; return response(500, {}); } } });
    assert.equal(ctx[fn]({ tel: '09000000000', lineUserId: 'fake' }), null);
    assert.equal(calls, 1);
  });
  test(`${fn}: rejected update does not return saved customer ID`, () => {
    let calls = 0;
    const ctx = gas({ UrlFetchApp: { fetch: () => ++calls === 1 ? response(200, { results: [{ id: 'fake' }] }) : response(400, {}) } });
    assert.equal(ctx[fn]({ tel: '09000000000', lineUserId: 'fake' }), null);
  });
}

function formContext(fetchResult) {
  const ctx = gas({ UrlFetchApp: { fetch: () => fetchResult },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent() {} }) },
    MailApp: { sendEmail() {} }, Session: { getEffectiveUser: () => ({ getEmail: () => 'test@example.invalid' }) } });
  ctx.isTokenValid_ = () => ({ ok: true }); ctx.isRateLimited = () => false;
  ctx.validatePayload_ = () => ({ ok: true }); ctx.tryLockSlot = () => true;
  ctx.upsertCustomerMaster = () => 'fake-customer';
  return ctx;
}
test('diagnosis confirms only after Notion saved successfully', () => {
  const ctx = formContext(response(200, { id: 'saved' }));
  assert.equal(JSON.parse(ctx.handleWebForm({ name: '架空', token: 'fake' }).text).confirmed, true);
});
test('Notion failure returns error and sends no confirmation emails', () => {
  const ctx = formContext(response(500, {}));
  ctx.MailApp.sendEmail = () => assert.fail('Do not confirm unsaved record');
  const result = JSON.parse(ctx.handleWebForm({ name: '架空', email: 'test@example.invalid' }).text);
  assert.equal(result.status, 'error'); assert.equal(result.confirmed, undefined);
});
test('calendar failure returns error', () => {
  const ctx = formContext(response(200, {}));
  ctx.CalendarApp.getDefaultCalendar = () => { throw Error('offline'); };
  assert.equal(JSON.parse(ctx.handleWebForm({ name: '架空', date: '2026-10-01', time: '10:00' }).text).status, 'error');
});
test('standalone app check cannot pretend to save without an identified customer', () => {
  const ctx = formContext(response(200, {}));
  assert.equal(JSON.parse(ctx.handleWebForm({ formType: 'app_check', appUsed: 'LINE' }).text).status, 'error');
});

test('member discount is identical regardless of selection/login order', () => {
  for (const price of [0, 3300, 5500, 11000]) {
    const { ctx } = reserveContext();
    vm.runInContext(`selectMenu('m','相談',${price},60);enableMemberMode();`, ctx);
    assert.equal(vm.runInContext('selected.price', ctx), price * 0.8);
    vm.runInContext(`selectMenu('m','相談',${price},60);`, ctx);
    assert.equal(vm.runInContext('selected.price', ctx), price * 0.8);
  }
});
for (const kind of ['network', 'http', 'error-json', 'invalid-slot']) test(`calendar ${kind} fails closed and clears old selection`, async () => {
  const { ctx, elements } = reserveContext({ fetch: async () => {
    if (kind === 'network') throw Error('offline');
    return { ok: kind !== 'http', json: async () => kind === 'invalid-slot' ? { busy: [{ start: 'bad', end: 'bad' }] } : { status: 'error' } };
  } });
  vm.runInContext("selected={duration:60,dateRaw:'old',time:'10:00'}",ctx);
  await ctx.generateCalendar();
  assert.equal(vm.runInContext('selected.dateRaw',ctx),'');
  assert.equal(vm.runInContext('calendarMatrix.length',ctx),0);
  assert.match(elements.get('calendar-head').innerHTML, /確認できません/);
});
test('long family estimate JSON round-trips exactly including emoji boundaries', () => {
  const ctx = vm.createContext({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) } });
  vm.runInContext(read('gas/mitsumori-save.gs'), ctx);
  const obj = { family: Array.from({ length: 5 }, (_, i) => ({ name: '架空'+i, memo: '📱日本語'.repeat(700) })) };
  const chunks = ctx.jsonRichText_(obj);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.text.content.length <= 1900);
  assert.deepEqual(JSON.parse(chunks.map(c => c.text.content).join('')), obj);
  assert.throws(() => ctx.jsonRichText_({ large: 'x'.repeat(200000) }));
});

for (const result of [{ status: 'error' }, { status: 'success' }]) test(`reservation rejects unconfirmed response ${JSON.stringify(result)}`, async () => {
  const nodes = new Map(); const alerts = []; let saved = false;
  const ctx = vm.createContext({ document: { getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, { value: 'test', checked: false }); return nodes.get(id);
  } }, SECRET_TOKEN: 'fake', GAS_URL: 'mock', selected: { name: '相談', price: 3300 },
    showSendingOverlay() {}, hideSendingOverlay() {}, updateOverlayToSuccess() { assert.fail('Must not show success'); },
    localStorage: { setItem() { saved = true; } }, Swal: { fire: (...args) => alerts.push(args) },
    fetch: async () => ({ ok: true, json: async () => result }) });
  vm.runInContext(reserve.slice(reserve.indexOf('    function submitToGAS()'), reserve.indexOf('    function goBack()')), ctx);
  ctx.submitToGAS();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, false); assert.match(alerts[0][0], /確認できません/);
});

// --- LP page-view beacon (doGet?action=pv) and weekly source report ---

const LP_DB_ID = 'c8016744-4a6f-427b-ac2c-d20b4eb432f8';

function cacheService(initial) {
  const store = new Map(Object.entries(initial || {}));
  return { getScriptCache: () => ({
    get: key => (store.has(key) ? store.get(key) : null),
    put: (key, value) => { store.set(key, value); }
  }) };
}
function pvContext(extra = {}) {
  return gas({ Utilities: { formatDate: () => '2026100712' }, CacheService: cacheService(), ...extra });
}

test('doGet?action=pv bypasses the shared rate limiter', () => {
  const ctx = pvContext({ UrlFetchApp: { fetch: () => response(200, { id: 'ok' }) } });
  ctx.checkRateLimit = () => { throw Error('Must not share rate limit with real browser traffic'); };
  const result = JSON.parse(ctx.doGet({ parameter: { action: 'pv', src: 'insta', page: 'lp' } }).text);
  assert.deepEqual(plain(result), { status: 'success' });
});
test('doGet?action=pv sanitizes src before writing it to the LP view log', () => {
  let payload;
  const ctx = pvContext({ UrlFetchApp: { fetch: (url, opts) => { payload = JSON.parse(opts.payload); return response(200, { id: 'ok' }); } } });
  ctx.doGet({ parameter: { action: 'pv', src: '  insta!! <script>'.padEnd(80, 'x'), page: 'lp' } });
  const saved = payload.properties['流入経路'].rich_text[0].text.content;
  assert.ok(saved.length <= 50);
  assert.doesNotMatch(saved, /[^a-zA-Z0-9_-]/);
});
test('recordLpView_ defaults an empty src to "direct"', () => {
  let payload;
  const ctx = pvContext({ UrlFetchApp: { fetch: (url, opts) => { payload = JSON.parse(opts.payload); return response(200, {}); } } });
  ctx.recordLpView_({ src: '', page: 'lp' });
  assert.equal(payload.properties['流入経路'].rich_text[0].text.content, 'direct');
});
test('recordLpView_ ignores unknown page values without writing to Notion', () => {
  let calls = 0;
  const ctx = pvContext({ UrlFetchApp: { fetch: () => { calls++; return response(200, {}); } } });
  const result = ctx.recordLpView_({ src: 'insta', page: 'prices' });
  assert.equal(calls, 0);
  assert.deepEqual(plain(result), { status: 'success' });
});
test('recordLpView_ stops writing once the hourly cap is reached but still reports success', () => {
  let calls = 0;
  const ctx = pvContext({ UrlFetchApp: { fetch: () => { calls++; return response(200, {}); } },
    CacheService: cacheService({ pv_hour_2026100712: '600' }) });
  const result = ctx.recordLpView_({ src: 'insta', page: 'lp' });
  assert.equal(calls, 0);
  assert.deepEqual(plain(result), { status: 'success' });
});
test('recordLpView_ reports an error when the Notion write fails, without throwing', () => {
  const ctx = pvContext({ UrlFetchApp: { fetch: () => response(500, { message: 'down' }) } });
  assert.deepEqual(plain(ctx.recordLpView_({ src: 'insta', page: 'lp' })), { status: 'error' });
});
test('recordLpView_ never throws even if the cache itself is broken', () => {
  const ctx = pvContext({ CacheService: { getScriptCache() { throw Error('cache offline'); } } });
  assert.deepEqual(plain(ctx.recordLpView_({ src: 'insta', page: 'lp' })), { status: 'error' });
});

test('aggregateWeeklySignups_ only counts the last N days and groups by source', () => {
  const ctx = gas();
  const now = new Date('2026-10-07T00:00:00+09:00').getTime();
  const customers = [
    { source: 'insta', isMember: false, firstDateStr: '2026-10-05' },
    { source: 'insta', isMember: true,  firstDateStr: '2026-10-01' },
    { source: 'insta', isMember: false, firstDateStr: '2026-09-20' },
    { source: '',      isMember: false, firstDateStr: '2026-10-06' },
    { source: 'insta', isMember: false, firstDateStr: '' }
  ];
  assert.deepEqual(plain(ctx.aggregateWeeklySignups_(customers, now, 7)),
    { insta: { signups: 2, members: 1 }, direct: { signups: 1, members: 0 } });
});
test('aggregateWeeklyPageViews_ only counts the last N days and defaults missing source to direct', () => {
  const ctx = gas();
  const now = new Date('2026-10-07T12:00:00Z').getTime();
  const views = [
    { source: 'insta', viewedAtMs: now - 1 * 86400000 },
    { source: 'insta', viewedAtMs: now - 6 * 86400000 },
    { source: 'insta', viewedAtMs: now - 8 * 86400000 },
    { source: '',      viewedAtMs: now - 2 * 86400000 },
    { source: 'insta', viewedAtMs: NaN }
  ];
  assert.deepEqual(plain(ctx.aggregateWeeklyPageViews_(views, now, 7)), { insta: 2, direct: 1 });
});
test('buildWeeklyReportRows_ computes the view-to-signup rate and sorts by views desc, using "-" (null) when views are 0', () => {
  const ctx = gas();
  const rows = plain(ctx.buildWeeklyReportRows_(
    { insta: { signups: 2, members: 1 }, flyer: { signups: 1, members: 0 } },
    { insta: 10, flyer: 0, direct: 5 }
  ));
  assert.deepEqual(rows, [
    { source: 'insta', views: 10, signups: 2, members: 1, rate: 20 },
    { source: 'direct', views: 5, signups: 0, members: 0, rate: 0 },
    { source: 'flyer', views: 0, signups: 1, members: 0, rate: null }
  ]);
});

test('generateSourceReport still emails the cumulative table when the LP view log fetch fails', () => {
  let emailBody;
  const ctx = gas({
    UrlFetchApp: { fetch: url => url.includes('databases/' + LP_DB_ID)
      ? response(500, { message: 'down' })
      : response(200, { results: [], has_more: false }) },
    MailApp: { sendEmail: (to, subject, body) => { emailBody = body; } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }) }
  });
  const body = ctx.generateSourceReport();
  assert.ok(emailBody, 'email must still be sent even when the LP log fetch fails');
  assert.match(emailBody, /取得失敗/);
  assert.equal(body, emailBody);
});

// --- Phase 2: LINE click / scroll depth / device / hourly breakdown ---

test('doGet?action=pv passes type and dev through to recordLpView_', () => {
  let payload;
  const ctx = pvContext({ UrlFetchApp: { fetch: (url, opts) => { payload = JSON.parse(opts.payload); return response(200, {}); } } });
  ctx.doGet({ parameter: { action: 'pv', src: 'insta', page: 'lp', type: 'line_click', dev: 'android' } });
  assert.equal(payload.properties['種別'].rich_text[0].text.content, 'line_click');
  assert.equal(payload.properties['端末'].rich_text[0].text.content, 'android');
  assert.equal(payload.properties['名前'].title[0].text.content, 'insta lp line_click');
});
test('recordLpView_ falls back to view/other for unknown type or device values', () => {
  let payload;
  const ctx = pvContext({ UrlFetchApp: { fetch: (url, opts) => { payload = JSON.parse(opts.payload); return response(200, {}); } } });
  ctx.recordLpView_({ src: 'insta', page: 'lp', type: 'something_else', dev: 'something_else' });
  assert.equal(payload.properties['種別'].rich_text[0].text.content, 'view');
  assert.equal(payload.properties['端末'].rich_text[0].text.content, 'other');
  assert.equal(payload.properties['名前'].title[0].text.content, 'insta lp');
});
test('recordLpView_ hourly cap was raised to 600 (a 200-count hour still accepts writes)', () => {
  let calls = 0;
  const ctx = pvContext({ UrlFetchApp: { fetch: () => { calls++; return response(200, {}); } },
    CacheService: cacheService({ pv_hour_2026100712: '200' }) });
  ctx.recordLpView_({ src: 'insta', page: 'lp' });
  assert.equal(calls, 1);
});

test('fetchRecentLpViews_ defaults missing 種別/端末 (pre-phase-2 rows) to view/other', () => {
  const ctx = gas({ UrlFetchApp: { fetch: () => response(200, { results: [{
    properties: {
      '流入経路': { rich_text: [{ plain_text: 'insta' }] },
      '閲覧日時': { date: { start: '2026-10-07T10:00:00+09:00' } }
      // no 種別 / 端末 properties at all -- a row saved before phase 2
    }
  }], has_more: false }) } });
  const rows = plain(ctx.fetchRecentLpViews_(LP_DB_ID, 100, 5000));
  assert.deepEqual(rows, [{
    source: 'insta', viewedAtMs: new Date('2026-10-07T10:00:00+09:00').getTime(), type: 'view', dev: 'other'
  }]);
});

test('aggregateWeeklyEventCounts_ only counts the matching type within the window, grouped by source', () => {
  const ctx = gas();
  const now = new Date('2026-10-08T00:00:00+09:00').getTime();
  const rows = [
    { source: 'insta', viewedAtMs: now - 1 * 86400000, type: 'line_click' },
    { source: 'insta', viewedAtMs: now - 6 * 86400000, type: 'line_click' },
    { source: 'insta', viewedAtMs: now - 8 * 86400000, type: 'line_click' }, // too old
    { source: 'insta', viewedAtMs: now - 1 * 86400000, type: 'view' },       // wrong type
    { source: '',      viewedAtMs: now - 1 * 86400000, type: 'line_click' }  // empty source -> direct
  ];
  assert.deepEqual(plain(ctx.aggregateWeeklyEventCounts_(rows, now, 7, 'line_click')), { insta: 2, direct: 1 });
});

test('buildWeeklyRateRows_ shows "-" (null) when there were no views, and sorts by views desc', () => {
  const ctx = gas();
  const rows = plain(ctx.buildWeeklyRateRows_({ insta: 10, flyer: 0 }, { insta: 3, flyer: 1 }));
  assert.deepEqual(rows, [
    { source: 'insta', views: 10, count: 3, rate: 30 },
    { source: 'flyer', views: 0, count: 1, rate: null }
  ]);
});

test('buildWeeklyScrollRows_ computes independent 50%/90% rates per source', () => {
  const ctx = gas();
  const rows = plain(ctx.buildWeeklyScrollRows_({ insta: 10 }, { insta: 5 }, { insta: 2 }));
  assert.deepEqual(rows, [{ source: 'insta', views: 10, scroll50: 5, scroll90: 2, rate50: 50, rate90: 20 }]);
});

test('aggregateWeeklyDeviceBreakdown_ counts view rows only, treating missing type/device as view/other', () => {
  const ctx = gas();
  const now = new Date('2026-10-08T00:00:00+09:00').getTime();
  const oneDayAgo = now - 1 * 86400000;
  const rows = [
    { viewedAtMs: oneDayAgo, type: 'view', dev: 'ios' },
    { viewedAtMs: oneDayAgo, type: 'view', dev: 'android' },
    { viewedAtMs: oneDayAgo, type: 'view' },                   // missing dev -> other
    { viewedAtMs: oneDayAgo },                                 // missing type AND dev (legacy row)
    { viewedAtMs: oneDayAgo, type: 'view', dev: 'bogus' },     // unknown dev -> other
    { viewedAtMs: oneDayAgo, type: 'line_click', dev: 'ios' }  // event row must NOT count as a view
  ];
  assert.deepEqual(plain(ctx.aggregateWeeklyDeviceBreakdown_(rows, now, 7)), { ios: 1, android: 1, pc: 0, other: 3 });
});

test('buildDeviceBreakdownRows_ computes percentages, and null when there is no data at all', () => {
  const ctx = gas();
  assert.deepEqual(plain(ctx.buildDeviceBreakdownRows_({ ios: 3, android: 1, pc: 0, other: 0 })), [
    { dev: 'ios', count: 3, pct: 75 },
    { dev: 'android', count: 1, pct: 25 },
    { dev: 'pc', count: 0, pct: 0 },
    { dev: 'other', count: 0, pct: 0 }
  ]);
  assert.deepEqual(plain(ctx.buildDeviceBreakdownRows_({ ios: 0, android: 0, pc: 0, other: 0 })), [
    { dev: 'ios', count: 0, pct: null },
    { dev: 'android', count: 0, pct: null },
    { dev: 'pc', count: 0, pct: null },
    { dev: 'other', count: 0, pct: null }
  ]);
});

test('aggregateWeeklyHourlyViews_ buckets JST hours into the 7 fixed ranges, view rows only (missing type counts as view)', () => {
  const ctx = gas();
  const now = Date.UTC(2026, 9, 8, 0, 0, 0);
  function jstMs(hour) { return Date.UTC(2026, 9, 7, hour, 0, 0) - 9 * 60 * 60 * 1000; }
  const rows = [
    { viewedAtMs: jstMs(3), type: 'view' },
    { viewedAtMs: jstMs(3) },                     // missing type -> counted as view
    { viewedAtMs: jstMs(7), type: 'view' },
    { viewedAtMs: jstMs(7), type: 'line_click' }  // must NOT be counted
  ];
  const counts = plain(ctx.aggregateWeeklyHourlyViews_(rows, now, 7));
  assert.equal(counts['0-5時'], 2);
  assert.equal(counts['6-8時'], 1);
  assert.equal(counts['9-11時'], 0);
});

test('generateSourceReport counts only view rows as "views" for a source, not line_click/scroll event rows', () => {
  let emailBody;
  const today = new Date().toISOString().substring(0, 10);
  const customerRows = [{ properties: {
    '流入経路': { select: { name: 'insta' } },
    'かかりつけ会員': { checkbox: false },
    '初回登録日': { date: { start: today } }
  } }];
  const nowIso = new Date().toISOString();
  function lpRow(type) {
    return { properties: {
      '流入経路': { rich_text: [{ plain_text: 'insta' }] },
      '閲覧日時': { date: { start: nowIso } },
      '種別': { rich_text: [{ plain_text: type }] }
    } };
  }
  const lpRows = [lpRow('view'), lpRow('line_click'), lpRow('scroll50')];
  const ctx = gas({
    UrlFetchApp: { fetch: url => url.includes('databases/' + LP_DB_ID)
      ? response(200, { results: lpRows, has_more: false })
      : response(200, { results: customerRows, has_more: false }) },
    MailApp: { sendEmail: (to, subject, body) => { emailBody = body; } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }) }
  });
  ctx.generateSourceReport();
  const viewLine = emailBody.split('\n').find(l => l.startsWith('insta'));
  assert.ok(viewLine, 'expected a report row starting with the source name');
  const viewsField = viewLine.slice(20, 24).trim();
  assert.equal(viewsField, '1', 'views must count only the view-type row, not line_click/scroll50');
});
