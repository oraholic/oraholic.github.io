'use strict';

/* ============================================================
   오라홀릭 게스트하우스 — app.js
   A·B·C·D 4채 예약/캘린더 · 당일 턴오버 · 3룸 빈방 · 보증금
   공동 운영(작업자 기록 + Firebase 실시간 동기화)
   ============================================================ */

(function () {
  /* ---------- 0. 기본 상수 ---------- */
  const LS_KEY = 'oraholic-guesthouse-v1';
  const AUTH_KEY = 'oraholic-guesthouse-auth-v1';
  const DEFAULT_PIN = '0000';
  const PIN_MIN_LEN = 4;
  const PIN_MAX_LEN = 12;
  const APP_VERSION = '1.1.1';
  const TEST = !!window.__GH_TEST__;
  const MAX_SYNC_MS = 20000;

  const HOUSES = [
    { id: 'A', name: 'A하우스', rooms: 5, baseGuests: 10, short: '5룸', desc: '5룸 · 독채' },
    { id: 'B', name: 'B하우스', rooms: 3, baseGuests: 6, short: '3룸', desc: '3룸 · 뒷마당' },
    { id: 'C', name: 'C하우스', rooms: 3, baseGuests: 6, short: '3룸', desc: '3룸 · 화장실 3개' },
    { id: 'D', name: 'D하우스', rooms: 3, baseGuests: 6, short: '3룸', desc: '3룸 · 2층 테라스' }
  ];
  const THREE_HOUSES = ['B', 'C', 'D'];
  const SOURCES = ['개별', '에어비앤비', '기타'];
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const OPERATOR_PRESETS = ['사장님', '엘레나'];

  /* ---------- 1. 유틸 ---------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rid = () => 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) { const p = String(s || '').split('-').map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); }
  function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  function todayStr() { return ymd(new Date()); }
  function shiftStr(ds, n) { return ymd(addDays(parseYmd(ds), n)); }
  function nights(ci, co) {
    if (!ci || !co) return 0;
    return Math.max(0, Math.round((parseYmd(co) - parseYmd(ci)) / 86400000));
  }
  function fmtMD(ds) { const d = parseYmd(ds); return (d.getMonth() + 1) + '/' + d.getDate(); }
  function fmtDateLong(ds) { const d = parseYmd(ds); return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + DOW[d.getDay()] + ')'; }
  function fmtDateFull(ds) { const d = parseYmd(ds); return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + DOW[d.getDay()] + ')'; }
  function fmtDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function money(n) { return '₱' + num(n).toLocaleString('en-US'); }
  function daysFromToday(ds) { return Math.round((parseYmd(ds) - parseYmd(todayStr())) / 86400000); }
  function dLabel(ds) {
    const n = daysFromToday(ds);
    if (n === 0) return '오늘';
    if (n === 1) return '내일';
    if (n === -1) return '어제';
    return n > 0 ? 'D-' + n : 'D+' + Math.abs(n);
  }
  function houseById(id) { return HOUSES.find((h) => h.id === id) || HOUSES[0]; }
  function srcCls(src) { return src === '에어비앤비' ? 'airbnb' : src === '기타' ? 'other' : 'direct'; }

  /* ---------- 2. 상태 ---------- */
  function defaultState() {
    return {
      v: 1,
      bookings: [],
      settings: { operator: '사장님', currency: 'PHP' },
      security: { pinHash: hashPin(DEFAULT_PIN), pinUpdatedAt: 0 },
      sync: { url: '', code: '', enabled: false, lastSync: null },
      deviceId: rid(),
      updatedAt: 0
    };
  }

  function normalizeBooking(raw) {
    const b = Object.assign({}, raw || {});
    const h = houseById(b.house);
    b.id = b.id || rid();
    b.house = ['A', 'B', 'C', 'D'].indexOf(b.house) >= 0 ? b.house : 'A';
    b.source = SOURCES.indexOf(b.source) >= 0 ? b.source : '개별';
    b.guestName = String(b.guestName || '').trim();
    b.phone = String(b.phone || '').trim();
    b.payer = String(b.payer || '').trim();
    b.guestNames = String(b.guestNames || '').trim();
    b.checkIn = String(b.checkIn || '');
    b.checkInTime = String(b.checkInTime || '15:00');
    b.checkOut = String(b.checkOut || '');
    b.checkOutTime = String(b.checkOutTime || '11:00');
    b.airline = String(b.airline || '').trim();
    b.flightNo = String(b.flightNo || '').trim();
    b.arriveDate = String(b.arriveDate || b.checkIn || '');
    b.arriveTime = String(b.arriveTime || b.checkInTime || '');
    b.departDate = String(b.departDate || b.checkOut || '');
    b.departTime = String(b.departTime || b.checkOutTime || '');
    b.nightFlight = !!b.nightFlight;
    b.baseGuests = clamp(num(b.baseGuests) || h.baseGuests, 1, 30);
    b.extraGuests = clamp(num(b.extraGuests), 0, 20);
    const a = b.addons || {};
    b.addons = {
      ate: !!a.ate, ateNote: String(a.ateNote || ''), ateName: String(a.ateName || ''),
      babysitter: !!a.babysitter, babysitterNote: String(a.babysitterNote || ''),
      tutor: !!a.tutor, tutorNote: String(a.tutorNote || '')
    };
    b.mattress = clamp(num(b.mattress), 0, 10);
    b.pickup = !!b.pickup;
    b.dropoff = !!b.dropoff;
    b.pickupNote = String(b.pickupNote || '');
    b.totalAmount = num(b.totalAmount);
    b.prepaid = num(b.prepaid);
    b.depositAmount = num(b.depositAmount);
    b.depositReceivedAt = String(b.depositReceivedAt || '');
    b.depositRefundedAt = String(b.depositRefundedAt || '');
    b.note = String(b.note || '');
    b.createdBy = String(b.createdBy || '');
    b.createdAt = num(b.createdAt);
    b.updatedBy = String(b.updatedBy || '');
    b.updatedAt = num(b.updatedAt);
    b.deleted = !!b.deleted;
    return b;
  }

  let state = defaultState();

  function loadLocal() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') return;
    const base = defaultState();
    state = Object.assign(base, raw);
    state.bookings = (raw.bookings || []).map(normalizeBooking);
    state.settings = Object.assign(base.settings, raw.settings || {});
    state.sync = Object.assign(base.sync, raw.sync || {});
    state.security = Object.assign({ pinHash: hashPin(DEFAULT_PIN), pinUpdatedAt: 0 }, raw.security || {});
    if (!state.security.pinHash) state.security.pinHash = hashPin(DEFAULT_PIN);
    if (!num(state.security.pinUpdatedAt)) state.security.pinUpdatedAt = 0;
    if (!state.settings.operator) state.settings.operator = '사장님';
  }

  function saveLocal() {
    state.updatedAt = Date.now();
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* 저장 공간 부족 */ }
  }
  function save(push) {
    saveLocal();
    if (push !== false && state.sync.enabled) scheduleSync();
  }

  /* ---------- 3. 예약 로직 ---------- */
  const liveBookings = () => state.bookings.filter((b) => !b.deleted);

  function isOccupied(houseId, ds, excludeId) {
    return liveBookings().some((b) => b.house === houseId && b.id !== excludeId && b.checkIn <= ds && ds < b.checkOut);
  }
  function conflictFor(houseId, ci, co, excludeId) {
    if (!ci || !co) return null;
    return liveBookings().find((b) => b.house === houseId && b.id !== excludeId && ci < b.checkOut && b.checkIn < co) || null;
  }
  function turnoverFor(houseId, ci, co, excludeId) {
    const outs = liveBookings().filter((b) => b.house === houseId && b.id !== excludeId && b.checkOut === ci);
    const ins = liveBookings().filter((b) => b.house === houseId && b.id !== excludeId && b.checkIn === co);
    return { outs, ins, any: outs.length > 0 || ins.length > 0 };
  }
  function eventsOn(houseId, ds, excludeId) {
    const out = liveBookings().filter((b) => b.house === houseId && b.id !== excludeId && b.checkOut === ds);
    const inn = liveBookings().filter((b) => b.house === houseId && b.id !== excludeId && b.checkIn === ds);
    const stay = liveBookings().filter((b) => b.house === houseId && b.id !== excludeId && b.checkIn < ds && ds < b.checkOut);
    return { out: out[0] || null, in: inn[0] || null, stay: stay[0] || null, turnover: !!(out.length && inn.length) };
  }
  function threeRoomSummary(ds) {
    const free = THREE_HOUSES.filter((h) => !isOccupied(h, ds));
    const labels = { 3: '3룸 3채 빈방', 2: '3룸 2채 빈방', 1: '3룸 1채 빈방', 0: '3룸 마감' };
    return {
      total: 3, freeCount: free.length, free, occupied: THREE_HOUSES.filter((h) => free.indexOf(h) < 0),
      label: labels[free.length],
      turnover: THREE_HOUSES.filter((h) => eventsOn(h, ds).out)   // 이 날 퇴실 있는 3룸 (턴오버 가능)
    };
  }
  function availableHouses(ci, co, opts) {
    const o = opts || {};
    const type = o.roomType || 'all';
    const pool = HOUSES.filter((h) => type === 'all' ? true : type === '3' ? h.rooms === 3 : h.rooms === 5);
    return pool.map((h) => {
      const conflict = conflictFor(h.id, ci, co, o.excludeId);
      const tn = turnoverFor(h.id, ci, co, o.excludeId);
      return {
        house: h,
        available: !conflict,
        conflict,
        turnoverOut: tn.outs[0] || null,   // 이 날 퇴실 → 늦게 입실 가능
        turnoverIn: tn.ins[0] || null      // 이 날 다음 손님 입실
      };
    });
  }

  function depositStatus(b) {
    if (b.depositRefundedAt) return 'refunded';
    if (b.depositReceivedAt) return 'received';
    if (num(b.depositAmount) > 0) return 'pending';
    return 'none';
  }
  const DEP_LABEL = { none: '보증금 없음', pending: '보증금 미수령', received: '보증금 수령 완료', refunded: '보증금 반환 완료' };

  function depositReceiveNeeded() {
    const t = todayStr(), until = shiftStr(t, 7);
    return liveBookings()
      .filter((b) => num(b.depositAmount) > 0 && !b.depositReceivedAt && !b.depositRefundedAt)
      .filter((b) => b.checkIn <= until && b.checkOut >= t)
      .sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  }
  function depositRefundNeeded() {
    const t = todayStr();
    return liveBookings()
      .filter((b) => num(b.depositAmount) > 0 && b.depositReceivedAt && !b.depositRefundedAt && b.checkOut <= t)
      .sort((a, b) => a.checkOut.localeCompare(b.checkOut));
  }

  function validateBooking(data, excludeId) {
    if (!data.house || HOUSES.every((h) => h.id !== data.house)) return '하우스를 선택해 주세요.';
    if (!String(data.guestName || '').trim()) return '대표 예약자명을 입력해 주세요.';
    if (data.arriveDate && data.checkIn && data.arriveDate < data.checkIn) return '세부 도착일은 입실일 이전일 수 없습니다.';
    if (data.departDate && data.checkOut && data.departDate < data.checkOut) return '세부 출발일은 퇴실일 이전일 수 없습니다.';
    if (!data.checkIn || !data.checkOut) return '입실일과 퇴실일을 입력해 주세요.';
    if (data.checkOut <= data.checkIn) return '퇴실일은 입실일 다음 날 이후여야 합니다. (최소 1박)';
    const c = conflictFor(data.house, data.checkIn, data.checkOut, excludeId);
    if (c) {
      return data.house + '하우스는 ' + fmtMD(c.checkIn) + ' ~ ' + fmtMD(c.checkOut) +
        ' (' + c.guestName + ') 예약과 겹칩니다. 같은 날 퇴실·입실(턴오버)은 입실일과 퇴실일이 같을 때만 가능합니다.';
    }
    return '';
  }

  function addBooking(data) {
    const b = normalizeBooking(data);
    const err = validateBooking(b);
    if (err) return { ok: false, error: err };
    const now = Date.now();
    b.createdBy = b.createdBy || state.settings.operator;
    b.createdAt = b.createdAt || now;
    b.updatedBy = state.settings.operator;
    b.updatedAt = now;
    state.bookings.push(b);
    save();
    return { ok: true, booking: b };
  }
  function updateBooking(id, data) {
    const idx = state.bookings.findIndex((b) => b.id === id);
    if (idx < 0) return { ok: false, error: '예약을 찾을 수 없습니다.' };
    const prev = state.bookings[idx];
    const b = normalizeBooking(Object.assign({}, prev, data, { id: id, createdBy: prev.createdBy, createdAt: prev.createdAt }));
    const err = validateBooking(b, id);
    if (err) return { ok: false, error: err };
    b.updatedBy = state.settings.operator;
    b.updatedAt = Date.now();
    state.bookings[idx] = b;
    save();
    return { ok: true, booking: b };
  }
  function removeBooking(id) {
    const idx = state.bookings.findIndex((b) => b.id === id);
    if (idx < 0) return { ok: false };
    const b = state.bookings[idx];
    b.deleted = true;
    b.updatedBy = state.settings.operator;
    b.updatedAt = Date.now();
    state.bookings[idx] = b; // 동기화용 tombstone
    save();
    return { ok: true };
  }
  function markDeposit(id, kind) {
    const b = state.bookings.find((x) => x.id === id);
    if (!b) return { ok: false };
    const t = todayStr();
    if (kind === 'receive') {
      b.depositReceivedAt = b.depositReceivedAt || t;
    } else if (kind === 'refund') {
      b.depositReceivedAt = b.depositReceivedAt || t;
      b.depositRefundedAt = t;
    } else if (kind === 'reset') {
      b.depositReceivedAt = '';
      b.depositRefundedAt = '';
    }
    b.updatedBy = state.settings.operator;
    b.updatedAt = Date.now();
    save();
    return { ok: true, booking: b };
  }

  /* ---------- 4. 손님 안내 문구 ---------- */
  function buildGuestMessage(opt) {
    const o = opt || {};
    const ci = o.checkIn, co = o.checkOut;
    const n = nights(ci, co);
    const list = o.houses || [];
    const name = String(o.name || '').trim();
    const guests = num(o.guests);
    const head = name ? name + '님, 안녕하세요 😊' : '안녕하세요 😊';
    if (!ci || !co || n < 1) {
      return '입실일과 퇴실일을 먼저 선택해 주세요.';
    }
    if (!list.length) {
      return head + '\n오라홀릭 게스트하우스입니다.\n\n' +
        '죄송하지만 문의하신 ' + fmtDateLong(ci) + ' 입실 ~ ' + fmtDateLong(co) + ' 퇴실(' + n + '박) 일정은\n' +
        '예약 가능한 하우스가 없습니다.\n\n' +
        '다른 날짜를 알려 주시면 바로 확인해 드리겠습니다.\n' +
        '감사합니다!';
    }
    const lines = [];
    lines.push(head);
    lines.push('오라홀릭 게스트하우스입니다.');
    lines.push('');
    lines.push('문의하신 일정으로 빈 방을 확인했습니다.');
    lines.push('');
    lines.push('📅 ' + fmtDateLong(ci) + ' 입실 ~ ' + fmtDateLong(co) + ' 퇴실 · ' + n + '박' +
      (guests ? ' · ' + guests + '명' : ''));
    lines.push('');
    lines.push('✅ 예약 가능한 하우스');
    list.forEach((it, i) => {
      const h = it.house || it;
      lines.push((i + 1) + '. ' + h.name + ' — ' + h.desc + ' (기본 ' + h.baseGuests + '명)');
    });
    lines.push('');
    lines.push('· 입실 15:00 이후 / 퇴실 11:00');
    lines.push('· 보증금은 입실 1주일 전부터 받고, 퇴실 후 방 상태 확인 후 돌려드립니다.');
    const turn = list.filter((it) => it.turnoverOut);
    if (turn.length) {
      lines.push('');
      turn.forEach((it) => {
        const h = it.house || it;
        const prev = it.turnoverOut;
        lines.push('※ ' + h.name + '는 ' + fmtMD(prev.checkOut) + ' 앞 손님 퇴실 후 입실하는 날입니다. ' +
          '체크인 시간(15:00) 이후 입실 가능합니다.');
      });
    }
    lines.push('');
    lines.push('예약을 원하시면 성함, 연락처, 인원, 도착 시간(항공편)을 알려 주세요.');
    lines.push('감사합니다!');
    return lines.join('\n');
  }

  /* ---------- 5. 공통 렌더 조각 ---------- */
  function badgesFor(b) {
    const out = [];
    if (b.addons && b.addons.ate) {
      const ateTitle = b.addons.ateName ? '아떼: ' + b.addons.ateName : '아떼';
      out.push('<span class="badge ate" title="' + esc(b.addons.ateNote) + '">👩‍🍳 ' + esc(ateTitle) + '</span>');
    }
    if (b.addons && b.addons.babysitter) out.push('<span class="badge baby" title="' + esc(b.addons.babysitterNote) + '">🧸 베이비시터</span>');
    if (b.addons && b.addons.tutor) out.push('<span class="badge tutor" title="' + esc(b.addons.tutorNote) + '">📚 튜터</span>');
    if (num(b.mattress) > 0) out.push('<span class="badge mattress">🛏 매트리스 ' + num(b.mattress) + '</span>');
    if (num(b.extraGuests) > 0) out.push('<span class="badge extra">👥 추가인원 ' + num(b.extraGuests) + '</span>');
    if (b.nightFlight) out.push('<span class="badge night">🌙 밤/새벽 비행기</span>');
    if (b.pickup) out.push('<span class="badge pickup">🚐 공항 픽업</span>');
    if (b.dropoff) out.push('<span class="badge pickup">🚐 샌딩</span>');
    return out.join('');
  }
  function depBadge(b) {
    const st = depositStatus(b);
    if (st === 'none') return '';
    const when = st === 'received' ? b.depositReceivedAt : st === 'refunded' ? b.depositRefundedAt : '';
    return '<span class="badge dep-' + st + '" title="보증금 ' + money(b.depositAmount) + (when ? ' · ' + fmtMD(when) : '') + '">' +
      '🔐 ' + DEP_LABEL[st].replace('보증금 ', '') + (num(b.depositAmount) > 0 ? ' ' + money(b.depositAmount) : '') + '</span>';
  }
  function byline(b) {
    const parts = ['등록: ' + esc(b.createdBy || '-')];
    if (b.updatedBy && b.updatedBy !== b.createdBy) parts.push('수정: ' + esc(b.updatedBy));
    return parts.join(' · ');
  }
  function moneyLine(b) {
    const bal = Math.max(0, num(b.totalAmount) - num(b.prepaid));
    const out = [];
    if (num(b.totalAmount) > 0) out.push('총 <b>' + money(b.totalAmount) + '</b>');
    if (num(b.prepaid) > 0) out.push('예약금 ' + money(b.prepaid));
    if (num(b.totalAmount) > 0) out.push('잔금 ' + money(bal));
    if (num(b.depositAmount) > 0) out.push('보증금 ' + money(b.depositAmount));
    return out.join('<span class="muted"> · </span>');
  }

  function openSheet(html, opts) {
    const root = $('#sheetRoot');
    root.innerHTML = '<div class="sheet-backdrop"><div class="sheet" role="dialog" aria-modal="true">' + html + '</div></div>';
    document.body.style.overflow = 'hidden';
    if (opts && opts.focus) {
      setTimeout(() => { const el = $(opts.focus); if (el && el.focus) el.focus(); }, 30);
    }
  }
  function closeSheet() {
    $('#sheetRoot').innerHTML = '';
    document.body.style.overflow = '';
  }
  let toastTimer = null;
  function toast(msg, kind) {
    const root = $('#toastRoot');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { try { root.removeChild(el); } catch (e) {} }, 2600);
  }
  function askConfirm(title, body, okLabel, onOk, danger) {
    openSheet(
      '<div class="sheet-head"><h2>' + esc(title) + '</h2><button type="button" class="x" data-action="close-sheet" aria-label="닫기">✕</button></div>' +
      '<div class="sheet-body"><p style="margin:4px 0 16px;font-size:13.5px;line-height:1.65;color:var(--ink-2)">' + body + '</p></div>' +
      '<div class="sheet-foot"><button type="button" class="btn ghost" data-action="close-sheet">취소</button>' +
      '<button type="button" class="btn ' + (danger ? 'coral' : 'primary') + '" data-action="confirm-ok">' + esc(okLabel || '확인') + '</button></div>'
    );
    pendingConfirm = onOk;
  }
  let pendingConfirm = null;

  /* ---------- 6. 헤더 ---------- */
  function syncLabel(st) {
    switch (st) {
      case 'on': return '공동 운영 동기화 연결됨';
      case 'connecting': return '동기화 확인 중…';
      case 'error': return '동기화 오류 · 로컬 저장 중';
      default: return '로컬 저장만 사용 중';
    }
  }
  function setSyncStatus(st) {
    const badge = $('#syncBadge');
    if (!badge) return;
    badge.className = 'sync-badge ' + st;
    $('#syncBadgeText').textContent = syncLabel(st);
    const el = $('#syncState');
    if (el) {
      el.className = 'sync-state ' + st;
      el.innerHTML = '<span>' + (st === 'on' ? '🟢' : st === 'error' ? '🔴' : st === 'connecting' ? '🟡' : '⚪') + '</span> ' + esc(syncLabel(st)) +
        (st === 'on' && state.sync.lastSync ? '<span class="tiny muted" style="margin-left:auto">마지막 ' + fmtDateTime(state.sync.lastSync) + '</span>' : '');
    }
  }
  function renderHeader() {
    $('#operatorName').textContent = state.settings.operator || '사장님';
    setSyncStatus(state.sync.enabled ? (syncRuntime || 'off') : 'off');
  }
  let syncRuntime = 'off';

  /* ---------- 7. 캘린더 ---------- */
  const ui = {
    view: 'calendar',
    month: null,
    roomFilter: 'all',
    calHouseFilter: 'all',
    bkRange: 'upcoming',
    bkHouse: 'all',
    bkSource: 'all',
    bkQuery: '',
    finder: null,
    finderInputs: null
  };
  if (!ui.month) { const d = new Date(); ui.month = ymd(new Date(d.getFullYear(), d.getMonth(), 1)); }

  function visibleHouses() {
    if (ui.calHouseFilter === '3') return HOUSES.filter((h) => h.rooms === 3);
    if (ui.calHouseFilter === '5') return HOUSES.filter((h) => h.rooms === 5);
    return HOUSES;
  }

  function segHTML(b, kind, extraCls) {
    if (!b) return '';
    const cls = 'seg ' + kind + ' ' + srcCls(b.source) + (b.nightFlight ? ' has-flight' : '') + (extraCls ? ' ' + extraCls : '');
    const label = kind === 'out' ? '퇴실' : kind === 'in' ? '입실' : '숙박';
    return '<span class="' + cls + '" data-seg="' + kind + '" data-booking="' + esc(b.id) + '" data-action="edit-booking" data-id="' + esc(b.id) + '"' +
      ' title="' + label + ' ' + esc(b.guestName) + ' · ' + esc(b.source) + (b.nightFlight ? ' · 밤/새벽 비행기' : '') + '">' +
      label + '<i class="nm"> ' + esc(b.guestName) + '</i></span>';
  }

  function dayCellHTML(d, inMonth) {
    const ds = ymd(d);
    const dow = d.getDay();
    const t = todayStr();
    const sum = threeRoomSummary(ds);
    const list = visibleHouses();
    let bars = '';
    list.forEach((h) => {
      const ev = eventsOn(h.id, ds);
      let inner = '';
      if (ev.out && ev.in) {
        inner = '<span class="split">' + segHTML(ev.out, 'out') + segHTML(ev.in, 'in', 'turn-in') + '</span>';
      } else if (ev.out) {
        inner = segHTML(ev.out, 'out');
      } else if (ev.in) {
        inner = segHTML(ev.in, 'in');
      } else if (ev.stay) {
        inner = segHTML(ev.stay, 'stay');
      } else {
        inner = '<span class="seg empty"></span>';
      }
      bars += '<span class="hbar' + (ev.out || ev.in || ev.stay ? '' : ' no-data') + '" data-house="' + h.id + '"' +
        (ev.turnover ? ' data-turnover="1"' : '') + (ev.in ? ' data-checkin="' + esc(ev.in.id) + '"' : '') +
        (ev.out ? ' data-checkout="' + esc(ev.out.id) + '"' : '') + '>' +
        '<span class="hl">' + h.id + '</span>' + inner + '</span>';
    });
    const pill = '<span class="pill3 fit-' + sum.freeCount + '" title="' + esc(sum.label) + '">3룸 ' +
      (sum.freeCount ? sum.freeCount + '채' : '마감') + '</span>';
    return '<button type="button" class="day' + (inMonth ? '' : ' outside') + (ds === t ? ' today' : '') + (ds < t ? ' past' : '') +
      (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '') + '" data-action="day" data-date="' + ds + '" aria-label="' + fmtDateLong(ds) + ' ' + esc(sum.label) + '">' +
      '<span class="day-top"><span class="dnum">' + d.getDate() + '</span>' + pill + '</span>' +
      '<span class="hbars">' + bars + '</span></button>';
  }

  function renderCalendar() {
    const m = parseYmd(ui.month);
    const y = m.getFullYear(), mo = m.getMonth();
    const first = new Date(y, mo, 1);
    const gridStart = addDays(first, -first.getDay());
    const monthDays = new Date(y, mo + 1, 0).getDate();
    const weeks = Math.ceil((first.getDay() + monthDays) / 7);
    const t = todayStr();

    let strip = '';
    for (let i = 0; i < monthDays; i++) {
      const ds = ymd(new Date(y, mo, i + 1));
      const s = threeRoomSummary(ds);
      strip += '<button type="button" class="sum-chip fit-' + s.freeCount + (ds === t ? ' is-today-mark' : '') + '" data-action="day" data-date="' + ds + '" title="' + fmtDateLong(ds) + ' · ' + esc(s.label) + '">' +
        '<span>' + (mo + 1) + '/' + (i + 1) + '</span><em>' + (s.freeCount ? s.freeCount + '채 빈방' : '마감') + '</em></button>';
    }

    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(gridStart, i);
      cells += dayCellHTML(d, d.getMonth() === mo);
    }

    const el = $('#viewCalendar');
    el.innerHTML =
      '<div class="cal-toolbar">' +
        '<div class="month-nav">' +
          '<button type="button" class="icon-btn" data-action="month-prev" aria-label="이전 달">‹</button>' +
          '<h2>' + y + '년 ' + (mo + 1) + '월</h2>' +
          '<button type="button" class="icon-btn" data-action="month-next" aria-label="다음 달">›</button>' +
          '<button type="button" class="btn ghost sm today-btn" data-action="month-today">오늘</button>' +
        '</div>' +
        '<button type="button" class="btn primary sm" data-action="open-booking">＋ 예약 추가</button>' +
      '</div>' +
      '<div class="filter-row" role="group" aria-label="하우스 필터">' +
        '<span class="label">보기</span>' +
        '<button type="button" class="chip' + (ui.calHouseFilter === 'all' ? ' active-filter' : '') + '" data-action="cal-filter" data-rooms="all">전체 A·B·C·D</button>' +
        '<button type="button" class="chip' + (ui.calHouseFilter === '3' ? ' active-filter' : '') + '" data-action="cal-filter" data-rooms="3">3룸만 보기 B·C·D</button>' +
        '<button type="button" class="chip' + (ui.calHouseFilter === '5' ? ' active-filter' : '') + '" data-action="cal-filter" data-rooms="5">5룸 A하우스</button>' +
      '</div>' +
      '<div class="three-strip-wrap">' +
        '<div class="three-strip-head"><b>🏝 3룸 빈방 한눈에 · ' + (mo + 1) + '월</b><span>3룸 마감은 🔴</span></div>' +
        '<div class="three-strip" id="threeRoomStrip">' + strip + '</div>' +
      '</div>' +
      '<div class="legend legend-house">' +
        '<span class="cap">하우스 색</span>' +
        HOUSES.map((h) => '<span class="lg lg-house" data-house="' + h.id + '"><span class="sw hsw">' + h.id + '</span>' + h.name + '</span>').join('') +
      '</div>' +
      '<div class="legend">' +
        '<span class="lg"><span class="sw st-in"></span>입실</span>' +
        '<span class="lg"><span class="sw st-stay"></span>숙박 중</span>' +
        '<span class="lg"><span class="sw st-out"></span>퇴실</span>' +
        '<span class="lg"><span class="sw src-dot"></span>에어비앤비</span>' +
        '<span class="lg">🌙 밤/새벽 비행기</span>' +
        '<span class="lg">퇴실+입실 = 당일 턴오버</span>' +
      '</div>' +
      '<div class="cal-wrap">' +
        '<div class="cal-dow"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>' +
        '<div class="cal-grid" id="calendarGrid">' + cells + '</div>' +
      '</div>' +
      '<p class="tiny muted" style="margin:10px 2px 0;line-height:1.6">날짜를 누르면 하우스별 입실·퇴실을 자세히 볼 수 있습니다. ' +
      '한 칸에 <b>퇴실과 입실이 반씩</b> 보이면 그날 퇴실 후 새 손님이 입실하는 <b>턴오버</b>입니다.</p>';
  }

  function renderDaySheet(ds) {
    const list = visibleHouses();
    const sum = threeRoomSummary(ds);
    let blocks = '';
    list.forEach((h) => {
      const ev = eventsOn(h.id, ds);
      const rows = [];
      if (ev.stay) rows.push(evRowHTML(ev.stay, 'stay'));
      if (ev.out) rows.push(evRowHTML(ev.out, 'out'));
      if (ev.in) rows.push(evRowHTML(ev.in, 'in'));
      let inner;
      if (!rows.length) {
        inner = '<div class="ev-free">✅ 입실 가능 · ' + (h.rooms === 3 ? '3룸' : '5룸') + '</div>' +
          '<button type="button" class="btn sm ghost mt8" data-action="open-booking" data-date="' + ds + '" data-house="' + h.id + '">＋ 이 날 ' + h.id + '하우스 예약</button>';
      } else {
        inner = rows.join('');
        if (ev.turnover) inner += '<div class="turnover-note">🔄 당일 턴오버 — 퇴실 ' + esc(ev.out.checkOutTime) + ' / 입실 ' + esc(ev.in.checkInTime) + ' · 청소·정비 시간을 확인하세요.</div>';
        inner += '<button type="button" class="btn xs ghost mt8" data-action="open-booking" data-date="' + ds + '" data-house="' + h.id + '">＋ 예약 추가</button>';
      }
      blocks += '<div class="house-block" data-house-block="' + h.id + '">' +
        '<div class="house-block-head"><b>' + h.name + '</b><span class="desc">' + h.desc + '</span></div>' + inner + '</div>';
    });
    openSheet(
      '<div class="sheet-head"><div><h2>' + fmtDateFull(ds) + '</h2></div>' +
      '<button type="button" class="x" data-action="close-sheet" aria-label="닫기">✕</button></div>' +
      '<div class="sheet-body">' +
        '<div class="three-strip-wrap" style="margin-bottom:12px">' +
          '<div class="three-strip-head"><b>3룸 빈방</b><span>' + esc(sum.label) + '</span></div>' +
          '<div class="tiny muted">빈 곳: ' + (sum.free.length ? sum.free.map((x) => x + '하우스').join(' · ') : '없음 (3룸 마감)') +
          (sum.turnover.length ? ' · 턴오버: ' + sum.turnover.map((x) => x + '하우스').join(' · ') : '') + '</div>' +
        '</div>' + blocks +
        '<button type="button" class="btn primary block mt8" data-action="open-booking" data-date="' + ds + '">＋ 이 날 예약 추가</button>' +
      '</div>' +
      '<div class="sheet-foot"><button type="button" class="btn ghost" data-action="close-sheet">닫기</button></div>'
    );
  }

  function evRowHTML(b, kind) {
    const label = kind === 'in' ? '입실' : kind === 'out' ? '퇴실' : '숙박';
    const time = kind === 'in' ? b.checkInTime : kind === 'out' ? b.checkOutTime : '';
    const other = kind === 'in' ? '퇴실 ' + fmtMD(b.checkOut) : kind === 'out' ? '입실 ' + fmtMD(b.checkIn) : fmtMD(b.checkIn) + ' ~ ' + fmtMD(b.checkOut);
    return '<div class="ev-row" data-ev="' + kind + '">' +
      '<span class="ev-kind ' + kind + ' ' + srcCls(b.source) + '">' + label + '</span>' +
      '<div class="ev-body">' +
        '<div class="ev-name">' + esc(b.guestName) +
          ' <span class="badge src-' + srcCls(b.source) + '">' + esc(b.source) + '</span>' +
          (b.nightFlight ? ' <span class="badge night">🌙 밤/새벽</span>' : '') + '</div>' +
        '<div class="ev-meta tiny">대표 예약자명' + (b.phone ? ' · ' + esc(b.phone) : ' (연락처 없음)') + '</div>' +
        '<div class="ev-meta">' + esc(time) + ' · ' + other + ' · ' + b.baseGuests + '명' + (b.extraGuests ? ' +' + b.extraGuests : '') + '</div>' +
        '<div class="ev-badges">' + badgesFor(b) + depBadge(b) + '</div>' +
      '</div>' +
      '<div class="ev-actions"><button type="button" class="btn xs" data-action="edit-booking" data-id="' + esc(b.id) + '">수정</button></div>' +
    '</div>';
  }

  /* ---------- 8. 오늘 운영 ---------- */
  function opItemHTML(b, kind) {
    const h = houseById(b.house);
    const time = kind === 'in' ? b.checkInTime : b.checkOutTime;
    const partner = liveBookings().find((x) => x.id !== b.id && x.house === b.house && (kind === 'in' ? x.checkOut === b.checkIn : x.checkIn === b.checkOut));
    return '<div class="op-item">' +
      '<div class="op-item-head"><span class="badge house-' + b.house + '">' + b.house + '하우스</span>' +
        '<b>' + esc(b.guestName) + '</b><span class="tiny muted">대표 예약자명</span>' +
        '<span class="badge src-' + srcCls(b.source) + '">' + esc(b.source) + '</span>' +
        (b.nightFlight ? '<span class="badge night">🌙 밤/새벽</span>' : '') +
        '<button type="button" class="btn xs quiet" style="margin-left:auto" data-action="edit-booking" data-id="' + esc(b.id) + '">열기</button></div>' +
      '<div class="when">' + (kind === 'in' ? '입실 ' : '퇴실 ') + esc(time) + ' · ' + (kind === 'in' ? '퇴실 ' + fmtMD(b.checkOut) : '입실 ' + fmtMD(b.checkIn)) +
        ' · ' + b.baseGuests + '명' + (b.extraGuests ? ' + 추가 ' + b.extraGuests + '명' : '') + (b.phone ? ' · ' + esc(b.phone) : '') + '</div>' +
      (kind === 'in' && b.pickup ? '<div class="when">🚐 공항 픽업' + (b.pickupNote ? ' · ' + esc(b.pickupNote) : '') + '</div>' : '') +
      (b.airline || b.flightNo ? '<div class="when">✈️ ' + esc([b.airline, b.flightNo].filter(Boolean).join(' ')) +
        (kind === 'in' && b.arriveDate ? ' · ' + fmtMD(b.arriveDate) + ' ' + esc(b.arriveTime || '') + ' 도착' : '') +
        (kind === 'out' && b.departDate ? ' · ' + fmtMD(b.departDate) + ' ' + esc(b.departTime || '') + ' 출발' : '') + '</div>' : '') +
      (kind === 'out' && b.dropoff ? '<div class="when">🚐 샌딩' + (b.pickupNote ? ' · ' + esc(b.pickupNote) : '') + '</div>' : '') +
      '<div class="badges">' + badgesFor(b) + depBadge(b) + '</div>' +
      (kind === 'in' && partner ? '<div class="turnover-note">🔄 당일 턴오버 — 앞 손님 ' + esc(partner.guestName) + ' 퇴실 ' + esc(partner.checkOutTime) + ' 후 입실</div>' : '') +
      (kind === 'out' && partner ? '<div class="turnover-note">🔄 당일 턴오버 — 다음 손님 ' + esc(partner.guestName) + ' 입실 ' + esc(partner.checkInTime) + '</div>' : '') +
    '</div>';
  }

  function depositAlertHTML() {
    const recv = depositReceiveNeeded();
    const ref = depositRefundNeeded();
    const row = (b, kind) => {
      const h = houseById(b.house);
      const when = kind === 'receive' ? b.checkIn : b.checkOut;
      return '<div class="alert-row" data-dep-row="' + b.id + '">' +
        '<div class="who"><b>' + esc(b.guestName) + ' · ' + b.house + '하우스</b>' +
        '<span>' + (kind === 'receive' ? '입실 ' : '퇴실 ') + fmtMD(when) + ' (' + dLabel(when) + ') · ' + esc(h.desc) + ' · ' + money(b.depositAmount) + '</span></div>' +
        '<button type="button" class="btn xs primary" data-action="' + (kind === 'receive' ? 'dep-receive' : 'dep-refund') + '" data-id="' + esc(b.id) + '">' +
        (kind === 'receive' ? '수령 완료' : '반환 완료') + '</button></div>';
    };
    return '<section class="section">' +
      '<div class="section-head"><h2>🔐 보증금 알림</h2><span class="sub">입실 D-7 수령 · 퇴실 후 반환</span></div>' +
      '<div class="alert-card" data-alert="deposit-receive"><h3>💰 보증금 수령 필요 <span class="badge dep-pending">' + recv.length + '건</span></h3>' +
        '<div class="hint">입실 7일 전부터 받는 보증금입니다.</div>' +
        (recv.length ? recv.map((b) => row(b, 'receive')).join('') : '<div class="tiny muted">지금 챙길 보증금이 없습니다 👍</div>') + '</div>' +
      '<div class="alert-card refund" data-alert="deposit-refund"><h3>↩️ 보증금 반환 대기 <span class="badge dep-received">' + ref.length + '건</span></h3>' +
        '<div class="hint">퇴실한 손님의 보증금을 돌려주세요.</div>' +
        (ref.length ? ref.map((b) => row(b, 'refund')).join('') : '<div class="tiny muted">반환할 보증금이 없습니다 👍</div>') + '</div>' +
    '</section>';
  }

  function renderToday() {
    const t = todayStr(), tm = shiftStr(t, 1);
    const arrivals = liveBookings().filter((b) => b.checkIn === t).sort((a, b) => a.checkInTime.localeCompare(b.checkInTime));
    const departures = liveBookings().filter((b) => b.checkOut === t).sort((a, b) => a.checkOutTime.localeCompare(b.checkOutTime));
    const sum = threeRoomSummary(t);
    const recv = depositReceiveNeeded(), ref = depositRefundNeeded();
    const inHouse = liveBookings().filter((b) => b.checkIn < t && t < b.checkOut);

    const prep = [
      { k: 'ate', e: '👩‍🍳', n: '아떼', list: arrivals.filter((b) => b.addons.ate) },
      { k: 'baby', e: '🧸', n: '베이비시터', list: arrivals.filter((b) => b.addons.babysitter) },
      { k: 'tutor', e: '📚', n: '튜터', list: arrivals.filter((b) => b.addons.tutor) },
      { k: 'mattress', e: '🛏', n: '매트리스', list: arrivals.filter((b) => num(b.mattress) > 0) }
    ];
    const prepNames = prep.filter((p) => p.list.length).map((p) =>
      '<div><b>' + p.e + ' ' + p.n + '</b> — ' + p.list.map((b) => {
        let extra = '';
        if (p.k === 'mattress') extra = ' ' + num(b.mattress) + '개';
        if (p.k === 'ate' && b.addons.ateName) extra = ' · 아떼 ' + esc(b.addons.ateName);
        return esc(b.guestName) + '(' + b.house + ')' + extra;
      }).join(', ') + '</div>'
    ).join('');

    const arrTm = liveBookings().filter((b) => b.checkIn === tm);
    const depTm = liveBookings().filter((b) => b.checkOut === tm);

    const el = $('#viewToday');
    el.innerHTML =
      '<div class="dash-date"><h2>오늘 운영</h2><span class="w">' + fmtDateFull(t) + ' · ' + DOW[parseYmd(t).getDay()] + '요일</span></div>' +
      '<div class="stat-grid">' +
        '<div class="stat"><div class="k">🛬 오늘 입실</div><div class="v">' + arrivals.length + '</div><div class="d">' + (arrivals[0] ? esc(arrivals[0].guestName) + ' ' + esc(arrivals[0].checkInTime) : '없음') + '</div></div>' +
        '<div class="stat"><div class="k">🛫 오늘 퇴실</div><div class="v">' + departures.length + '</div><div class="d">' + (departures[0] ? esc(departures[0].guestName) + ' ' + esc(departures[0].checkOutTime) : '없음') + '</div></div>' +
        '<div class="stat"><div class="k">🏝 3룸 빈방</div><div class="v">' + sum.freeCount + '<span class="tiny muted">/3</span></div><div class="d">' + (sum.free.length ? sum.free.join('·') + ' 가능' : '3룸 마감') + '</div></div>' +
        '<div class="stat' + (recv.length + ref.length ? ' alarm' : '') + '"><div class="k">🔐 보증금 할 일</div><div class="v">' + (recv.length + ref.length) + '</div><div class="d">수령 ' + recv.length + ' · 반환 ' + ref.length + '</div></div>' +
      '</div>' +
      depositAlertHTML() +
      '<section class="section"><div class="section-head"><h2>🛬 오늘 입실 ' + arrivals.length + '</h2><span class="sub">숙박 중 ' + inHouse.length + '팀</span></div>' +
        '<div class="op-list">' + (arrivals.length ? arrivals.map((b) => opItemHTML(b, 'in')).join('') : '<div class="empty"><b>오늘 입실 예약이 없습니다</b>3룸 빈방은 ' + sum.freeCount + '채입니다.</div>') + '</div></section>' +
      '<section class="section"><div class="section-head"><h2>🛫 오늘 퇴실 ' + departures.length + '</h2></div>' +
        '<div class="op-list">' + (departures.length ? departures.map((b) => opItemHTML(b, 'out')).join('') : '<div class="empty">오늘 퇴실 예약이 없습니다.</div>') + '</div></section>' +
      '<section class="section"><div class="section-head"><h2>🧺 오늘 준비</h2><span class="sub">오늘 입실 손님 기준</span></div>' +
        '<div class="card card-pad">' +
          '<div class="prep-grid">' + prep.map((p) => '<div class="prep' + (p.list.length ? ' has' : '') + '"><div class="e">' + p.e + '</div><div class="n">' + p.list.length + '</div><div class="k">' + p.n + '</div></div>').join('') + '</div>' +
          (prepNames ? '<div class="prep-names mt8">' + prepNames + '</div>' : '<div class="tiny muted mt8">오늘은 추가 준비가 없습니다.</div>') +
        '</div></section>' +
      '<section class="section"><div class="section-head"><h2>🌤 내일 미리보기</h2><span class="sub">' + fmtDateLong(tm) + '</span></div>' +
        '<div class="card card-pad tiny">' +
          '<div><b>입실 ' + arrTm.length + '</b> — ' + (arrTm.length ? arrTm.map((b) => esc(b.guestName) + '(' + b.house + ')').join(', ') : '없음') + '</div>' +
          '<div style="margin-top:4px"><b>퇴실 ' + depTm.length + '</b> — ' + (depTm.length ? depTm.map((b) => esc(b.guestName) + '(' + b.house + ')').join(', ') : '없음') + '</div>' +
        '</div></section>';
  }

  /* ---------- 9. 예약 목록 ---------- */
  function bookingCardHTML(b) {
    const h = houseById(b.house);
    const n = nights(b.checkIn, b.checkOut);
    const past = b.checkOut < todayStr();
    const bal = Math.max(0, num(b.totalAmount) - num(b.prepaid));
    const dep = depositStatus(b);
    return '<article class="booking-card house-' + b.house + (past ? ' past' : '') + '" data-action="edit-booking" data-id="' + esc(b.id) + '" data-bk="' + esc(b.id) + '">' +
      '<div class="bc-top"><span class="badge house-' + b.house + '">' + b.house + '하우스</span>' +
        '<span class="badge src-' + srcCls(b.source) + '">' + esc(b.source) + '</span>' +
        (b.nightFlight ? '<span class="badge night">🌙</span>' : '') + '</div>' +
      '<div class="bc-lead"><span class="lbl">대표 예약자명</span><b>' + esc(b.guestName) + '</b>' +
        (b.phone ? '<span class="ph">' + esc(b.phone) + '</span>' : '') + '</div>' +
      '<div class="bc-when">' + fmtMD(b.checkIn) + ' ' + esc(b.checkInTime) + ' <span class="arr">→</span> ' + fmtMD(b.checkOut) + ' ' + esc(b.checkOutTime) + ' · ' + n + '박</div>' +
      '<div class="bc-sub">' + esc(h.desc) + ' · 기본 ' + b.baseGuests + '명' + (b.extraGuests ? ' + 추가 ' + b.extraGuests + '명' : '') + '</div>' +
      (b.payer ? '<div class="bc-sub">입금자 · ' + esc(b.payer) + '</div>' : '') +
      (b.guestNames ? '<div class="bc-sub">투숙객 · ' + esc(b.guestNames) + '</div>' : '') +
      (b.airline || b.flightNo ? '<div class="bc-sub">✈️ ' + esc([b.airline, b.flightNo].filter(Boolean).join(' ')) +
        (b.arriveDate ? ' · ' + fmtMD(b.arriveDate) + ' ' + esc(b.arriveTime || '') + ' 도착' : '') + '</div>' : '') +
      '<div class="bc-badges">' + badgesFor(b) + depBadge(b) + '</div>' +
      '<div class="bc-money">' +
        (num(b.totalAmount) ? '<span>총 <b>' + money(b.totalAmount) + '</b></span>' : '') +
        (num(b.prepaid) ? '<span>예약금 ' + money(b.prepaid) + '</span>' : '') +
        (num(b.totalAmount) ? '<span>잔금 ' + money(bal) + '</span>' : '') +
        (num(b.depositAmount) ? '<span>보증금 ' + money(b.depositAmount) + '</span>' : '') +
      '</div>' +
      (b.note ? '<div class="bc-sub" style="color:var(--ink-3)">📝 ' + esc(b.note) + '</div>' : '') +
      '<div class="bc-foot"><span class="bc-by">' + byline(b) + '</span>' +
        '<span class="bc-actions">' +
          (dep === 'pending' ? '<button type="button" class="btn xs" data-action="dep-receive" data-id="' + esc(b.id) + '">보증금 수령</button>' : '') +
          (dep === 'received' ? '<button type="button" class="btn xs" data-action="dep-refund" data-id="' + esc(b.id) + '">보증금 반환</button>' : '') +
          '<button type="button" class="btn xs" data-action="confirmation" data-id="' + esc(b.id) + '">확정서</button>' +
          '<button type="button" class="btn xs" data-action="edit-booking" data-id="' + esc(b.id) + '">수정</button>' +
          '<button type="button" class="btn xs danger" data-action="delete-booking" data-id="' + esc(b.id) + '">삭제</button>' +
        '</span></div>' +
    '</article>';
  }

  function filteredBookings() {
    const t = todayStr();
    let list = liveBookings().slice();
    if (ui.bkRange === 'upcoming') list = list.filter((b) => b.checkOut >= t);
    else if (ui.bkRange === 'past') list = list.filter((b) => b.checkOut < t);
    else if (ui.bkRange === 'stay') list = list.filter((b) => b.checkIn <= t && t < b.checkOut);
    if (ui.bkHouse !== 'all') list = list.filter((b) => b.house === ui.bkHouse);
    if (ui.bkSource !== 'all') list = list.filter((b) => b.source === ui.bkSource);
    const q = (ui.bkQuery || '').trim().toLowerCase();
    if (q) list = list.filter((b) => (b.guestName + ' ' + b.phone + ' ' + b.note).toLowerCase().indexOf(q) >= 0);
    list.sort((a, b) => ui.bkRange === 'past' ? b.checkIn.localeCompare(a.checkIn) : a.checkIn.localeCompare(b.checkIn));
    return list;
  }

  function renderBookings() {
    const list = filteredBookings();
    const el = $('#viewBookings');
    el.innerHTML =
      '<div class="dash-date"><h2>예약</h2><span class="w">' + liveBookings().length + '건 · ' + list.length + '건 표시</span></div>' +
      '<div class="list-toolbar">' +
        '<div class="search-box"><input type="text" id="bkQuery" placeholder="손님 이름·연락처 검색" value="' + esc(ui.bkQuery) + '"></div>' +
        '<select id="bkHouse" aria-label="하우스">' +
          '<option value="all">모든 하우스</option>' +
          HOUSES.map((h) => '<option value="' + h.id + '"' + (ui.bkHouse === h.id ? ' selected' : '') + '>' + h.name + ' · ' + h.desc + '</option>').join('') +
        '</select>' +
        '<select id="bkSource" aria-label="예약 구분">' +
          '<option value="all">개별 + 에어비앤비</option>' +
          SOURCES.map((s) => '<option value="' + s + '"' + (ui.bkSource === s ? ' selected' : '') + '>' + s + '</option>').join('') +
        '</select>' +
      '</div>' +
      '<div class="filter-row">' +
        '<span class="label">기간</span>' +
        '<button type="button" class="chip' + (ui.bkRange === 'upcoming' ? ' active-filter' : '') + '" data-action="bk-range" data-range="upcoming">다가오는</button>' +
        '<button type="button" class="chip' + (ui.bkRange === 'stay' ? ' active-filter' : '') + '" data-action="bk-range" data-range="stay">숙박 중</button>' +
        '<button type="button" class="chip' + (ui.bkRange === 'all' ? ' active-filter' : '') + '" data-action="bk-range" data-range="all">전체</button>' +
        '<button type="button" class="chip' + (ui.bkRange === 'past' ? ' active-filter' : '') + '" data-action="bk-range" data-range="past">지난 예약</button>' +
      '</div>' +
      (list.length ? list.map(bookingCardHTML).join('') : '<div class="empty"><b>조건에 맞는 예약이 없습니다</b>필터를 바꾸거나 새 예약을 추가해 보세요.</div>') +
      '<button type="button" class="btn primary block mt12" data-action="open-booking">＋ 새 예약 추가</button>';
  }

  /* ---------- 10. 손님 안내 ---------- */
  function finderState() {
    return ui.finderInputs || {
      checkIn: shiftStr(todayStr(), 1),
      checkOut: shiftStr(todayStr(), 4),
      roomType: 'all',
      guests: '',
      name: ''
    };
  }

  function renderFinder() {
    const f = finderState();
    const res = ui.finder;
    let resultsHTML = '';
    if (res) {
      const avail = res.items.filter((x) => x.available);
      const not = res.items.filter((x) => !x.available);
      resultsHTML =
        '<div class="card card-pad mt12">' +
          '<div class="section-head"><h2>' + fmtDateLong(res.checkIn) + ' → ' + fmtDateLong(res.checkOut) + ' · ' + nights(res.checkIn, res.checkOut) + '박</h2></div>' +
          '<div class="tiny muted" style="margin:-4px 0 10px">' + (res.roomType === '3' ? '3룸 하우스 (B·C·D)' : res.roomType === '5' ? '5룸 A하우스' : '전체 하우스') + ' · ' +
            (avail.length ? '<b style="color:var(--ok)">' + avail.length + '채 예약 가능</b>' : '<b style="color:var(--danger)">예약 가능한 하우스 없음</b>') + '</div>' +
          avail.map((x) => '<div class="avail-card" data-avail="' + x.house.id + '">' +
              '<div class="nm">✅ ' + x.house.name + ' <span class="badge house-' + x.house.id + '">' + x.house.desc + '</span></div>' +
              '<div class="ds">기본 ' + x.house.baseGuests + '명 · 입실 15:00 / 퇴실 11:00</div>' +
              (x.turnoverOut ? '<div class="note">당일 퇴실 후 입실(턴오버) — 앞 손님 ' + esc(x.turnoverOut.guestName) + ' 퇴실 ' + esc(x.turnoverOut.checkOutTime) + ' 이후 입실</div>' : '') +
            '</div>').join('') +
          not.map((x) => '<div class="unavail-card">✖ ' + x.house.name + ' (' + x.house.desc + ') — ' +
              (x.conflict ? esc(x.conflict.guestName) + ' ' + fmtMD(x.conflict.checkIn) + '~' + fmtMD(x.conflict.checkOut) + ' 예약' : '예약 불가') + '</div>').join('') +
          '<div class="copy-head mt12"><b>💬 카카오톡으로 보낼 안내 문구</b>' +
            '<button type="button" class="btn sm primary" data-action="copy-msg">복사</button></div>' +
          '<div class="copy-box"><textarea id="guestMessage" readonly>' + esc(res.message) + '</textarea></div>' +
          '<div class="tiny muted" style="margin-top:6px">보증금은 입실 1주일 전부터 받고, 퇴실 후 반환한다는 안내가 포함되어 있습니다.</div>' +
        '</div>';
    }
    const el = $('#viewFinder');
    el.innerHTML =
      '<div class="dash-date"><h2>손님 안내</h2><span class="w">빈 날짜 찾기 · 문구 복사</span></div>' +
      '<form id="finderForm" class="card card-pad finder-form">' +
        '<div class="grid2">' +
          '<div class="field"><label for="qCheckIn">입실일</label><input type="date" id="qCheckIn" name="checkIn" value="' + f.checkIn + '"></div>' +
          '<div class="field"><label for="qCheckOut">퇴실일</label><input type="date" id="qCheckOut" name="checkOut" value="' + f.checkOut + '"></div>' +
        '</div>' +
        '<div class="field"><label for="qRooms">룸 타입</label><select id="qRooms" name="roomType">' +
          '<option value="all"' + (f.roomType === 'all' ? ' selected' : '') + '>전체 (A·B·C·D)</option>' +
          '<option value="3"' + (f.roomType === '3' ? ' selected' : '') + '>3룸만 (B·C·D)</option>' +
          '<option value="5"' + (f.roomType === '5' ? ' selected' : '') + '>5룸 (A하우스)</option>' +
        '</select></div>' +
        '<div class="grid2">' +
          '<div class="field"><label for="qGuests">인원 (선택)</label><input type="number" id="qGuests" name="guests" min="1" max="30" value="' + esc(f.guests) + '" placeholder="예: 4"></div>' +
          '<div class="field"><label for="qName">손님 이름 (선택)</label><input type="text" id="qName" name="name" value="' + esc(f.name) + '" placeholder="예: 김민수"></div>' +
        '</div>' +
        '<button type="submit" class="btn primary block">🔎 입실 가능한 하우스 찾기</button>' +
      '</form>' + resultsHTML;
  }

  function runFinder() {
    const f = finderState();
    if (!f.checkIn || !f.checkOut) { toast('입실일과 퇴실일을 선택해 주세요.', 'warn'); return; }
    if (f.checkOut <= f.checkIn) { toast('퇴실일은 입실일 다음 날이어야 합니다.', 'warn'); return; }
    const items = availableHouses(f.checkIn, f.checkOut, { roomType: f.roomType });
    const avail = items.filter((x) => x.available);
    const message = buildGuestMessage({ checkIn: f.checkIn, checkOut: f.checkOut, houses: avail, guests: f.guests, name: f.name });
    ui.finder = { checkIn: f.checkIn, checkOut: f.checkOut, roomType: f.roomType, items, message };
    renderFinder();
    const box = $('#guestMessage');
    if (box && box.scrollIntoView) { try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }
  }

  function copyText(text) {
    const done = () => toast('안내 문구를 복사했습니다. 카카오톡에 붙여넣으세요 💬');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallback());
      return;
    }
    fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('복사가 안 되면 문구를 길게 눌러 복사해 주세요.', 'warn'); }
      document.body.removeChild(ta);
    }
  }

  /* ---------- 11. 예약 확정서 ---------- */
  function renderConfirm() {
    const list = liveBookings().slice().sort((a, b) => b.checkIn.localeCompare(a.checkIn));
    const opts = list.map((b) => '<option value="' + esc(b.id) + '">' + esc(b.guestName) + ' · ' + b.house + '하우스 · ' + fmtMD(b.checkIn) + '~' + fmtMD(b.checkOut) + '</option>').join('');
    const el = $('#viewConfirm');
    el.innerHTML =
      '<div class="dash-date"><h2>예약 확정서</h2><span class="w">PNG 저장 · 오프라인</span></div>' +
      '<section class="set-block">' +
        '<h2>🖼 확정서 만들기</h2>' +
        '<p class="lead">예약을 고르면 <b>예약자 · 숙박기간 · 금액</b>이 자동으로 채워집니다. 확정서는 이 기기에서 그림으로 그려져 <b>인터넷 없이도 PNG로 저장</b>됩니다.</p>' +
        (list.length ? '<div class="field"><label for="confBooking">예약 선택</label><select id="confBooking">' + opts + '</select></div>' :
          '<div class="empty" style="margin-bottom:10px"><b>아직 예약이 없습니다</b>예약을 먼저 추가하거나, 빈 확정서로 직접 작성할 수 있습니다.</div>') +
        '<div class="data-row">' +
          '<button type="button" class="btn primary" data-action="conf-open">확정서 만들기</button>' +
          '<button type="button" class="btn ghost" data-action="conf-blank">빈 확정서</button>' +
        '</div>' +
      '</section>' +
      '<section class="set-block">' +
        '<h2>📄 확정서에 들어가는 내용</h2>' +
        '<div class="house-info">' +
          '<div class="house-info-row"><b>예약자</b><span class="muted">대표 예약자명 · 입금자 · 숙박인 · 동반자</span></div>' +
          '<div class="house-info-row"><b>숙박</b><span class="muted">숙박기간 · 시즌 · 객실 · 예약상태 · 총 금액</span></div>' +
          '<div class="house-info-row"><b>항공</b><span class="muted">항공사 · 세부 도착 · 세부 출발</span></div>' +
          '<div class="house-info-row"><b>금액</b><span class="muted">숙박 요금 · 아떼 · 픽업드랍 · 매트리스/기타</span></div>' +
          '<div class="house-info-row"><b>고정 안내</b><span class="muted">요금표 · 양도/취소 규정 · 입퇴실 안내</span></div>' +
        '</div>' +
      '</section>' +
      '<section class="set-block">' +
        '<h2>💡 사용 팁</h2>' +
        '<p class="lead" style="margin:0">저장된 파일 이름은 <code>예약자명YYYY.MM.DD.png</code> 형식입니다. 카카오톡·문자에 바로 붙여 보낼 수 있습니다. 확정서 내용은 저장 후에도 예약과 별도로 관리됩니다.</p>' +
      '</section>';
  }

  function openConfirmation(bookingId) {
    if (!window.ORA_CONFIRM) { toast('확정서 모듈을 불러오지 못했습니다.', 'err'); return; }
    const b = state.bookings.find((x) => !x.deleted && x.id === bookingId) || null;
    ui.confBase = b;
    const base = b || {
      house: 'A', guestName: '', checkIn: todayStr(), checkOut: shiftStr(todayStr(), 1),
      baseGuests: 6, extraGuests: 0, checkInTime: '15:00', checkOutTime: '11:00', totalAmount: 0
    };
    const m = window.ORA_CONFIRM.buildModel(base, {});
    const html =
      '<div class="sheet-head"><h2>예약 확정서</h2><button type="button" class="x" data-action="close-sheet" aria-label="닫기">✕</button></div>' +
      '<div class="sheet-body">' +
        '<div class="conf-file">파일명 <b id="confFilename">' + esc(window.ORA_CONFIRM.filenameFor(m)) + '</b></div>' +
        '<div class="conf-preview"><canvas id="confirmCanvas" width="1800" height="3560" aria-label="예약 확정서 미리보기"></canvas></div>' +
        '<div class="tiny muted" style="margin:8px 2px 12px">아래 내용을 고치면 미리보기가 바로 바뀝니다. 마음에 들면 <b>PNG로 저장</b>을 누르세요.</div>' +
        '<form id="confForm">' +
          '<div class="form-group"><h3>👤 예약자</h3>' +
            '<div class="grid2">' +
              '<div class="field" style="margin:0"><label for="cGuest">대표 예약자명</label><input type="text" id="cGuest" value="' + esc(m.guestName) + '" placeholder="예: 김동준"></div>' +
              '<div class="field" style="margin:0"><label for="cPayer">입금자 (선택)</label><input type="text" id="cPayer" value="' + esc(m.payer) + '" placeholder="예: 김우열"></div>' +
            '</div>' +
            '<div class="field" style="margin:10px 0 0"><label for="cGuestsLine">숙박인 표기</label><input type="text" id="cGuestsLine" value="' + esc(m.guestsLine) + '" placeholder="예: 김동준 외 4인"></div>' +
            '<div class="field" style="margin:8px 0 0"><label for="cCompanions">동반자 이름 (선택)</label><input type="text" id="cCompanions" value="' + esc(m.companions) + '" placeholder="예: 박경자, 김우열, 김하린, 김유찬"></div>' +
          '</div>' +
          '<div class="form-group"><h3>📅 숙박</h3>' +
            '<div class="grid2">' +
              '<div class="field" style="margin:0"><label for="cStart">입실일</label><input type="date" id="cStart" value="' + esc(m.startISO) + '"></div>' +
              '<div class="field" style="margin:0"><label for="cEnd">퇴실일</label><input type="date" id="cEnd" value="' + esc(m.endISO) + '"></div>' +
            '</div>' +
            '<div class="grid2" style="margin-top:8px">' +
              '<div class="field" style="margin:0"><label for="cSeason">시즌</label><select id="cSeason"><option' + (m.season === '성수기' ? ' selected' : '') + '>성수기</option><option' + (m.season === '비수기' ? ' selected' : '') + '>비수기</option></select></div>' +
              '<div class="field" style="margin:0"><label for="cRoom">객실</label><input type="text" id="cRoom" value="' + esc(m.room) + '" placeholder="예: B하우스 (3룸)"></div>' +
            '</div>' +
            '<div class="grid2" style="margin-top:8px">' +
              '<div class="field" style="margin:0"><label for="cStatus">예약상태</label><input type="text" id="cStatus" value="' + esc(m.status) + '"></div>' +
              '<div class="field" style="margin:0"><label for="cTotal">총 금액 (확정서에 ₩로 표기)</label><input type="number" id="cTotal" min="0" step="1000" value="' + m.total + '"></div>' +
            '</div>' +
          '</div>' +
          '<div class="form-group"><h3>✈️ 항공편</h3>' +
            '<div class="field" style="margin:0 0 8px"><label for="cAirline">항공사</label><input type="text" id="cAirline" value="' + esc(m.airline) + '" placeholder="예: 대한항공"></div>' +
            '<div class="grid2">' +
              '<div class="field" style="margin:0"><label for="cArrive">세부 도착</label><input type="text" id="cArrive" value="' + esc(m.arrive) + '"></div>' +
              '<div class="field" style="margin:0"><label for="cDepart">세부 출발</label><input type="text" id="cDepart" value="' + esc(m.depart) + '"></div>' +
            '</div>' +
          '</div>' +
          '<div class="form-group"><h3>💰 금액 내역</h3>' +
            '<div class="grid2">' +
              '<div class="field" style="margin:0"><label for="cStayAmt">숙박 요금</label><input type="number" id="cStayAmt" min="0" step="1000" value="' + m.stayAmount + '"></div>' +
              '<div class="field" style="margin:0"><label for="cAteAmt">아떼 추가 (선택)</label><input type="number" id="cAteAmt" min="0" step="1000" value="' + m.ateAmount + '"></div>' +
            '</div>' +
            '<div class="grid2" style="margin-top:8px">' +
              '<div class="field" style="margin:0"><label for="cPickupAmt">픽업드랍 신청</label><input type="number" id="cPickupAmt" min="0" step="1000" value="' + m.pickupAmount + '"></div>' +
              '<div class="field" style="margin:0"><label for="cEtcAmt">추가 매트리스 / 기타</label><input type="number" id="cEtcAmt" min="0" step="1000" value="' + m.etcAmount + '"></div>' +
            '</div>' +
          '</div>' +
          '<div class="form-group"><h3>✨ 추가 서비스 표기</h3>' +
            '<div class="grid2">' +
              '<div class="field" style="margin:0"><label for="cMattress">추가 매트리스</label><input type="text" id="cMattress" value="' + esc(m.addonDetail.mattress) + '" placeholder="예: ×2"></div>' +
              '<div class="field" style="margin:0"><label for="cSetting">세팅 / 튜터 / 베이비시터</label><input type="text" id="cSetting" value="' + esc(m.addonDetail.setting) + '" placeholder="예: 튜터"></div>' +
            '</div>' +
            '<div class="grid2" style="margin-top:8px">' +
              '<div class="field" style="margin:0"><label for="cPickupDetail">공항 픽드랍</label><input type="text" id="cPickupDetail" value="' + esc(m.addonDetail.pickup) + '" placeholder="예: 픽업 23:40"></div>' +
              '<div class="field" style="margin:0"><label for="cAteDetail">아떼 서비스</label><input type="text" id="cAteDetail" value="' + esc(m.addonDetail.ate) + '" placeholder="예: 마리엘"></div>' +
            '</div>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="sheet-foot">' +
        '<button type="button" class="btn ghost" data-action="close-sheet">닫기</button>' +
        '<button type="button" class="btn primary" data-action="conf-save">PNG로 저장</button>' +
      '</div>';
    openSheet(html);
    renderConfPreview();
  }

  function readConfOverrides() {
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const totalRaw = v('cTotal');
    return {
      guestName: v('cGuest'),
      payer: v('cPayer'),
      guestsLine: v('cGuestsLine'),
      companions: v('cCompanions'),
      start: v('cStart'),
      end: v('cEnd'),
      season: v('cSeason'),
      room: v('cRoom'),
      status: v('cStatus'),
      total: totalRaw === '' ? null : Number(totalRaw),
      airline: v('cAirline'),
      arrive: v('cArrive'),
      depart: v('cDepart'),
      stayAmount: Number(v('cStayAmt') || 0),
      ateAmount: Number(v('cAteAmt') || 0),
      pickupAmount: Number(v('cPickupAmt') || 0),
      etcAmount: Number(v('cEtcAmt') || 0),
      mattressDetail: v('cMattress'),
      settingDetail: v('cSetting'),
      pickupDetail: v('cPickupDetail'),
      ateDetail: v('cAteDetail')
    };
  }

  function renderConfPreview() {
    if (!window.ORA_CONFIRM) return null;
    const cv = $('#confirmCanvas');
    const ov = readConfOverrides();
    const model = window.ORA_CONFIRM.buildModel(ui.confBase, ov);
    if (cv) window.ORA_CONFIRM.renderTo(cv, model, 2);
    const fn = $('#confFilename');
    if (fn) fn.textContent = window.ORA_CONFIRM.filenameFor(model);
    ui.confModel = model;
    return model;
  }
  let confTimer = null;
  function scheduleConfPreview() {
    if (confTimer) clearTimeout(confTimer);
    confTimer = setTimeout(() => { try { renderConfPreview(); } catch (e) {} }, 160);
  }

  async function saveConfirmation() {
    const cv = $('#confirmCanvas');
    const model = ui.confModel || (window.ORA_CONFIRM && window.ORA_CONFIRM.buildModel(ui.confBase, {}));
    if (!cv || !window.ORA_CONFIRM) { toast('확정서를 준비하지 못했습니다.', 'err'); return { ok: false }; }
    const filename = window.ORA_CONFIRM.filenameFor(model);
    try {
      const blob = await window.ORA_CONFIRM.toBlob(cv);
      if (!blob) throw new Error('no-blob');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('확정서를 저장했습니다 · ' + filename);
      return { ok: true, filename: filename, size: blob.size };
    } catch (e) {
      toast('이 브라우저에서는 PNG 저장을 지원하지 않습니다.', 'err');
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /* ---------- 12. 설정 ---------- */
  function renderSettings() {
    const op = state.settings.operator;
    const s = state.sync;
    const el = $('#viewSettings');
    el.innerHTML =
      '<div class="dash-date"><h2>설정</h2><span class="w">공동 운영 · 백업</span></div>' +

      '<section class="set-block" id="opBlock">' +
        '<h2>👤 작업자</h2>' +
        '<p class="lead">지금 조작하는 사람을 고르면, 예약마다 <b>등록 · 수정한 사람</b>이 기록됩니다. 사장님과 엘레나가 함께 볼 때 누가 손댔는지 바로 알 수 있어요.</p>' +
        '<div class="operator-picker">' +
          OPERATOR_PRESETS.map((n) => '<button type="button" data-action="op-pick" data-op="' + esc(n) + '" class="' + (op === n ? 'on' : '') + '">' + esc(n) + '</button>').join('') +
        '</div>' +
        '<div class="grid2" style="align-items:end">' +
          '<div class="field" style="margin:0"><label for="opCustom">직접 입력</label><input type="text" id="opCustom" maxlength="16" placeholder="예: 마이클" value="' + (OPERATOR_PRESETS.indexOf(op) < 0 ? esc(op) : '') + '"></div>' +
          '<button type="button" class="btn" data-action="op-save-custom">이 이름으로 저장</button>' +
        '</div>' +
        '<div class="tiny muted" style="margin-top:8px">현재 작업자 · <b>' + esc(op) + '</b> — 새 예약과 수정에 이 이름이 남습니다.</div>' +
      '</section>' +

      '<section class="set-block" id="lockBlock">' +
        '<h2>🔒 접속 비밀번호 <span class="badge dep-pending' + (isDefaultPin() ? '' : ' hidden') + '" id="lockDefaultBadge">기본 0000</span></h2>' +
        '<p class="lead">앱을 열 때 물어보는 비밀번호입니다. <b>사장님과 엘레나가 같은 비밀번호</b>를 씁니다. 공동 운영 동기화가 켜져 있으면 바꾼 비밀번호가 상대 기기에도 함께 전해집니다.</p>' +
        '<form id="pinForm" novalidate autocomplete="off">' +
          '<div class="field" style="margin:0 0 8px"><label for="pinCurrent">지금 비밀번호</label>' +
            '<input type="password" id="pinCurrent" inputmode="numeric" maxlength="12" autocomplete="current-password" placeholder="지금 쓰는 비밀번호"></div>' +
          '<div class="grid2">' +
            '<div class="field" style="margin:0"><label for="pinNew">새 비밀번호 (4자 이상)</label>' +
              '<input type="password" id="pinNew" inputmode="numeric" maxlength="12" autocomplete="new-password" placeholder="예: 2580"></div>' +
            '<div class="field" style="margin:0"><label for="pinNew2">새 비밀번호 확인</label>' +
              '<input type="password" id="pinNew2" inputmode="numeric" maxlength="12" autocomplete="new-password" placeholder="한 번 더"></div>' +
          '</div>' +
          '<div id="pinNotice" class="form-notice" role="alert"></div>' +
          '<div class="data-row" style="margin-top:8px">' +
            '<button type="submit" class="btn primary sm" id="pinChangeBtn">비밀번호 바꾸기</button>' +
            '<button type="button" class="btn sm ghost" data-action="lock-now">🔒 지금 잠금</button>' +
          '</div>' +
          '<div class="tiny muted" style="margin-top:8px;line-height:1.65">기본 비밀번호는 <b>0000</b>입니다. 처음 한 번은 꼭 바꿔 주세요. 비밀번호는 이 기기에 저장되고, 공동 운영을 켰다면 Firebase에도 함께 보관됩니다.</div>' +
        '</form>' +
      '</section>' +

      '<section class="set-block" id="syncBlock">' +
        '<h2>🔄 공동 운영 동기화 <span class="badge dep-received">실시간</span></h2>' +
        '<p class="lead">사장님과 엘레나가 <b>같은 예약을 실시간으로</b> 보고 고칠 수 있습니다. 한 사람이 예약을 넣으면 다른 사람 화면에도 바로 나타납니다. 설정은 한 번만 하면 됩니다.</p>' +
        '<div id="syncState" class="sync-state ' + (s.enabled ? (syncRuntime || 'off') : 'off') + '">' +
          esc(syncLabel(s.enabled ? (syncRuntime || 'off') : 'off')) + '</div>' +
        '<ol class="steps">' +
          '<li><b>Firebase 콘솔</b>에서 새 프로젝트를 만듭니다. → <a href="https://console.firebase.google.com" target="_blank" rel="noopener">console.firebase.google.com</a></li>' +
          '<li>왼쪽 메뉴 <b>빌드 → Realtime Database → 데이터베이스 만들기</b>를 누르고 <b>테스트 모드</b>로 시작합니다. 위에 나오는 주소(<code>https://....firebaseio.com</code>)를 복사합니다.</li>' +
          '<li>아래에 주소와 <b>같은 공유 코드</b>(예: <code>oraholic-cebu</code>)를 넣고 <b>연결 확인 및 켜기</b>를 누릅니다. 엘레나는 같은 주소와 코드를 넣으면 됩니다.</li>' +
        '</ol>' +
        '<div class="field"><label for="syncUrl">데이터베이스 주소</label>' +
          '<input type="url" id="syncUrl" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://내프로젝트-default-rtdb.firebaseio.com" value="' + esc(s.url) + '">' +
          '<div class="hint">주소가 <code>asia-southeast1</code>이면 그대로 붙여넣으세요. 끝의 / 는 자동으로 정리됩니다.</div></div>' +
        '<div class="field"><label for="syncCode">공유 코드</label>' +
          '<input type="text" id="syncCode" autocomplete="off" spellcheck="false" placeholder="예: oraholic-cebu" value="' + esc(s.code) + '">' +
          '<div class="hint">사장님과 엘레나가 <b>똑같은 코드</b>를 쓰면 같은 장부를 봅니다. 다른 사람에게는 알려주지 마세요.</div></div>' +
        '<div class="data-row">' +
          '<button type="button" class="btn primary sm" data-action="sync-enable" id="syncEnableBtn">' + (s.enabled ? '연결 확인' : '연결 확인 및 켜기') + '</button>' +
          (s.enabled ? '<button type="button" class="btn sm" data-action="sync-now">지금 동기화</button>' : '') +
          (s.enabled ? '<button type="button" class="btn sm ghost" data-action="sync-off">끄기</button>' : '') +
        '</div>' +
        (s.enabled && s.lastSync ? '<div class="tiny muted" style="margin-top:8px">마지막 동기화 · ' + fmtDateTime(s.lastSync) + '</div>' : '') +
        '<div class="tiny muted" style="margin-top:10px;line-height:1.6">⚠️ 테스트 모드는 누구나 읽을 수 있습니다. 손님 개인정보가 걱정되면 Firebase 규칙을 잠그고, 두 기기만 쓰는 것을 권합니다. 연결이 끊겨도 기록은 이 기기에 그대로 저장됩니다.</div>' +
      '</section>' +

      '<section class="set-block">' +
        '<h2>🏠 하우스 안내</h2>' +
        '<div class="house-info">' +
          HOUSES.map((h) => '<div class="house-info-row"><b>' + h.name + '</b><span class="rt">' + h.short + '</span><span class="muted">' + h.desc + ' · 기본 ' + h.baseGuests + '명</span></div>').join('') +
        '</div>' +
      '</section>' +

      '<section class="set-block">' +
        '<h2>💾 데이터</h2>' +
        '<p class="lead">이 기기에 자동 저장됩니다. 아래에서 백업하거나 샘플로 미리 볼 수 있습니다.</p>' +
        '<div class="data-row">' +
          '<button type="button" class="btn sm" data-action="export-json">JSON 내보내기</button>' +
          '<button type="button" class="btn sm" data-action="import-json">JSON 가져오기</button>' +
          '<button type="button" class="btn sm ghost" data-action="save-sample">샘플 데이터 넣기</button>' +
        '</div>' +
        '<div class="danger-zone">' +
          '<button type="button" class="btn sm danger" data-action="reset-all">전체 초기화</button>' +
          '<div class="tiny muted" style="margin-top:6px">전체 초기화는 이 기기의 예약을 모두 지웁니다. 먼저 JSON으로 백업해 주세요.</div>' +
        '</div>' +
        '<div class="tiny muted" style="margin-top:12px">앱 버전 ' + APP_VERSION + ' · 저장 위치: 이 브라우저(localStorage)' + (s.enabled ? ' + Firebase 공동 운영' : '') + '</div>' +
      '</section>' +

      '<section class="set-block">' +
        '<h2>📱 홈 화면에 설치</h2>' +
        '<p class="lead" style="margin:0">아이폰(Safari)은 <b>공유 → 홈 화면에 추가</b>, 안드로이드(Chrome)는 <b>⋮ → 앱 설치</b>를 누르면 앱처럼 쓸 수 있습니다. 인터넷이 없어도 열립니다.</p>' +
      '</section>';
    setSyncStatus(s.enabled ? (syncRuntime || 'off') : 'off');
  }

  /* ---------- 12. 예약 폼 ---------- */
  function formDefaults(b, prefill) {
    const p = prefill || {};
    const house = (b && b.house) || p.house || 'A';
    const h = houseById(house);
    const ci = (b && b.checkIn) || p.date || todayStr();
    const co = (b && b.checkOut) || shiftStr(ci, 1);
    return Object.assign({
      id: '', house: house, source: '개별', guestName: '', phone: '', payer: '', guestNames: '',
      checkIn: ci, checkInTime: '15:00', nightFlight: false,
      checkOut: co, checkOutTime: '11:00',
      airline: '', flightNo: '', arriveDate: ci, arriveTime: '15:00', departDate: co, departTime: '11:00',
      baseGuests: h.baseGuests, extraGuests: 0,
      ate: false, ateNote: '', ateName: '', babysitter: false, babysitterNote: '', tutor: false, tutorNote: '',
      mattress: 0, pickup: false, dropoff: false, pickupNote: '',
      totalAmount: 0, prepaid: 0,
      depositAmount: 5000, depositReceivedAt: '', depositRefundedAt: '',
      note: ''
    }, b || {});
  }

  function openBookingForm(booking, prefill) {
    const isEdit = !!(booking && booking.id);
    const d = formDefaults(booking, prefill);
    const status = booking ? depositStatus(booking) : 'pending';
    const h = houseById(d.house);
    const html =
      '<div class="sheet-head"><h2>' + (isEdit ? '예약 수정' : '새 예약') + '</h2>' +
        '<button type="button" class="x" data-action="close-sheet" aria-label="닫기">✕</button></div>' +
      '<div class="sheet-body">' +
        '<form id="bookingForm" novalidate data-id="' + esc(d.id) + '">' +
          '<div class="form-group"><h3>🏠 하우스</h3>' +
            '<input type="hidden" name="house" id="fHouse" value="' + d.house + '">' +
            '<div class="house-pick">' + HOUSES.map((x) =>
              '<button type="button" class="house-opt' + (x.id === d.house ? ' on' : '') + '" data-pick-house="' + x.id + '">' +
                '<span class="h"><i class="hd"></i>' + x.name + '</span><span class="m">' + x.desc + '</span></button>').join('') + '</div></div>' +

          '<div class="form-group"><h3>🏷 예약 구분</h3>' +
            '<input type="hidden" name="source" id="fSource" value="' + esc(d.source) + '">' +
            '<div class="seg-pick">' + SOURCES.map((s) =>
              '<button type="button" class="' + (s === d.source ? 'on' : '') + '" data-pick-source="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div></div>' +

          '<div class="form-group"><h3>🙋 손님</h3>' +
            '<div class="field" style="margin:0"><label for="fGuestName">대표 예약자명 *</label><input type="text" id="fGuestName" name="guestName" value="' + esc(d.guestName) + '" placeholder="예: 김민수" autocomplete="off">' +
              '<div class="hint">이름만으로 저장할 수 있습니다.</div></div>' +
            '<div class="grid2" style="margin-top:8px">' +
              '<div class="field" style="margin:0"><label for="fPhone">연락처 (선택)</label><input type="tel" id="fPhone" name="phone" value="' + esc(d.phone) + '" placeholder="010-0000-0000">' +
                '<div class="hint">있으면 카드에 함께 보입니다.</div></div>' +
              '<div class="field" style="margin:0"><label for="fPayer">입금자 (선택)</label><input type="text" id="fPayer" name="payer" value="' + esc(d.payer || '') + '" placeholder="예: 김우열"></div>' +
            '</div>' +
            '<div class="field" style="margin-top:8px"><label for="fGuestNames">투숙객 전원 성명 (선택)</label>' +
              '<input type="text" id="fGuestNames" name="guestNames" value="' + esc(d.guestNames || '') + '" placeholder="쉼표로 구분 · 예: 박경자, 김우열, 김하린, 김유찬">' +
              '<div class="hint">확정서 「숙박인」에 그대로 들어갑니다.</div></div>' +
          '</div>' +

          '<div class="form-group"><h3>📅 일정</h3>' +
            '<div class="grid2">' +
              '<div class="field"><label for="fCheckIn">입실일 *</label><input type="date" id="fCheckIn" name="checkIn" value="' + d.checkIn + '"></div>' +
              '<div class="field"><label for="fCheckInTime">입실 시간</label><input type="time" id="fCheckInTime" name="checkInTime" value="' + esc(d.checkInTime) + '"></div>' +
            '</div>' +
            '<label class="check"><input type="checkbox" id="fNight" name="nightFlight"' + (d.nightFlight ? ' checked' : '') + '> 🌙 밤/새벽 비행기로 도착<span class="ck-sub">늦은 입실 · 새벽 도착 손님</span></label>' +
            '<div class="grid2 mt8">' +
              '<div class="field"><label for="fCheckOut">퇴실일 *</label><input type="date" id="fCheckOut" name="checkOut" value="' + d.checkOut + '"></div>' +
              '<div class="field"><label for="fCheckOutTime">퇴실 시간</label><input type="time" id="fCheckOutTime" name="checkOutTime" value="' + esc(d.checkOutTime) + '"></div>' +
            '</div>' +
            '<div id="formNotice" class="form-notice"></div>' +
          '</div>' +

          '<div class="form-group"><h3>👥 인원</h3>' +
            '<div class="grid2">' +
              '<div class="field" style="margin:0"><label for="fBaseGuests">기본 인원</label><input type="number" id="fBaseGuests" name="baseGuests" min="1" max="30" value="' + d.baseGuests + '"></div>' +
              '<div class="field" style="margin:0"><label for="fExtraGuests">추가 인원</label><input type="number" id="fExtraGuests" name="extraGuests" min="0" max="20" value="' + d.extraGuests + '">' +
                '<div class="hint">기본 ' + h.baseGuests + '명 초과 시</div></div>' +
            '</div></div>' +

          '<div class="form-group"><h3>✨ 추가 서비스</h3>' +
            '<div class="addon"><label class="check"><input type="checkbox" id="fAte" name="ate"' + (d.ate ? ' checked' : '') + '> 👩‍🍳 아떼(Ate) 서비스</label>' +
              '<div class="note"><input type="text" id="fAteName" name="ateName" value="' + esc(d.ateName || '') + '" placeholder="배정된 아떼 이름 · 예: 마리엘"></div>' +
              '<div class="note"><input type="text" id="fAteNote" name="ateNote" value="' + esc(d.ateNote) + '" placeholder="예: 아침 식사 준비 8시"></div></div>' +
            '<div class="addon"><label class="check"><input type="checkbox" id="fBaby" name="babysitter"' + (d.babysitter ? ' checked' : '') + '> 🧸 베이비시터</label>' +
              '<div class="note"><input type="text" id="fBabyNote" name="babysitterNote" value="' + esc(d.babysitterNote) + '" placeholder="예: 오후 2~5시, 아이 2명"></div></div>' +
            '<div class="addon"><label class="check"><input type="checkbox" id="fTutor" name="tutor"' + (d.tutor ? ' checked' : '') + '> 📚 튜터 수업</label>' +
              '<div class="note"><input type="text" id="fTutorNote" name="tutorNote" value="' + esc(d.tutorNote) + '" placeholder="예: 영어 회화 2회"></div></div>' +
            '<div class="field" style="margin:8px 0 0"><label for="fMattress">🛏 추가 매트리스</label><input type="number" id="fMattress" name="mattress" min="0" max="10" value="' + d.mattress + '">' +
              '<div class="hint">필요한 매트리스 개수 (0이면 없음)</div></div>' +
          '</div>' +

          '<div class="form-group"><h3>✈️ 항공편</h3>' +
            '<div class="grid2">' +
              '<div class="field" style="margin:0"><label for="fAirline">항공사</label><input type="text" id="fAirline" name="airline" value="' + esc(d.airline || '') + '" placeholder="예: 대한항공"></div>' +
              '<div class="field" style="margin:0"><label for="fFlightNo">항공편명</label><input type="text" id="fFlightNo" name="flightNo" value="' + esc(d.flightNo || '') + '" placeholder="예: KE631"></div>' +
            '</div>' +
            '<div class="grid2" style="margin-top:8px">' +
              '<div class="field" style="margin:0"><label for="fArriveDate">세부 도착일</label><input type="date" id="fArriveDate" name="arriveDate" value="' + esc(d.arriveDate || d.checkIn) + '"></div>' +
              '<div class="field" style="margin:0"><label for="fArriveTime">도착 시간</label><input type="time" id="fArriveTime" name="arriveTime" value="' + esc(d.arriveTime || '') + '"></div>' +
            '</div>' +
            '<div class="grid2" style="margin-top:8px">' +
              '<div class="field" style="margin:0"><label for="fDepartDate">세부 출발일</label><input type="date" id="fDepartDate" name="departDate" value="' + esc(d.departDate || d.checkOut) + '"></div>' +
              '<div class="field" style="margin:0"><label for="fDepartTime">출발 시간</label><input type="time" id="fDepartTime" name="departTime" value="' + esc(d.departTime || '') + '"></div>' +
            '</div>' +
            '<div class="hint">픽업·샌딩 시간을 잡을 때 쓰고, 확정서 「추가 정보 (항공편)」에 그대로 들어갑니다.</div>' +
          '</div>' +

          '<div class="form-group"><h3>🚐 픽업 · 샌딩</h3>' +
            '<label class="check"><input type="checkbox" id="fPickup" name="pickup"' + (d.pickup ? ' checked' : '') + '> 공항 픽업</label>' +
            '<label class="check"><input type="checkbox" id="fDropoff" name="dropoff"' + (d.dropoff ? ' checked' : '') + '> 공항 샌딩</label>' +
            '<div class="field" style="margin:6px 0 0"><label for="fPickupNote">항공편 · 시간</label><input type="text" id="fPickupNote" name="pickupNote" value="' + esc(d.pickupNote) + '" placeholder="예: PR 432 / 23:40 도착"></div>' +
          '</div>' +

          '<div class="form-group"><h3>💰 금액 (페소)</h3>' +
            '<div class="grid3">' +
              '<div class="field" style="margin:0"><label for="fTotal">총 금액</label><input type="number" id="fTotal" name="totalAmount" min="0" step="100" value="' + d.totalAmount + '"></div>' +
              '<div class="field" style="margin:0"><label for="fPrepaid">예약금</label><input type="number" id="fPrepaid" name="prepaid" min="0" step="100" value="' + d.prepaid + '"></div>' +
              '<div class="field" style="margin:0"><label>잔금</label><div id="balanceView" style="padding:9px 0;font-weight:800">' + money(Math.max(0, num(d.totalAmount) - num(d.prepaid))) + '</div></div>' +
            '</div></div>' +

          '<div class="form-group"><h3>🔐 보증금</h3>' +
            '<div class="field" style="margin:0 0 8px"><label for="fDeposit">보증금 금액</label><input type="number" id="fDeposit" name="depositAmount" min="0" step="100" value="' + d.depositAmount + '">' +
              '<div class="hint">입실 1주일 전부터 받고, 퇴실 후 반환합니다.</div></div>' +
            '<div class="grid2">' +
              '<div class="field" style="margin:0"><label for="fDepReceived">수령 완료일</label><input type="date" id="fDepReceived" name="depositReceivedAt" value="' + esc(d.depositReceivedAt) + '">' +
                '<button type="button" class="btn xs ghost" style="margin-top:5px" data-action="dep-today" data-kind="receive">오늘 수령</button></div>' +
              '<div class="field" style="margin:0"><label for="fDepRefunded">반환 완료일</label><input type="date" id="fDepRefunded" name="depositRefundedAt" value="' + esc(d.depositRefundedAt) + '">' +
                '<button type="button" class="btn xs ghost" style="margin-top:5px" data-action="dep-today" data-kind="refund">오늘 반환</button></div>' +
            '</div>' +
            '<div class="dep-flag" id="depFlag">' +
              '<span class="pill' + (status === 'pending' || status === 'none' ? ' on' : '') + '">미수령</span>' +
              '<span class="pill' + (status === 'received' ? ' on' : '') + '">수령 완료</span>' +
              '<span class="pill' + (status === 'refunded' ? ' on' : '') + '">반환 완료</span>' +
            '</div></div>' +

          '<div class="form-group"><h3>📝 특이사항</h3>' +
            '<textarea name="note" id="fNote" placeholder="예: 아이 2명, 늦은 체크인, 청소 요청 등">' + esc(d.note) + '</textarea></div>' +

          (isEdit ? '<div class="tiny muted">등록: ' + esc(booking.createdBy || '-') + ' · ' + fmtDateTime(booking.createdAt) +
            (booking.updatedBy && booking.updatedBy !== booking.createdBy ? ' / 최근 수정: ' + esc(booking.updatedBy) + ' · ' + fmtDateTime(booking.updatedAt) : '') + '</div>' : '') +
        '</form>' +
      '</div>' +
      '<div class="sheet-foot">' +
        (isEdit ? '<button type="button" class="btn danger del" data-action="delete-booking" data-id="' + esc(booking.id) + '">삭제</button>' : '') +
        '<button type="button" class="btn ghost" data-action="close-sheet">취소</button>' +
        '<button type="submit" form="bookingForm" class="btn primary">저장</button>' +
      '</div>';
    openSheet(html, { focus: '#fGuestName' });
    const form = $('#bookingForm');
    if (form) {
      form.addEventListener('submit', onSubmitBooking);
      updateFormNotice();
      updateDepFlag();
    }
  }

  function updateBalance() {
    const total = num($('#fTotal') && $('#fTotal').value);
    const pre = num($('#fPrepaid') && $('#fPrepaid').value);
    const el = $('#balanceView');
    if (el) el.textContent = money(Math.max(0, total - pre));
  }
  function updateDepFlag() {
    const recv = $('#fDepReceived') ? $('#fDepReceived').value : '';
    const ref = $('#fDepRefunded') ? $('#fDepRefunded').value : '';
    const amt = num($('#fDeposit') && $('#fDeposit').value);
    const st = ref ? 'refunded' : recv ? 'received' : amt > 0 ? 'pending' : 'none';
    const flag = $('#depFlag');
    if (flag) {
      flag.innerHTML = '<span class="pill' + (st === 'pending' || st === 'none' ? ' on' : '') + '">미수령</span>' +
        '<span class="pill' + (st === 'received' ? ' on' : '') + '">수령 완료</span>' +
        '<span class="pill' + (st === 'refunded' ? ' on' : '') + '">반환 완료</span>';
    }
  }
  function updateFormNotice() {
    const box = $('#formNotice');
    if (!box || !$('#bookingForm')) return;
    const house = $('#fHouse').value;
    const ci = $('#fCheckIn').value;
    const co = $('#fCheckOut').value;
    const id = $('#bookingForm').getAttribute('data-id') || '';
    if (!ci || !co) { box.className = 'form-notice'; box.textContent = ''; return; }
    if (co <= ci) {
      box.className = 'form-notice err show';
      box.innerHTML = '⚠ 퇴실일은 입실일 <b>다음 날 이후</b>여야 합니다. (최소 1박)';
      return;
    }
    const c = conflictFor(house, ci, co, id);
    if (c) {
      box.className = 'form-notice err show';
      box.innerHTML = '⛔ ' + house + '하우스는 ' + fmtMD(c.checkIn) + '~' + fmtMD(c.checkOut) + ' <b>' + esc(c.guestName) + '</b> 예약과 겹칩니다. ' +
        '같은 하우스의 숙박 기간은 겹칠 수 없습니다.';
      return;
    }
    const tn = turnoverFor(house, ci, co, id);
    if (tn.any) {
      const parts = [];
      tn.outs.forEach((b) => parts.push('앞 손님 <b>' + esc(b.guestName) + '</b> ' + fmtMD(b.checkOut) + ' ' + esc(b.checkOutTime) + ' 퇴실'));
      tn.ins.forEach((b) => parts.push('다음 손님 <b>' + esc(b.guestName) + '</b> ' + fmtMD(b.checkIn) + ' ' + esc(b.checkInTime) + ' 입실'));
      box.className = 'form-notice ok show';
      box.innerHTML = '🔄 <b>당일 퇴실 후 입실(턴오버)</b> — ' + parts.join(' · ') + '. 청소·정비 시간을 확인하세요.';
      return;
    }
    box.className = 'form-notice info show';
    box.innerHTML = '✅ ' + house + '하우스 · ' + fmtMD(ci) + ' ~ ' + fmtMD(co) + ' (' + nights(ci, co) + '박) 예약 가능한 일정입니다.';
  }

  function readForm() {
    const f = $('#bookingForm');
    if (!f) return null;
    const val = (id) => { const el = $('#' + id); return el ? el.value : ''; };
    const chk = (id) => !!(elById(id) && elById(id).checked);
    function elById(id) { return document.getElementById(id); }
    return {
      id: f.getAttribute('data-id') || '',
      house: val('fHouse'),
      source: val('fSource'),
      guestName: val('fGuestName').trim(),
      phone: val('fPhone').trim(),
      payer: val('fPayer').trim(),
      guestNames: val('fGuestNames').trim(),
      checkIn: val('fCheckIn'),
      checkInTime: val('fCheckInTime') || '15:00',
      nightFlight: chk('fNight'),
      checkOut: val('fCheckOut'),
      checkOutTime: val('fCheckOutTime') || '11:00',
      airline: val('fAirline').trim(),
      flightNo: val('fFlightNo').trim(),
      arriveDate: val('fArriveDate') || val('fCheckIn'),
      arriveTime: val('fArriveTime') || val('fCheckInTime'),
      departDate: val('fDepartDate') || val('fCheckOut'),
      departTime: val('fDepartTime') || val('fCheckOutTime'),
      baseGuests: num(val('fBaseGuests')),
      extraGuests: num(val('fExtraGuests')),
      addons: {
        ate: chk('fAte'), ateNote: val('fAteNote'), ateName: val('fAteName'),
        babysitter: chk('fBaby'), babysitterNote: val('fBabyNote'),
        tutor: chk('fTutor'), tutorNote: val('fTutorNote')
      },
      mattress: num(val('fMattress')),
      pickup: chk('fPickup'),
      dropoff: chk('fDropoff'),
      pickupNote: val('fPickupNote'),
      totalAmount: num(val('fTotal')),
      prepaid: num(val('fPrepaid')),
      depositAmount: num(val('fDeposit')),
      depositReceivedAt: val('fDepReceived'),
      depositRefundedAt: val('fDepRefunded'),
      note: val('fNote')
    };
  }

  function onSubmitBooking(e) {
    if (e && e.preventDefault) e.preventDefault();
    const data = readForm();
    if (!data) return;
    if (data.depositRefundedAt) data.depositReceivedAt = data.depositReceivedAt || todayStr();
    if (data.depositReceivedAt && data.depositRefundedAt && data.depositRefundedAt < data.depositReceivedAt) data.depositRefundedAt = data.depositReceivedAt;
    const res = data.id ? updateBooking(data.id, data) : addBooking(data);
    if (!res.ok) {
      const box = $('#formNotice');
      if (box) { box.className = 'form-notice err show'; box.innerHTML = '⛔ ' + esc(res.error); }
      toast(res.error, 'err');
      return;
    }
    closeSheet();
    toast((data.id ? '예약을 수정했습니다' : '예약을 저장했습니다') + ' · ' + esc(res.booking.guestName) + ' (' + esc(state.settings.operator) + ')');
    renderAll();
  }

  /* ---------- 13. 운영자 ---------- */
  function setOperator(name) {
    const n = String(name || '').trim().slice(0, 16);
    if (!n) { toast('이름을 입력해 주세요.', 'warn'); return; }
    state.settings.operator = n;
    save(false);
    renderHeader();
    if (ui.view === 'settings') renderSettings();
    closeSheet();
    toast('작업자: ' + n);
  }
  function openOperatorSheet() {
    const op = state.settings.operator;
    openSheet(
      '<div class="sheet-head"><h2>작업자 선택</h2><button type="button" class="x" data-action="close-sheet" aria-label="닫기">✕</button></div>' +
      '<div class="sheet-body">' +
        '<p class="lead" style="font-size:12.5px;color:var(--ink-2);margin:0 0 10px">지금 이 기기에서 예약을 등록·수정하는 사람입니다. 예약 카드에 이름이 남습니다.</p>' +
        '<div class="operator-picker">' + OPERATOR_PRESETS.map((n) =>
          '<button type="button" data-action="op-pick" data-op="' + esc(n) + '" class="' + (op === n ? 'on' : '') + '">' + esc(n) + '</button>').join('') + '</div>' +
        '<div class="field" style="margin-top:6px"><label for="opSheetCustom">다른 이름</label>' +
          '<input type="text" id="opSheetCustom" maxlength="16" placeholder="예: 마이클" value="' + (OPERATOR_PRESETS.indexOf(op) < 0 ? esc(op) : '') + '"></div>' +
        '<button type="button" class="btn primary block" data-action="op-save-sheet">이 이름으로 설정</button>' +
        '<div class="tiny muted" style="margin-top:10px">사장님과 엘레나가 같은 Firebase 코드로 연결되어 있으면, 서로의 등록·수정 내역이 예약마다 표시됩니다.</div>' +
      '</div>'
    );
  }

  /* ---------- 14. 동기화 ---------- */
  let syncBusy = false;
  let syncTimer = null;
  let syncDebounce = null;

  function syncEndpoint(s) {
    const cfg = s || state.sync;
    if (!cfg || !cfg.url) return '';
    let u = String(cfg.url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const code = String(cfg.code || 'oraholic-cebu').trim().replace(/[^\w\-]/g, '').slice(0, 40) || 'oraholic-cebu';
    return u + '/oraholic-guesthouse/' + encodeURIComponent(code) + '.json';
  }

  function mergeBookings(local, remote) {
    const map = new Map();
    (local || []).forEach((b) => { if (b && b.id) map.set(b.id, b); });
    (remote || []).forEach((r) => {
      if (!r || !r.id) return;
      const cur = map.get(r.id);
      if (!cur || num(r.updatedAt) > num(cur.updatedAt)) map.set(r.id, normalizeBooking(r));
    });
    return Array.from(map.values());
  }

  async function syncNow(options) {
    const o = options || {};
    if (!state.sync.enabled && !o.force) return { ok: false, reason: 'off' };
    if (typeof fetch !== 'function') { setSyncStatus('error'); syncRuntime = 'error'; return { ok: false, reason: 'no-fetch' }; }
    if (!syncEndpoint()) { setSyncStatus('error'); syncRuntime = 'error'; return { ok: false, reason: 'no-url' }; }
    if (syncBusy) return { ok: false, reason: 'busy' };
    syncBusy = true;
    syncRuntime = 'connecting';
    setSyncStatus('connecting');
    try {
      const ep = syncEndpoint();
      const res = await fetch(ep, { cache: 'no-store' });
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
      const remote = await res.json();
      const merged = mergeBookings(state.bookings, (remote && remote.bookings) || []);
      const changed = JSON.stringify(merged) !== JSON.stringify(state.bookings);
      state.bookings = merged;
      const pinChanged = adoptRemoteSecurity(remote);
      const put = await fetch(ep, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          v: 1, app: 'oraholic-guesthouse', updatedAt: Date.now(), bookings: merged,
          security: { pinHash: state.security.pinHash, pinUpdatedAt: state.security.pinUpdatedAt }
        })
      });
      if (!put || !put.ok) throw new Error('HTTP ' + (put ? put.status : '?'));
      state.sync.lastSync = Date.now();
      saveLocal();
      syncRuntime = 'on';
      setSyncStatus('on');
      if (changed) renderAll();
      if (pinChanged && !locked) toast('공동 운영으로 접속 비밀번호가 바뀌었습니다. 다음에 열 때는 새 비밀번호를 씁니다.', 'warn');
      return { ok: true, changed };
    } catch (err) {
      syncRuntime = 'error';
      setSyncStatus('error');
      return { ok: false, reason: 'network', error: String(err && err.message || err) };
    } finally {
      syncBusy = false;
    }
  }

  function scheduleSync() {
    if (syncDebounce) clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => { syncNow(); }, 1200);
  }
  function startSyncPolling() {
    if (TEST) return;
    if (syncTimer) clearInterval(syncTimer);
    if (!state.sync.enabled) return;
    syncTimer = setInterval(() => { syncNow(); }, MAX_SYNC_MS);
  }

  async function enableSync() {
    const url = ($('#syncUrl') && $('#syncUrl').value || '').trim();
    const code = ($('#syncCode') && $('#syncCode').value || '').trim();
    if (!url) { toast('데이터베이스 주소를 입력해 주세요.', 'warn'); return; }
    if (!code) { toast('공유 코드를 입력해 주세요.', 'warn'); return; }
    state.sync.url = url;
    state.sync.code = code;
    const prev = state.sync.enabled;
    state.sync.enabled = true;
    syncRuntime = 'connecting';
    setSyncStatus('connecting');
    saveLocal();
    const res = await syncNow({ force: true });
    if (res.ok) {
      toast('공동 운영 동기화가 연결되었습니다 🎉');
      saveLocal();
      startSyncPolling();
      renderAll();
      return;
    }
    state.sync.enabled = prev;
    syncRuntime = prev ? 'on' : 'off';
    saveLocal();
    setSyncStatus(state.sync.enabled ? (syncRuntime || 'off') : 'off');
    if ($('#syncState')) {
      $('#syncState').className = 'sync-state error';
      $('#syncState').innerHTML = '❌ 연결 실패 — 주소·코드를 확인해 주세요. (' + esc(res.reason === 'network' ? (res.error || '네트워크') : res.reason) + ')';
    }
    toast('연결하지 못했습니다. 주소와 코드를 확인해 주세요.', 'err');
  }

  function disableSync() {
    state.sync.enabled = false;
    syncRuntime = 'off';
    saveLocal();
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    setSyncStatus('off');
    renderAll();
    toast('동기화를 껐습니다. 이 기기에만 저장됩니다.');
  }

  /* ---------- 15. 데이터 ---------- */
  function sampleBookings() {
    const t = todayStr();
    const d = (n) => shiftStr(t, n);
    const mk = (o) => normalizeBooking(Object.assign({ createdBy: '사장님', updatedBy: '사장님' }, o));
    const list = [
      mk({
        house: 'A', source: '개별', guestName: '김민수', phone: '010-2345-6789',
        payer: '이지은', guestNames: '김민수, 이지은, 김하준, 김서연, 김지우',
        checkIn: d(-2), checkInTime: '21:30', nightFlight: true, checkOut: d(2), checkOutTime: '11:00',
        airline: '대한항공', flightNo: 'KE631', arriveDate: d(-2), arriveTime: '23:40', departDate: d(2), departTime: '01:10',
        baseGuests: 4, extraGuests: 1,
        addons: { ate: true, ateNote: '아침 8시 준비', ateName: '마리엘', babysitter: false, babysitterNote: '', tutor: false, tutorNote: '' },
        mattress: 1, pickup: true, pickupNote: 'PR 432 / 23:40 도착',
        totalAmount: 32000, prepaid: 10000, depositAmount: 5000, depositReceivedAt: d(-3),
        note: '아이 2명 · 늦은 체크인'
      }),
      mk({
        house: 'A', source: '에어비앤비', guestName: '사토 유키', phone: '+81 90-1234-5678',
        checkIn: d(2), checkInTime: '22:10', nightFlight: true, checkOut: d(5), checkOutTime: '11:00',
        baseGuests: 2, extraGuests: 0,
        totalAmount: 28000, prepaid: 8000, depositAmount: 5000,
        note: '당일 A하우스 턴오버 — 오후 정비 필요'
      }),
      mk({
        house: 'B', source: '에어비앤비', guestName: '박지은', phone: '010-9876-5432',
        payer: '박지은', guestNames: '박지은, 박준호, 박하은',
        airline: '진에어', flightNo: 'LJ031', arriveDate: d(6), arriveTime: '14:20', departDate: d(9), departTime: '12:00',
        checkIn: d(6), checkInTime: '15:00', checkOut: d(9), checkOutTime: '11:00',
        baseGuests: 3, extraGuests: 0,
        addons: { ate: false, ateNote: '', babysitter: true, babysitterNote: '오후 2~5시, 아이 1명', tutor: false, tutorNote: '' },
        mattress: 2, totalAmount: 24000, prepaid: 6000, depositAmount: 5000
      }),
      mk({
        house: 'B', source: '에어비앤비', guestName: 'Smith family', phone: '+1 415-555-0132',
        payer: 'Michael Smith', guestNames: 'Michael Smith, Anna Smith, Emma Smith, Noah Smith, Liam Smith, Olivia Smith',
        airline: 'Cebu Pacific', flightNo: '5J 038', arriveDate: d(10), arriveTime: '16:20', departDate: d(13), departTime: '18:05',
        checkIn: d(10), checkInTime: '16:00', checkOut: d(13), checkOutTime: '11:00',
        baseGuests: 5, extraGuests: 1, mattress: 1,
        totalAmount: 30000, prepaid: 10000, depositAmount: 5000,
        note: '픽업 요청 예정'
      }),
      mk({
        house: 'C', source: '개별', guestName: '요시다 켄', phone: '+81 80-2222-3333',
        checkIn: d(-3), checkInTime: '14:00', checkOut: d(0), checkOutTime: '11:00',
        baseGuests: 2, extraGuests: 0,
        addons: { ate: true, ateNote: '저녁 6시', ateName: '조이', babysitter: false, babysitterNote: '', tutor: false, tutorNote: '' },
        totalAmount: 18000, prepaid: 5000, depositAmount: 4000, depositReceivedAt: d(-4),
        note: '오늘 퇴실 → C하우스 턴오버'
      }),
      mk({
        house: 'C', source: '에어비앤비', guestName: '마리아 산토스', phone: '+63 917 555 0101',
        checkIn: d(0), checkInTime: '15:00', checkOut: d(3), checkOutTime: '11:00',
        baseGuests: 4, extraGuests: 0,
        addons: { ate: false, ateNote: '', babysitter: false, babysitterNote: '', tutor: true, tutorNote: '영어 수업 2회 · 6시' },
        totalAmount: 24000, prepaid: 6000, depositAmount: 5000, depositReceivedAt: d(-2),
        createdBy: '엘레나', updatedBy: '엘레나',
        note: '오늘 요시다 씨 퇴실 후 입실'
      }),
      mk({
        house: 'D', source: '개별', guestName: '최현우', phone: '010-1111-2222',
        checkIn: d(-5), checkInTime: '15:00', checkOut: d(0), checkOutTime: '11:00',
        baseGuests: 2, extraGuests: 0,
        totalAmount: 20000, prepaid: 5000, depositAmount: 5000, depositReceivedAt: d(-6),
        note: '오늘 퇴실 · 보증금 반환 대기'
      })
    ];
    return list;
  }

  function loadSample() {
    state.bookings = sampleBookings();
    save();
    renderAll();
    toast('샘플 데이터를 넣었습니다. 턴오버·3룸 빈방·보증금을 확인해 보세요.');
  }
  function resetAll() {
    const op = state.settings.operator;
    const sync = state.sync;
    const security = state.security;   // 전체 초기화해도 접속 비밀번호는 그대로 둡니다
    state = defaultState();
    state.settings.operator = op;
    state.sync = sync;
    state.security = security;
    save(false);
    renderAll();
    toast('모든 예약을 지웠습니다. 깨끗한 상태에서 시작합니다.');
  }
  function exportJSON() {
    const data = { app: 'oraholic-guesthouse', v: 1, exportedAt: new Date().toISOString(), bookings: liveBookings(), settings: state.settings };
    const text = JSON.stringify(data, null, 2);
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'oraholic-guesthouse-' + todayStr() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast('JSON 파일을 내보냈습니다.');
    } catch (e) {
      toast('내보내기를 지원하지 않는 브라우저입니다.', 'warn');
    }
    return data;
  }
  function importJSON(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { toast('JSON 파일을 읽을 수 없습니다.', 'err'); return { ok: false }; }
    const list = Array.isArray(raw) ? raw : (raw && raw.bookings);
    if (!Array.isArray(list)) { toast('예약 목록이 없는 파일입니다.', 'err'); return { ok: false }; }
    const clean = list.map(normalizeBooking).filter((b) => b.checkIn && b.checkOut);
    state.bookings = clean;
    save(false);
    renderAll();
    toast(clean.length + '건의 예약을 가져왔습니다.');
    return { ok: true, count: clean.length };
  }

  /* ---------- 15.5 접속 비밀번호 잠금 ---------- */
  function hashPin(pin) {
    // 4자리 비밀번호가 저장소에 그대로 남지 않도록 두 개의 32비트 해시로 보관합니다.
    const s = 'oraholic-guesthouse:' + String(pin == null ? '' : pin);
    let h1 = 0x811c9dc5;
    let h2 = 0x1000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
    }
    const hex = (n) => ('00000000' + n.toString(16)).slice(-8);
    return hex(h1) + hex(h2);
  }
  function isDefaultPin() { return state.security.pinHash === hashPin(DEFAULT_PIN); }

  let locked = true;   // 화면이 잠겨 있는지 (잠긴 동안 예약 데이터는 그리지 않습니다)

  function readAuthRecord(store) {
    try {
      const raw = JSON.parse(store.getItem(AUTH_KEY) || 'null');
      return raw && typeof raw === 'object' ? raw : null;
    } catch (e) { return null; }
  }
  function authMatches(rec) { return !!(rec && rec.pinHash && rec.pinHash === state.security.pinHash); }
  function keepRecord() { try { return readAuthRecord(localStorage); } catch (e) { return null; } }
  function hasValidSession() {
    if (authMatches(keepRecord())) return true;
    try { return authMatches(readAuthRecord(sessionStorage)); } catch (e) { return false; }
  }
  function writeAuthRecord(remember) {
    const rec = JSON.stringify({ pinHash: state.security.pinHash, at: Date.now() });
    try {
      if (remember) {
        localStorage.setItem(AUTH_KEY, rec);
        try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
      } else {
        sessionStorage.setItem(AUTH_KEY, rec);
        try { localStorage.removeItem(AUTH_KEY); } catch (e) {}
      }
    } catch (e) { /* 저장 공간 부족 */ }
  }
  function clearAuthRecord() {
    try { localStorage.removeItem(AUTH_KEY); } catch (e) {}
    try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
  }

  function clearProtectedViews() {
    closeSheet();
    const t = $('#toastRoot');
    if (t) t.innerHTML = '';
    ['viewCalendar', 'viewToday', 'viewBookings', 'viewFinder', 'viewConfirm', 'viewSettings'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
  }

  function setLockError(msg, ok) {
    const el = $('#lockError');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'lock-error' + (msg ? (ok ? ' ok' : '') : '');
  }
  function refreshLockHint() {
    const hint = $('#lockDefaultHint');
    if (hint) hint.classList.toggle('hidden', !isDefaultPin());
    const badge = $('#lockDefaultBadge');
    if (badge) badge.classList.toggle('hidden', !isDefaultPin());
  }

  function showLock(opts) {
    locked = true;
    const shell = $('#app-shell');
    if (shell) { shell.classList.add('hidden'); shell.setAttribute('hidden', ''); }
    const screen = $('#lockScreen');
    if (screen) screen.classList.remove('hidden');
    clearProtectedViews();
    setLockError('');
    refreshLockHint();
    const keep = $('#lockKeep');
    if (keep && !(opts && opts.keepState)) keep.checked = true;
    const pin = $('#lockPin');
    if (pin) {
      pin.value = '';
      if (!(opts && opts.noFocus)) setTimeout(() => { try { pin.focus(); } catch (e) {} }, 60);
    }
    document.body.style.overflow = 'hidden';
  }

  function unlockApp(opts) {
    // 로그인 기록이 확인될 때만 앱을 보여 줍니다.
    if (!(opts && opts.force) && !hasValidSession()) return false;
    locked = false;
    const shell = $('#app-shell');
    if (shell) { shell.classList.remove('hidden'); shell.removeAttribute('hidden'); }
    const screen = $('#lockScreen');
    if (screen) screen.classList.add('hidden');
    document.body.style.overflow = '';
    renderHeader();
    renderAll();
    return true;
  }

  function attemptUnlock(pin, remember) {
    const val = String(pin == null ? '' : pin).trim();
    if (!val) { setLockError('비밀번호를 입력해 주세요.'); return false; }
    if (hashPin(val) !== state.security.pinHash) {
      setLockError('비밀번호가 맞지 않습니다. 다시 확인해 주세요.');
      const card = $('.lock-card');
      if (card) { card.classList.add('shake'); setTimeout(() => { try { card.classList.remove('shake'); } catch (e) {} }, 400); }
      const el = $('#lockPin');
      if (el) { el.value = ''; try { el.focus(); } catch (e) {} }
      return false;
    }
    writeAuthRecord(!!remember);
    unlockApp();
    if (isDefaultPin()) toast('기본 비밀번호 0000으로 열었습니다. ⚙️ 설정에서 새 비밀번호로 바꿔 주세요.', 'warn');
    else toast('잠금을 풀었습니다 · ' + (state.settings.operator || '사장님'));
    return true;
  }

  function lockNow(opts) {
    clearAuthRecord();
    showLock();
    if (!(opts && opts.silent)) toast('잠겼습니다. 다시 열려면 접속 비밀번호를 입력하세요.');
    return true;
  }

  function changePin(current, next, again) {
    const cur = String(current == null ? '' : current).trim();
    const nw = String(next == null ? '' : next).trim();
    const nw2 = String(again == null ? '' : again).trim();
    if (!cur) return { ok: false, message: '지금 쓰는 비밀번호를 먼저 입력해 주세요.' };
    if (hashPin(cur) !== state.security.pinHash) return { ok: false, message: '지금 비밀번호가 맞지 않습니다.' };
    if (nw.length < PIN_MIN_LEN) return { ok: false, message: '새 비밀번호는 ' + PIN_MIN_LEN + '자 이상으로 정해 주세요.' };
    if (nw.length > PIN_MAX_LEN) return { ok: false, message: '새 비밀번호는 ' + PIN_MAX_LEN + '자까지 쓸 수 있습니다.' };
    if (nw2 && nw2 !== nw) return { ok: false, message: '새 비밀번호 두 개가 서로 다릅니다.' };
    if (nw === cur) return { ok: false, message: '지금 쓰는 비밀번호와 다른 번호로 정해 주세요.' };
    state.security.pinHash = hashPin(nw);
    state.security.pinUpdatedAt = Date.now();
    save();                       // 이 기기 저장 + (연결되어 있으면) 공동 운영으로 전파
    writeAuthRecord(authMatches(keepRecord()));   // 지금 이 기기는 새 비밀번호로 계속 열어 둡니다
    locked = false;
    refreshLockHint();
    return {
      ok: true,
      message: '접속 비밀번호를 바꿨습니다.' + (state.sync.enabled ? ' 공동 운영이 켜져 있어 엘레나 기기에도 곧 전해집니다.' : '')
    };
  }

  function adoptRemoteSecurity(remote) {
    const r = remote && remote.security;
    if (!r || !r.pinHash) return false;
    if (num(r.pinUpdatedAt) > num(state.security.pinUpdatedAt)) {
      state.security.pinHash = String(r.pinHash);
      state.security.pinUpdatedAt = num(r.pinUpdatedAt);
      refreshLockHint();
      return true;
    }
    return false;
  }

  /* ---------- 16. 렌더 ---------- */
  function renderAll() {
    if (locked) return;   // 잠긴 동안에는 예약 데이터를 화면에 그리지 않습니다
    renderHeader();
    if (ui.view === 'calendar') renderCalendar();
    else if (ui.view === 'today') renderToday();
    else if (ui.view === 'bookings') renderBookings();
    else if (ui.view === 'finder') renderFinder();
    else if (ui.view === 'confirm') renderConfirm();
    else if (ui.view === 'settings') renderSettings();
    syncTabs();
  }
  function syncTabs() {
    document.querySelectorAll('#tabs [data-view]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-view') === ui.view));
    document.querySelectorAll('#mobileTabs [data-view]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-view') === ui.view));
  }
  function switchView(v, opts) {
    ui.view = v;
    const fabEl = $('#fabAdd');
    if (fabEl) fabEl.classList.toggle('hidden', ['settings', 'finder'].indexOf(v) >= 0);
    ['calendar', 'today', 'bookings', 'finder', 'confirm', 'settings'].forEach((k) => {
      const id = '#view' + k.charAt(0).toUpperCase() + k.slice(1);
      const el = $(id);
      if (el) el.classList.toggle('hidden', k !== v);
    });
    renderAll();
    if (opts && opts.scrollTop) window.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo({ top: 0 });
  }

  /* ---------- 17. 이벤트 ---------- */
  function wireEvents() {
    document.addEventListener('click', (e) => {
      if (e.target.classList && e.target.classList.contains('sheet-backdrop')) { closeSheet(); return; }
      const nav = e.target.closest('[data-view]');
      if (nav && (nav.closest('#tabs') || nav.closest('#mobileTabs'))) {
        switchView(nav.getAttribute('data-view'));
        return;
      }
      const pickH = e.target.closest('[data-pick-house]');
      if (pickH) {
        const v = pickH.getAttribute('data-pick-house');
        $('#fHouse').value = v;
        document.querySelectorAll('[data-pick-house]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-pick-house') === v));
        const h = houseById(v);
        const bg = $('#fBaseGuests');
        if (bg && !bg.getAttribute('data-touched')) bg.value = h.baseGuests;
        updateFormNotice();
        return;
      }
      const pickS = e.target.closest('[data-pick-source]');
      if (pickS) {
        const v = pickS.getAttribute('data-pick-source');
        $('#fSource').value = v;
        document.querySelectorAll('[data-pick-source]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-pick-source') === v));
        return;
      }
      const act = e.target.closest('[data-action]');
      if (!act) return;
      const a = act.getAttribute('data-action');
      const id = act.getAttribute('data-id');
      switch (a) {
        case 'close-sheet': closeSheet(); break;
        case 'confirm-ok': { const fn = pendingConfirm; pendingConfirm = null; closeSheet(); if (fn) fn(); break; }
        case 'month-prev': { const m = parseYmd(ui.month); ui.month = ymd(new Date(m.getFullYear(), m.getMonth() - 1, 1)); renderCalendar(); break; }
        case 'month-next': { const m = parseYmd(ui.month); ui.month = ymd(new Date(m.getFullYear(), m.getMonth() + 1, 1)); renderCalendar(); break; }
        case 'month-today': { const d = new Date(); ui.month = ymd(new Date(d.getFullYear(), d.getMonth(), 1)); renderCalendar(); break; }
        case 'cal-filter': ui.calHouseFilter = act.getAttribute('data-rooms'); renderCalendar(); break;
        case 'day': renderDaySheet(act.getAttribute('data-date')); break;
        case 'open-booking': {
          closeSheet();
          openBookingForm(null, { date: act.getAttribute('data-date') || todayStr(), house: act.getAttribute('data-house') || 'A' });
          break;
        }
        case 'edit-booking': {
          const b = state.bookings.find((x) => x.id === id);
          if (b) { closeSheet(); openBookingForm(b); }
          break;
        }
        case 'delete-booking': {
          const b = state.bookings.find((x) => x.id === id);
          if (!b) break;
          askConfirm('예약을 삭제할까요?', '<b>' + esc(b.guestName) + '</b> · ' + b.house + '하우스 · ' + fmtMD(b.checkIn) + '~' + fmtMD(b.checkOut) +
            '<br><br>삭제하면 캘린더와 목록에서 사라집니다.', '삭제', () => {
            removeBooking(id);
            renderAll();
            toast('예약을 삭제했습니다.');
          }, true);
          break;
        }
        case 'dep-receive': {
          const r = markDeposit(id, 'receive');
          if (r.ok) { renderAll(); toast('보증금 수령 완료로 기록했습니다.'); }
          break;
        }
        case 'dep-refund': {
          const r = markDeposit(id, 'refund');
          if (r.ok) { renderAll(); toast('보증금 반환 완료로 기록했습니다.'); }
          break;
        }
        case 'dep-today': {
          const kind = act.getAttribute('data-kind');
          const el = kind === 'refund' ? $('#fDepRefunded') : $('#fDepReceived');
          if (el) el.value = todayStr();
          const other = $('#fDepReceived');
          if (kind === 'refund' && other && !other.value) other.value = todayStr();
          updateDepFlag();
          break;
        }
        case 'bk-range': ui.bkRange = act.getAttribute('data-range'); renderBookings(); break;
        case 'confirmation': closeSheet(); openConfirmation(id); break;
        case 'conf-open': { const sel = $('#confBooking'); openConfirmation(sel ? sel.value : (liveBookings()[0] && liveBookings()[0].id)); break; }
        case 'conf-blank': openConfirmation(null); break;
        case 'conf-save': saveConfirmation(); break;
        case 'copy-msg': { const ta = $('#guestMessage'); if (ta) copyText(ta.value); break; }
        case 'sync-enable': enableSync(); break;
        case 'sync-now': syncNow({ force: true }).then((r) => toast(r.ok ? '동기화했습니다.' : '동기화에 실패했습니다.', r.ok ? null : 'err')); break;
        case 'sync-off': disableSync(); break;
        case 'op-pick': setOperator(act.getAttribute('data-op')); break;
        case 'lock-now': lockNow(); break;
        case 'op-save-sheet': { const el = $('#opSheetCustom'); setOperator(el ? el.value : ''); break; }
        case 'op-save-custom': { const el = $('#opCustom'); setOperator(el ? el.value : ''); break; }
        case 'save-sample': {
          askConfirm('샘플 데이터를 넣을까요?', '지금 있는 예약을 지우고, 턴오버·3룸 빈방·보증금을 바로 볼 수 있는 <b>샘플 7건</b>으로 채웁니다.', '샘플 넣기', () => { loadSample(); });
          break;
        }
        case 'reset-all': {
          askConfirm('전체 초기화할까요?', '이 기기의 <b>모든 예약</b>이 지워집니다. 되돌릴 수 없으니 먼저 JSON으로 백업해 주세요.', '전체 초기화', () => { resetAll(); }, true);
          break;
        }
        case 'export-json': exportJSON(); break;
        case 'import-json': { const f = $('#importFile'); if (f) f.click(); break; }
        default: break;
      }
    });

    document.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'bkHouse') { ui.bkHouse = t.value; renderBookings(); }
      else if (t.id === 'bkSource') { ui.bkSource = t.value; renderBookings(); }
      else if (t.id === 'importFile') {
        const file = t.files && t.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { importJSON(String(reader.result || '')); };
        reader.readAsText(file);
        t.value = '';
      }
      if (t.closest('#bookingForm')) {
        if (t.id === 'fCheckIn') {
          const out = $('#fCheckOut');
          if (out && (!out.value || out.value <= t.value)) out.value = shiftStr(t.value, 1);
        }
        if (t.id === 'fDeposit') updateDepFlag();
        if (t.id === 'fDepReceived' || t.id === 'fDepRefunded') {
          if (t.id === 'fDepRefunded' && t.value) {
            const r = $('#fDepReceived');
            if (r && !r.value) r.value = todayStr();
          }
          updateDepFlag();
        }
        updateFormNotice();
      }
      if (t.closest('#confForm')) { if (t.id === 'cSeason') scheduleConfPreview(); }
    });

    document.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'bkQuery') { ui.bkQuery = t.value; renderBookings(); const el = $('#bkQuery'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
      if (t.closest('#bookingForm')) {
        if (t.id === 'fTotal' || t.id === 'fPrepaid') updateBalance();
        if (t.id === 'fBaseGuests') t.setAttribute('data-touched', '1');
        updateFormNotice();
      }
      if (t.closest('#confForm')) {
        if (['cStayAmt', 'cAteAmt', 'cPickupAmt', 'cEtcAmt'].indexOf(t.id) >= 0) {
          const sum = num($('#cStayAmt') && $('#cStayAmt').value) + num($('#cAteAmt') && $('#cAteAmt').value) +
            num($('#cPickupAmt') && $('#cPickupAmt').value) + num($('#cEtcAmt') && $('#cEtcAmt').value);
          const tot = $('#cTotal');
          if (tot) tot.value = sum;
        }
        scheduleConfPreview();
      }
    });

    document.addEventListener('submit', (e) => {
      if (e.target && e.target.id === 'lockForm') {
        e.preventDefault();
        const pin = $('#lockPin');
        const keep = $('#lockKeep');
        attemptUnlock(pin ? pin.value : '', keep ? keep.checked : true);
        return;
      }
      if (e.target && e.target.id === 'pinForm') {
        e.preventDefault();
        const r = changePin(
          $('#pinCurrent') ? $('#pinCurrent').value : '',
          $('#pinNew') ? $('#pinNew').value : '',
          $('#pinNew2') ? $('#pinNew2').value : ''
        );
        const box = $('#pinNotice');
        if (box) {
          box.className = 'form-notice ' + (r.ok ? 'info' : 'err') + ' show';
          box.innerHTML = (r.ok ? '✅ ' : '⛔ ') + esc(r.message);
        }
        if (r.ok) {
          ['pinCurrent', 'pinNew', 'pinNew2'].forEach((id) => { const el = $('#' + id); if (el) el.value = ''; });
          toast(r.message);
        }
        return;
      }
      if (e.target && e.target.id === 'finderForm') {
        e.preventDefault();
        ui.finderInputs = {
          checkIn: $('#qCheckIn').value,
          checkOut: $('#qCheckOut').value,
          roomType: $('#qRooms').value,
          guests: $('#qGuests').value,
          name: $('#qName').value
        };
        runFinder();
      }
    });
  }

  /* ---------- 18. 초기화 ---------- */
  function buildMobileTabs() {
    const el = document.createElement('nav');
    el.className = 'mobile-tabs';
    el.id = 'mobileTabs';
    el.setAttribute('aria-label', '주요 화면');
    el.innerHTML =
      '<button type="button" data-view="calendar" class="active"><i>📅</i>캘린더</button>' +
      '<button type="button" data-view="today"><i>☀️</i>오늘</button>' +
      '<button type="button" data-view="bookings"><i>📋</i>예약</button>' +
      '<button type="button" data-view="finder"><i>💬</i>손님 안내</button>' +
      '<button type="button" data-view="confirm"><i>🖼</i>확정서</button>' +
      '<button type="button" data-view="settings"><i>⚙️</i>설정</button>';
    document.body.appendChild(el);
  }

  function init() {
    loadLocal();
    buildMobileTabs();
    wireEvents();

    const fab = $('#fabAdd');
    if (fab) fab.addEventListener('click', () => openBookingForm(null, { date: todayStr(), house: 'A' }));
    const opBtn = $('#operatorBtn');
    if (opBtn) opBtn.addEventListener('click', openOperatorSheet);
    const lockBtn = $('#lockBtn');
    if (lockBtn) lockBtn.addEventListener('click', () => lockNow());
    const sb = $('#syncBadge');
    if (sb) sb.addEventListener('click', () => { switchView('settings'); setTimeout(() => { const el = $('#syncBlock'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60); });

    // 이 기기에 남은 로그인 기록이 있으면 바로 열고, 없으면 잠금 화면을 보여 줍니다.
    if (hasValidSession()) unlockApp();
    else showLock({ noFocus: TEST });

    if (!TEST && state.sync.enabled) {
      syncNow().then(() => startSyncPolling());
    }
    if (!TEST && 'serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      });
    }
    window.addEventListener('online', () => { if (state.sync.enabled) syncNow(); });
  }

  /* ---------- 19. 외부 노출 (테스트/디버그) ---------- */
  window.__GH = {
    HOUSES, THREE_HOUSES, SOURCES,
    get state() { return state; },
    today: todayStr, ymd, parseYmd, addDays, shiftStr, nights,
    fmtMD, fmtDateLong, fmtDateFull, money,
    isOccupied, conflictFor, turnoverFor, eventsOn, threeRoomSummary, availableHouses,
    depositStatus, depositReceiveNeeded, depositRefundNeeded,
    buildGuestMessage, addBooking, updateBooking, removeBooking, markDeposit,
    setOperator, loadSample, resetAll, exportJSON, importJSON,
    syncNow, syncEndpoint, setSyncStatus, mergeBookings,
    renderAll, switchView, openBookingForm, openOperatorSheet,
    lockNow, unlockApp, attemptUnlock, changePin, isDefaultPin, hashPin, hasValidSession,
    DEFAULT_PIN: DEFAULT_PIN, AUTH_KEY: AUTH_KEY,
    get locked() { return locked; },
    validateBooking, saveLocal, ui,
    openConfirmation, renderConfirm, renderConfPreview, saveConfirmation,
    buildConfirmModel: function (booking, overrides) { return window.ORA_CONFIRM.buildModel(booking, overrides); },
    confirmFilename: function (m) { return window.ORA_CONFIRM.filenameFor(m); }
  };

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    init();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
    if (TEST) boot();   // jsdom 등 즉시 실행 환경
  } else {
    boot();
  }
})();
