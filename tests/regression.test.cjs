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

// --- Security hardening (2026-10-22): LINE account hijack protection ---

test('normalizeTel_: hyphenated and full-width phone numbers normalize to the same value, but a different digit count never matches', () => {
  const ctx = gas();
  assert.equal(ctx.normalizeTel_('090-1234-5678'), ctx.normalizeTel_('09012345678'));
  assert.equal(ctx.normalizeTel_('０９０-１２３４-５６７８'), ctx.normalizeTel_('09012345678'));
  assert.notEqual(ctx.normalizeTel_('0901234567'), ctx.normalizeTel_('09012345678'));
  assert.notEqual(ctx.normalizeTel_('090123456789'), ctx.normalizeTel_('09012345678'));
});

test('upsertCustomerMaster links LINE_userid when the matched customer has none yet', () => {
  let patchPayload;
  const ctx = gas({ UrlFetchApp: { fetch: (url, opts) => {
    if (url.includes('/query')) {
      return response(200, { results: [{ id: 'cust-1', properties: {
        '電話番号': { rich_text: [{ plain_text: '09000000000' }] }
      } }] });
    }
    if (opts && opts.method === 'patch' && url.includes('/pages/')) { patchPayload = JSON.parse(opts.payload); return response(200, {}); }
    return response(200, {});
  } } });
  const result = ctx.upsertCustomerMaster({ tel: '09000000000', lineUserId: 'line-new', lineDisplayName: 'たろう' });
  assert.equal(result, 'cust-1');
  assert.equal(patchPayload.properties['LINE_userid'].rich_text[0].text.content, 'line-new');
});

test('upsertCustomerMaster does not overwrite a different LINE_userid already on file, and notifies the owner with only the last 4 phone digits', () => {
  let patchPayload;
  let notified;
  const ctx = gas({
    UrlFetchApp: { fetch: (url, opts) => {
      if (url.includes('/query')) {
        return response(200, { results: [{ id: 'cust-1', properties: {
          '電話番号': { rich_text: [{ plain_text: '09011112222' }] },
          'LINE_userid': { rich_text: [{ plain_text: 'line-existing-owner' }] }
        } }] });
      }
      if (opts && opts.method === 'patch' && url.includes('/pages/')) { patchPayload = JSON.parse(opts.payload); return response(200, {}); }
      return response(200, {});
    } },
    MailApp: { sendEmail: (to, subject, body) => { notified = { to, subject, body }; } }
  });
  const result = ctx.upsertCustomerMaster({ tel: '09011112222', lineUserId: 'line-attacker' });
  assert.equal(result, 'cust-1');
  assert.equal(patchPayload.properties['LINE_userid'], undefined);
  assert.equal(patchPayload.properties['LINE_displayName'], undefined);
  assert.ok(notified, 'owner must be notified by email');
  assert.ok(notified.body.includes('2222'), 'last 4 digits should be shown');
  assert.ok(!notified.body.includes('09011112222'), 'full phone number must never be included');
});

test('upsertCustomerMaster treats 2+ exact phone matches as ambiguous: no write happens anywhere, and the owner is notified', () => {
  let writeCalls = 0;
  let notifiedSubject;
  const ctx = gas({
    UrlFetchApp: { fetch: (url) => {
      if (url.includes('/query')) {
        return response(200, { results: [
          { id: 'cust-1', properties: { '電話番号': { rich_text: [{ plain_text: '09033334444' }] } } },
          { id: 'cust-2', properties: { '電話番号': { rich_text: [{ plain_text: '09033334444' }] } } }
        ] });
      }
      writeCalls++;
      return response(200, {});
    } },
    MailApp: { sendEmail: (to, subject) => { notifiedSubject = subject; } }
  });
  const result = ctx.upsertCustomerMaster({ tel: '09033334444', lineUserId: 'line-x' });
  assert.equal(result, '__PHONE_MATCH_AMBIGUOUS__');
  assert.equal(writeCalls, 0, 'must not update either matched record, and must not create a new one');
  assert.match(notifiedSubject, /複数件/);
});

test('upsertCustomerMasterByLineId treats 2+ matches for the same LINE_userid as ambiguous: no write happens, and the owner is notified', () => {
  let writeCalls = 0;
  let notifiedSubject;
  const ctx = gas({
    UrlFetchApp: { fetch: (url) => {
      if (url.includes('/query')) {
        return response(200, { results: [{ id: 'cust-1' }, { id: 'cust-2' }] });
      }
      writeCalls++;
      return response(200, {});
    } },
    MailApp: { sendEmail: (to, subject) => { notifiedSubject = subject; } }
  });
  const result = ctx.upsertCustomerMasterByLineId({ lineUserId: 'line-dup', name: '架空' });
  assert.equal(result, '__LINE_MATCH_AMBIGUOUS__');
  assert.equal(writeCalls, 0);
  assert.match(notifiedSubject, /複数件/);
});

test('resolveVerifiedLineUserId_ trusts lineUserId only when the ID token verifies to the same sub', () => {
  const ctx = gas({ UrlFetchApp: { fetch: url => url.includes('oauth2/v2.1/verify') ? response(200, { sub: 'U-verified' }) : response(200, {}) } });
  assert.equal(ctx.resolveVerifiedLineUserId_({ lineUserId: 'U-verified', idToken: 'good-token' }), 'U-verified');
});

test('resolveVerifiedLineUserId_ ignores a spoofed lineUserId when the ID token verifies to a different sub', () => {
  const ctx = gas({ UrlFetchApp: { fetch: url => url.includes('oauth2/v2.1/verify') ? response(200, { sub: 'U-real-owner' }) : response(200, {}) } });
  assert.equal(ctx.resolveVerifiedLineUserId_({ lineUserId: 'U-attacker-claims', idToken: 'token-for-real-owner' }), '');
});

test('resolveVerifiedLineUserId_ returns "" without calling LINE when there is no ID token at all', () => {
  const ctx = gas({ UrlFetchApp: { fetch: () => assert.fail('must not call LINE verify without an idToken') } });
  assert.equal(ctx.resolveVerifiedLineUserId_({ lineUserId: 'U-x', idToken: '' }), '');
});

test('resolveVerifiedLineUserId_ fails safe (returns "") when LINE_LOGIN_CHANNEL_ID is not configured yet', () => {
  const ctx = gas({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'LINE_LOGIN_CHANNEL_ID' ? '' : 'test-only' }) },
    UrlFetchApp: { fetch: () => assert.fail('must not call LINE verify without a configured channel id') }
  });
  assert.equal(ctx.resolveVerifiedLineUserId_({ lineUserId: 'U-x', idToken: 'some-token' }), '');
});

test("resolveVerifiedLineUserId_ returns \"\" when LINE's verify endpoint rejects the token (e.g. expired)", () => {
  const ctx = gas({ UrlFetchApp: { fetch: () => response(400, { error: 'invalid_request' }) } });
  assert.equal(ctx.resolveVerifiedLineUserId_({ lineUserId: 'U-x', idToken: 'expired-token' }), '');
});

test('handleWebForm (diagnosis): a failed/expired ID token never blocks the diagnosis save, it only drops the LINE link', () => {
  const ctx = gas({
    UrlFetchApp: { fetch: url => url.includes('oauth2/v2.1/verify') ? response(400, {}) : response(200, { id: 'saved' }) }
  });
  ctx.isTokenValid_   = () => ({ ok: true });
  ctx.isRateLimited   = () => false;
  ctx.validatePayload_ = () => ({ ok: true });
  ctx.tryLockSlot     = () => true;
  const result = JSON.parse(ctx.handleWebForm({ name: '架空', lineUserId: 'U-spoofed', idToken: 'expired' }).text);
  assert.equal(result.status, 'success');
  assert.equal(result.confirmed, true);
});

test('handleWebForm: an ambiguous phone match does not fail the diagnosis save, it only skips the customer-master link', () => {
  const ctx = gas({
    UrlFetchApp: { fetch: url => {
      if (url.includes('/query')) {
        return response(200, { results: [
          { id: 'cust-1', properties: { '電話番号': { rich_text: [{ plain_text: '09055556666' }] } } },
          { id: 'cust-2', properties: { '電話番号': { rich_text: [{ plain_text: '09055556666' }] } } }
        ] });
      }
      return response(200, { id: 'saved' });
    } },
    CalendarApp: { getDefaultCalendar: () => ({ createEvent() {} }) },
    MailApp: { sendEmail() {} },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'test@example.invalid' }) }
  });
  ctx.isTokenValid_   = () => ({ ok: true });
  ctx.isRateLimited   = () => false;
  ctx.validatePayload_ = () => ({ ok: true });
  ctx.tryLockSlot     = () => true;
  const result = JSON.parse(ctx.handleWebForm({ name: '架空', tel: '09055556666' }).text);
  assert.equal(result.status, 'success');
  assert.equal(result.confirmed, true);
});

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

// --- Security hardening (2026-10-22, round 2): diagnosis form no longer auto-links by phone number ---

test('handleWebForm (diagnosis): a genuine ID-verified LINE login combined with someone else\'s phone number never reads or updates that other customer\'s record', () => {
  let phoneQueryCalls = 0;
  const ctx = gas({ UrlFetchApp: { fetch: (url, opts) => {
    if (url.includes('oauth2/v2.1/verify')) return response(200, { sub: 'line-self' });
    if (url.includes('/query')) {
      const body = JSON.parse(opts.payload);
      if (body.filter && body.filter.property === '電話番号') { phoneQueryCalls++; return response(200, { results: [{ id: 'victim-page' }] }); }
      if (body.filter && body.filter.property === 'LINE_userid') return response(200, { results: [] }); // 自分は新規
      return response(200, { results: [] });
    }
    return response(200, { id: 'new-self-page' });
  } } });
  ctx.isTokenValid_   = () => ({ ok: true });
  ctx.isRateLimited   = () => false;
  ctx.validatePayload_ = () => ({ ok: true });
  ctx.tryLockSlot     = () => true;
  const result = JSON.parse(ctx.handleWebForm({
    name: '本人', tel: '09099990000', lineUserId: 'line-self', idToken: 'good-token'
  }).text);
  assert.equal(result.status, 'success');
  assert.equal(phoneQueryCalls, 0, '一度LINEで本人確認できたら、電話番号で他人の顧客マスターを検索・更新してはいけない');
});

test('handleWebForm (diagnosis): a phone number matching an existing customer whose LINE_userid is still empty does NOT get linked (no LINE login at all)', () => {
  let patchCalls = 0;
  let notified;
  const ctx = gas({
    UrlFetchApp: { fetch: (url, opts) => {
      if (url.includes('/query')) {
        return response(200, { results: [{ id: 'existing-no-line', properties: {
          '電話番号': { rich_text: [{ plain_text: '09088880000' }] }
        } }] });
      }
      if (opts && opts.method === 'patch') { patchCalls++; }
      return response(200, { id: 'diag-saved' });
    } },
    MailApp: { sendEmail: (to, subject) => { notified = subject; } }
  });
  ctx.isTokenValid_   = () => ({ ok: true });
  ctx.isRateLimited   = () => false;
  ctx.validatePayload_ = () => ({ ok: true });
  ctx.tryLockSlot     = () => true;
  const result = JSON.parse(ctx.handleWebForm({ name: '架空', tel: '09088880000' }).text);
  assert.equal(result.status, 'success', 'diagnosis save must still succeed');
  assert.equal(patchCalls, 0, '電話番号が一致するだけでは、LINE_useridが空の既存顧客であっても更新してはいけない');
  assert.match(notified, /要確認/);
});

test('handleWebForm (diagnosis): the raw ID token itself is never written to Notion, never emailed, and never logged', () => {
  const SECRET_TOKEN_VALUE = 'this-is-the-id-token-9f8e7d6c5b4a';
  const sentPayloads = [];
  const sentEmails = [];
  const logs = [];
  const ctx = gas({
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    UrlFetchApp: { fetch: (url, opts) => {
      // LINEの検証エンドポイントへ送るのは正当な用途(検証そのもの)なので対象外。
      // それ以外(Notion等)への送信にIDトークンが紛れ込んでいないかだけを見る。
      if (url.includes('oauth2/v2.1/verify')) return response(200, { sub: 'line-self' });
      if (opts && opts.payload) sentPayloads.push(typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload));
      return response(200, { id: 'saved' });
    } },
    MailApp: { sendEmail: (to, subject, body) => { sentEmails.push(body); } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'test@example.invalid' }) }
  });
  ctx.isTokenValid_   = () => ({ ok: true });
  ctx.isRateLimited   = () => false;
  ctx.validatePayload_ = () => ({ ok: true });
  ctx.tryLockSlot     = () => true;
  ctx.handleWebForm({ name: '架空', lineUserId: 'line-self', idToken: SECRET_TOKEN_VALUE });
  for (const p of sentPayloads) assert.ok(!p.includes(SECRET_TOKEN_VALUE), 'Notion/他APIへの送信payloadにIDトークンが含まれている');
  for (const b of sentEmails) assert.ok(!b.includes(SECRET_TOKEN_VALUE), 'メール本文にIDトークンが含まれている');
  for (const l of logs) assert.ok(!l.includes(SECRET_TOKEN_VALUE), 'ログにIDトークンが含まれている');
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

// --- Phase 3: LP trust/FAQ additions + "data migration pack" naming unification ---

const lp = read('machi-sumaho-soudanshi.html');
// machi-sumaho-soudanshi.html stores all Japanese text as numeric character
// references (&#xNNNN;) to keep the file itself ASCII-only. Decode before
// checking for Japanese substrings; the raw ASCII file is checked separately.
const decodeEntities = html => html.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
const lpText = decodeEntities(lp);
const allHtmlFiles = fs.readdirSync(root).filter(n => n.endsWith('.html'));

test('LP has the new #faq and #local sections, with exactly 7 FAQ entries', () => {
  assert.match(lp, /id="faq"/);
  assert.match(lp, /id="local"/);
  assert.equal((lp.match(/<details>/g) || []).length, 7);
});

for (const banned of ['完全データ移行パック', '全アプリのログイン確認']) {
  test(`no HTML file still contains the retired phrase "${banned}"`, () => {
    for (const name of allHtmlFiles) {
      const text = decodeEntities(read(name));
      assert.doesNotMatch(text, new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name);
    }
  });
}
test('the renamed "data migration pack" name is present where the old name used to be', () => {
  assert.match(lpText, /データ移行パック/);
  assert.match(decodeEntities(read('prices.html')), /データ移行パック/);
  assert.match(decodeEntities(read('reserve.html')), /データ移行パック/);
});

test('"LINE operation questions are free" perk no longer appears in LP/prices/reserve', () => {
  const phrase = '操作質問・相談が無料'; // "操作質問・相談が無料"
  for (const name of ['machi-sumaho-soudanshi.html', 'prices.html', 'reserve.html']) {
    assert.doesNotMatch(decodeEntities(read(name)), new RegExp(phrase), name);
  }
});

test('LP still carries the phase 1/2 measurement code (pv beacon, line_click, scroll50/90, src tracking)', () => {
  for (const marker of ['action=pv', 'line_click', 'scroll50', 'scroll90', 'sumaho_src']) {
    assert.ok(lp.includes(marker), `missing measurement marker: ${marker}`);
  }
});

test('LP file stays ASCII-only (Japanese text must be numeric-entity encoded)', () => {
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(lp, /[^\x00-\x7F]/);
});

test('LP does not include unapproved draft-only content (testimonials, draft badges, noindex)', () => {
  assert.doesNotMatch(lp, /class="voice"/);
  assert.doesNotMatch(lp, /dn-/);
  assert.doesNotMatch(lp, /noindex/);
});

// --- MyPage card8: "relation/name" (zokugara/meigi) shown per family member ---

test('sanitizeRelationName_ trims, strips control characters, and truncates to 40 chars', () => {
  const ctx = gas();
  assert.equal(ctx.sanitizeRelationName_('  長男様  '), '長男様');
  assert.equal(ctx.sanitizeRelationName_('本人\n\t　'.replace('　', '')), '本人');
  assert.equal(ctx.sanitizeRelationName_('a'.repeat(50)).length, 40);
  assert.equal(ctx.sanitizeRelationName_('a'.repeat(50)), 'a'.repeat(40));
});
test('sanitizeRelationName_ treats missing/empty/whitespace-only/placeholder values as blank', () => {
  const ctx = gas();
  assert.equal(ctx.sanitizeRelationName_(undefined), '');
  assert.equal(ctx.sanitizeRelationName_(null), '');
  assert.equal(ctx.sanitizeRelationName_(''), '');
  assert.equal(ctx.sanitizeRelationName_('   '), '');
  assert.equal(ctx.sanitizeRelationName_('（お名前未記入）'), ''); // "（お名前未記入）"
});
test('sanitizeRelationName_ strips embedded control characters (e.g. newlines) without dropping real text', () => {
  const ctx = gas();
  assert.equal(ctx.sanitizeRelationName_('長女\n様'), '長女様'); // "長女\n様" -> "長女様"
});

test('buildMitsumoriPersonRows_ places "relation/name" directly under "last created date" when present', () => {
  const ctx = gas();
  const me = { meigi: '長女様', carrier: 'docomo', planName: 'eximo', basePrice: 7315, monthly: 7315 };
  const rows = plain(ctx.buildMitsumoriPersonRows_(me, '2026/10/16'));
  assert.deepEqual(rows[0], { label: '最終作成日', value: '2026/10/16' });
  assert.deepEqual(rows[1], { label: '続柄・お名前', value: '長女様' });
  assert.deepEqual(rows[2], { type: 'separator' });
});
test('buildMitsumoriPersonRows_ omits the row entirely when the relation/name is blank', () => {
  const ctx = gas();
  const me = { meigi: '', carrier: 'docomo', planName: 'eximo', basePrice: 7315, monthly: 7315 };
  const rows = plain(ctx.buildMitsumoriPersonRows_(me, '2026/10/16'));
  assert.deepEqual(rows[0], { label: '最終作成日', value: '2026/10/16' });
  assert.deepEqual(rows[1], { type: 'separator' }); // straight to the existing separator, no blank row
  assert.ok(!rows.some(r => r.label === '続柄・お名前'));
});
test('buildMitsumoriPersonRows_ does not throw on old saved data missing the "meigi" field entirely', () => {
  const ctx = gas();
  const me = { carrier: 'docomo', planName: 'eximo', basePrice: 7315, monthly: 7315 }; // no `meigi` key at all
  const rows = plain(ctx.buildMitsumoriPersonRows_(me, '2026/10/16'));
  assert.ok(!rows.some(r => r.label === '続柄・お名前'));
  assert.equal(rows[rows.length - 1].label, '月額合計'); // still ends normally
});
test('buildMitsumoriPersonRows_ keeps the existing row order and fields unchanged (carrier/plan/call/discount/hosho/other/device/total)', () => {
  const ctx = gas();
  const me = {
    meigi: '本人', carrier: 'au', planName: 'プランA', basePrice: 5000,
    callLabel: '24時間かけ放題', callVal: 1870,
    discountTotal: 1100, hosho: 770, other: 330,
    deviceName: 'iPhone 15', deviceMonthly: 2145, kaisu: 24,
    monthly: 9890
  };
  const rows = plain(ctx.buildMitsumoriPersonRows_(me, '2026/10/16'));
  const labels = rows.map(r => r.label !== undefined ? r.label : '---sep---');
  assert.deepEqual(labels, [
    '最終作成日', '続柄・お名前', '---sep---',
    'キャリア', 'プラン', '通話OP', '割引', '補償', 'その他',
    '端末', '端末/分割24回', '---sep---', '月額合計'
  ]);
  assert.equal(rows[rows.length - 1].bold, true);
});

test('selectDisplayedFamilyMembers_ shows everyone when within the card limit', () => {
  const ctx = gas();
  const family = [{ meigi: 'a' }, { meigi: 'b' }, { meigi: 'c' }];
  const result = plain(ctx.selectDisplayedFamilyMembers_(family, 5));
  assert.equal(result.shown.length, 3);
  assert.equal(result.remainingCount, 0);
});
test('selectDisplayedFamilyMembers_ caps at maxCards and reports how many are left out', () => {
  const ctx = gas();
  const family = Array.from({ length: 8 }, (_, i) => ({ meigi: 'person' + i }));
  const result = plain(ctx.selectDisplayedFamilyMembers_(family, 5));
  assert.equal(result.shown.length, 5);
  assert.equal(result.remainingCount, 3);
  assert.deepEqual(result.shown.map(p => p.meigi), ['person0', 'person1', 'person2', 'person3', 'person4']);
});
test('selectDisplayedFamilyMembers_ handles an empty or missing family array without throwing', () => {
  const ctx = gas();
  assert.deepEqual(plain(ctx.selectDisplayedFamilyMembers_([], 5)), { shown: [], remainingCount: 0 });
  assert.deepEqual(plain(ctx.selectDisplayedFamilyMembers_(undefined, 5)), { shown: [], remainingCount: 0 });
});
test('mypage family cards never exceed the LINE Flex carousel limit of 12 (7 fixed cards + up to 5 family cards)', () => {
  const ctx = gas();
  const FIXED_CARDS = 7;
  const MAX_FAMILY_CARDS = 5;
  for (const familySize of [0, 1, 5, 6, 12, 30]) {
    const family = Array.from({ length: familySize }, (_, i) => ({ meigi: 'p' + i, monthly: 1000 }));
    const picked = ctx.selectDisplayedFamilyMembers_(family, MAX_FAMILY_CARDS);
    const cardCount = FIXED_CARDS + Math.max(1, picked.shown.length); // at least 1 "no estimate yet" card
    assert.ok(cardCount <= 12, `familySize=${familySize} produced ${cardCount} cards`);
  }
});
test('a built family card is valid Flex bubble JSON: correct type, no literal "undefined"/"NaN" text leaking through', () => {
  const ctx = gas();
  // Deliberately sparse person object to exercise every `|| "未記録"` / `me && ...` guard.
  const sparse = { meigi: '長男様' };
  const rows = ctx.buildMitsumoriPersonRows_(sparse, '');
  const bubble = ctx.makeMyPageBubble('#b0894a', '📄', 'ご家族の見積もり', rows,
    { type: 'uri', label: '相談を予約する', uri: 'https://example.invalid/reserve' });
  const json = JSON.stringify(bubble);
  assert.equal(bubble.type, 'bubble');
  assert.equal(bubble.header.type, 'box');
  assert.equal(bubble.body.type, 'box');
  assert.equal(bubble.footer.type, 'box');
  assert.doesNotMatch(json, /\bundefined\b/);
  assert.doesNotMatch(json, /\bNaN\b/);
  assert.ok(JSON.parse(json)); // round-trips cleanly
});

// --- MyPage carousel simplification: some cards temporarily hidden via MYPAGE_CARD_VISIBILITY ---

const CUSTOMER_MASTER_DB_ID = '34cb9755785480df9465d156cd572bd9';
const DIAGNOSIS_DB_ID_VALUE = '333b9755785480acb1a2e46850b5edca';
const MITSUMORI_DB_ID_VALUE = '3490d14e49c445bc963d1378f4a96e12';

function defaultCustomerPageProps(overrides = {}) {
  return Object.assign({
    '氏名': { title: [{ plain_text: 'テスト 太郎' }] },
    'ポイント': { number: 18 },
    '初回登録日': { date: { start: '2026-01-01' } },
    '最終来店日': { date: { start: '2026-10-01' } },
    '対応ステータス': { select: { name: '対応中' } },
    'かかりつけ会員': { checkbox: false },
    '利用キャリア': { rich_text: [{ plain_text: 'docomo' }] },
    'Q2_毎月の支払額': { select: { name: '5000〜7000円' } },
    '買い替え時期': { rich_text: [{ plain_text: '２年以内' }] },
    'Q5_ネット環境': { select: { name: '光回線' } },
    '利用端末': { rich_text: [{ plain_text: 'iPhone 14' }] },
    'スマホカルテ更新日': { date: { start: '2026-09-01' } }
  }, overrides);
}
function mypageContext({ customerProps, mitsumoriResults = [], customerFound = true } = {}) {
  let blocksCalls = 0;
  let pushedPayload = null;
  const customerPage = { id: 'test-page-id', properties: defaultCustomerPageProps(customerProps) };
  const ctx = gas({
    Utilities: { DigestAlgorithm: { MD5: 'md5' }, computeDigest: () => [1, 2, 3, 4, 5, 6] },
    UrlFetchApp: { fetch: (url, opts) => {
      if (url.includes('/databases/' + CUSTOMER_MASTER_DB_ID + '/query')) {
        return response(200, { results: customerFound ? [customerPage] : [] });
      }
      if (url.includes('/databases/' + MITSUMORI_DB_ID_VALUE + '/query')) {
        return response(200, { results: mitsumoriResults, has_more: false });
      }
      if (url.includes('/databases/' + DIAGNOSIS_DB_ID_VALUE + '/query')) {
        return response(200, { results: [] });
      }
      if (url.includes('/blocks/')) {
        blocksCalls++;
        return response(200, { results: [] });
      }
      if (url.includes('/v2/bot/message/reply')) {
        pushedPayload = JSON.parse(opts.payload);
        return response(200, {});
      }
      if (url.includes('/v2/bot/profile/')) {
        return response(200, { displayName: 'テスト太郎' });
      }
      return response(200, {});
    } }
  });
  return { ctx, getPushed: () => pushedPayload, getBlocksCalls: () => blocksCalls };
}
function cardTitles(pushed) {
  const carousel = pushed.messages[1].contents.contents;
  return carousel.map(c => c.header.contents[1].text);
}

test('mypage carousel ships with only "basic info", "diagnosis result", and "family estimate" cards by default', () => {
  const { ctx, getPushed, getBlocksCalls } = mypageContext();
  ctx.replyMyPage('line-user-1', 'reply-token');
  const pushed = getPushed();
  assert.ok(pushed, 'expected a LINE push message');
  const titles = cardTitles(pushed);
  assert.deepEqual(titles, ['基本情報', 'スマホ診断結果', 'ご家族の見積もり']);
  // the hidden cards must not appear at all
  for (const hidden of ['料金シミュレーション', 'スマホカルテ', 'アプリチェック結果', 'まちつながり履歴', 'スマホ遍歴']) {
    assert.ok(!titles.includes(hidden), `"${hidden}" should be hidden`);
  }
  // hiding "town connection" must skip its only dedicated Notion read (the blocks/children call)
  assert.equal(getBlocksCalls(), 0);
});
test('mypage "basic info" card keeps name/status/dates but drops points/next-reward while hidden', () => {
  const { ctx, getPushed } = mypageContext();
  ctx.replyMyPage('line-user-1', 'reply-token');
  const basicInfo = cardTitles(getPushed()).length && getPushed().messages[1].contents.contents[0];
  const rows = basicInfo.body.contents;
  const labels = rows.map(r => r.contents ? r.contents[0].text : '---sep---');
  assert.deepEqual(labels, ['お名前', '会員ステータス', '初回登録日', '最終来店日']);
  assert.ok(!labels.includes('ポイント'));
  assert.ok(!labels.includes('次の特典'));
});
test('mypage carousel shows all cards again when MYPAGE_CARD_VISIBILITY flags are switched on (reversible)', () => {
  const { ctx, getPushed, getBlocksCalls } = mypageContext();
  Object.keys(ctx.MYPAGE_CARD_VISIBILITY).forEach(k => { ctx.MYPAGE_CARD_VISIBILITY[k] = true; });
  ctx.replyMyPage('line-user-1', 'reply-token');
  const titles = cardTitles(getPushed());
  assert.deepEqual(titles, [
    '基本情報', 'スマホ診断結果', '料金シミュレーション', 'スマホカルテ',
    'アプリチェック結果', 'まちつながり履歴', 'スマホ遍歴', 'ご家族の見積もり'
  ]);
  assert.equal(getBlocksCalls(), 1, 'turning town connection back on should resume the blocks/children read');
});
test('mypage still renders cleanly (no throw) for a customer with no diagnosis/estimate data at all', () => {
  const { ctx, getPushed } = mypageContext({
    customerProps: {
      '利用キャリア': { rich_text: [] }, 'Q2_毎月の支払額': { select: null },
      '買い替え時期': { rich_text: [] }, 'Q5_ネット環境': { select: null }, '利用端末': { rich_text: [] }
    },
    mitsumoriResults: []
  });
  assert.doesNotThrow(() => ctx.replyMyPage('line-user-1', 'reply-token'));
  const titles = cardTitles(getPushed());
  assert.deepEqual(titles, ['基本情報', 'スマホ診断結果', 'ご家族の見積もり']);
});
test('mypage flex carousel stays within the LINE 12-bubble limit and is valid JSON even with a multi-person family', () => {
  const family = Array.from({ length: 6 }, (_, i) => ({ meigi: '家族' + i, monthly: 1000 + i }));
  const mitsumoriPage = { properties: {
    '流入経路': { rich_text: [] },
    '作成日': { date: { start: '2026-10-16' } },
    '明細JSON': { rich_text: [{ plain_text: JSON.stringify({ date: '2026-10-16', family }) }] }
  } };
  const { ctx, getPushed } = mypageContext({ mitsumoriResults: [mitsumoriPage] });
  ctx.replyMyPage('line-user-1', 'reply-token');
  const pushed = getPushed();
  const carousel = pushed.messages[1].contents.contents;
  assert.ok(carousel.length <= 12, `carousel has ${carousel.length} cards`);
  assert.ok(carousel.every(c => c.type === 'bubble'));
  const json = JSON.stringify(pushed);
  assert.doesNotMatch(json, /\bundefined\b/);
  assert.ok(JSON.parse(json));
});
test('a customer not found in the customer master still gets a reply without throwing', () => {
  const { ctx } = mypageContext({ customerFound: false });
  assert.doesNotThrow(() => ctx.replyMyPage('line-user-new', 'reply-token'));
});

// --- Diagnosis auto-reply: judge type / one-points / templates ---

test('judgeDiagnosisType_ returns B for a high payer with only light usage selected', () => {
  const ctx = gas();
  assert.equal(ctx.judgeDiagnosisType_({ q2: '5000円 前後', q3: ['4GB以下'] }), 'B');
  assert.equal(ctx.judgeDiagnosisType_({ q2: '8000円 前後', q3: ['検索やLINE中心', '4GB以下'] }), 'B');
});
test('judgeDiagnosisType_ does NOT return B when Q3 is empty, even if Q2 is high (boundary case)', () => {
  const ctx = gas();
  assert.notEqual(ctx.judgeDiagnosisType_({ q1: 'au', q2: '10000円 以上', q3: [] }), 'B');
});
test('judgeDiagnosisType_ does NOT return B when Q3 includes a heavy-usage option', () => {
  const ctx = gas();
  assert.notEqual(ctx.judgeDiagnosisType_({ q2: '5000円 前後', q3: ['4GB以下', '動画をたっぷり'] }), 'B');
});
test('judgeDiagnosisType_ returns A for Q2>=10000, or Q2=8000 with a major carrier', () => {
  const ctx = gas();
  assert.equal(ctx.judgeDiagnosisType_({ q1: '楽天モバイル', q2: '10000円 以上', q3: [] }), 'A');
  assert.equal(ctx.judgeDiagnosisType_({ q1: 'docomo', q2: '8000円 前後', q3: [] }), 'A');
  assert.equal(ctx.judgeDiagnosisType_({ q1: 'au', q2: '8000円 前後', q3: [] }), 'A');
  assert.equal(ctx.judgeDiagnosisType_({ q1: 'SoftBank', q2: '8000円 前後', q3: [] }), 'A');
});
test('judgeDiagnosisType_: Q2=8000 with a non-major carrier does not trigger A', () => {
  const ctx = gas();
  assert.notEqual(ctx.judgeDiagnosisType_({ q1: '楽天モバイル', q2: '8000円 前後', q3: [] }), 'A');
});
test('judgeDiagnosisType_ returns D whenever Q7 includes "family together", ahead of C/E', () => {
  const ctx = gas();
  assert.equal(ctx.judgeDiagnosisType_({ q2: '3000円 以下', q6: '４年以上', q7: ['家族も一緒に'] }), 'D');
  assert.equal(ctx.judgeDiagnosisType_({ q7: ['データ移行', '家族も一緒に'] }), 'D');
});
test('judgeDiagnosisType_ returns C for 4+ years, or 2-4 years with a qualifying Q7 item', () => {
  const ctx = gas();
  assert.equal(ctx.judgeDiagnosisType_({ q6: '４年以上', q7: [] }), 'C');
  assert.equal(ctx.judgeDiagnosisType_({ q6: '２〜４年以内', q7: ['データ移行'] }), 'C');
  assert.equal(ctx.judgeDiagnosisType_({ q6: '２〜４年以内', q7: ['機種代を抑えたい'] }), 'C');
});
test('judgeDiagnosisType_: 2-4 years WITHOUT a qualifying Q7 item does not trigger C', () => {
  const ctx = gas();
  assert.notEqual(ctx.judgeDiagnosisType_({ q6: '２〜４年以内', q7: ['電波の質'] }), 'C');
});
test('judgeDiagnosisType_ returns E for data-migration/LINE-handover/procedure concerns', () => {
  const ctx = gas();
  assert.equal(ctx.judgeDiagnosisType_({ q6: '２年以内', q7: ['LINE引継ぎ'] }), 'E');
  assert.equal(ctx.judgeDiagnosisType_({ q7: ['手続きの手間'] }), 'E');
});
test('judgeDiagnosisType_ falls back to F when nothing else matches', () => {
  const ctx = gas();
  assert.equal(ctx.judgeDiagnosisType_({ q1: 'docomo', q2: '3000円 以下', q3: [], q4: '', q5: '', q6: '２年以内', q7: [] }), 'F');
});
test('judgeDiagnosisType_ evaluates in order: B before A before D before C before E', () => {
  const ctx = gas();
  // Would also match A(Q2>=10000) and E(データ移行), but B's light-usage condition should win since it's checked first.
  assert.equal(ctx.judgeDiagnosisType_({ q1: 'docomo', q2: '10000円 以上', q3: ['4GB以下'], q7: ['データ移行'] }), 'B');
});

test('buildDiagnosisOnePoints_ adds the home-network mismatch tip only for known, mismatched combinations', () => {
  const ctx = gas();
  assert.ok(ctx.buildDiagnosisOnePoints_({ q1: 'docomo', q5: 'auひかり' }).length === 1);
  assert.equal(ctx.buildDiagnosisOnePoints_({ q1: 'docomo', q5: 'ドコモ光/home5G' }).length, 0); // matches, no tip
  assert.equal(ctx.buildDiagnosisOnePoints_({ q1: '楽天モバイル', q5: 'auひかり' }).length, 0); // 楽天 is "確認" -> no tip
  assert.equal(ctx.buildDiagnosisOnePoints_({ q1: 'docomo', q5: 'TOKAIケーブル' }).length, 0); // TOKAI is "確認" -> no tip
});
test('buildDiagnosisOnePoints_ adds the long-call tip and the LINE-call tip under their own conditions', () => {
  const ctx = gas();
  assert.ok(ctx.buildDiagnosisOnePoints_({ q4: '長電話をよくする' })[0].includes('かけ放題'));
  assert.ok(ctx.buildDiagnosisOnePoints_({ q4: 'LINE通話がほとんど', q2: '8000円 前後' })[0].includes('通話オプション'));
  assert.equal(ctx.buildDiagnosisOnePoints_({ q4: 'LINE通話がほとんど', q2: '3000円 以下' }).length, 0); // Q2 too low -> no tip
});
test('buildDiagnosisOnePoints_ stops at a maximum of 2 tips even when more conditions match', () => {
  const ctx = gas();
  const tips = ctx.buildDiagnosisOnePoints_({
    q1: 'docomo', q5: 'auひかり',           // tip a
    q4: '長電話をよくする',                   // tip b
    q7: ['電波の質', '機種代を抑えたい']       // tips d, e
  });
  assert.equal(tips.length, 2);
});

test('buildDiagnosisMessage_ fills {name}/{Q2}/{Q6} and includes up to 2 tips before the closing', () => {
  const ctx = gas();
  const msg = ctx.buildDiagnosisMessage_('太郎', { q2: '8000円 前後', q6: '' }, 'A', ['ワンポイントその1']);
  assert.match(msg, /^太郎さん、スマホ診断へのご回答ありがとうございました。\n内容を拝見しました。/);
  assert.match(msg, /毎月の支払いが8000円 前後とのことで/);
  assert.match(msg, /ワンポイントその1/);
  assert.match(msg, /街のスマホ相談士 櫻井$/);
});

// --- Diagnosis auto-reply: timing (day/night + quiet-hour owner-reply rule) ---

test('computeScheduledSendAtMs_: a 18:59 answer is scheduled 2 hours later', () => {
  const ctx = gas();
  const answeredAtMs = Date.UTC(2026, 9, 19, 18, 59, 0);
  assert.equal(ctx.computeScheduledSendAtMs_(answeredAtMs), answeredAtMs + 2 * 60 * 60 * 1000);
});
test('computeScheduledSendAtMs_: a 19:00 answer is scheduled for 9:00 the next morning', () => {
  const ctx = gas();
  const answeredAtMs = Date.UTC(2026, 9, 19, 19, 0, 0);
  assert.equal(ctx.computeScheduledSendAtMs_(answeredAtMs), Date.UTC(2026, 9, 20, 9, 0, 0));
});
test('computeScheduledSendAtMs_: a 0:30 answer is scheduled for 9:00 that same morning', () => {
  const ctx = gas();
  const answeredAtMs = Date.UTC(2026, 9, 19, 0, 30, 0);
  assert.equal(ctx.computeScheduledSendAtMs_(answeredAtMs), Date.UTC(2026, 9, 19, 9, 0, 0));
});
test('isNightSubmission_ is true for 19:00-23:59 and 0:00-8:59, false for 9:00-18:59', () => {
  const ctx = gas();
  assert.equal(ctx.isNightSubmission_(Date.UTC(2026, 9, 19, 19, 0, 0)), true);
  assert.equal(ctx.isNightSubmission_(Date.UTC(2026, 9, 19, 23, 59, 0)), true);
  assert.equal(ctx.isNightSubmission_(Date.UTC(2026, 9, 19, 0, 0, 0)), true);
  assert.equal(ctx.isNightSubmission_(Date.UTC(2026, 9, 19, 8, 59, 0)), true);
  assert.equal(ctx.isNightSubmission_(Date.UTC(2026, 9, 19, 9, 0, 0)), false);
  assert.equal(ctx.isNightSubmission_(Date.UTC(2026, 9, 19, 18, 59, 0)), false);
});
test('computeEffectiveSendAtMs_: a 20:50 owner reply (even on a night submission) sends immediately', () => {
  const ctx = gas();
  const replyAtMs = Date.UTC(2026, 9, 19, 20, 50, 0);
  assert.equal(ctx.computeEffectiveSendAtMs_(replyAtMs), replyAtMs);
});
test('computeEffectiveSendAtMs_: a 21:10 owner reply is deferred to 9:00 the next morning', () => {
  const ctx = gas();
  const replyAtMs = Date.UTC(2026, 9, 19, 21, 10, 0);
  assert.equal(ctx.computeEffectiveSendAtMs_(replyAtMs), Date.UTC(2026, 9, 20, 9, 0, 0));
});
test('computeEffectiveSendAtMs_: a 0:30 owner reply (quiet hours) is deferred to 9:00 that same morning', () => {
  const ctx = gas();
  const replyAtMs = Date.UTC(2026, 9, 19, 0, 30, 0);
  assert.equal(ctx.computeEffectiveSendAtMs_(replyAtMs), Date.UTC(2026, 9, 19, 9, 0, 0));
});
test('computeEffectiveSendAtMs_: daytime (e.g. 10:00) owner replies are also immediate (rule applies all day, not just at night)', () => {
  const ctx = gas();
  const replyAtMs = Date.UTC(2026, 9, 19, 10, 0, 0);
  assert.equal(ctx.computeEffectiveSendAtMs_(replyAtMs), replyAtMs);
});

// --- Diagnosis auto-reply: owner reply parsing (OK/hold/replace/comment + quote stripping) ---

test('parseOwnerReply_ recognizes "OK" (case-insensitive) on the first line after stripping a Gmail-style quote', () => {
  const ctx = gas();
  const raw = 'OK\n\nOn Mon, Oct 19, 2026 at 3:00 PM Owner <owner@example.com> wrote:\n> original message\n> more quoted text';
  assert.deepEqual(plain(ctx.parseOwnerReply_(raw)), { kind: 'ok', text: '' });
});
test('parseOwnerReply_ recognizes "保留" (hold) after stripping an iPhone/iPad Mail-style quote', () => {
  const ctx = gas();
  const raw = '保留\n\n> 2026/10/19 15:00、【診断】太郎さんのメール:\n> 元の本文';
  assert.deepEqual(plain(ctx.parseOwnerReply_(raw)), { kind: 'hold', text: '' });
});
test('parseOwnerReply_ extracts the replacement text (everything after line 1) for "差し替え"', () => {
  const ctx = gas();
  const raw = '差し替え\nもう少しお得なプランがあります。電話で詳しくお伝えします。\n\n2026年10月19日(月) 15:00 Owner <owner@example.com> のメール:\n> quoted';
  assert.deepEqual(plain(ctx.parseOwnerReply_(raw)), { kind: 'replace', text: 'もう少しお得なプランがあります。電話で詳しくお伝えします。' });
});
test('parseOwnerReply_ treats anything else as a free comment to be inserted (A-pattern)', () => {
  const ctx = gas();
  const raw = '今は忙しいので来週連絡します\n\nOn Mon, Oct 19, 2026 at 3:00 PM Owner <owner@example.com> wrote:\n> quoted';
  assert.deepEqual(plain(ctx.parseOwnerReply_(raw)), { kind: 'comment', text: '今は忙しいので来週連絡します' });
});
test('stripQuotedReply_ strips Outlook-style "-----Original Message-----" and "差出人:" headers too', () => {
  const ctx = gas();
  assert.equal(ctx.stripQuotedReply_('OK\n\n-----Original Message-----\nFrom: owner'), 'OK');
  assert.equal(ctx.stripQuotedReply_('OK\n\n差出人: owner@example.com\n内容...'), 'OK');
});
test('composeFinalDiagnosisMessage_: "ok" sends the base message unchanged', () => {
  const ctx = gas();
  const base = ctx.buildDiagnosisMessage_('太郎', { q2: '', q6: '' }, 'F', []);
  assert.equal(ctx.composeFinalDiagnosisMessage_(base, { kind: 'ok', text: '' }), base);
});
test('composeFinalDiagnosisMessage_: "hold" sends nothing (null)', () => {
  const ctx = gas();
  const base = ctx.buildDiagnosisMessage_('太郎', { q2: '', q6: '' }, 'F', []);
  assert.equal(ctx.composeFinalDiagnosisMessage_(base, { kind: 'hold', text: '' }), null);
});
test('composeFinalDiagnosisMessage_: "replace" sends only the owner\'s text, not the template', () => {
  const ctx = gas();
  const base = ctx.buildDiagnosisMessage_('太郎', { q2: '', q6: '' }, 'F', []);
  const final = ctx.composeFinalDiagnosisMessage_(base, { kind: 'replace', text: '別の内容でご案内します' });
  assert.equal(final, '別の内容でご案内します');
});
test('composeFinalDiagnosisMessage_: "comment" is inserted right after the common greeting (A-pattern)', () => {
  const ctx = gas();
  const base = ctx.buildDiagnosisMessage_('太郎', { q2: '', q6: '' }, 'F', []);
  const final = ctx.composeFinalDiagnosisMessage_(base, { kind: 'comment', text: '来週改めてご連絡します' });
  assert.ok(final.startsWith('太郎さん、スマホ診断へのご回答ありがとうございました。\n内容を拝見しました。\n\n来週改めてご連絡します\n\n'));
  assert.ok(final.includes('今の契約はおおむね良好')); // F's body text still follows
});

// --- Diagnosis auto-reply: email subject/body field completeness ---

test('buildDiagnosisEmailSubject_ uses the normal format when LINE is resolved, and the unreachable format when not', () => {
  const ctx = gas();
  const normal = ctx.buildDiagnosisEmailSubject_('太郎', 'A判定', Date.UTC(2026, 9, 19, 14, 0, 0), 'AB12CD34', false, '09000000000');
  assert.match(normal, /^【診断】太郎さん\|A判定\|自動送信 10\/19 14:00\|#AB12CD34$/);
  const unresolved = ctx.buildDiagnosisEmailSubject_('太郎', 'A判定', Date.UTC(2026, 9, 19, 14, 0, 0), 'AB12CD34', true, '09000000000');
  assert.match(unresolved, /^【要連絡・LINE送信不可】【診断】太郎さん\|電話 09000000000\|#AB12CD34$/);
});
test('buildDiagnosisEmailBody_ includes every field that the old "【新着】" owner email had', () => {
  const ctx = gas();
  const body = ctx.buildDiagnosisEmailBody_({
    name: '太郎', tel: '09000000000', source: 'insta',
    answers: { q1: 'docomo', q2: '8000円 前後', q3: ['4GB以下'], q4: '長電話をよくする', q5: 'ドコモ光/home5G', q6: '２年以内', q7: ['電波の質'] },
    detail: '相談したいことがあります', receivedAtIso: '2026-10-19T14:00:00+09:00',
    customerLinked: true, typeLabel: 'A判定', message: '(本文)',
    scheduledAtMs: Date.UTC(2026, 9, 19, 16, 0, 0), lineUnresolved: false
  });
  for (const must of ['太郎', '09000000000', 'insta', 'docomo', '8000円 前後', '相談したいことがあります',
                       '2026-10-19T14:00:00+09:00', '完了', 'A判定', '(本文)']) {
    assert.ok(body.includes(must), `email body missing: ${must}`);
  }
  assert.match(body, /OK/);
  assert.match(body, /保留/);
  assert.match(body, /差し替え/);
});
test('buildDiagnosisEmailBody_ shows "LINE送信不可" scheduling note when the LINE id is unresolved', () => {
  const ctx = gas();
  const body = ctx.buildDiagnosisEmailBody_({
    name: '太郎', tel: '', source: '', answers: {}, detail: '', receivedAtIso: '2026-10-19T14:00:00+09:00',
    customerLinked: false, typeLabel: 'F判定', message: '(本文)', scheduledAtMs: 0, lineUnresolved: true
  });
  assert.match(body, /LINE送信不可のため自動送信なし/);
  assert.match(body, /電話番号なし\(スキップ\)/);
});

// --- Diagnosis auto-reply: reception ID, sheet storage, LINE id resolution, double-send prevention ---

function fakeDiagSheetFactory() {
  const sheetsByName = {};
  function makeSheet() {
    const rows = [];
    return {
      appendRow(row) { rows.push(row.slice()); },
      getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
      getRange(r, c) {
        return { getValue: () => rows[r - 1][c - 1], setValue(v) { rows[r - 1][c - 1] = v; } };
      },
      _rows: rows
    };
  }
  const SpreadsheetApp = { openById: () => ({
    getSheetByName: name => sheetsByName[name],
    insertSheet: name => { const s = makeSheet(); sheetsByName[name] = s; return s; }
  }) };
  return { SpreadsheetApp, sheetsByName };
}
const fakeLockService = { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) };
function fakeGmailMsg(from, plainBody, realDateMs) {
  return { getFrom: () => from, getPlainBody: () => plainBody, getDate: () => new Date(realDateMs) };
}
// JSTの壁時計(y,m,d,h,mi)を表す「本物の」UTCミリ秒（findOwnerReplyInThread_が+9hする前提の入力用）
function jstWallClockToRealMs(y, m, d, h, mi) {
  return Date.UTC(y, m - 1, d, h, mi, 0) - 9 * 60 * 60 * 1000;
}

function diagContext(overrides = {}) {
  const { SpreadsheetApp, sheetsByName } = fakeDiagSheetFactory();
  const pushedMessages = [];
  const sentEmails = [];
  const notionResults = overrides.notionCustomerResults !== undefined ? overrides.notionCustomerResults : [];
  const gmailThreads = overrides.gmailThreads || {};
  let threadSeq = 0;

  const ctx = gas({
    Utilities: { getUuid: () => overrides.uuid || ('11111111-2222-3333-4444-' + String(Math.random()).slice(2, 14)) },
    SpreadsheetApp: SpreadsheetApp,
    LockService: fakeLockService,
    UrlFetchApp: { fetch: (url, opts) => {
      if (url.includes('/v2/bot/message/push')) { pushedMessages.push(JSON.parse(opts.payload)); return response(200, {}); }
      if (url.includes('/databases/' + CUSTOMER_MASTER_DB_ID + '/query')) return response(200, { results: notionResults });
      return response(200, {});
    } },
    GmailApp: {
      sendEmail: (to, subject, body) => { sentEmails.push({ to, subject, body }); },
      search: () => { threadSeq++; return [{ getId: () => 'thread-' + threadSeq }]; },
      getThreadById: id => gmailThreads[id] || null
    }
  });
  return { ctx, pushedMessages, sentEmails, sheetsByName };
}

test('generateReceptionId_ returns a short uppercase alphanumeric id', () => {
  const { ctx } = diagContext({ uuid: 'abcdef12-aaaa-bbbb-cccc-000000000000' });
  assert.equal(ctx.generateReceptionId_(), 'ABCDEF12');
});

test('handleDiagnosisAutoReply_ resolves the LINE id from the form itself (priority 1) and sends the daytime acceptance message', () => {
  const { ctx, pushedMessages, sentEmails, sheetsByName } = diagContext();
  const jstNow = new Date(Date.UTC(2026, 9, 19, 10, 0, 0));
  const receptionId = ctx.handleDiagnosisAutoReply_(
    { name: '太郎', tel: '09000000000', lineUserId: 'line-user-1', q1: 'docomo', q2: '10000円 以上', q3: [] },
    { customerMasterPageId: 'cust-1', cleanSource: 'insta', jstNow: jstNow, jstISO: '2026-10-19T10:00:00+09:00', todayStr: '2026-10-19' }
  );
  assert.ok(receptionId);
  assert.equal(pushedMessages.length, 1);
  assert.equal(pushedMessages[0].to, 'line-user-1');
  assert.match(pushedMessages[0].messages[0].text, /少しだけお待ちください/);
  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].subject, /^【診断】太郎さん\|/);
  const row = sheetsByName['診断自動返信']._rows[1];
  assert.equal(row[0], receptionId);
  assert.equal(row[6], 'line-user-1'); // lineUserId column
});

test('handleDiagnosisAutoReply_ sends the night-time acceptance wording for 19:00+ answers', () => {
  const { ctx, pushedMessages } = diagContext();
  const jstNow = new Date(Date.UTC(2026, 9, 19, 20, 0, 0));
  ctx.handleDiagnosisAutoReply_(
    { name: '花子', tel: '09000000001', lineUserId: 'line-user-2', q2: '3000円 以下', q3: [] },
    { customerMasterPageId: null, cleanSource: '', jstNow: jstNow, jstISO: '2026-10-19T20:00:00+09:00', todayStr: '2026-10-19' }
  );
  assert.match(pushedMessages[0].messages[0].text, /明日の午前中にお送りします/);
});

test('handleDiagnosisAutoReply_ no longer falls back to a phone lookup: a mistyped (or someone else\'s) phone number never resolves a send destination', () => {
  // セキュリティ強化(2026-10-22): 電話番号でのLINE宛先フォールバックは廃止。
  // 他人の電話番号(または打ち間違い)が、たまたま既存顧客と一致しても、その人のLINEには送らない。
  const { ctx, pushedMessages, sentEmails } = diagContext({
    notionCustomerResults: [{ properties: {
      '電話番号': { rich_text: [{ plain_text: '09000000002' }] },
      'LINE_userid': { rich_text: [{ plain_text: 'line-user-someone-else' }] }
    } }]
  });
  const jstNow = new Date(Date.UTC(2026, 9, 19, 10, 0, 0));
  ctx.handleDiagnosisAutoReply_(
    { name: '次郎', tel: '09000000002', lineUserId: '', q2: '3000円 以下', q3: [] },
    { customerMasterPageId: null, cleanSource: '', jstNow: jstNow, jstISO: '', todayStr: '2026-10-19' }
  );
  assert.equal(pushedMessages.length, 0, 'must never push to a LINE id resolved from a phone number');
  assert.match(sentEmails[0].subject, /^【要連絡・LINE送信不可】/);
});

test('handleDiagnosisAutoReply_: when LINE cannot be resolved at all, no acceptance push is sent and the email subject flags it', () => {
  const { ctx, pushedMessages, sentEmails } = diagContext({ notionCustomerResults: [] });
  const jstNow = new Date(Date.UTC(2026, 9, 19, 10, 0, 0));
  ctx.handleDiagnosisAutoReply_(
    { name: '三郎', tel: '09000000003', lineUserId: '', q2: '3000円 以下', q3: [] },
    { customerMasterPageId: null, cleanSource: '', jstNow: jstNow, jstISO: '', todayStr: '2026-10-19' }
  );
  assert.equal(pushedMessages.length, 0);
  assert.match(sentEmails[0].subject, /^【要連絡・LINE送信不可】/);
});

test('linkReceptionIdToLineUser_ fills in the lineUserId column for an existing pending row (priority 2)', () => {
  const { ctx, sheetsByName } = diagContext();
  const jstNow = new Date(Date.UTC(2026, 9, 19, 10, 0, 0));
  const receptionId = ctx.handleDiagnosisAutoReply_(
    { name: '四郎', tel: '', lineUserId: '', q2: '3000円 以下', q3: [] },
    { customerMasterPageId: null, cleanSource: '', jstNow: jstNow, jstISO: '', todayStr: '2026-10-19' }
  );
  const ok = ctx.linkReceptionIdToLineUser_(receptionId, 'line-user-later');
  assert.equal(ok, true);
  const row = sheetsByName['診断自動返信']._rows[1];
  assert.equal(row[6], 'line-user-later');
});

test('processOnePendingDiagnosisRow_ sends the base message as-is once the scheduled time has passed with no owner reply', () => {
  const { ctx, pushedMessages, sheetsByName } = diagContext();
  const sheet = ctx.getDiagReplySheet_();
  sheet.appendRow(['R1', '2026-10-19T10:00:00.000Z', new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString(), '待機', '太郎', '09000000000', 'line-user-1', 'F', '(送信予定の文面)', '', '', '']);
  const row = { receptionId: 'R1', scheduledAtIso: new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString(), lineUserId: 'line-user-1', tel: '09000000000', message: '(送信予定の文面)', emailThreadId: '' };
  ctx.processOnePendingDiagnosisRow_(row, Date.UTC(2026, 9, 19, 12, 0, 0), 'owner@example.com');
  assert.equal(pushedMessages.length, 1);
  assert.equal(pushedMessages[0].messages[0].text, '(送信予定の文面)');
  assert.equal(sheet._rows[1][3], '送信済み'); // 状態
});
test('processOnePendingDiagnosisRow_ does nothing before the scheduled time with no owner reply (no double trigger risk)', () => {
  const { ctx, pushedMessages } = diagContext();
  const sheet = ctx.getDiagReplySheet_();
  const scheduledIso = new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString();
  sheet.appendRow(['R2', '2026-10-19T10:00:00.000Z', scheduledIso, '待機', '太郎', '09000000000', 'line-user-1', 'F', '(文面)', '', '', '']);
  const row = { receptionId: 'R2', scheduledAtIso: scheduledIso, lineUserId: 'line-user-1', tel: '09000000000', message: '(文面)', emailThreadId: '' };
  ctx.processOnePendingDiagnosisRow_(row, Date.UTC(2026, 9, 19, 11, 0, 0), 'owner@example.com');
  assert.equal(pushedMessages.length, 0);
  assert.equal(sheet._rows[1][3], '待機');
});
test('processOnePendingDiagnosisRow_ never sends twice: a row already marked 送信済み is skipped on a later tick', () => {
  const { ctx, pushedMessages } = diagContext();
  const sheet = ctx.getDiagReplySheet_();
  const scheduledIso = new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString();
  sheet.appendRow(['R3', '2026-10-19T10:00:00.000Z', scheduledIso, '送信済み', '太郎', '09000000000', 'line-user-1', 'F', '(文面)', '', scheduledIso, '']);
  const row = { receptionId: 'R3', scheduledAtIso: scheduledIso, lineUserId: 'line-user-1', tel: '09000000000', message: '(文面)', emailThreadId: '' };
  ctx.processOnePendingDiagnosisRow_(row, Date.UTC(2026, 9, 19, 13, 0, 0), 'owner@example.com');
  assert.equal(pushedMessages.length, 0, 'must not resend a row that is no longer 待機');
});
test('processOnePendingDiagnosisRow_: an "OK" owner reply during the day sends immediately, even before the original scheduled time', () => {
  const { ctx, pushedMessages } = diagContext({
    gmailThreads: { 't1': { getMessages: () => [
      fakeGmailMsg('owner@example.com', '(original send, not counted)', jstWallClockToRealMs(2026, 10, 19, 10, 0)),
      fakeGmailMsg('Owner Name <owner@example.com>', 'OK\n\nOn ... wrote:\n> quoted', jstWallClockToRealMs(2026, 10, 19, 10, 30))
    ] } }
  });
  const sheet = ctx.getDiagReplySheet_();
  const scheduledIso = new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString();
  sheet.appendRow(['R4', '2026-10-19T10:00:00.000Z', scheduledIso, '待機', '太郎', '09000000000', 'line-user-1', 'F', '(案の文面)', 't1', '', '']);
  const row = { receptionId: 'R4', scheduledAtIso: scheduledIso, lineUserId: 'line-user-1', tel: '09000000000', message: '(案の文面)', emailThreadId: 't1' };
  ctx.processOnePendingDiagnosisRow_(row, Date.UTC(2026, 9, 19, 10, 35, 0), 'owner@example.com'); // well before the 12:00 scheduled time
  assert.equal(pushedMessages.length, 1);
  assert.equal(pushedMessages[0].messages[0].text, '(案の文面)');
});
test('processOnePendingDiagnosisRow_: a reply from someone other than the owner is ignored', () => {
  const { ctx, pushedMessages } = diagContext({
    gmailThreads: { 't2': { getMessages: () => [
      fakeGmailMsg('owner@example.com', '(original send)', jstWallClockToRealMs(2026, 10, 19, 10, 0)),
      fakeGmailMsg('stranger@example.com', 'OK', jstWallClockToRealMs(2026, 10, 19, 10, 30))
    ] } }
  });
  const sheet = ctx.getDiagReplySheet_();
  const scheduledIso = new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString();
  sheet.appendRow(['R5', '2026-10-19T10:00:00.000Z', scheduledIso, '待機', '太郎', '09000000000', 'line-user-1', 'F', '(文面)', 't2', '', '']);
  const row = { receptionId: 'R5', scheduledAtIso: scheduledIso, lineUserId: 'line-user-1', tel: '09000000000', message: '(文面)', emailThreadId: 't2' };
  ctx.processOnePendingDiagnosisRow_(row, Date.UTC(2026, 9, 19, 10, 35, 0), 'owner@example.com');
  assert.equal(pushedMessages.length, 0, 'a non-owner reply must not trigger a send');
  assert.equal(sheet._rows[1][3], '待機'); // still waiting for the scheduled time
});
test('processOnePendingDiagnosisRow_: a "保留" owner reply marks the row held and stops future auto-sends', () => {
  const { ctx, pushedMessages } = diagContext({
    gmailThreads: { 't3': { getMessages: () => [
      fakeGmailMsg('owner@example.com', '(original send)', jstWallClockToRealMs(2026, 10, 19, 10, 0)),
      fakeGmailMsg('owner@example.com', '保留', jstWallClockToRealMs(2026, 10, 19, 10, 30))
    ] } }
  });
  const sheet = ctx.getDiagReplySheet_();
  const scheduledIso = new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString();
  sheet.appendRow(['R6', '2026-10-19T10:00:00.000Z', scheduledIso, '待機', '太郎', '09000000000', 'line-user-1', 'F', '(文面)', 't3', '', '']);
  const row = { receptionId: 'R6', scheduledAtIso: scheduledIso, lineUserId: 'line-user-1', tel: '09000000000', message: '(文面)', emailThreadId: 't3' };
  ctx.processOnePendingDiagnosisRow_(row, Date.UTC(2026, 9, 19, 10, 35, 0), 'owner@example.com');
  assert.equal(pushedMessages.length, 0);
  assert.equal(sheet._rows[1][3], '保留');
  // a later tick must not revive it, since it is no longer 待機
  ctx.processOnePendingDiagnosisRow_(row, Date.UTC(2026, 9, 19, 13, 0, 0), 'owner@example.com');
  assert.equal(pushedMessages.length, 0);
});
test('processOnePendingDiagnosisRow_: no LINE id resolvable at send time marks the row 送信不可 and does not push', () => {
  const { ctx, pushedMessages } = diagContext({ notionCustomerResults: [] });
  const sheet = ctx.getDiagReplySheet_();
  const scheduledIso = new Date(Date.UTC(2026, 9, 19, 12, 0, 0)).toISOString();
  sheet.appendRow(['R7', '2026-10-19T10:00:00.000Z', scheduledIso, '待機', '太郎', '09000000099', '', 'F', '(文面)', '', '', '']);
  const row = { receptionId: 'R7', scheduledAtIso: scheduledIso, lineUserId: '', tel: '09000000099', message: '(文面)', emailThreadId: '' };
  ctx.processOnePendingDiagnosisRow_(row, Date.UTC(2026, 9, 19, 12, 0, 0), 'owner@example.com');
  assert.equal(pushedMessages.length, 0);
  assert.equal(sheet._rows[1][3], '送信不可');
});
test('processPendingDiagnosisReplies does nothing and does not throw when OWNER_EMAIL is not set', () => {
  const ctx = gas({ PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) } });
  assert.doesNotThrow(() => ctx.processPendingDiagnosisReplies());
});

// --- handleWebForm diagnosis path: receptionId in the response, 【新着】replaced only for diagnosis ---

test('handleWebForm (diagnosis) returns a receptionId and does not throw', () => {
  const { ctx } = diagContext();
  ctx.isTokenValid_ = () => ({ ok: true });
  ctx.isRateLimited = () => false;
  ctx.validatePayload_ = () => ({ ok: true });
  ctx.upsertCustomerMaster = () => 'fake-customer';
  const result = JSON.parse(ctx.handleWebForm({
    token: 'fake', name: '太郎', tel: '09000000000', lineUserId: 'line-user-1',
    q1: 'docomo', q2: '10000円 以上', q3: []
  }).text);
  assert.equal(result.status, 'success');
  assert.equal(result.confirmed, true);
  assert.ok(result.receptionId);
});
test('handleWebForm (reservation) is unaffected: no receptionId, still gets the generic 【新着】-style owner email', () => {
  const { ctx, sentEmails } = diagContext();
  ctx.isTokenValid_ = () => ({ ok: true });
  ctx.isRateLimited = () => false;
  ctx.validatePayload_ = () => ({ ok: true });
  ctx.upsertCustomerMaster = () => 'fake-customer';
  ctx.CalendarApp = { getDefaultCalendar: () => ({ createEvent() {} }) };
  ctx.Session = { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }) };
  ctx.MailApp = { sendEmail: (to, subject, body) => { sentEmails.push({ to, subject, body, viaMailApp: true }); } };
  ctx.CacheService = { getScriptCache: () => ({ get: () => null, put: () => {} }) };
  const result = JSON.parse(ctx.handleWebForm({
    token: 'fake', name: '太郎', tel: '09000000000', date: '2026-10-20', time: '10:00'
  }).text);
  assert.equal(result.status, 'success');
  assert.equal(result.receptionId, undefined);
  assert.ok(sentEmails.some(e => e.viaMailApp && e.subject.startsWith('【新着】')));
});

// --- handleLineEvent: "カルテ診断完了 #受付ID" links without disturbing the existing exact-match behavior ---

test('"カルテ診断完了 #ID" links the reception row\'s lineUserId, then still shows mypage like the plain keyword does', () => {
  const { ctx, sheetsByName } = diagContext();
  const jstNow = new Date(Date.UTC(2026, 9, 19, 10, 0, 0));
  const receptionId = ctx.handleDiagnosisAutoReply_(
    { name: '五郎', tel: '', lineUserId: '', q2: '3000円 以下', q3: [] },
    { customerMasterPageId: null, cleanSource: '', jstNow: jstNow, jstISO: '', todayStr: '2026-10-19' }
  );
  let myPageCalls = 0;
  ctx.replyMyPage = () => { myPageCalls++; };
  ctx.UrlFetchApp = { fetch: (url) => {
    if (url.includes('/databases/' + CUSTOMER_MASTER_DB_ID + '/query')) return response(200, { results: [{ id: 'p1' }], has_more: false });
    return response(200, {});
  } };
  ctx.handleLineEvent({ type: 'message', message: { type: 'text', text: 'カルテ診断完了 #' + receptionId }, source: { userId: 'line-user-resolved' }, replyToken: 'rt' });
  const row = sheetsByName['診断自動返信']._rows[1];
  assert.equal(row[6], 'line-user-resolved');
  assert.equal(myPageCalls, 1, 'must still behave like the existing カルテ診断完了 flow (show mypage)');
});

// --- Public map/chiiki/oshirase APIs must never read the diagnosis reply sheet ---

test('getMapData/getChiikiData/getOshiraseData never reference the diagnosis-reply sheet name', () => {
  const fnSources = ['getMapData', 'getChiikiData', 'getOshiraseData'].map(name => {
    const start = main.indexOf('function ' + name + '(');
    const end = main.indexOf('\nfunction ', start + 1);
    return main.slice(start, end === -1 ? start + 3000 : end);
  });
  for (const src of fnSources) {
    assert.doesNotMatch(src, /診断自動返信/);
  }
});
test('no public doGet action branch reads the diagnosis-reply sheet', () => {
  const start = main.indexOf('function doGet(e) {');
  const end = main.indexOf('\nfunction ', start + 1);
  const doGetSrc = main.slice(start, end);
  assert.doesNotMatch(doGetSrc, /診断自動返信/);
});
