'use strict';

/* ============================================================
   오라홀릭 게스트하우스 — 자동 테스트 (jsdom)
   실행: node test.js   (tests 폴더에서)
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const MANIFEST = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const CONF = fs.readFileSync(path.join(ROOT, 'confirmation.js'), 'utf8');

let passed = 0;
const failures = [];
const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '값이 다릅니다') + ' — 기대: ' + JSON.stringify(expected) + ' / 실제: ' + JSON.stringify(actual));
  }
}
function includes(hay, needle, msg) {
  if (String(hay).indexOf(needle) < 0) {
    throw new Error((msg || '문구를 찾지 못했습니다') + ' — 찾는 값: "' + needle + '" / 실제: "' + String(hay).slice(0, 400) + '"');
  }
}
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => {
        passed++;
        results.push({ name, ok: true });
        console.log('  ✅ ' + name);
      }).catch((e) => {
        failures.push({ name, error: e.message });
        results.push({ name, ok: false, error: e.message });
        console.log('  ❌ ' + name + '\n       → ' + e.message);
      }));
      return;
    }
    passed++;
    results.push({ name, ok: true });
    console.log('  ✅ ' + name);
  } catch (e) {
    failures.push({ name, error: e.message });
    results.push({ name, ok: false, error: e.message });
    console.log('  ❌ ' + name + '\n       → ' + e.message);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, ok: true });
    console.log('  ✅ ' + name);
  } catch (e) {
    failures.push({ name, error: e.message });
    results.push({ name, ok: false, error: e.message });
    console.log('  ❌ ' + name + '\n       → ' + e.message);
  }
}

/* ---------- DOM 하네스 ---------- */
function makeDom(preload, opts) {
  const o = opts || {};
  const html = INDEX.replace(/<script src="\.\/app\.js"><\/script>/, '');
  const dom = new JSDOM(html, {
    url: 'https://oraholic.github.io/oraholic-guesthouse/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  const d = w.document;
  w.__GH_TEST__ = true;
  w.scrollTo = function () {};
  w.HTMLElement.prototype.scrollIntoView = function () {};
  if (!w.matchMedia) {
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  }
  w.document.execCommand = () => true;
  const clipboard = { text: null };
  Object.defineProperty(w.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => { clipboard.text = String(t); return Promise.resolve(); } }
  });
  if (preload) w.localStorage.setItem('oraholic-guesthouse-v1', preload);
  if (o.preAuth) {
    const store = o.preAuthStore === 'session' ? w.sessionStorage : w.localStorage;
    store.setItem('oraholic-guesthouse-auth-v1', o.preAuth);
  }
  w.eval(CONF);
  w.eval(APP);
  // 기본은 이미 로그인한 기기처럼 동작시키고, o.locked 이면 첫 실행(잠금 화면) 상태로 둡니다.
  if (!o.locked) w.__GH.attemptUnlock(o.pin || '0000', o.remember !== false);
  return { dom, w, d, $: (s) => d.querySelector(s), $$: (s) => Array.from(d.querySelectorAll(s)), clipboard };
}

function fire(w, el, type) {
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

/* ---------- 공통 날짜 ---------- */
const ctx = makeDom();
const GH = ctx.w.__GH;
const TODAY = GH.today();
const now = new Date();
const Y = now.getFullYear();
const M = now.getMonth();
const D = (n) => GH.ymd(new Date(Y, M, n));
const T = (n) => GH.shiftStr(TODAY, n);

console.log('\n🏡 오라홀릭 게스트하우스 관리 앱 — 자동 테스트\n');
console.log('기준일: ' + TODAY + '\n');

/* ============================================================
   1. 4채 하우스 정보
   ============================================================ */
console.log('[1] 하우스 구성');

test('A·B·C·D 4채가 정의되어 있다', () => {
  eq(GH.HOUSES.length, 4);
  eq(GH.HOUSES.map((h) => h.id).join(''), 'ABCD');
});

test('A하우스 = 5룸 독채', () => {
  const a = GH.HOUSES.find((h) => h.id === 'A');
  eq(a.rooms, 5);
  includes(a.desc, '5룸');
  includes(a.desc, '독채');
  eq(a.baseGuests, 10);
});

test('B하우스 = 3룸 · 뒷마당', () => {
  const b = GH.HOUSES.find((h) => h.id === 'B');
  eq(b.rooms, 3);
  includes(b.desc, '뒷마당');
});

test('C하우스 = 3룸 · 화장실 3개', () => {
  const c = GH.HOUSES.find((h) => h.id === 'C');
  eq(c.rooms, 3);
  includes(c.desc, '화장실 3개');
});

test('D하우스 = 3룸 · 2층 테라스', () => {
  const d = GH.HOUSES.find((h) => h.id === 'D');
  eq(d.rooms, 3);
  includes(d.desc, '2층 테라스');
});

test('설정 화면에 4채 안내가 보인다', () => {
  GH.switchView('settings');
  const txt = ctx.$('#viewSettings').textContent;
  ['A하우스', 'B하우스', 'C하우스', 'D하우스', '뒷마당', '화장실 3개', '2층 테라스', '독채'].forEach((k) => includes(txt, k));
  assert(ctx.$('#syncBlock'), '동기화 설정 블록이 없습니다');
});

/* ============================================================
   2. 예약 폼 전체 흐름 (추가 서비스 포함)
   ============================================================ */
console.log('\n[2] 예약 등록 (UI 폼)');

test('예약 폼에서 추가 서비스까지 저장된다', () => {
  GH.switchView('calendar');
  click(ctx.w, ctx.$('#fabAdd'));
  const form = ctx.$('#bookingForm');
  assert(form, '예약 폼이 열리지 않았습니다');

  click(ctx.w, ctx.$('[data-pick-house="A"]'));
  click(ctx.w, ctx.$('[data-pick-source="에어비앤비"]'));
  setVal(ctx.w, ctx.$('#fGuestName'), '김민수');
  setVal(ctx.w, ctx.$('#fPhone'), '010-2345-6789');
  setVal(ctx.w, ctx.$('#fPayer'), '김우열');
  setVal(ctx.w, ctx.$('#fGuestNames'), '김민수, 이지은, 김하린');
  setVal(ctx.w, ctx.$('#fAirline'), '대한항공');
  setVal(ctx.w, ctx.$('#fFlightNo'), 'KE631');
  setVal(ctx.w, ctx.$('#fArriveDate'), T(1), 'change');
  setVal(ctx.w, ctx.$('#fArriveTime'), '23:40');
  setVal(ctx.w, ctx.$('#fDepartDate'), T(4), 'change');
  setVal(ctx.w, ctx.$('#fDepartTime'), '01:10');
  setVal(ctx.w, ctx.$('#fCheckIn'), T(1), 'change');
  setVal(ctx.w, ctx.$('#fCheckOut'), T(4), 'change');
  setVal(ctx.w, ctx.$('#fCheckInTime'), '22:30');
  setVal(ctx.w, ctx.$('#fCheckOutTime'), '11:00');
  ctx.$('#fNight').checked = true;
  setVal(ctx.w, ctx.$('#fBaseGuests'), '4');
  setVal(ctx.w, ctx.$('#fExtraGuests'), '2');
  ctx.$('#fAte').checked = true;
  setVal(ctx.w, ctx.$('#fAteName'), '마리엘');
  setVal(ctx.w, ctx.$('#fAteNote'), '아침 8시 준비');
  ctx.$('#fBaby').checked = true;
  setVal(ctx.w, ctx.$('#fBabyNote'), '오후 2~5시');
  ctx.$('#fTutor').checked = true;
  setVal(ctx.w, ctx.$('#fTutorNote'), '영어 2회');
  setVal(ctx.w, ctx.$('#fMattress'), '2');
  ctx.$('#fPickup').checked = true;
  setVal(ctx.w, ctx.$('#fPickupNote'), 'PR 432 / 23:40');
  setVal(ctx.w, ctx.$('#fTotal'), '32000', 'input');
  setVal(ctx.w, ctx.$('#fPrepaid'), '10000', 'input');
  setVal(ctx.w, ctx.$('#fDeposit'), '5000', 'input');
  setVal(ctx.w, ctx.$('#fDepReceived'), T(1), 'change');
  setVal(ctx.w, ctx.$('#fNote'), '아이 2명 · 늦은 체크인');

  eq(ctx.$('#balanceView').textContent, '₱22,000', '잔금 자동 계산');

  form.dispatchEvent(new ctx.w.Event('submit', { bubbles: true, cancelable: true }));

  eq(GH.state.bookings.length, 1, '예약 1건 저장');
  const b = GH.state.bookings[0];
  eq(b.house, 'A');
  eq(b.source, '에어비앤비');
  eq(b.guestName, '김민수');
  eq(b.payer, '김우열');
  eq(b.guestNames, '김민수, 이지은, 김하린');
  eq(b.airline, '대한항공');
  eq(b.flightNo, 'KE631');
  eq(b.arriveDate, T(1));
  eq(b.arriveTime, '23:40');
  eq(b.departDate, T(4));
  eq(b.departTime, '01:10');
  eq(b.checkIn, T(1));
  eq(b.checkOut, T(4));
  eq(b.nightFlight, true);
  eq(b.extraGuests, 2);
  eq(b.addons.ate, true);
  eq(b.addons.ateName, '마리엘');
  eq(b.addons.ateNote, '아침 8시 준비');
  eq(b.addons.babysitter, true);
  eq(b.addons.tutor, true);
  eq(b.mattress, 2);
  eq(b.pickup, true);
  eq(b.totalAmount, 32000);
  eq(b.prepaid, 10000);
  eq(b.depositAmount, 5000);
  eq(b.depositReceivedAt, T(1));
  eq(b.createdBy, '사장님');
  eq(ctx.$('#bookingForm'), null, '저장 후 폼이 닫힌다');
});

test('예약 카드에 추가 서비스 배지가 모두 보인다', () => {
  GH.switchView('bookings');
  const card = ctx.$('.booking-card');
  assert(card, '예약 카드가 없습니다');
  const txt = card.textContent;
  ['김민수', 'A하우스', '에어비앤비', '아떼: 마리엘', '베이비시터', '튜터', '매트리스 2', '추가인원 2', '밤/새벽', '공항 픽업', '수령 완료', '등록: 사장님',
    '입금자 · 김우열', '투숙객 · 김민수, 이지은, 김하린', '대한항공 KE631'].forEach((k) => includes(txt, k, '카드에 "' + k + '" 표시'));
});

test('대표 예약자명만으로 저장되고 연락처는 선택이다', () => {
  const noPhone = GH.addBooking({ house: 'D', guestName: '연락처없는손님', checkIn: D(28), checkOut: D(29) });
  assert(noPhone.ok, '이름만으로 저장되지 않았습니다: ' + noPhone.error);
  eq(noPhone.booking.phone, '');

  const noName = GH.addBooking({ house: 'D', guestName: '   ', checkIn: D(28), checkOut: D(29) });
  eq(noName.ok, false);
  includes(noName.error, '대표 예약자명');

  GH.ui.bkRange = 'all';
  GH.switchView('bookings');
  const card = ctx.$('.booking-card[data-bk="' + noPhone.booking.id + '"]');
  assert(card, '연락처 없는 예약 카드가 없습니다');
  includes(card.textContent, '대표 예약자명');
  includes(card.textContent, '연락처없는손님');

  const withPhone = GH.state.bookings.find((b) => b.guestName === '김민수');
  const card2 = ctx.$('.booking-card[data-bk="' + withPhone.id + '"]');
  includes(card2.textContent, '010-2345-6789', '연락처가 있으면 카드에 보인다');
});

test('배정된 아떼 이름이 예약 카드와 오늘 운영에 보인다', () => {
  const r = GH.addBooking({
    house: 'C', guestName: '오늘 아떼 손님', checkIn: TODAY, checkOut: T(2),
    addons: { ate: true, ateName: '마리엘', ateNote: '아침 7시' }
  });
  assert(r.ok, r.error);
  GH.switchView('bookings');
  const card = ctx.$('.booking-card[data-bk="' + r.booking.id + '"]');
  assert(card, '예약 카드가 없습니다');
  includes(card.textContent, '아떼: 마리엘');
  assert(card.querySelector('.badge.ate'), '아떼 배지가 없습니다');
  GH.switchView('today');
  const today = ctx.$('#viewToday').textContent;
  includes(today, '아떼 마리엘');
});

test('추가 서비스가 localStorage에 저장되고 다시 불러온다', () => {
  const raw = ctx.w.localStorage.getItem('oraholic-guesthouse-v1');
  const saved = JSON.parse(raw);
  const b = saved.bookings[0];
  eq(b.addons.ate, true);
  eq(b.addons.babysitter, true);
  eq(b.addons.tutor, true);
  eq(b.mattress, 2);
  eq(b.extraGuests, 2);

  const ctx2 = makeDom(raw);
  const b2 = ctx2.w.__GH.state.bookings[0];
  eq(b2.addons.ate, true, '다시 열어도 아떼 유지');
  eq(b2.addons.ateName, '마리엘', '다시 열어도 아떼 이름 유지');
  eq(b2.addons.tutor, true, '다시 열어도 튜터 유지');
  eq(b2.mattress, 2, '다시 열어도 매트리스 유지');
  ctx2.dom.window.close();
});

/* ============================================================
   3. 당일 턴오버
   ============================================================ */
console.log('\n[3] 당일 퇴실 + 당일 입실 (턴오버)');

const TURN_D1 = D(5);
const TURN_D2 = D(8);
const TURN_D3 = D(10);

test('같은 날 퇴실·입실(턴오버)은 허용된다', () => {
  const before = GH.state.bookings.length;
  const r1 = GH.addBooking({ house: 'B', guestName: '요시다', checkIn: TURN_D1, checkOut: TURN_D2 });
  assert(r1.ok, '첫 예약 실패: ' + r1.error);
  const r2 = GH.addBooking({ house: 'B', guestName: '마리아', checkIn: TURN_D2, checkOut: TURN_D3, nightFlight: true, checkInTime: '22:00' });
  assert(r2.ok, '턴오버 예약이 막혔습니다: ' + r2.error);
  eq(GH.state.bookings.length, before + 2);
});

test('턴오버 날짜의 칸에 퇴실과 입실이 함께 표시된다', () => {
  GH.ui.month = GH.ymd(new Date(Y, M, 1));
  GH.switchView('calendar');
  const cell = ctx.$('.day[data-date="' + TURN_D2 + '"]');
  assert(cell, '턴오버 날짜 칸이 없습니다: ' + TURN_D2);
  const bar = cell.querySelector('.hbar[data-house="B"]');
  assert(bar, 'B하우스 줄이 없습니다');
  const out = bar.querySelector('.seg[data-seg="out"]');
  const inn = bar.querySelector('.seg[data-seg="in"]');
  assert(out, '퇴실 표시가 없습니다');
  assert(inn, '입실 표시가 없습니다');
  assert(bar.querySelector('.split'), '한 칸이 퇴실/입실로 나뉘지 않았습니다');
  eq(bar.getAttribute('data-turnover'), '1');
  includes(cell.getAttribute('aria-label'), '3룸');
});

test('날짜 상세에서 턴오버 안내가 보인다', () => {
  const cell = ctx.$('.day[data-date="' + TURN_D2 + '"]');
  click(ctx.w, cell);
  const sheet = ctx.$('.sheet');
  assert(sheet, '날짜 상세 시트가 열리지 않았습니다');
  const txt = sheet.textContent;
  includes(txt, '요시다');
  includes(txt, '마리아');
  includes(txt, '퇴실');
  includes(txt, '입실');
  includes(txt, '당일 턴오버');
  assert(sheet.querySelector('.ev-row[data-ev="out"]'), '퇴실 행');
  assert(sheet.querySelector('.ev-row[data-ev="in"]'), '입실 행');
  click(ctx.w, ctx.$('[data-action="close-sheet"]'));
});

test('예약 폼에서 턴오버 안내 문구가 뜬다', () => {
  click(ctx.w, ctx.$('#fabAdd'));
  setVal(ctx.w, ctx.$('#fGuestName'), '턴오버 테스트');
  setVal(ctx.w, ctx.$('#fHouse'), 'B');
  setVal(ctx.w, ctx.$('#fCheckIn'), TURN_D3, 'change');
  setVal(ctx.w, ctx.$('#fCheckOut'), D(12), 'change');
  fire(ctx.w, ctx.$('#fCheckIn'), 'change');
  GH.switchView; // no-op
  const notice = ctx.$('#formNotice');
  assert(notice, '안내 상자가 없습니다');
  includes(notice.textContent, '턴오버');
  includes(notice.textContent, '마리아');
  click(ctx.w, ctx.$('[data-action="close-sheet"]'));
});

/* ============================================================
   4. 중복 예약 차단
   ============================================================ */
console.log('\n[4] 숙박 기간 중복 차단');

test('숙박 중간에 겹치는 예약은 막힌다', () => {
  const c = GH.conflictFor('B', TURN_D1, TURN_D2);
  assert(c, '겹침을 찾지 못했습니다');
  const r = GH.addBooking({ house: 'B', guestName: '겹침', checkIn: GH.shiftStr(TURN_D1, 1), checkOut: GH.shiftStr(TURN_D1, 2) });
  eq(r.ok, false);
  includes(r.error, '겹칩니다');
});

test('다른 하우스는 같은 기간에 예약할 수 있다', () => {
  const r = GH.addBooking({ house: 'C', guestName: '다른집', checkIn: TURN_D1, checkOut: TURN_D2 });
  assert(r.ok, '다른 하우스가 막혔습니다: ' + r.error);
});

test('폼에서도 겹치면 오류 안내가 나온다', () => {
  click(ctx.w, ctx.$('#fabAdd'));
  setVal(ctx.w, ctx.$('#fGuestName'), '중복 테스트');
  setVal(ctx.w, ctx.$('#fHouse'), 'B');
  setVal(ctx.w, ctx.$('#fCheckIn'), TURN_D2, 'change');
  setVal(ctx.w, ctx.$('#fCheckOut'), TURN_D3, 'change');
  setVal(ctx.w, ctx.$('#fCheckIn'), GH.shiftStr(TURN_D1, 1), 'change');
  setVal(ctx.w, ctx.$('#fCheckOut'), GH.shiftStr(TURN_D1, 2), 'change');
  fire(ctx.w, ctx.$('#fCheckIn'), 'change');
  const notice = ctx.$('#formNotice');
  assert(notice.className.indexOf('err') >= 0, '오류 스타일이 아닙니다: ' + notice.className);
  includes(notice.textContent, '겹칩니다');
  click(ctx.w, ctx.$('[data-action="close-sheet"]'));
});

test('퇴실일이 입실일과 같거나 이전이면 막힌다', () => {
  const r = GH.addBooking({ house: 'D', guestName: '제로박', checkIn: TURN_D1, checkOut: TURN_D1 });
  eq(r.ok, false);
  includes(r.error, '최소 1박');
});

/* ============================================================
   5. 3룸 빈방 요약
   ============================================================ */
console.log('\n[5] 3룸 빈방 한눈에');

test('3룸 계산: B만 차 있는 날은 2채', () => {
  const s = GH.threeRoomSummary(TURN_D2);
  eq(s.freeCount, 2);
  eq(s.free.join(''), 'CD');
  eq(s.label, '3룸 2채 빈방');
});

test('3룸 계산: 다음 손님 없이 퇴실한 날은 다시 3채', () => {
  const s = GH.threeRoomSummary(TURN_D3);
  eq(s.freeCount, 3);
  eq(s.label, '3룸 3채 빈방');
});

test('3룸 계산: B·C·D 모두 차면 마감', () => {
  const d1 = D(16), d2 = D(18);
  GH.addBooking({ house: 'B', guestName: '비', checkIn: d1, checkOut: d2 });
  GH.addBooking({ house: 'C', guestName: '씨', checkIn: d1, checkOut: d2 });
  GH.addBooking({ house: 'D', guestName: '디', checkIn: d1, checkOut: d2 });
  const s = GH.threeRoomSummary(d1);
  eq(s.freeCount, 0);
  eq(s.label, '3룸 마감');
  eq(s.occupied.length, 3);
});

test('캘린더 칸과 상단 요약에 3룸 상태가 보인다', () => {
  GH.ui.month = GH.ymd(new Date(Y, M, 1));
  GH.switchView('calendar');
  const closed = ctx.$('.day[data-date="' + D(16) + '"]');
  assert(closed, '16일 칸 없음 (이번 달 기준)');
  const pill = closed.querySelector('.pill3');
  includes(pill.textContent, '마감');
  assert(pill.className.indexOf('fit-0') >= 0, '마감 색상이 아닙니다');
  const chip = ctx.$('.sum-chip[data-date="' + D(16) + '"]');
  assert(chip, '상단 요약 칩이 없습니다');
  includes(chip.textContent, '마감');
  const openChip = ctx.$('.sum-chip[data-date="' + TURN_D3 + '"]');
  includes(openChip.textContent, '3채 빈방');
});

test('3룸만 보기 필터는 B·C·D만 남긴다', () => {
  click(ctx.w, ctx.$('[data-action="cal-filter"][data-rooms="3"]'));
  const cell = ctx.$('.day[data-date="' + TURN_D2 + '"]');
  const houses = Array.from(cell.querySelectorAll('.hbar')).map((x) => x.getAttribute('data-house'));
  eq(houses.join(''), 'BCD');
  click(ctx.w, ctx.$('[data-action="cal-filter"][data-rooms="all"]'));
  const all = Array.from(ctx.$('.day[data-date="' + TURN_D2 + '"]').querySelectorAll('.hbar')).map((x) => x.getAttribute('data-house'));
  eq(all.join(''), 'ABCD');
});

/* ============================================================
   6. 손님 안내 (가용성 찾기 + 문구)
   ============================================================ */
console.log('\n[6] 손님 안내 문구');

test('빈 날짜를 찾아 하우스를 보여준다', () => {
  GH.switchView('finder');
  setVal(ctx.w, ctx.$('#qCheckIn'), D(24), 'change');
  setVal(ctx.w, ctx.$('#qCheckOut'), D(27), 'change');
  setVal(ctx.w, ctx.$('#qRooms'), '3', 'change');
  setVal(ctx.w, ctx.$('#qGuests'), '4');
  setVal(ctx.w, ctx.$('#qName'), '엘레나 고객');
  const form = ctx.$('#finderForm');
  form.dispatchEvent(new ctx.w.Event('submit', { bubbles: true, cancelable: true }));
  const cards = ctx.$$('.avail-card');
  eq(cards.length, 3, '3룸 3채가 보여야 합니다');
  const msg = ctx.$('#guestMessage').value;
  includes(msg, '엘레나 고객님');
  includes(msg, 'B하우스');
  includes(msg, 'C하우스');
  includes(msg, 'D하우스');
  includes(msg, '보증금');
  includes(msg, '감사합니다');
  includes(msg, '3박');
});

test('예약 문구를 복사할 수 있다', () => {
  const msg = ctx.$('#guestMessage').value;
  click(ctx.w, ctx.$('[data-action="copy-msg"]'));
  eq(ctx.clipboard.text, msg, '클립보드에 들어간 문구');
});

test('턴오버가 있는 하우스는 안내 문구에 퇴실 후 입실이 적힌다', () => {
  GH.switchView('finder');
  setVal(ctx.w, ctx.$('#qCheckIn'), TURN_D3, 'change');
  setVal(ctx.w, ctx.$('#qCheckOut'), D(12), 'change');
  setVal(ctx.w, ctx.$('#qRooms'), 'all', 'change');
  ctx.$('#finderForm').dispatchEvent(new ctx.w.Event('submit', { bubbles: true, cancelable: true }));
  const msg = ctx.$('#guestMessage').value;
  includes(msg, '앞 손님 퇴실 후 입실');
  includes(msg, 'B하우스');
});

test('빈 방이 없으면 정중히 마감 안내를 만든다', () => {
  const m = GH.buildGuestMessage({ checkIn: D(16), checkOut: D(18), houses: [] });
  includes(m, '예약 가능한 하우스가 없습니다');
  includes(m, '다른 날짜');
});

/* ============================================================
   7. 보증금 수명주기
   ============================================================ */
console.log('\n[7] 보증금 (D-7 수령 → 퇴실 후 반환)');

let depBookingId = null;
test('입실 D-7 이내 미수령 보증금이 대시보드에 뜬다', () => {
  const r = GH.addBooking({
    house: 'D', guestName: '보증금 손님', checkIn: T(3), checkOut: T(6),
    depositAmount: 5000, totalAmount: 18000
  });
  assert(r.ok, '예약 실패: ' + r.error);
  depBookingId = r.booking.id;
  eq(GH.depositStatus(r.booking), 'pending');
  const need = GH.depositReceiveNeeded().map((b) => b.id);
  assert(need.indexOf(depBookingId) >= 0, '수령 필요 목록에 없습니다');
  GH.switchView('today');
  const alert = ctx.$('[data-alert="deposit-receive"]');
  assert(alert, '보증금 수령 알림 카드가 없습니다');
  includes(alert.textContent, '보증금 수령 필요');
  includes(alert.textContent, '보증금 손님');
  includes(alert.textContent, 'D-3');
  assert(alert.querySelector('[data-action="dep-receive"]'), '수령 완료 버튼이 없습니다');
});

test('수령 완료 처리하면 미수령 알림에서 빠진다', () => {
  const res = GH.markDeposit(depBookingId, 'receive');
  assert(res.ok);
  eq(GH.depositStatus(res.booking), 'received');
  const need = GH.depositReceiveNeeded().map((b) => b.id);
  assert(need.indexOf(depBookingId) < 0, '아직 수령 필요로 남아 있습니다');
  GH.switchView('today');
  includes(ctx.$('[data-alert="deposit-receive"]').textContent, '없습니다');
});

test('퇴실 후 미반환 보증금이 반환 대기로 뜬다', () => {
  const r = GH.addBooking({
    house: 'A', guestName: '반환 손님', checkIn: T(-3), checkOut: T(0),
    depositAmount: 4000, depositReceivedAt: T(-4)
  });
  assert(r.ok, '예약 실패: ' + r.error);
  const ref = GH.depositRefundNeeded().map((b) => b.id);
  assert(ref.indexOf(r.booking.id) >= 0, '반환 대기 목록에 없습니다');
  GH.switchView('today');
  const card = ctx.$('[data-alert="deposit-refund"]');
  includes(card.textContent, '보증금 반환 대기');
  includes(card.textContent, '반환 손님');
  assert(card.querySelector('[data-action="dep-refund"]'), '반환 완료 버튼이 없습니다');
});

test('반환 완료 처리하면 배지와 알림이 바뀐다', () => {
  const b = GH.state.bookings.find((x) => x.guestName === '반환 손님');
  const res = GH.markDeposit(b.id, 'refund');
  assert(res.ok);
  eq(GH.depositStatus(res.booking), 'refunded');
  eq(GH.depositRefundNeeded().length, 0);
  GH.switchView('bookings');
  const card = ctx.$('.booking-card[data-bk="' + b.id + '"]');
  includes(card.textContent, '반환 완료');
  assert(card.querySelector('.badge.dep-refunded'), '반환 완료 배지 클래스');
});

test('폼에서 수령·반환 날짜로 상태가 정해진다', () => {
  const b = GH.state.bookings.find((x) => x.id === depBookingId);
  GH.openBookingForm(b);
  includes(ctx.$('#depFlag').textContent, '수령 완료');
  setVal(ctx.w, ctx.$('#fDepRefunded'), T(6), 'change');
  eq(ctx.$('#fDepReceived').value, b.depositReceivedAt, '수령일은 유지');
  includes(ctx.$('#depFlag').textContent, '반환 완료');
  click(ctx.w, ctx.$('[data-action="close-sheet"]'));
});

/* ============================================================
   8. 작업자 기록 (사장님 / 엘레나)
   ============================================================ */
console.log('\n[8] 공동 운영 — 작업자 기록');

test('작업자를 엘레나로 바꾸면 새 예약에 기록된다', () => {
  GH.setOperator('엘레나');
  eq(ctx.$('#operatorName').textContent, '엘레나');
  const r = GH.addBooking({ house: 'C', guestName: '엘레나 예약', checkIn: D(14), checkOut: D(16) });
  assert(r.ok, r.error);
  eq(r.booking.createdBy, '엘레나');
  eq(r.booking.updatedBy, '엘레나');
});

test('사장님이 수정하면 등록·수정이 함께 표시된다', () => {
  GH.setOperator('사장님');
  const b = GH.state.bookings.find((x) => x.guestName === '엘레나 예약');
  const r = GH.updateBooking(b.id, { note: '사장님이 메모 수정' });
  assert(r.ok, r.error);
  eq(r.booking.createdBy, '엘레나');
  eq(r.booking.updatedBy, '사장님');
  GH.ui.bkRange = 'all';
  GH.switchView('bookings');
  const card = ctx.$('.booking-card[data-bk="' + b.id + '"]');
  includes(card.textContent, '등록: 엘레나');
  includes(card.textContent, '수정: 사장님');
});

test('작업자 선택 시트에서 엘레나를 고를 수 있다', () => {
  click(ctx.w, ctx.$('#operatorBtn'));
  const sheet = ctx.$('.sheet');
  assert(sheet, '작업자 시트가 없습니다');
  includes(sheet.textContent, '사장님');
  includes(sheet.textContent, '엘레나');
  click(ctx.w, sheet.querySelector('[data-op="엘레나"]'));
  eq(GH.state.settings.operator, '엘레나');
  eq(ctx.$('#operatorName').textContent, '엘레나');
  GH.setOperator('사장님');
});

/* ============================================================
   9. Firebase 공동 운영 동기화
   ============================================================ */
console.log('\n[9] 공동 운영 동기화');

test('기본 상태는 로컬 저장만 사용 중', () => {
  const ctx3 = makeDom();
  eq(ctx3.$('#syncBadgeText').textContent, '로컬 저장만 사용 중');
  assert(ctx3.$('#syncBadge').className.indexOf('off') >= 0);
  ctx3.dom.window.close();
});

test('주소와 코드로 엔드포인트가 만들어진다', () => {
  const ep = GH.syncEndpoint({ url: 'https://my-proj-default-rtdb.firebaseio.com/', code: 'oraholic-cebu' });
  eq(ep, 'https://my-proj-default-rtdb.firebaseio.com/oraholic-guesthouse/oraholic-cebu.json');
});

test('동기화에 성공하면 공동 운영 상태와 상대 예약이 들어온다', async () => {
  const ctx4 = makeDom();
  const w = ctx4.w;
  const g = w.__GH;
  const remote = {
    bookings: [{
      id: 'remote-1', house: 'D', source: '에어비앤비', guestName: '엘레나 손님',
      checkIn: '2026-12-01', checkOut: '2026-12-03', checkInTime: '15:00', checkOutTime: '11:00',
      baseGuests: 3, extraGuests: 0, mattress: 0, depositAmount: 5000,
      updatedAt: 10, createdBy: '엘레나', updatedBy: '엘레나'
    }]
  };
  let putBody = null;
  w.fetch = function (url, opts) {
    if (opts && opts.method === 'PUT') { putBody = JSON.parse(opts.body); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(remote) });
  };
  g.state.sync.url = 'https://demo.firebaseio.com';
  g.state.sync.code = 'oraholic-cebu';
  g.state.sync.enabled = true;
  const res = await g.syncNow({ force: true });
  assert(res.ok, '동기화 실패: ' + JSON.stringify(res));
  eq(ctx4.$('#syncBadgeText').textContent, '공동 운영 동기화 연결됨');
  assert(ctx4.$('#syncBadge').className.indexOf('on') >= 0);
  assert(g.state.bookings.some((b) => b.guestName === '엘레나 손님'), '상대 예약이 합쳐지지 않았습니다');
  assert(putBody && putBody.bookings.length >= 1, '합친 장부를 올리지 않았습니다');
  assert(g.state.sync.lastSync, '마지막 동기화 시간이 없습니다');
  g.state.sync.enabled = false;
  ctx4.dom.window.close();
});

test('동기화가 실패하면 오류 상태로 두고 로컬 저장을 지킨다', async () => {
  const ctx5 = makeDom();
  const w = ctx5.w;
  const g = w.__GH;
  g.addBooking({ house: 'A', guestName: '로컬 손님', checkIn: '2026-12-05', checkOut: '2026-12-07' });
  w.fetch = function () { return Promise.reject(new Error('offline')); };
  g.state.sync.url = 'https://demo.firebaseio.com';
  g.state.sync.code = 'oraholic-cebu';
  g.state.sync.enabled = true;
  const res = await g.syncNow({ force: true });
  eq(res.ok, false);
  eq(ctx5.$('#syncBadgeText').textContent, '동기화 오류 · 로컬 저장 중');
  eq(g.state.bookings.length, 1, '로컬 예약은 그대로');
  g.state.sync.enabled = false;
  ctx5.dom.window.close();
});

test('설정 화면에 3단계 안내와 코드 입력이 있다', () => {
  GH.switchView('settings');
  const txt = ctx.$('#syncBlock').textContent;
  includes(txt, 'Firebase');
  includes(txt, 'Realtime Database');
  includes(txt, '공유 코드');
  includes(txt, 'console.firebase.google.com');
  assert(ctx.$('#syncUrl'), '주소 입력칸');
  assert(ctx.$('#syncCode'), '코드 입력칸');
  assert(ctx.$('#syncEnableBtn'), '연결 버튼');
});

/* ============================================================
   10. 샘플 / 초기화 / 백업
   ============================================================ */
console.log('\n[10] 샘플 데이터 · 초기화 · 백업');

test('샘플 데이터에 턴오버·3룸·보증금 사례가 들어 있다', () => {
  GH.loadSample();
  eq(GH.state.bookings.length, 7);
  const list = GH.state.bookings;
  assert(list.some((b) => b.house === 'A' && b.checkOut === list.find((x) => x.house === 'A' && x.checkIn === b.checkOut)?.checkIn), 'A하우스 턴오버 샘플');
  assert(list.some((b) => b.addons.ate && b.addons.ateName), '배정된 아떼 이름 샘플');
  assert(list.some((b) => b.addons.ate && b.mattress > 0), '아떼·매트리스 샘플');
  assert(list.some((b) => b.createdBy === '엘레나'), '엘레나가 등록한 샘플');
  assert(GH.depositReceiveNeeded().length > 0, '수령 필요 샘플');
  assert(GH.depositRefundNeeded().length > 0, '반환 대기 샘플');
  GH.switchView('today');
  const txt = ctx.$('#viewToday').textContent;
  includes(txt, '오늘 입실');
  includes(txt, '보증금 알림');
  includes(txt, '오늘 준비');
  includes(txt, '3룸 빈방');
});

test('JSON 내보내기 데이터에 예약이 들어 있다', () => {
  const data = GH.exportJSON();
  eq(data.app, 'oraholic-guesthouse');
  eq(data.bookings.length, 7);
  assert(data.exportedAt);
});

test('JSON 가져오기로 예약을 복원한다', () => {
  const json = JSON.stringify({ bookings: [
    { house: 'B', guestName: '가져온 손님', checkIn: '2026-12-10', checkOut: '2026-12-12', source: '기타' }
  ] });
  const r = GH.importJSON(json);
  assert(r.ok);
  eq(GH.state.bookings.length, 1);
  eq(GH.state.bookings[0].guestName, '가져온 손님');
});

test('전체 초기화 후 빈 상태가 된다', () => {
  GH.resetAll();
  eq(GH.state.bookings.length, 0);
  eq(JSON.parse(ctx.w.localStorage.getItem('oraholic-guesthouse-v1')).bookings.length, 0);
  GH.switchView('calendar');
  includes(ctx.$('#viewCalendar').textContent, '3룸 마감');
});

/* ============================================================
   11. PWA / 정적 파일
   ============================================================ */
console.log('\n[11] PWA · 상대 경로');

test('index.html이 상대 경로만 사용한다', () => {
  includes(INDEX, 'href="./manifest.json"');
  includes(INDEX, 'href="./styles.css"');
  includes(INDEX, 'src="./app.js"');
  includes(INDEX, 'href="./icon.svg"');
  const absolute = INDEX.match(/(?:href|src)="\/[^"]*"/g);
  eq(absolute, null, '절대 경로가 있습니다: ' + JSON.stringify(absolute));
});

test('manifest가 GitHub Pages 하위 경로용 상대 경로다', () => {
  const m = JSON.parse(MANIFEST);
  eq(m.start_url, './index.html');
  eq(m.scope, './');
  eq(m.lang, 'ko');
  assert(m.icons.length >= 3);
  assert(m.icons.some((i) => i.src === './icon-192.png'));
  assert(m.icons.some((i) => i.src === './icon-512.png'));
  assert(m.icons.some((i) => i.purpose === 'maskable'));
});

test('서비스 워커가 상대 경로 자산을 캐시한다', () => {
  includes(SW, "'./index.html'");
  includes(SW, "'./app.js'");
  includes(SW, "'./styles.css'");
  includes(SW, "'./confirmation.js'");
  assert(!/'\/(index\.html|app\.js|styles\.css)'/.test(SW), '루트 절대 경로 캐시가 있습니다');
});

test('앱 아이콘 파일이 실제로 있다', () => {
  ['icon-192.png', 'icon-512.png', 'icon.svg', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png'].forEach((f) => {
    const p = path.join(ROOT, f);
    assert(fs.existsSync(p), f + ' 없음');
    assert(fs.statSync(p).size > 200, f + ' 파일이 비어 있습니다');
  });
});

/* ============================================================
   12. 레이아웃 스모크
   ============================================================ */
console.log('\n[12] 화면 구성');

test('캘린더에 7요일 머리글과 날짜 칸이 그려진다', () => {
  GH.switchView('calendar');
  eq(ctx.$$('.cal-dow span').length, 7);
  assert(ctx.$$('.day').length >= 28, '날짜 칸이 부족합니다');
  eq(ctx.$$('.sum-chip').length, new Date(Y, M + 1, 0).getDate(), '3룸 요약 칩 수');
});

test('모바일 하단 탭 6개와 데스크톱 탭 6개', () => {
  eq(ctx.$$('#mobileTabs [data-view]').length, 6);
  eq(ctx.$$('#tabs [data-view]').length, 6);
});

test('모든 화면이 오류 없이 그려진다', () => {
  ['calendar', 'today', 'bookings', 'finder', 'confirm', 'settings'].forEach((v) => {
    GH.switchView(v);
    const el = ctx.$('#view' + v.charAt(0).toUpperCase() + v.slice(1));
    assert(el && !el.classList.contains('hidden'), v + ' 화면이 숨겨졌습니다');
    assert(el.innerHTML.length > 200, v + ' 화면이 비어 있습니다');
  });
});

/* ============================================================
   13. 예약 확정서 (Canvas PNG)
   ============================================================ */
console.log('\n[13] 예약 확정서');

test('확정서 모델이 예약에서 자동으로 채워진다', () => {
  const b = {
    house: 'B', guestName: '김동준', checkIn: '2027-07-02', checkOut: '2027-07-30',
    baseGuests: 5, extraGuests: 0, totalAmount: 2300000, checkInTime: '23:30', checkOutTime: '01:00',
    mattress: 2, pickup: true, addons: { ate: true, ateName: '마리엘' }
  };
  const m = GH.buildConfirmModel(b, { payer: '김우열', companions: '박경자, 김우열, 김하린, 김유찬' });
  eq(m.guestLine, '김동준 (입금자: 김우열)');
  eq(m.guestsLine, '김동준 외 4인');
  eq(m.stayLine, '2027. 07. 02  ~  2027. 07. 30');
  eq(m.staySub, '(총 28박 29일)');
  eq(m.season, '성수기');
  eq(m.room, 'B하우스 (3룸)');
  eq(m.roomsLabel, '3룸');
  eq(m.status, '예약확정');
  eq(m.total, 2300000);
  includes(m.arrive, '2027. 07. 02');
  includes(m.arrive, '23:30');
  eq(m.addonDetail.mattress, '×2');
  eq(m.addonDetail.ate, '마리엘');
  eq(GH.confirmFilename(m), '김동준2027.07.02.png');
});

test('5룸 · 비수기 등 다른 예약도 확정서에 반영된다', () => {
  const m = GH.buildConfirmModel({
    house: 'A', guestName: '이서연', checkIn: '2026-12-05', checkOut: '2026-12-08',
    baseGuests: 10, totalAmount: 300000, addons: { ate: false }
  }, { season: '비수기', room: 'A하우스 (5룸) · 독채' });
  eq(m.season, '비수기');
  eq(m.roomsLabel, '5룸');
  eq(m.room, 'A하우스 (5룸) · 독채');
  eq(m.staySub, '(총 3박 4일)');
  eq(GH.confirmFilename(m), '이서연2026.12.05.png');
});

test('고정 디자인·요금표·규정 문구가 템플릿에 그대로 있다', () => {
  ['ORAHOLIC', 'Reservation Confirmation', '비수기 숙박 비용', '성수기 숙박 비용',
    '90,000', '110,000', '66,000', '80,000', '아떼; 집안일 도우미',
    '양도 규정', '취소 환불 규정', '체크인 7일 전까지 취소', '50% 환불', '환불 불가',
    '입/퇴실 안내', 'Thank you! ♥', '프로모션으로 구매한 내용은 양도 및 취소 불가',
    '오라홀릭을 선택해 주셔서 감사합니다', '이용 안내'].forEach((k) => includes(CONF, k, '확정서 템플릿에 "' + k + '"'));
});

test('확정서 탭이 열리고 예약을 고를 수 있다', () => {
  GH.loadSample();
  GH.switchView('confirm');
  assert(ctx.$('#confBooking'), '예약 선택이 없습니다');
  assert(ctx.$$('#confBooking option').length >= 7, '예약 목록이 부족합니다');
  assert(ctx.$('[data-action="conf-open"]'), '확정서 만들기 버튼이 없습니다');
  assert(ctx.$('[data-action="conf-blank"]'), '빈 확정서 버튼이 없습니다');
});

test('예약 카드마다 확정서 버튼이 있다', () => {
  GH.switchView('bookings');
  GH.ui.bkRange = 'all';
  GH.switchView('bookings');
  const cards = ctx.$$('.booking-card');
  assert(cards.length > 0);
  cards.forEach((c) => assert(c.querySelector('[data-action="confirmation"]'), '확정서 버튼이 없는 카드'));
});

test('확정서 버튼으로 미리보기와 편집 필드가 열린다', () => {
  const first = ctx.$('.booking-card');
  click(ctx.w, first.querySelector('[data-action="confirmation"]'));
  const sheet = ctx.$('.sheet');
  assert(sheet, '확정서 시트가 열리지 않았습니다');
  includes(sheet.textContent, '예약 확정서');
  assert(ctx.$('#confirmCanvas'), '미리보기 캔버스가 없습니다');
  assert(ctx.$('#cGuest'), '예약자 입력');
  assert(ctx.$('#cPayer'), '입금자 입력');
  assert(ctx.$('#cGuestsLine'), '숙박인 입력');
  assert(ctx.$('#cStart') && ctx.$('#cEnd'), '숙박기간 입력');
  assert(ctx.$('#cSeason') && ctx.$('#cRoom') && ctx.$('#cStatus'), '숙박 정보 입력');
  assert(ctx.$('#cAirline') && ctx.$('#cArrive') && ctx.$('#cDepart'), '항공편 입력');
  assert(ctx.$('#cStayAmt') && ctx.$('#cAteAmt') && ctx.$('#cPickupAmt') && ctx.$('#cEtcAmt'), '금액 내역 입력');
  assert(ctx.$('#cMattress') && ctx.$('#cSetting') && ctx.$('#cPickupDetail') && ctx.$('#cAteDetail'), '추가 서비스 입력');
  includes(ctx.$('#confFilename').textContent, '.png');
});

test('확정서 필드를 고치면 모델과 파일명이 바뀐다', () => {
  setVal(ctx.w, ctx.$('#cGuest'), '김동준');
  setVal(ctx.w, ctx.$('#cPayer'), '김우열');
  setVal(ctx.w, ctx.$('#cCompanions'), '박경자, 김우열');
  setVal(ctx.w, ctx.$('#cSeason'), '비수기', 'change');
  setVal(ctx.w, ctx.$('#cRoom'), 'Bk14 L5');
  setVal(ctx.w, ctx.$('#cStayAmt'), '2100000', 'input');
  setVal(ctx.w, ctx.$('#cAteAmt'), '200000', 'input');
  const m = GH.renderConfPreview();
  eq(m.guestLine, '김동준 (입금자: 김우열)');
  eq(m.companions, '박경자, 김우열');
  eq(m.season, '비수기');
  eq(m.room, 'Bk14 L5');
  eq(m.total, 2300000, '금액 내역 합계가 총 금액에 반영');
  eq(ctx.$('#cTotal').value, '2300000');
  eq(GH.confirmFilename(m), '김동준' + m.startISO.replace(/-/g, '.') + '.png');
  includes(ctx.$('#confFilename').textContent, '김동준');
});

test('빈 확정서도 열린다', () => {
  click(ctx.w, ctx.$('[data-action="close-sheet"]'));
  GH.switchView('confirm');
  click(ctx.w, ctx.$('[data-action="conf-blank"]'));
  assert(ctx.$('.sheet'), '빈 확정서 시트');
  eq(ctx.$('#cGuest').value, '');
  assert(ctx.$('#confirmCanvas'));
  eq(ctx.$('#cRoom').value.indexOf('A하우스'), 0);
  click(ctx.w, ctx.$('[data-action="close-sheet"]'));
});

test('투숙객 전원 성명과 항공편이 확정서에 자동으로 들어간다', () => {
  const m = GH.buildConfirmModel({
    house: 'A', guestName: '김동준',
    guestNames: '김동준, 박경자, 김우열, 김하린, 김유찬',
    checkIn: '2027-07-02', checkOut: '2027-07-30', baseGuests: 5, totalAmount: 2300000,
    airline: '대한항공', flightNo: 'KE631',
    arriveDate: '2027-07-02', arriveTime: '23:30', departDate: '2027-07-30', departTime: '01:00'
  }, {});
  eq(m.guestsLine, '김동준 외 4인');
  eq(m.companions, '박경자, 김우열, 김하린, 김유찬');
  eq(m.airline, '대한항공 KE631');
  includes(m.arrive, '2027. 07. 02');
  includes(m.arrive, '23:30');
  includes(m.depart, '2027. 07. 30');
  includes(m.depart, '01:00');
});

test('확정서 시트의 숙박인·항공 정보가 예약에서 채워진다', () => {
  GH.switchView('confirm');
  click(ctx.w, ctx.$('[data-action="conf-open"]'));
  const sheet = ctx.$('.sheet');
  assert(sheet, '확정서 시트가 열려 있어야 합니다');
  includes(ctx.$('#cGuestsLine').value, '외');
  assert(ctx.$('#cCompanions').value.length > 0, '동반자 이름이 채워지지 않았습니다');
  assert(ctx.$('#cAirline').value.indexOf('5J 038') >= 0, '항공편명이 함께 보여야 합니다: ' + ctx.$('#cAirline').value);
  assert(ctx.$('#cArrive').value.length > 8, '세부 도착 일시가 비어 있습니다');
  assert(ctx.$('#cDepart').value.length > 8, '세부 출발 일시가 비어 있습니다');
  click(ctx.w, ctx.$('[data-action="close-sheet"]'));
});

/* ============================================================
   14. 접속 비밀번호 잠금
   ============================================================ */
console.log('\n[14] 접속 비밀번호 잠금');

test('앱을 처음 열면 잠금 화면이 뜨고 앱 껍데기는 숨겨진다', () => {
  const L = makeDom(null, { locked: true });
  const shell = L.$('#app-shell');
  const screen = L.$('#lockScreen');
  assert(shell, '#app-shell 이 없습니다');
  assert(shell.hasAttribute('hidden'), '앱 껍데기에 hidden 이 있어야 합니다');
  assert(shell.classList.contains('hidden'), '앱 껍데기가 숨겨져 있어야 합니다');
  assert(screen, '잠금 화면이 없습니다');
  assert(!screen.classList.contains('hidden'), '잠금 화면이 보여야 합니다');
  includes(screen.textContent, '오라홀릭 게스트하우스');
  includes(screen.textContent, '관리자 로그인');
  assert(L.$('#lockPin'), '비밀번호 입력칸이 없습니다');
  eq(L.$('#lockSubmit').getAttribute('type'), 'submit', 'Enter 로도 제출되도록 submit 버튼');
  assert(L.$('#lockKeep').checked, '"이 기기에서 로그인 유지"는 기본 체크여야 합니다');
  includes(L.$('#lockDefaultHint').textContent, '0000');
  eq(L.w.__GH.locked, true);
  L.dom.window.close();
});

test('잠긴 동안에는 예약 데이터가 그려지지 않는다', () => {
  const preload = JSON.stringify({
    bookings: [{ id: 'secret-1', house: 'A', guestName: '숨은손님', checkIn: '2026-12-01', checkOut: '2026-12-03' }]
  });
  const L = makeDom(preload, { locked: true });
  eq(L.w.__GH.state.bookings.length, 1, '데이터는 읽혀 있어도');
  eq(L.$('#viewCalendar').innerHTML, '', '캘린더는 비어 있어야 합니다');
  eq(L.$('#viewBookings').innerHTML, '', '예약 화면은 비어 있어야 합니다');
  assert(L.d.body.textContent.indexOf('숨은손님') < 0, '잠금 화면 뒤에 손님 이름이 남으면 안 됩니다');
  L.w.__GH.renderAll();
  eq(L.$('#viewCalendar').innerHTML, '', '잠긴 상태의 renderAll 은 그리지 않습니다');
  L.dom.window.close();
});

test('틀린 비밀번호는 잠금을 풀지 못하고 안내 문구를 보여 준다', () => {
  const L = makeDom(null, { locked: true });
  setVal(L.w, L.$('#lockPin'), '1234');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__GH.locked, true, '잠금이 유지되어야 합니다');
  assert(L.$('#app-shell').hasAttribute('hidden'));
  includes(L.$('#lockError').textContent, '맞지 않습니다');
  eq(L.$('#lockPin').value, '', '틀리면 입력칸을 비웁니다');
  assert(!L.w.localStorage.getItem(L.w.__GH.AUTH_KEY), '틀린 비밀번호로 로그인 기록을 남기지 않습니다');
  eq(L.$$('.day').length, 0);
  L.dom.window.close();
});

test('기본 비밀번호 0000 으로 잠금이 풀린다', () => {
  const L = makeDom(null, { locked: true });
  includes(L.$('#lockDefaultHint').textContent, '0000');
  setVal(L.w, L.$('#lockPin'), '0000');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__GH.locked, false, '잠금이 풀려야 합니다');
  assert(!L.$('#app-shell').hasAttribute('hidden'), '앱이 보여야 합니다');
  assert(L.$('#lockScreen').classList.contains('hidden'), '잠금 화면이 사라져야 합니다');
  assert(L.$$('.day').length >= 28, '캘린더가 그려져야 합니다');
  assert(L.w.localStorage.getItem(L.w.__GH.AUTH_KEY), '"이 기기에서 로그인 유지"를 켰으니 localStorage 에 기록');
  assert(!L.w.sessionStorage.getItem(L.w.__GH.AUTH_KEY));
  L.dom.window.close();
});

test('"이 기기에서 로그인 유지"를 끄면 이 탭에서만 유지된다', () => {
  const L = makeDom(null, { locked: true });
  L.$('#lockKeep').checked = false;
  setVal(L.w, L.$('#lockPin'), '0000');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__GH.locked, false);
  assert(L.w.sessionStorage.getItem(L.w.__GH.AUTH_KEY), 'sessionStorage 에 기록');
  assert(!L.w.localStorage.getItem(L.w.__GH.AUTH_KEY), 'localStorage 에는 남기지 않습니다');
  L.dom.window.close();
});

test('로그인 유지 기록이 있으면 다시 열 때 비밀번호를 묻지 않는다', () => {
  const first = makeDom(null, { locked: true });
  setVal(first.w, first.$('#lockPin'), '0000');
  fire(first.w, first.$('#lockForm'), 'submit');
  const rec = first.w.localStorage.getItem(first.w.__GH.AUTH_KEY);
  assert(rec, '로그인 기록이 없습니다');
  const again = makeDom(null, { locked: true, preAuth: rec });
  eq(again.w.__GH.locked, false, '저장된 로그인으로 바로 열려야 합니다');
  assert(!again.$('#app-shell').hasAttribute('hidden'));
  assert(again.$('#lockScreen').classList.contains('hidden'));
  first.dom.window.close();
  again.dom.window.close();
});

test('비밀번호를 바꾸면 이전 비밀번호로는 열리지 않는다', () => {
  const L = makeDom(null, { locked: true });
  eq(L.w.__GH.attemptUnlock('0000', true), true);
  const r = L.w.__GH.changePin('0000', '2580');
  assert(r.ok, r.message);
  includes(r.message, '바꿨습니다');
  eq(L.w.__GH.isDefaultPin(), false);
  const saved = JSON.parse(L.w.localStorage.getItem('oraholic-guesthouse-v1'));
  assert(saved.security && saved.security.pinHash, '비밀번호가 이 기기에 저장되지 않았습니다');
  eq(saved.security.pinHash, L.w.__GH.hashPin('2580'));
  L.w.__GH.lockNow({ silent: true });
  eq(L.w.__GH.locked, true);
  setVal(L.w, L.$('#lockPin'), '0000');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__GH.locked, true, '이전 비밀번호로는 열리지 않아야 합니다');
  setVal(L.w, L.$('#lockPin'), '2580');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__GH.locked, false, '새 비밀번호로 열려야 합니다');
  assert(L.$('#lockDefaultHint').classList.contains('hidden'), '기본 비밀번호 안내는 사라져야 합니다');
  L.dom.window.close();
});

test('설정의 "접속 비밀번호 변경"으로 바꿀 수 있다', () => {
  const L = makeDom();
  L.w.__GH.switchView('settings');
  const block = L.$('#lockBlock');
  assert(block, '설정에 접속 비밀번호 구역이 없습니다');
  includes(block.textContent, '접속 비밀번호');
  assert(L.$('#pinCurrent') && L.$('#pinNew') && L.$('#pinNew2'), '입력칸 3개');
  assert(L.$('[data-action="lock-now"]'), '설정의 잠금 버튼이 없습니다');

  setVal(L.w, L.$('#pinCurrent'), '0000');
  setVal(L.w, L.$('#pinNew'), '12');
  setVal(L.w, L.$('#pinNew2'), '12');
  fire(L.w, L.$('#pinForm'), 'submit');
  includes(L.$('#pinNotice').textContent, '4자 이상');
  eq(L.w.__GH.isDefaultPin(), true, '짧은 비밀번호는 바꾸지 않습니다');

  setVal(L.w, L.$('#pinCurrent'), '9999');
  setVal(L.w, L.$('#pinNew'), '4821');
  fire(L.w, L.$('#pinForm'), 'submit');
  includes(L.$('#pinNotice').textContent, '지금 비밀번호가 맞지 않습니다');

  setVal(L.w, L.$('#pinCurrent'), '0000');
  setVal(L.w, L.$('#pinNew'), '4821');
  setVal(L.w, L.$('#pinNew2'), '9999');
  fire(L.w, L.$('#pinForm'), 'submit');
  includes(L.$('#pinNotice').textContent, '서로 다릅니다');

  setVal(L.w, L.$('#pinCurrent'), '0000');
  setVal(L.w, L.$('#pinNew'), '4821');
  setVal(L.w, L.$('#pinNew2'), '4821');
  fire(L.w, L.$('#pinForm'), 'submit');
  includes(L.$('#pinNotice').textContent, '바꿨습니다');
  eq(L.$('#pinCurrent').value, '', '바꾼 뒤 입력칸을 비웁니다');
  eq(L.w.__GH.locked, false, '바꾼 뒤에도 열린 상태로 남습니다');
  eq(L.w.__GH.hashPin('4821'), L.w.__GH.state.security.pinHash);
  L.dom.window.close();
});

test('상단 잠금 버튼으로 언제든 다시 잠근다', () => {
  const L = makeDom();
  eq(L.w.__GH.locked, false);
  assert(L.$('#lockBtn'), '상단 잠금 버튼이 없습니다');
  click(L.w, L.$('#lockBtn'));
  eq(L.w.__GH.locked, true);
  assert(L.$('#app-shell').hasAttribute('hidden'), '앱이 가려져야 합니다');
  assert(!L.$('#lockScreen').classList.contains('hidden'), '잠금 화면이 보여야 합니다');
  assert(!L.w.localStorage.getItem(L.w.__GH.AUTH_KEY), '로그인 기록을 지웁니다');
  assert(!L.w.sessionStorage.getItem(L.w.__GH.AUTH_KEY), '세션 기록도 지웁니다');
  eq(L.$('#viewCalendar').innerHTML, '', '잠글 때 예약 화면을 비웁니다');
  eq(L.$$('.day').length, 0);
  setVal(L.w, L.$('#lockPin'), '0000');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(L.w.__GH.locked, false, '다시 비밀번호로 열 수 있습니다');
  L.dom.window.close();
});

test('공동 운영 동기화로 바뀐 접속 비밀번호가 전해진다', async () => {
  const L = makeDom();
  const g = L.w.__GH;
  let putBody = null;
  L.w.fetch = function (url, opts) {
    if (opts && opts.method === 'PUT') { putBody = JSON.parse(opts.body); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ bookings: [] }) });
  };
  g.changePin('0000', '7777');
  g.state.sync.url = 'https://demo.firebaseio.com';
  g.state.sync.code = 'oraholic-cebu';
  g.state.sync.enabled = true;
  const res = await g.syncNow({ force: true });
  assert(res.ok, '동기화 실패: ' + JSON.stringify(res));
  assert(putBody && putBody.security && putBody.security.pinHash, '비밀번호 해시를 함께 올리지 않았습니다');
  eq(putBody.security.pinHash, g.hashPin('7777'));
  assert(g.state.security.pinUpdatedAt > 0, '바꾼 시각을 남깁니다');
  g.state.sync.enabled = false;
  L.dom.window.close();
});

test('상대 기기가 바꾼 비밀번호를 동기화로 받는다', async () => {
  const L = makeDom();
  const g = L.w.__GH;
  const remote = { bookings: [], security: { pinHash: g.hashPin('1357'), pinUpdatedAt: Date.now() + 5000 } };
  L.w.fetch = function (url, opts) {
    if (opts && opts.method === 'PUT') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(remote) });
  };
  g.state.sync.url = 'https://demo.firebaseio.com';
  g.state.sync.code = 'oraholic-cebu';
  g.state.sync.enabled = true;
  const res = await g.syncNow({ force: true });
  assert(res.ok, '동기화 실패: ' + JSON.stringify(res));
  eq(g.isDefaultPin(), false, '상대가 바꾼 비밀번호를 받아들여야 합니다');
  g.lockNow({ silent: true });
  setVal(L.w, L.$('#lockPin'), '1357');
  fire(L.w, L.$('#lockForm'), 'submit');
  eq(g.locked, false, '받은 새 비밀번호로 열려야 합니다');
  g.state.sync.enabled = false;
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
