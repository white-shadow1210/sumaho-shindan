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
const reserve = read('reserve.html');
const quiet = { log() {}, warn() {}, error() {} };
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
    for (const [, script] of read(name).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script, { filename: name });
  }
  for (const name of fs.readdirSync(path.join(root, 'gas'))) new vm.Script(read('gas/'+name), { filename: name });
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
