'use strict';

/* ============================================================
   오라홀릭 회계 정산 — 자동 테스트 (jsdom)
   실행: node test.js   (accounting/tests 폴더에서)
   ============================================================ */

const fs = require('fs');
const path = require('path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) { ({ JSDOM } = require(path.join(__dirname, '..', '..', 'tests', 'node_modules', 'jsdom'))); }

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const STYLES = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const MANIFEST = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

let passed = 0;
const failures = [];
const results = [];

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '값이 다릅니다') + ' — 기대: ' + JSON.stringify(expected) + ' / 실제: ' + JSON.stringify(actual));
  }
}
function near(actual, expected, tol, msg) {
  if (Math.abs(Number(actual) - Number(expected)) > (tol == null ? 0.01 : tol)) {
    throw new Error((msg || '값이 다릅니다') + ' — 기대: ' + expected + ' ±' + (tol == null ? 0.01 : tol) + ' / 실제: ' + actual);
  }
}
function includes(hay, needle, msg) {
  if (String(hay).indexOf(needle) < 0) {
    throw new Error((msg || '문구를 찾지 못했습니다') + ' — 찾는 값: "' + needle + '" / 실제: "' + String(hay).slice(0, 400) + '"');
  }
}
function notIncludes(hay, needle, msg) {
  if (String(hay).indexOf(needle) >= 0) throw new Error((msg || '있으면 안 되는 값이 있습니다') + ' — "' + needle + '"');
}

const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { passed++; results.push({ name, ok: true }); console.log('  ✅ ' + name); })
        .catch((e) => { failures.push({ name, error: e.message }); results.push({ name, ok: false }); console.log('  ❌ ' + name + '\n       → ' + e.message); }));
      return;
    }
    passed++; results.push({ name, ok: true }); console.log('  ✅ ' + name);
  } catch (e) {
    failures.push({ name, error: e.message }); results.push({ name, ok: false });
    console.log('  ❌ ' + name + '\n       → ' + e.message);
  }
}

/* ---------- DOM 하네스 ---------- */
function makeDom(preload, opts) {
  const o = opts || {};
  const html = INDEX.replace(/<script src="\.\/app\.js"><\/script>/, '');
  const dom = new JSDOM(html, { url: 'https://oraholic.github.io/accounting/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const d = w.document;
  w.__AC_TEST__ = true;
  w.scrollTo = function () {};
  w.HTMLElement.prototype.scrollIntoView = function () {};
  if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  d.execCommand = () => true;
  if (preload) w.localStorage.setItem('oraholic-accounting-v1', typeof preload === 'string' ? preload : JSON.stringify(preload));
  if (o.bookingData) w.localStorage.setItem('oraholic-guesthouse-v1', o.bookingData);
  if (o.preAuth) {
    const store = o.preAuthStore === 'session' ? w.sessionStorage : w.localStorage;
    store.setItem('oraholic-accounting-auth-v1', o.preAuth);
  }
  w.eval(APP);
  if (!o.locked) w.__AC.attemptUnlock(o.pin || '0000', o.remember !== false);
  return { dom, w, d, $: (s) => d.querySelector(s), $$: (s) => Array.from(d.querySelectorAll(s)) };
}

function fire(w, el, type) {
  assert(el, '이벤트를 보낼 요소가 없습니다: ' + type);
  el.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }));
}
function click(w, el) {
  assert(el, '클릭할 요소가 없습니다');
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function setVal(w, el, v, type) {
  assert(el, '입력 요소가 없습니다');
  el.value = v;
  if (type) fire(w, el, type);
}

/* 공통 컨텍스트: 이미 로그인된 기기 */
const ctx = makeDom();
const AC = ctx.w.__AC;
const TODAY = AC.todayStr();
const THIS_MONTH = AC.monthKey(TODAY);
const TODAY_MONTH = THIS_MONTH;
const dom = ctx.dom;

console.log('\n💰 오라홀릭 회계 정산 앱 — 자동 테스트\n');
console.log('기준일: ' + TODAY + ' · 이번 달: ' + THIS_MONTH + '\n');

/* ============================================================
   1. 잠금 화면
   ============================================================ */
console.log('[1] 접속 비밀번호 잠금');

test('처음 여는 기기는 잠금 화면부터 보여 준다', () => {
  const L = makeDom(null, { locked: true });
  eq(L.w.__AC.locked, true, '잠겨 있어야 합니다');
  assert(L.$('#lockScreen') && !L.$('#lockScreen').classList.contains('hidden'), '잠금 화면이 보여야 합니다');
  assert(L.$('#app-shell').classList.contains('hidden'), '앱 화면은 숨겨져야 합니다');
  includes(L.$('#lockScreen').textContent, '관리자 로그인');
  includes(L.$('#lockScreen').textContent, '접속 비밀번호');
  L.dom.window.close();
});

test('잠겨 있는 동안 지출·수입 금액이 DOM에 그려지지 않는다', () => {
  const L = makeDom({
    settings: { rate: 24.5 },
    entries: [
      { id: 'a1', type: 'expense', date: TODAY, region: 'PH', currency: 'PHP', amount: 518273, category: '월세', house: 'A' },
      { id: 'a2', type: 'income', date: TODAY, region: 'PH', currency: 'PHP', amount: 913744, category: '숙박 수입 - 개별', house: 'ALL' }
    ]
  }, { locked: true });
  const text = L.d.body.textContent;
  notIncludes(text, '518,273', '잠금 중 금액이 보이면 안 됩니다');
  notIncludes(text, '913,744', '잠금 중 금액이 보이면 안 됩니다');
  notIncludes(text, '월세', '잠금 중 항목명이 보이면 안 됩니다');
  eq(L.$('#viewDashboard').innerHTML.trim(), '', '잠금 중에는 대시보드가 비어 있어야 합니다');
  eq(L.$('#viewSettings').innerHTML.trim(), '', '잠금 중에는 설정 화면도 비어 있어야 합니다');
  L.dom.window.close();
});

test('틀린 비밀번호는 거부된다', () => {
  const L = makeDom(null, { locked: true });
  setVal(L.w, L.$('#lockPin'), '9999');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__AC.locked, true, '잠긴 채로 남아야 합니다');
  includes(L.$('#lockError').textContent, '맞지 않습니다');
  eq(L.$('#lockPin').value, '', '입력칸을 비웁니다');
  L.dom.window.close();
});

test('기본 비밀번호 0000으로 열린다', () => {
  const L = makeDom(null, { locked: true });
  setVal(L.w, L.$('#lockPin'), '0000');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__AC.locked, false, '열려야 합니다');
  assert(!L.$('#app-shell').classList.contains('hidden'), '앱 화면이 보여야 합니다');
  includes(L.$('#viewDashboard').textContent, '현재 보유 잔액');
  L.dom.window.close();
});

test('이 기기에서 로그인 유지 → localStorage에 기록', () => {
  const L = makeDom(null, { locked: true });
  setVal(L.w, L.$('#lockPin'), '0000');
  L.$('#lockKeep').checked = true;
  fire(L.w, L.$('#lockForm'), 'submit');
  assert(L.w.localStorage.getItem('oraholic-accounting-auth-v1'), 'localStorage 로그인 기록이 있어야 합니다');
  eq(L.w.sessionStorage.getItem('oraholic-accounting-auth-v1'), null, '세션 저장소에는 남기지 않습니다');
  L.dom.window.close();
});

test('로그인 유지 해제 → sessionStorage에만 기록', () => {
  const L = makeDom(null, { locked: true });
  setVal(L.w, L.$('#lockPin'), '0000');
  L.$('#lockKeep').checked = false;
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__AC.locked, false);
  assert(L.w.sessionStorage.getItem('oraholic-accounting-auth-v1'), '세션 저장소 기록이 있어야 합니다');
  eq(L.w.localStorage.getItem('oraholic-accounting-auth-v1'), null, 'localStorage에는 남기지 않습니다');
  L.dom.window.close();
});

test('저장된 로그인 기록이 있으면 다시 열 때 잠금 화면을 건너뛴다', () => {
  const rec = JSON.stringify({ pinHash: ctx.w.__AC.hashPin('0000'), at: Date.now() });
  const L = makeDom(null, { locked: true, preAuth: rec });
  eq(L.w.__AC.locked, false, '로그인 기록으로 바로 열려야 합니다');
  L.dom.window.close();
});

test('🔒 버튼을 누르면 즉시 잠기고 화면이 비워진다', () => {
  const L = makeDom(null, {});
  eq(L.w.__AC.locked, false);
  click(L.w, L.$('#lockBtn'));
  eq(L.w.__AC.locked, true, '잠겨야 합니다');
  assert(!L.$('#lockScreen').classList.contains('hidden'), '잠금 화면이 보여야 합니다');
  eq(L.$('#viewDashboard').innerHTML.trim(), '', '재무 화면을 비웁니다');
  eq(L.w.localStorage.getItem('oraholic-accounting-auth-v1'), null, '로그인 기록을 지웁니다');
  L.dom.window.close();
});

test('비밀번호 변경 — 지금 비밀번호가 틀리면 거부', () => {
  const L = makeDom(null, {});
  eq(L.w.__AC.changePin('1234', '2580', '2580'), false);
  eq(L.w.__AC.isDefaultPin(), true, '바뀌지 않아야 합니다');
  L.dom.window.close();
});

test('비밀번호 변경 — 4자 미만·확인 불일치는 거부', () => {
  const L = makeDom(null, {});
  eq(L.w.__AC.changePin('0000', '12', '12'), false, '짧은 비밀번호 거부');
  eq(L.w.__AC.changePin('0000', '2580', '2581'), false, '확인 불일치 거부');
  eq(L.w.__AC.isDefaultPin(), true);
  L.dom.window.close();
});

test('비밀번호 변경 — 성공하면 새 비밀번호만 통한다', () => {
  const L = makeDom(null, {});
  eq(L.w.__AC.changePin('0000', '2580', '2580'), true, '변경 성공해야 합니다');
  eq(L.w.__AC.isDefaultPin(), false, '기본 비밀번호가 아니게 됩니다');
  assert(L.w.__AC.state.settings.pinUpdatedAt > 0, '바꾼 시각을 남깁니다');
  L.w.__AC.lockNow({ silent: true });
  setVal(L.w, L.$('#lockPin'), '0000');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__AC.locked, true, '옛 비밀번호로는 안 열립니다');
  setVal(L.w, L.$('#lockPin'), '2580');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__AC.locked, false, '새 비밀번호로 열립니다');
  L.dom.window.close();
});

test('비밀번호는 해시로만 저장된다', () => {
  const L = makeDom(null, {});
  L.w.__AC.changePin('0000', '7412', '7412');
  const raw = L.w.localStorage.getItem('oraholic-accounting-v1');
  notIncludes(raw, '7412', '비밀번호 원문이 저장되면 안 됩니다');
  includes(raw, 'pinHash');
  L.dom.window.close();
});

test('예약 앱과 저장 키가 완전히 분리되어 있다', () => {
  const booking = JSON.stringify({ bookings: [{ id: 'b1', guest: '김민수' }], security: { pinHash: 'bookinghash' } });
  const L = makeDom(null, { locked: true, bookingData: booking });
  setVal(L.w, L.$('#lockPin'), '0000');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__AC.locked, false);
  eq(L.w.localStorage.getItem('oraholic-guesthouse-v1'), booking, '예약 앱 데이터는 그대로여야 합니다');
  L.w.__AC.addEntry({ type: 'expense', date: THIS_MONTH + '-07', region: 'PH', currency: 'PHP', amount: 700, category: '수도세' });
  includes(L.w.localStorage.getItem('oraholic-accounting-v1'), 'entries', '회계 데이터는 자기 키에 저장합니다');
  eq(L.w.__AC.state.entries.length, 1, '예약 앱 예약이 회계 장부로 새지 않습니다');
  eq(L.w.__AC.state.security, undefined, '예약 앱 보안 설정을 가져오지 않습니다');
  L.dom.window.close();
});

test('잠금 화면 안내문·기본 비밀번호 힌트', () => {
  const L = makeDom(null, { locked: true });
  includes(L.$('#lockDefaultHint').textContent, '0000');
  assert(!L.$('#lockDefaultHint').classList.contains('hidden'));
  L.dom.window.close();
});

/* ============================================================
   2. 내역 입력 (지역·통화·항목)
   ============================================================ */
console.log('\n[2] 지출·수입 입력');

function newEntry(L) {
  click(L.w, L.$('#fabAdd'));
  const f = L.$('#entryForm');
  assert(f, '내역 입력 시트가 열리지 않았습니다');
  return f;
}
function submitEntry(L) {
  const f = L.$('#entryForm');
  fire(L.w, f, 'submit');
}

test('지출 추가 — 필리핀 현지 월세 ₱35,000', () => {
  const L = makeDom(null, {});
  newEntry(L);
  click(L.w, L.$('[data-action="set-region"][data-region="PH"]'));
  click(L.w, L.$('[data-action="set-cat"][data-cat="월세"]'));
  setVal(L.w, L.$('#eAmount'), '35000');
  setVal(L.w, L.$('#eDate'), THIS_MONTH + '-01');
  submitEntry(L);
  eq(L.w.__AC.state.entries.length, 1, '1건 저장');
  const e = L.w.__AC.state.entries[0];
  eq(e.type, 'expense');
  eq(e.region, 'PH');
  eq(e.currency, 'PHP');
  eq(e.amount, 35000);
  eq(e.category, '월세');
  eq(e.house, 'ALL');
  eq(e.date, THIS_MONTH + '-01');
  L.dom.window.close();
});

test('지출 추가 — 한국 전기세는 통화가 ₩로 자동 지정', () => {
  const L = makeDom(null, {});
  newEntry(L);
  click(L.w, L.$('[data-action="set-region"][data-region="KR"]'));
  eq(L.$('#eCurSym').textContent, '₩', '한국은 원화가 기본입니다');
  click(L.w, L.$('[data-action="set-cat"][data-cat="전기세"]'));
  setVal(L.w, L.$('#eAmount'), '45000');
  setVal(L.w, L.$('#eDate'), THIS_MONTH + '-02');
  submitEntry(L);
  const e = L.w.__AC.state.entries[0];
  eq(e.region, 'KR');
  eq(e.currency, 'KRW');
  eq(e.amount, 45000);
  L.dom.window.close();
});

test('지역은 한국인데 통화를 ₱로 바꿔 기록할 수 있다', () => {
  const L = makeDom(null, {});
  newEntry(L);
  click(L.w, L.$('[data-action="set-region"][data-region="KR"]'));
  click(L.w, L.$('[data-action="set-cur"][data-cur="PHP"]'));
  eq(L.$('#eCurSym').textContent, '₱');
  click(L.w, L.$('[data-action="set-cat"][data-cat="물품 구입"]'));
  setVal(L.w, L.$('#eAmount'), '1500');
  submitEntry(L);
  const e = L.w.__AC.state.entries[0];
  eq(e.region, 'KR');
  eq(e.currency, 'PHP');
  L.dom.window.close();
});

test('필수 지출 항목 10종이 모두 준비되어 있다', () => {
  const names = AC.EXPENSE_CATS.map((c) => c.name);
  ['월세', '인터넷 요금', '마을 회비', '에어비앤비 등록비/수수료', '수도세', '전기세', '아떼 월급', '수리 비용', '물품 구입', '기타 지출']
    .forEach((n) => assert(names.indexOf(n) >= 0, '빠진 항목: ' + n));
  eq(names.length, 10);
});

test('지출 항목 10종을 현지(₱)·한국(₩) 양쪽에서 저장한다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.EXPENSE_CATS.forEach((c, i) => {
    A.addEntry({ type: 'expense', date: THIS_MONTH + '-0' + ((i % 9) + 1), region: 'PH', currency: 'PHP', amount: 1000 + i, category: c.name, house: 'ALL' });
    A.addEntry({ type: 'expense', date: THIS_MONTH + '-0' + ((i % 9) + 1), region: 'KR', currency: 'KRW', amount: 20000 + i, category: c.name, house: 'ALL' });
  });
  eq(A.state.entries.length, 20, '20건이 저장되어야 합니다');
  const ph = A.state.entries.filter((e) => e.region === 'PH');
  const kr = A.state.entries.filter((e) => e.region === 'KR');
  eq(ph.length, 10);
  eq(kr.length, 10);
  eq(new Set(ph.map((e) => e.category)).size, 10, '현지 지출 10종');
  L.dom.window.close();
});

test('수입 항목 4종을 ₱·₩ 모두로 기록한다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  eq(A.INCOME_CATS.length, 4, '수입 항목 4종');
  A.addEntry({ type: 'income', date: THIS_MONTH + '-05', region: 'PH', currency: 'PHP', amount: 185000, category: '숙박 수입 - 개별' });
  A.addEntry({ type: 'income', date: THIS_MONTH + '-06', region: 'PH', currency: 'PHP', amount: 96000, category: '숙박 수입 - 에어비앤비' });
  A.addEntry({ type: 'income', date: THIS_MONTH + '-07', region: 'PH', currency: 'PHP', amount: 12800, category: '추가 서비스(아떼/픽드랍/매트리스)' });
  A.addEntry({ type: 'income', date: THIS_MONTH + '-08', region: 'KR', currency: 'KRW', amount: 300000, category: '기타 수입' });
  eq(A.state.entries.length, 4);
  eq(A.state.entries.filter((e) => e.type === 'income' && e.currency === 'KRW').length, 1);
  L.dom.window.close();
});

test('수입은 UI에서 ＋수입으로 전환해 기록한다', () => {
  const L = makeDom(null, {});
  newEntry(L);
  click(L.w, L.$('[data-action="set-type"][data-type="income"]'));
  assert(L.$('[data-cat="숙박 수입 - 개별"]'), '수입 항목이 보여야 합니다');
  eq(L.$('[data-cat="월세"]'), null, '지출 항목은 사라져야 합니다');
  click(L.w, L.$('[data-action="set-cat"][data-cat="숙박 수입 - 에어비앤비"]'));
  setVal(L.w, L.$('#eAmount'), '96000');
  submitEntry(L);
  const e = L.w.__AC.state.entries[0];
  eq(e.type, 'income');
  eq(e.category, '숙박 수입 - 에어비앤비');
  L.dom.window.close();
});

test('새 항목(카테고리)을 직접 추가해 쓸 수 있다', () => {
  const L = makeDom(null, {});
  newEntry(L);
  setVal(L.w, L.$('#eNewCat'), '세탁비');
  click(L.w, L.$('[data-action="add-cat"]'));
  assert(L.$('[data-cat="세탁비"]'), '새 항목 칩이 생겨야 합니다');
  setVal(L.w, L.$('#eAmount'), '1800');
  submitEntry(L);
  eq(L.w.__AC.state.entries[0].category, '세탁비');
  assert(L.w.__AC.state.settings.customCats.expense.indexOf('세탁비') >= 0, '사용자 항목으로 저장');
  L.dom.window.close();
});

test('금액이 없으면 저장하지 않는다', () => {
  const L = makeDom(null, {});
  newEntry(L);
  click(L.w, L.$('[data-action="set-cat"][data-cat="수도세"]'));
  setVal(L.w, L.$('#eAmount'), '0');
  submitEntry(L);
  eq(L.w.__AC.state.entries.length, 0, '저장되면 안 됩니다');
  includes(L.$('#entryError').textContent, '금액');
  L.dom.window.close();
});

test('저장된 내역을 눌러 금액을 고칠 수 있다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  const e = A.addEntry({ type: 'expense', date: THIS_MONTH + '-03', region: 'PH', currency: 'PHP', amount: 3200, category: '수리 비용' });
  A.showView('ledger');
  const row = L.$('[data-action="edit-entry"][data-id="' + e.id + '"]');
  assert(row, '장부에 내역이 보여야 합니다');
  click(L.w, row);
  eq(L.$('#entryForm').getAttribute('id'), 'entryForm');
  includes(L.$('.sheet-head').textContent, '내역 수정');
  setVal(L.w, L.$('#eAmount'), '4500');
  submitEntry(L);
  eq(A.state.entries.length, 1, '수정은 새로 추가하지 않습니다');
  eq(A.state.entries[0].amount, 4500);
  L.dom.window.close();
});

test('내역을 삭제할 수 있다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  const e = A.addEntry({ type: 'expense', date: THIS_MONTH + '-04', region: 'PH', currency: 'PHP', amount: 500, category: '마을 회비' });
  A.showView('ledger');
  click(L.w, L.$('[data-action="edit-entry"][data-id="' + e.id + '"]'));
  click(L.w, L.$('[data-action="delete-entry"]'));
  eq(A.state.entries.length, 0, '삭제되어야 합니다');
  eq(L.$('#entryForm'), null, '시트가 닫힙니다');
  L.dom.window.close();
});

test('매달 고정 지출 표시를 켜고 끌 수 있다', () => {
  const L = makeDom(null, {});
  newEntry(L);
  assert(L.$('#eRecurring'), '지출에는 고정 지출 체크가 있습니다');
  L.$('#eRecurring').checked = true;
  click(L.w, L.$('[data-action="set-cat"][data-cat="인터넷 요금"]'));
  setVal(L.w, L.$('#eAmount'), '1899');
  submitEntry(L);
  eq(L.w.__AC.state.entries[0].recurring, true);
  L.dom.window.close();
});

/* ============================================================
   3. 월별 집계 · 환율
   ============================================================ */
console.log('\n[3] 월별 집계와 환율');

function seedMonth(A, ym) {
  A.resetData({ silent: true });
  A.addEntry({ type: 'income', date: ym + '-05', region: 'PH', currency: 'PHP', amount: 100000, category: '숙박 수입 - 개별' });
  A.addEntry({ type: 'income', date: ym + '-06', region: 'PH', currency: 'PHP', amount: 50000, category: '숙박 수입 - 에어비앤비' });
  A.addEntry({ type: 'expense', date: ym + '-01', region: 'PH', currency: 'PHP', amount: 35000, category: '월세' });
  A.addEntry({ type: 'expense', date: ym + '-02', region: 'KR', currency: 'KRW', amount: 120000, category: '물품 구입' });
}

test('환율 기본값은 1페소 = 24.5원', () => {
  const L = makeDom(null, {});
  eq(L.w.__AC.getRate(), 24.5);
  includes(L.$('#rateChipText').textContent, '24.5');
  L.dom.window.close();
});

test('총 수입·총 지출·월 순수익을 환산해 계산한다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedMonth(A, THIS_MONTH);
  const s = A.summarize(A.entriesForMonth(THIS_MONTH));
  near(s.income.php, 150000);
  near(s.income.krwTotal, 150000 * 24.5);
  near(s.expense.php, 35000);
  near(s.expense.krw, 120000);
  near(s.expense.krwTotal, 35000 * 24.5 + 120000);
  near(s.net, 150000 * 24.5 - (35000 * 24.5 + 120000));
  L.dom.window.close();
});

test('필리핀 현지 지출과 한국 지출을 나눠 센다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedMonth(A, THIS_MONTH);
  const s = A.summarize(A.entriesForMonth(THIS_MONTH));
  near(s.ph.krwTotal, 35000 * 24.5);
  near(s.kr.krwTotal, 120000);
  eq(s.ph.count, 1);
  eq(s.kr.count, 1);
  near(s.ph.krwTotal + s.kr.krwTotal, s.expense.krwTotal);
  L.dom.window.close();
});

test('환율을 바꾸면 모든 환산 금액이 다시 계산된다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedMonth(A, THIS_MONTH);
  eq(A.setRate('25'), true);
  eq(A.getRate(), 25);
  const s = A.summarize(A.entriesForMonth(THIS_MONTH));
  near(s.income.krwTotal, 150000 * 25);
  near(s.expense.krwTotal, 35000 * 25 + 120000);
  includes(L.$('#rateChipText').textContent, '25');
  L.dom.window.close();
});

test('항목별 비중 합계가 총 지출과 같다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedMonth(A, THIS_MONTH);
  const s = A.summarize(A.entriesForMonth(THIS_MONTH));
  const sum = s.catsExpense.reduce((a, c) => a + c.krwTotal, 0);
  near(sum, s.expense.krwTotal, 0.01);
  eq(s.catsExpense[0].category || s.catsExpense[0].name, '월세', '큰 항목이 먼저 정렬됩니다');
  L.dom.window.close();
});

test('다른 달 내역은 이번 달 합계에 섞이지 않는다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedMonth(A, THIS_MONTH);
  A.addEntry({ type: 'expense', date: AC.addMonths(THIS_MONTH, -1) + '-10', region: 'PH', currency: 'PHP', amount: 99999, category: '기타 지출' });
  const s = A.summarize(A.entriesForMonth(THIS_MONTH));
  near(s.expense.krwTotal, 35000 * 24.5 + 120000);
  L.dom.window.close();
});

test('월 선택을 옮기면 그 달의 정산이 보인다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  const prev = A.addMonths(THIS_MONTH, -1);
  A.addEntry({ type: 'expense', date: prev + '-15', region: 'PH', currency: 'PHP', amount: 1111, category: '수도세' });
  A.addEntry({ type: 'income', date: THIS_MONTH + '-15', region: 'PH', currency: 'PHP', amount: 2222, category: '기타 수입' });
  A.goMonth(-1);
  eq(A.ui.month, prev);
  includes(L.$('.mn-label').textContent, prev.slice(0, 4) + '년 ' + Number(prev.slice(5)) + '월');
  includes(L.$('#viewDashboard').textContent, '1,111');
  includes(L.$('.kpi.income .s').textContent, '이번 달 수입 없음', '이번 달 수입은 0으로 계산');
  eq(L.$('.kpi.expense .v').textContent, AC.money(1111 * 24.5, 'KRW'), '이번 달 지출만 집계');
  click(L.w, L.$('[data-action="month-now"]'));
  eq(A.ui.month, THIS_MONTH, '이번 달 버튼으로 복귀');
  L.dom.window.close();
});

test('이전 달·다음 달 버튼이 연도를 넘어간다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.ui.month = '2026-01';
  click(L.w, L.$('[data-action="month-prev"]'));
  eq(A.ui.month, '2025-12');
  click(L.w, L.$('[data-action="month-next"]'));
  eq(A.ui.month, '2026-01');
  L.dom.window.close();
});

/* ============================================================
   4. 현재 보유 잔액 (기초 잔액)
   ============================================================ */
console.log('\n[4] 현재 보유 잔액');

test('기초 잔액이 없으면 누적 수입 − 지출이 잔액이 된다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.setOpening(0, 0);
  A.addEntry({ type: 'income', date: THIS_MONTH + '-01', region: 'PH', currency: 'PHP', amount: 50000, category: '숙박 수입 - 개별' });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-02', region: 'PH', currency: 'PHP', amount: 20000, category: '월세' });
  const b = A.balance();
  near(b.php, 30000);
  near(b.krw, 0);
  near(b.totalKRW, 30000 * 24.5);
  L.dom.window.close();
});

test('기초 잔액(₱·₩)이 더해진다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.setOpening(10000, 500000);
  A.addEntry({ type: 'income', date: THIS_MONTH + '-01', region: 'PH', currency: 'PHP', amount: 20000, category: '숙박 수입 - 개별' });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-02', region: 'PH', currency: 'PHP', amount: 5000, category: '월세' });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-03', region: 'KR', currency: 'KRW', amount: 120000, category: '물품 구입' });
  const b = A.balance();
  near(b.php, 10000 + 20000 - 5000);
  near(b.krw, 500000 - 120000);
  near(b.totalKRW, (10000 + 20000 - 5000) * 24.5 + (500000 - 120000));
  L.dom.window.close();
});

test('한국 지출만 있어도 한국 잔액이 줄고 통합 잔액에 반영된다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.setOpening(0, 1000000);
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-09', region: 'KR', currency: 'KRW', amount: 250000, category: '기타 지출' });
  const b = A.balance();
  near(b.krw, 750000);
  near(b.php, 0);
  near(b.totalKRW, 750000);
  L.dom.window.close();
});

test('통화를 섞어 적어도 각 통화 잔액이 따로 계산된다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.setOpening(0, 0);
  A.addEntry({ type: 'income', date: THIS_MONTH + '-01', region: 'PH', currency: 'PHP', amount: 40000, category: '숙박 수입 - 개별' });
  A.addEntry({ type: 'income', date: THIS_MONTH + '-02', region: 'KR', currency: 'KRW', amount: 300000, category: '기타 수입' });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-03', region: 'KR', currency: 'PHP', amount: 2000, category: '물품 구입' });
  const b = A.balance();
  near(b.php, 40000 - 2000);
  near(b.krw, 300000);
  near(b.totalKRW, 38000 * 24.5 + 300000);
  L.dom.window.close();
});

test('내역을 지우면 잔액이 다시 늘어난다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.setOpening(1000, 0);
  const e = A.addEntry({ type: 'expense', date: THIS_MONTH + '-04', region: 'PH', currency: 'PHP', amount: 500, category: '수도세' });
  near(A.balance().php, 500);
  A.deleteEntry(e.id);
  near(A.balance().php, 1000);
  L.dom.window.close();
});

test('환율을 바꾸면 통합 잔액이 새 환율로 바뀐다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.setOpening(1000, 0);
  A.setRate(20);
  near(A.balance().totalKRW, 20000);
  A.setRate(30);
  near(A.balance().totalKRW, 30000);
  L.dom.window.close();
});

test('대시보드 맨 위에 현재 보유 잔액이 보인다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.setOpening(12000, 450000);
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-05', region: 'PH', currency: 'PHP', amount: 2000, category: '월세' });
  A.showView('dashboard');
  const card = L.$('#balanceCard');
  assert(card, '보유 잔액 카드가 없습니다');
  const first = L.$('#viewDashboard').firstElementChild;
  eq(first.id, 'balanceCard', '대시보드 맨 위에 있어야 합니다');
  const txt = card.textContent;
  includes(txt, '현재 보유 잔액');
  includes(txt, '₱' + AC.fmtNum(10000), '필리핀 잔액');
  includes(txt, '₩' + AC.fmtNum(450000), '한국 잔액');
  includes(txt, AC.money(10000 * 24.5 + 450000, 'KRW'), '통합 환산 잔액');
  includes(txt, '기초');
  L.dom.window.close();
});

test('기초 잔액 설정 시트에서 바로 저장한다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.showView('dashboard');
  click(L.w, L.$('[data-action="edit-opening"]'));
  assert(L.$('#bOpenPhp'), '기초 잔액 시트가 열려야 합니다');
  setVal(L.w, L.$('#bOpenPhp'), '25000');
  setVal(L.w, L.$('#bOpenKrw'), '600000');
  fire(L.w, L.$('#openingSheetForm'), 'submit');
  eq(A.state.settings.opening.php, 25000);
  eq(A.state.settings.opening.krw, 600000);
  eq(L.$('#bOpenPhp'), null, '저장하면 시트가 닫힙니다');
  includes(L.$('#balanceCard').textContent, '₱25,000');
  L.dom.window.close();
});

test('설정 화면에서도 기초 잔액을 저장한다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.showView('settings');
  assert(L.$('#sOpenPhp'), '설정의 기초 잔액 입력칸');
  setVal(L.w, L.$('#sOpenPhp'), '30000');
  setVal(L.w, L.$('#sOpenKrw'), '250000');
  fire(L.w, L.$('#openingForm'), 'submit');
  eq(A.state.settings.opening.php, 30000);
  eq(A.state.settings.opening.krw, 250000);
  L.dom.window.close();
});

test('시트를 열어도 화면에 중복 id가 생기지 않는다', () => {
  const L = makeDom(null, {});
  L.w.__AC.openBalanceSheet();
  const ids = L.$$('[id]').map((el) => el.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  eq(dup.join(','), '', '중복 id: ' + dup.join(','));
  L.w.__AC.closeSheet();
  L.w.__AC.openEntrySheet(null, 'expense');
  const ids2 = L.$$('[id]').map((el) => el.id);
  const dup2 = ids2.filter((id, i) => ids2.indexOf(id) !== i);
  eq(dup2.join(','), '', '중복 id: ' + dup2.join(','));
  L.dom.window.close();
});

test('기초 잔액은 JSON 내보내기에 포함된다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.setOpening(15000, 750000);
  const payload = JSON.parse(A.exportPayload());
  eq(payload.settings.opening.php, 15000);
  eq(payload.settings.opening.krw, 750000);
  L.dom.window.close();
});

/* ============================================================
   5. 필터
   ============================================================ */
console.log('\n[5] 장부 필터');

function seedFilter(A) {
  A.resetData({ silent: true });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-01', region: 'PH', currency: 'PHP', amount: 1000, category: '월세', house: 'A', memo: 'A하우스 렌트' });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-02', region: 'KR', currency: 'KRW', amount: 20000, category: '전기세', house: 'B', memo: '한국 전기' });
  A.addEntry({ type: 'income', date: THIS_MONTH + '-03', region: 'PH', currency: 'PHP', amount: 3000, category: '숙박 수입 - 개별', house: 'C', memo: '개별 예약' });
  A.addEntry({ type: 'expense', date: AC.addMonths(THIS_MONTH, -1) + '-04', region: 'PH', currency: 'PHP', amount: 4000, category: '수도세', house: 'ALL', memo: '지난달' });
}

test('지역(현지/한국)으로 거른다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFilter(A);
  A.setFilter('region', 'PH');
  eq(A.filteredEntries().length, 2, '이번 달 현지 내역 2건');
  A.setFilter('month', 'all');
  eq(A.filteredEntries().length, 3, '전체 기간이면 지난달 현지 1건 추가');
  A.setFilter('region', 'KR');
  eq(A.filteredEntries().length, 1);
  eq(A.filteredEntries()[0].category, '전기세');
  L.dom.window.close();
});

test('하우스(공통·A~D)로 거른다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFilter(A);
  A.setFilter('month', 'all');
  A.setFilter('house', 'A');
  eq(A.filteredEntries().length, 1);
  eq(A.filteredEntries()[0].house, 'A');
  A.setFilter('house', 'ALL');
  eq(A.filteredEntries().length, 1);
  eq(A.filteredEntries()[0].house, 'ALL');
  L.dom.window.close();
});

test('항목별로 거른다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFilter(A);
  A.setFilter('month', 'all');
  A.setFilter('category', '전기세');
  eq(A.filteredEntries().length, 1);
  A.setFilter('category', 'all');
  eq(A.filteredEntries().length, 4);
  L.dom.window.close();
});

test('수입/지출로 거른다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFilter(A);
  A.setFilter('month', 'all');
  A.setFilter('type', 'income');
  eq(A.filteredEntries().length, 1);
  eq(A.filteredEntries()[0].type, 'income');
  A.setFilter('type', 'expense');
  eq(A.filteredEntries().length, 3);
  L.dom.window.close();
});

test('메모 검색으로 찾는다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFilter(A);
  A.setFilter('month', 'all');
  A.setFilter('q', '한국');
  eq(A.filteredEntries().length, 1);
  A.setFilter('q', '');
  L.dom.window.close();
});

test('장부 화면의 필터 칩이 실제 목록을 바꾼다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFilter(A);
  A.showView('ledger');
  click(L.w, L.$('[data-action="filter"][data-filter="region"][data-value="KR"]'));
  eq(A.ui.filters.region, 'KR');
  const rows = L.$$('#viewLedger .entry');
  eq(rows.length, 1, '한국 내역 1건만 남습니다');
  includes(rows[0].textContent, '전기세');
  L.dom.window.close();
});

test('필터를 걸면 합계도 걸린 내역만 계산한다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFilter(A);
  A.setFilter('type', 'income');
  const s = A.summarize(A.filteredEntries());
  eq(s.expense.krwTotal, 0);
  near(s.income.krwTotal, 3000 * 24.5);
  L.dom.window.close();
});

/* ============================================================
   6. 고정비 불러오기
   ============================================================ */
console.log('\n[6] 지난달 고정비 불러오기');

function seedFixed(A) {
  A.resetData({ silent: true });
  const prev = A.addMonths(THIS_MONTH, -1);
  A.addEntry({ type: 'expense', date: prev + '-01', region: 'PH', currency: 'PHP', amount: 35000, category: '월세', house: 'ALL', recurring: true });
  A.addEntry({ type: 'expense', date: prev + '-02', region: 'PH', currency: 'PHP', amount: 1899, category: '인터넷 요금', house: 'ALL', recurring: true });
  A.addEntry({ type: 'expense', date: prev + '-04', region: 'PH', currency: 'PHP', amount: 500, category: '마을 회비', house: 'ALL', recurring: true });
  A.addEntry({ type: 'expense', date: prev + '-10', region: 'PH', currency: 'PHP', amount: 12000, category: '아떼 월급', house: 'ALL', recurring: true });
  A.addEntry({ type: 'expense', date: prev + '-15', region: 'PH', currency: 'PHP', amount: 3200, category: '수리 비용', house: 'B' });
  return prev;
}

test('지난달 고정 항목만 후보로 잡는다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFixed(A);
  const cands = A.fixedCandidates(THIS_MONTH);
  eq(cands.length, 4, '고정 4건만');
  assert(cands.every((e) => e.category !== '수리 비용'), '일회성 수리는 제외');
  L.dom.window.close();
});

test('고정비를 이번 달로 1탭 복사한다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFixed(A);
  const n = A.copyFixed(THIS_MONTH, { silent: true });
  eq(n, 4);
  const cur = A.entriesForMonth(THIS_MONTH);
  eq(cur.length, 4);
  const rent = cur.find((e) => e.category === '월세');
  eq(rent.amount, 35000);
  eq(rent.recurring, true);
  eq(rent.date, THIS_MONTH + '-01', '날짜(일)를 그대로 옮깁니다');
  L.dom.window.close();
});

test('이미 복사했으면 다시 복사해도 늘지 않는다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFixed(A);
  A.copyFixed(THIS_MONTH, { silent: true });
  const n = A.copyFixed(THIS_MONTH, { silent: true });
  eq(n, 0, '중복 복사 없음');
  eq(A.entriesForMonth(THIS_MONTH).length, 4);
  L.dom.window.close();
});

test('고정비 복사 버튼이 대시보드에 있고 동작한다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedFixed(A);
  A.showView('dashboard');
  assert(L.$('#fixedCard'), '고정비 카드가 있어야 합니다');
  includes(L.$('#fixedCard').textContent, '지난달 고정비 불러오기');
  includes(L.$('#fixedCard').textContent, '4건');
  click(L.w, L.$('[data-action="copy-fixed"]'));
  eq(A.entriesForMonth(THIS_MONTH).length, 4);
  L.dom.window.close();
});

/* ============================================================
   7. 백업 · CSV
   ============================================================ */
console.log('\n[7] 내보내기 · 가져오기 · CSV');

test('JSON 내보내기에 장부와 설정이 담기고 비밀번호는 빠진다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedMonth(A, THIS_MONTH);
  A.setOpening(5000, 100000);
  const raw = A.exportPayload();
  const p = JSON.parse(raw);
  eq(p.app, 'oraholic-accounting');
  eq(p.entries.length, 4);
  eq(p.settings.rate, 24.5);
  notIncludes(raw, 'pinHash', '비밀번호 해시는 내보내지 않습니다');
  L.dom.window.close();
});

test('JSON 가져오기는 기존 장부에 합치고 같은 내역은 중복되지 않는다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.upsertEntry({ id: 'x1', type: 'expense', date: THIS_MONTH + '-01', region: 'PH', currency: 'PHP', amount: 1000, category: '월세' });
  const payload = JSON.stringify({
    app: 'oraholic-accounting',
    settings: { rate: 26, opening: { php: 3000, krw: 40000 } },
    entries: [
      { id: 'x1', type: 'expense', date: THIS_MONTH + '-01', region: 'PH', currency: 'PHP', amount: 1500, category: '월세', updatedAt: Date.now() + 1000 },
      { id: 'x2', type: 'income', date: THIS_MONTH + '-05', region: 'PH', currency: 'PHP', amount: 9000, category: '숙박 수입 - 개별' }
    ]
  });
  const res = A.importPayload(payload, { silent: true });
  eq(res.ok, true);
  eq(res.added, 1);
  eq(res.updated, 1);
  eq(A.state.entries.length, 2, '중복 없이 2건');
  eq(A.getEntry('x1').amount, 1500, '같은 id는 최신 값으로 갱신');
  eq(A.getRate(), 26, '환율도 함께 복원');
  eq(A.state.settings.opening.php, 3000);
  L.dom.window.close();
});

test('잘못된 파일은 가져오지 않고 안내한다', () => {
  const L = makeDom(null, {});
  const res = L.w.__AC.importPayload('그냥 텍스트', { silent: true });
  eq(res.ok, false);
  includes(res.error, 'JSON');
  L.dom.window.close();
});

test('CSV 정산표에 머리글·내역·합계가 들어간다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  seedMonth(A, THIS_MONTH);
  const csv = A.buildCSV(THIS_MONTH);
  eq(csv.charCodeAt(0), 0xFEFF, '엑셀용 BOM');
  includes(csv, '날짜,구분,지역,통화,금액,원화환산,항목,하우스,고정지출,메모');
  includes(csv, '월세');
  includes(csv, '필리핀 현지');
  includes(csv, '한국');
  includes(csv, '합계,순수익');
  includes(csv, '현재 보유 잔액');
  L.dom.window.close();
});

test('CSV는 쉼표·따옴표가 든 메모를 안전하게 감싼다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-01', region: 'PH', currency: 'PHP', amount: 100, category: '기타 지출', memo: '엘레나, "확인" 필요' });
  const csv = A.buildCSV(THIS_MONTH);
  includes(csv, '"엘레나, ""확인"" 필요"');
  L.dom.window.close();
});

test('CSV는 선택한 달만 담는다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  const prev = A.addMonths(THIS_MONTH, -1);
  A.resetData({ silent: true });
  A.addEntry({ type: 'expense', date: prev + '-03', region: 'PH', currency: 'PHP', amount: 777, category: '수도세', memo: '지난달항목' });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-03', region: 'PH', currency: 'PHP', amount: 888, category: '전기세', memo: '이번달항목' });
  const csv = A.buildCSV(THIS_MONTH);
  includes(csv, '이번달항목');
  notIncludes(csv, '지난달항목');
  L.dom.window.close();
});

test('샘플 데이터를 넣으면 여러 달 장부가 채워진다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  const n = A.sampleData();
  assert(n > 30, '샘플이 여러 건이어야 합니다');
  eq(A.state.entries.length, n);
  const months = new Set(A.state.entries.map((e) => A.monthKey(e.date)));
  assert(months.size >= 3, '3개월 이상');
  assert(A.balance().totalKRW > 0, '보유 잔액이 계산됩니다');
  L.dom.window.close();
});

test('초기화는 내역만 지우고 비밀번호·기초 잔액은 남긴다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.changePin('0000', '1357', '1357');
  A.setOpening(9000, 5000);
  A.sampleData();
  A.resetData({ silent: true });
  eq(A.state.entries.length, 0);
  eq(A.state.settings.opening.php, 9000);
  eq(A.isDefaultPin(), false, '바꾼 비밀번호 유지');
  L.dom.window.close();
});

/* ============================================================
   8. 동기화
   ============================================================ */
console.log('\n[8] Firebase 동기화 (선택)');

test('동기화 경로는 oraholic-accounting/{코드}.json 이다', () => {
  const L = makeDom(null, {});
  const url = L.w.__AC.syncEndpoint({ url: 'https://demo.firebaseio.com/', code: 'oraholic-acct' });
  eq(url, 'https://demo.firebaseio.com/oraholic-accounting/oraholic-acct.json');
  L.dom.window.close();
});

test('동기화를 켜지 않으면 아무것도 보내지 않는다', async () => {
  const L = makeDom(null, {});
  let called = false;
  L.w.fetch = () => { called = true; return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); };
  const res = await L.w.__AC.syncNow({ silent: true });
  eq(res.ok, false);
  eq(called, false, '요청을 보내지 않습니다');
  L.dom.window.close();
});

test('동기화는 상대 내역을 합치고 내 장부를 올린다', async () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.addEntry({ id: 'mine', type: 'expense', date: THIS_MONTH + '-01', region: 'PH', currency: 'PHP', amount: 1000, category: '월세' });
  const calls = [];
  L.w.fetch = function (url, opts) {
    calls.push({ url: url, method: (opts && opts.method) || 'GET' });
    if (opts && opts.method === 'PUT') return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        entries: [{ id: 'theirs', type: 'expense', date: THIS_MONTH + '-02', region: 'KR', currency: 'KRW', amount: 30000, category: '물품 구입', updatedAt: Date.now() }],
        settings: { opening: { php: 2000, krw: 1000 } }
      })
    });
  };
  const s = A.state.settings.sync;
  s.url = 'https://demo.firebaseio.com'; s.code = 'oraholic-acct'; s.enabled = true;
  const res = await A.syncNow({ silent: true });
  eq(res.ok, true);
  eq(A.state.entries.length, 2, '상대 내역을 합칩니다');
  eq(A.state.settings.opening.php, 2000);
  includes(calls[0].url, '/oraholic-accounting/oraholic-acct.json');
  eq(calls[1].method, 'PUT', '내 장부를 올립니다');
  eq(A.state.settings.sync.lastResult, 'ok');
  L.dom.window.close();
});

/* ============================================================
   9. PWA · 배포 파일
   ============================================================ */
console.log('\n[9] PWA 구성');

test('manifest가 회계 앱 이름과 상대 경로를 쓴다', () => {
  const m = JSON.parse(MANIFEST);
  includes(m.name, '오라홀릭');
  includes(m.name, '회계');
  eq(m.start_url, './index.html');
  eq(m.scope, './');
  eq(m.display, 'standalone');
  eq(m.lang, 'ko');
  assert(m.icons.some((i) => i.src === './icon-192.png'), '192 아이콘');
  assert(m.icons.some((i) => i.src === './icon-512.png'), '512 아이콘');
  assert(m.theme_color.toLowerCase() === '#1b6b4a', '초록 테마색');
});

test('service worker가 상대 경로로 자기 캐시만 다룬다', () => {
  includes(SW, './index.html');
  includes(SW, './app.js');
  includes(SW, './styles.css');
  includes(SW, 'oraholic-accounting-');
  notIncludes(SW, 'oraholic-guesthouse-', '예약 앱 캐시를 지우지 않습니다');
  includes(SW, 'self.registration');
});

test('상단바에 예약 관리로 돌아가는 전환 버튼이 있다', () => {
  includes(INDEX, 'class="app-switch"');
  includes(INDEX, 'href="../"');
  includes(INDEX, '📅');
  includes(INDEX, '예약 관리 열기');
});

test('index.html은 상대 경로·잠금 화면·초록 테마를 쓴다', () => {
  includes(INDEX, 'href="./manifest.json"');
  includes(INDEX, 'src="./app.js"');
  includes(INDEX, 'href="./styles.css"');
  includes(INDEX, 'id="lockScreen"');
  includes(INDEX, '오라홀릭 회계 정산');
  includes(INDEX, '관리자 로그인');
  includes(INDEX, '이 기기에서 로그인 유지');
  includes(INDEX, '#1b6b4a');
  notIncludes(INDEX, 'http://', 'http 절대 경로가 없어야 합니다');
});

test('아이콘 파일이 실제로 있다', () => {
  ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'favicon-32.png'].forEach((f) => {
    assert(fs.existsSync(path.join(ROOT, f)), f + ' 가 없습니다');
    assert(fs.statSync(path.join(ROOT, f)).size > 500, f + ' 가 비어 있습니다');
  });
});

test('스타일시트가 초록 팔레트(#f5f9f6 · #1b6b4a)를 쓴다', () => {
  includes(STYLES.toLowerCase(), '#f5f9f6');
  includes(STYLES.toLowerCase(), '#1b6b4a');
  includes(STYLES, 'balance-card');
});

/* ============================================================
   10. 화면 구성
   ============================================================ */
console.log('\n[10] 화면 구성');

test('탭 4개(정산·장부·분석·설정)가 있다', () => {
  const tabs = ctx.$$('#tabs button').map((b) => b.getAttribute('data-view'));
  eq(tabs.join(','), 'dashboard,ledger,report,settings');
});

test('대시보드에 월 선택·KPI·보유 잔액이 보인다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.sampleData();
  A.showView('dashboard');
  const txt = L.$('#viewDashboard').textContent;
  includes(txt, '현재 보유 잔액');
  includes(txt, '총 수입');
  includes(txt, '총 지출');
  includes(txt, '월 순수익');
  includes(txt, '항목별 지출 비중');
  includes(txt, '현지 vs');
  includes(txt, '전월 대비');
  assert(L.$('.month-nav'), '월 선택이 있어야 합니다');
  L.dom.window.close();
});

test('전월 대비 색 구분 — 늘어난 수입은 초록, 늘어난 지출은 빨강', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  const prev = A.addMonths(THIS_MONTH, -1);
  A.addEntry({ type: 'income', date: prev + '-02', region: 'PH', currency: 'PHP', amount: 10000, category: '숙박 수입 - 개별' });
  A.addEntry({ type: 'expense', date: prev + '-03', region: 'PH', currency: 'PHP', amount: 1000, category: '월세' });
  A.addEntry({ type: 'income', date: THIS_MONTH + '-02', region: 'PH', currency: 'PHP', amount: 20000, category: '숙박 수입 - 개별' });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-03', region: 'PH', currency: 'PHP', amount: 3000, category: '월세' });
  A.showView('dashboard');
  const items = L.$$('#viewDashboard .mom-item');
  eq(items.length, 3);
  assert(items[0].querySelector('.md').classList.contains('good'), '수입 증가는 초록');
  assert(items[1].querySelector('.md').classList.contains('bad'), '지출 증가는 빨강');
  L.dom.window.close();
});

test('분석 화면에 연간 추이와 정산표가 보인다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.sampleData();
  A.showView('report');
  const txt = L.$('#viewReport').textContent;
  includes(txt, '년 월별 추이');
  includes(txt, '정산표');
  includes(txt, '연간 순수익');
  includes(txt, '하우스별 정산');
  L.dom.window.close();
});

test('설정 화면에 환율·비밀번호·백업·기초 잔액이 있다', () => {
  const L = makeDom(null, {});
  L.w.__AC.showView('settings');
  const txt = L.$('#viewSettings').textContent;
  ['기초(시작) 잔액', '환율', '접속 비밀번호', '백업', 'JSON 내보내기', 'CSV(엑셀)', '샘플 데이터', '초기화', '동기화']
    .forEach((k) => includes(txt, k));
  L.dom.window.close();
});

test('환율을 설정 화면에서 바꾸면 헤더와 합계에 반영된다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.showView('settings');
  setVal(L.w, L.$('#sRate'), '26');
  fire(L.w, L.$('#rateForm'), 'submit');
  eq(A.getRate(), 26);
  includes(L.$('#rateChipText').textContent, '26');
  L.dom.window.close();
});

test('잠금 후 다시 로그인하면 장부가 그대로 있다', () => {
  const L = makeDom(null, {});
  const A = L.w.__AC;
  A.resetData({ silent: true });
  A.addEntry({ type: 'expense', date: THIS_MONTH + '-01', region: 'PH', currency: 'PHP', amount: 4321, category: '월세' });
  A.lockNow({ silent: true });
  eq(L.$('#viewDashboard').innerHTML.trim(), '');
  setVal(L.w, L.$('#lockPin'), '0000');
  fire(L.w, L.$('#lockForm'), 'submit');
  includes(L.$('#viewDashboard').textContent, '4,321');
  L.dom.window.close();
});

test('설정 화면에 저장 키와 분리 안내가 보인다', () => {
  const L = makeDom(null, {});
  L.w.__AC.showView('settings');
  includes(L.$('#viewSettings').textContent, 'oraholic-accounting-v1');
  includes(L.$('#viewSettings').textContent, '예약 앱과 분리');
  L.dom.window.close();
});

/* ---------- 결과 ---------- */
Promise.all(pending).then(() => {
  console.log('\n────────────────────────────────────────');
  console.log('통과 ' + passed + ' · 실패 ' + failures.length + ' · 전체 ' + (passed + failures.length));
  if (failures.length) {
    console.log('\n실패 목록:');
    failures.forEach((f, i) => console.log(' ' + (i + 1) + '. ' + f.name + ' — ' + f.error));
    process.exit(1);
  } else {
    console.log('모든 테스트를 통과했습니다 ✅');
    process.exit(0);
  }
});
