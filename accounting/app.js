'use strict';

/* ============================================================
   오라홀릭 회계 정산 — app.js
   · 접속 비밀번호 잠금 (예약 앱과 완전히 분리된 저장 키)
   · 필리핀 현지(₱) / 한국(₩) 이중 통화 · 환율 환산
   · 현재 보유 잔액 (기초 잔액 + 누적 수입 − 누적 지출)
   · 월별 정산 · 항목별 비중 · 지역 비교 · 전월 대비 · 연간 추이
   · 고정비 불러오기 · JSON/CSV 백업 · Firebase 동기화(선택)
   ============================================================ */

(function () {

  /* ---------- 0. 기본 상수 ---------- */
  const LS_KEY = 'oraholic-accounting-v1';
  const AUTH_KEY = 'oraholic-accounting-auth-v1';
  const DEFAULT_PIN = '0000';
  const PIN_MIN = 4;
  const PIN_MAX = 12;
  const APP_VERSION = '1.0.0';
  const TEST = !!window.__AC_TEST__;
  const DEFAULT_RATE = 24.5;
  const SYNC_PATH = 'oraholic-accounting';

  const REGIONS = {
    PH: { id: 'PH', flag: '🇵🇭', name: '필리핀 현지', short: '현지', cur: 'PHP', sym: '₱' },
    KR: { id: 'KR', flag: '🇰🇷', name: '한국', short: '한국', cur: 'KRW', sym: '₩' }
  };
  const HOUSES = [
    { id: 'ALL', name: '공통(전체)', short: '공통' },
    { id: 'A', name: 'A하우스', short: 'A' },
    { id: 'B', name: 'B하우스', short: 'B' },
    { id: 'C', name: 'C하우스', short: 'C' },
    { id: 'D', name: 'D하우스', short: 'D' }
  ];
  const EXPENSE_CATS = [
    { name: '월세', emo: '🏠' },
    { name: '인터넷 요금', emo: '🌐' },
    { name: '마을 회비', emo: '🤝' },
    { name: '에어비앤비 등록비/수수료', emo: '🛎️' },
    { name: '수도세', emo: '💧' },
    { name: '전기세', emo: '⚡' },
    { name: '아떼 월급', emo: '👩‍🍳' },
    { name: '수리 비용', emo: '🔧' },
    { name: '물품 구입', emo: '🛒' },
    { name: '기타 지출', emo: '📦' }
  ];
  const INCOME_CATS = [
    { name: '숙박 수입 - 개별', emo: '🛏️' },
    { name: '숙박 수입 - 에어비앤비', emo: '🏡' },
    { name: '추가 서비스(아떼/픽드랍/매트리스)', emo: '✨' },
    { name: '기타 수입', emo: '💰' }
  ];
  const RECUR_CATS = ['월세', '인터넷 요금', '마을 회비', '아떼 월급', '에어비앤비 등록비/수수료'];
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  /* ---------- 1. 유틸 ---------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const rid = () => 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) { const p = String(s || '').split('-').map(Number); return new Date(p[0] || 1970, (p[1] || 1) - 1, p[2] || 1); }
  function todayStr() { return ymd(new Date()); }
  function monthKey(ds) { return String(ds || '').slice(0, 7); }
  function thisMonth() { return monthKey(todayStr()); }
  function addMonths(ym, n) {
    const p = String(ym).split('-').map(Number);
    const d = new Date(p[0], (p[1] - 1) + n, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  function daysInMonth(ym) {
    const p = String(ym).split('-').map(Number);
    return new Date(p[0], p[1], 0).getDate();
  }
  function monthLabel(ym) {
    const p = String(ym).split('-').map(Number);
    return p[0] + '년 ' + p[1] + '월';
  }
  function dayLabel(ds) {
    const d = parseYmd(ds);
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + DOW[d.getDay()] + ')';
  }
  function fmtRate(r) {
    const n = Math.round(num(r) * 100) / 100;
    return String(n);
  }
  function fmtNum(n) { return Math.round(num(n)).toLocaleString('en-US'); }
  function money(n, cur) {
    const v = Math.round(num(n));
    const sign = v < 0 ? '-' : '';
    const abs = Math.abs(v);
    return sign + (cur === 'PHP' ? '₱' : '₩') + abs.toLocaleString(cur === 'PHP' ? 'en-US' : 'ko-KR');
  }
  function moneyWon(n) { return money(n, 'KRW'); }
  function signMoney(n) { return (num(n) < 0 ? '−' : '+') + moneyWon(Math.abs(n)); }
  function pct(a, b) { const d = num(b); return d ? (num(a) / d) * 100 : 0; }
  function pctText(a, b, digits) { const p = pct(a, b); return (p < 10 ? p.toFixed(digits == null ? 1 : digits) : Math.round(p)) + '%'; }
  function catMeta(name, type) {
    const list = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
    const f = list.find((c) => c.name === name);
    if (f) return f;
    return { name: name, emo: '🧾' };
  }
  function houseLabel(id) {
    const h = HOUSES.find((x) => x.id === id);
    return h ? h.name : '공통(전체)';
  }

  /* ---------- 2. 상태 ---------- */
  function blankState() {
    return {
      schemaVersion: 1,
      settings: {
        rate: DEFAULT_RATE,
        opening: { php: 0, krw: 0 },
        pinHash: hashPin(DEFAULT_PIN),
        pinUpdatedAt: 0,
        operator: '사장님',
        customCats: { expense: [], income: [] },
        sync: { url: '', code: '', enabled: false, lastAt: 0, lastResult: '' }
      },
      entries: []
    };
  }

  function normEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = raw.type === 'income' ? 'income' : 'expense';
    const amount = Math.abs(num(raw.amount));
    if (!amount) return null;
    const currency = raw.currency === 'KRW' ? 'KRW' : 'PHP';
    const region = raw.region === 'KR' ? 'KR' : 'PH';
    let date = String(raw.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = todayStr();
    const house = HOUSES.some((h) => h.id === raw.house) ? raw.house : 'ALL';
    return {
      id: String(raw.id || rid()),
      type: type,
      date: date,
      region: region,
      currency: currency,
      amount: amount,
      category: String(raw.category || (type === 'income' ? '기타 수입' : '기타 지출')),
      house: house,
      memo: String(raw.memo == null ? '' : raw.memo).slice(0, 200),
      recurring: !!raw.recurring,
      createdAt: num(raw.createdAt) || Date.now(),
      updatedAt: num(raw.updatedAt) || num(raw.createdAt) || Date.now(),
      by: String(raw.by || '사장님')
    };
  }

  function normalize(raw) {
    const s = blankState();
    if (!raw || typeof raw !== 'object') return s;
    const st = raw.settings || {};
    if (num(st.rate) > 0) s.settings.rate = num(st.rate);
    s.settings.opening = { php: num(st.opening && st.opening.php), krw: num(st.opening && st.opening.krw) };
    if (st.pinHash) s.settings.pinHash = String(st.pinHash);
    if (num(st.pinUpdatedAt)) s.settings.pinUpdatedAt = num(st.pinUpdatedAt);
    if (st.operator) s.settings.operator = String(st.operator);
    const cc = st.customCats || {};
    s.settings.customCats = {
      expense: Array.isArray(cc.expense) ? cc.expense.map(String).filter(Boolean).slice(0, 80) : [],
      income: Array.isArray(cc.income) ? cc.income.map(String).filter(Boolean).slice(0, 80) : []
    };
    const sy = st.sync || {};
    s.settings.sync = {
      url: String(sy.url || ''),
      code: String(sy.code || ''),
      enabled: !!sy.enabled,
      lastAt: num(sy.lastAt),
      lastResult: String(sy.lastResult || '')
    };
    s.entries = Array.isArray(raw.entries) ? raw.entries.map(normEntry).filter(Boolean) : [];
    return s;
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      return normalize(raw);
    } catch (e) { return blankState(); }
  }

  let state = load();
  let locked = true;

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* 저장 공간 부족 */ }
  }

  const ui = {
    view: 'dashboard',
    month: thisMonth(),
    year: Number(thisMonth().slice(0, 4)),
    filters: { month: 'selected', type: 'all', region: 'all', house: 'all', category: 'all', q: '' }
  };
  let sheetState = null;

  /* ---------- 3. 통화 · 집계 ---------- */
  function getRate() { return num(state.settings.rate) > 0 ? num(state.settings.rate) : DEFAULT_RATE; }
  function setRate(r) {
    const v = num(String(r).replace(/[^0-9.]/g, ''));
    if (!(v > 0)) return false;
    state.settings.rate = Math.round(v * 1000) / 1000;
    save(); renderAll();
    return true;
  }
  function setOpening(php, krw) {
    state.settings.opening = { php: Math.round(num(String(php).replace(/[^0-9.-]/g, '')) * 100) / 100, krw: Math.round(num(String(krw).replace(/[^0-9.-]/g, '')) * 100) / 100 };
    save(); renderAll();
    return state.settings.opening;
  }
  function entryKRW(e) { return e.currency === 'PHP' ? num(e.amount) * getRate() : num(e.amount); }
  function entryPHP(e) { return e.currency === 'PHP' ? num(e.amount) : num(e.amount) / getRate(); }
  function entryNative(e) { return { v: num(e.amount), sym: e.currency === 'PHP' ? '₱' : '₩' }; }

  function entriesForMonth(ym) { return state.entries.filter((e) => monthKey(e.date) === ym); }

  function bucket() { return { php: 0, krw: 0, krwTotal: 0, count: 0 }; }
  function addTo(b, e) {
    const v = num(e.amount);
    if (e.currency === 'PHP') b.php += v; else b.krw += v;
    b.krwTotal += entryKRW(e);
    b.count += 1;
  }

  function summarize(list) {
    const income = bucket();
    const expense = bucket();
    const ph = bucket();
    const kr = bucket();
    const catE = {};
    const catI = {};
    const houses = {};
    HOUSES.forEach((h) => { houses[h.id] = { income: bucket(), expense: bucket() }; });

    list.forEach((e) => {
      if (e.type === 'income') {
        addTo(income, e);
        const k = e.category;
        catI[k] = catI[k] || { name: k, php: 0, krw: 0, krwTotal: 0, count: 0 };
        addTo(catI[k], e);
      } else {
        addTo(expense, e);
        if (e.region === 'KR') addTo(kr, e); else addTo(ph, e);
        const k = e.category;
        catE[k] = catE[k] || { name: k, php: 0, krw: 0, krwTotal: 0, count: 0 };
        addTo(catE[k], e);
      }
      const h = houses[e.house] || houses.ALL;
      addTo(e.type === 'income' ? h.income : h.expense, e);
    });

    const toArr = (o) => Object.keys(o).map((k) => o[k]).sort((a, b) => b.krwTotal - a.krwTotal);
    const net = income.krwTotal - expense.krwTotal;
    return {
      count: list.length,
      income: income,
      expense: expense,
      ph: ph,
      kr: kr,
      net: net,
      margin: income.krwTotal ? (net / income.krwTotal) * 100 : 0,
      days: new Set(list.map((e) => e.date)).size,
      catsExpense: toArr(catE),
      catsIncome: toArr(catI),
      houses: houses,
      list: list
    };
  }

  function balance() {
    let phpIn = 0, phpOut = 0, krwIn = 0, krwOut = 0;
    state.entries.forEach((e) => {
      const v = num(e.amount);
      if (e.currency === 'PHP') { if (e.type === 'income') phpIn += v; else phpOut += v; }
      else if (e.type === 'income') krwIn += v; else krwOut += v;
    });
    const openPhp = num(state.settings.opening.php);
    const openKrw = num(state.settings.opening.krw);
    const php = openPhp + phpIn - phpOut;
    const krw = openKrw + krwIn - krwOut;
    return {
      php: php, krw: krw, totalKRW: krw + php * getRate(),
      phpIn: phpIn, phpOut: phpOut, krwIn: krwIn, krwOut: krwOut,
      openPhp: openPhp, openKrw: openKrw, rate: getRate()
    };
  }

  function fixedCandidates(ym) {
    const prev = addMonths(ym, -1);
    const prevList = entriesForMonth(prev).filter((e) => e.type === 'expense' && (e.recurring || RECUR_CATS.indexOf(e.category) >= 0));
    const exists = {};
    entriesForMonth(ym).forEach((e) => { exists[fixSig(e)] = true; });
    return prevList.filter((e) => !exists[fixSig(e)]);
  }
  function fixSig(e) {
    return [e.type, e.category, e.region, e.currency, Math.round(num(e.amount)), e.house].join('|');
  }

  function copyFixed(ym, opts) {
    const targets = fixedCandidates(ym);
    const [yy, mm] = String(ym).split('-').map(Number);
    const last = daysInMonth(ym);
    let added = 0;
    targets.forEach((e) => {
      const day = clamp(Number(String(e.date).slice(8, 10)) || 1, 1, last);
      const copy = normEntry(Object.assign({}, e, {
        id: rid(),
        date: yy + '-' + pad2(mm) + '-' + pad2(day),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        memo: e.memo || ''
      }));
      if (copy) { state.entries.push(copy); added += 1; }
    });
    if (added) save();
    if (!(opts && opts.silent)) {
      renderAll();
      if (added) toast('지난달 고정비 ' + added + '건을 ' + monthLabel(ym) + '로 불러왔습니다.', 'ok');
      else toast('불러올 고정비가 없습니다. (이미 모두 반영됨)', 'warn');
    }
    return added;
  }

  /* ---------- 4. 내역 CRUD ---------- */
  function getEntry(id) { return state.entries.find((e) => e.id === id) || null; }

  function upsertEntry(data) {
    const clean = normEntry(Object.assign({}, data, {
      id: data.id || rid(),
      createdAt: data.createdAt || Date.now(),
      updatedAt: Date.now(),
      by: state.settings.operator || '사장님'
    }));
    if (!clean) return null;
    const i = state.entries.findIndex((e) => e.id === clean.id);
    if (i >= 0) state.entries[i] = clean; else state.entries.push(clean);
    save();
    renderAll();
    return clean;
  }

  function addEntry(data) { return upsertEntry(Object.assign({}, data, { id: null, createdAt: null })); }

  function deleteEntry(id) {
    const i = state.entries.findIndex((e) => e.id === id);
    if (i < 0) return false;
    state.entries.splice(i, 1);
    save(); renderAll();
    return true;
  }

  /* ---------- 5. 렌더 ---------- */
  function renderAll() {
    if (locked) return;
    renderHeader();
    renderDashboard();
    renderLedger();
    renderReport();
    renderSettings();
    ['dashboard', 'ledger', 'report', 'settings'].forEach((v) => {
      const el = document.getElementById('view' + cap(v));
      if (el) el.classList.toggle('hidden', ui.view !== v);
    });
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.getAttribute('data-view') === ui.view));
  }

  function renderHeader() {
    const r = $('#rateChipText');
    if (r) r.textContent = '₱1 = ₩' + fmtRate(getRate());
    const badge = $('#syncBadge');
    const txt = $('#syncBadgeText');
    const s = state.settings.sync;
    if (!badge || !txt) return;
    badge.classList.remove('on', 'off', 'err');
    if (s.enabled && s.lastResult === 'ok') { badge.classList.add('on'); txt.textContent = '동기화 켜짐'; }
    else if (s.enabled && s.lastResult === 'err') { badge.classList.add('err'); txt.textContent = '동기화 오류'; }
    else if (s.enabled) { badge.classList.add('on'); txt.textContent = '동기화 대기'; }
    else { badge.classList.add('off'); txt.textContent = '로컬 저장'; }
  }

  function monthNavHTML(ym, extra) {
    return '<div class="month-nav">' +
      '<button type="button" class="mn-btn" data-action="month-prev" aria-label="이전 달">‹</button>' +
      '<span class="mn-label">' + monthLabel(ym) + '</span>' +
      '<button type="button" class="mn-btn" data-action="month-next" aria-label="다음 달">›</button>' +
      (ym !== thisMonth() ? '<button type="button" class="mn-today" data-action="month-now">이번 달</button>' : '') +
      (extra || '') +
      '</div>';
  }

  function balanceCardHTML(b) {
    const ecount = state.entries.length;
    return '<div class="balance-card" id="balanceCard">' +
      '<div class="balance-top">' +
        '<span class="lab"><b>현재 보유 잔액</b> · 남아 있는 돈</span>' +
        '<button type="button" class="balance-edit" data-action="edit-opening">기초잔액 설정</button>' +
      '</div>' +
      '<div class="balance-total"><span class="v num">' + moneyWon(b.totalKRW) + '</span><span class="u">전체 통합 · 환산</span></div>' +
      '<div class="balance-split">' +
        '<div class="bal-box">' +
          '<div class="bh">🇵🇭 필리핀 현지</div>' +
          '<div class="bv num">' + money(b.php, 'PHP') + '</div>' +
          '<div class="bs">기초 ' + money(b.openPhp, 'PHP') + ' · 수입 ' + money(b.phpIn, 'PHP') + ' − 지출 ' + money(b.phpOut, 'PHP') + '</div>' +
        '</div>' +
        '<div class="bal-box">' +
          '<div class="bh">🇰🇷 한국</div>' +
          '<div class="bv num">' + money(b.krw, 'KRW') + '</div>' +
          '<div class="bs">기초 ' + money(b.openKrw, 'KRW') + ' · 수입 ' + money(b.krwIn, 'KRW') + ' − 지출 ' + money(b.krwOut, 'KRW') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="bal-foot">모든 달의 내역(' + ecount + '건)과 기초 잔액으로 자동 계산됩니다 · 환산 기준 <b>₱1 = ₩' + fmtRate(getRate()) + '</b></div>' +
      '</div>';
  }

  function kpiHTML(sum) {
    const phPart = sum.ph.krwTotal;
    const krPart = sum.kr.krwTotal;
    return '<div class="kpis">' +
      '<div class="kpi income">' +
        '<div class="k">총 수입</div>' +
        '<div class="v num">' + moneyWon(sum.income.krwTotal) + '</div>' +
        '<div class="s">' + (sum.income.php ? '₱' + fmtNum(sum.income.php) : '') + (sum.income.php && sum.income.krw ? ' · ' : '') + (sum.income.krw ? '₩' + fmtNum(sum.income.krw) : '') + (sum.income.krwTotal ? '' : '이번 달 수입 없음') + '</div>' +
      '</div>' +
      '<div class="kpi expense">' +
        '<div class="k">총 지출</div>' +
        '<div class="v num">' + moneyWon(sum.expense.krwTotal) + '</div>' +
        '<div class="s">🇵🇭 ' + moneyWon(phPart) + ' · 🇰🇷 ' + moneyWon(krPart) + '</div>' +
      '</div>' +
      '<div class="kpi net">' +
        '<div class="k">월 순수익</div>' +
        '<div class="v num ' + (sum.net < 0 ? 'neg' : 'pos') + '">' + (sum.net < 0 ? '−' : '') + moneyWon(Math.abs(sum.net)) + '</div>' +
        '<div class="s">' + (sum.income.krwTotal ? '수입의 ' + Math.round(sum.margin) + '%' : '내역을 추가해 보세요') + '</div>' +
      '</div>' +
      '</div>';
  }

  function fixedHTML(ym, cands) {
    const names = cands.slice(0, 4).map((e) => catMeta(e.category, 'expense').emo + ' ' + e.category);
    return '<div class="card tight" id="fixedCard">' +
      '<div class="card-head" style="margin-bottom:8px">' +
        '<div><h2>📋 지난달 고정비 불러오기</h2>' +
        '<p>' + (cands.length ? '지난달 고정 항목 ' + cands.length + '건 · ' + esc(names.join(' · ')) + (cands.length > 4 ? ' 외' : '') : '지난달에 복사할 고정 항목이 없습니다') + '</p></div>' +
        '<button type="button" class="btn sm primary" data-action="copy-fixed"' + (cands.length ? '' : ' disabled') + '>1탭 복사</button>' +
      '</div>' +
      '<div class="tiny muted">월세 · 인터넷 · 마을 회비 · 아떼 월급처럼 매달 나가는 지출을 ' + monthLabel(ym) + '로 그대로 옮겨 옵니다. 금액은 옮긴 뒤 수정할 수 있습니다.</div>' +
      '</div>';
  }

  function curPair(php, krw) {
    if (!php && !krw) return '<span class="cp"><span class="cmute">—</span></span>';
    return '<span class="cp">' +
      (php ? '<span>₱' + fmtNum(php) + '</span>' : '') +
      (krw ? '<span>₩' + fmtNum(krw) + '</span>' : '') +
      '</span>';
  }

  function catChartHTML(sum) {
    const list = sum.catsExpense;
    if (!list.length) {
      return '<div class="card"><div class="card-head"><div><h2>항목별 지출 비중</h2><p>이번 달 지출 내역이 없습니다</p></div></div>' +
        '<div class="empty"><span class="big">🧾</span>아래 <b>＋ 내역 추가</b>로 첫 지출을 적어 보세요.</div></div>';
    }
    const max = list[0].krwTotal || 1;
    const rows = list.map((c) => {
      const meta = catMeta(c.name, 'expense');
      return '<div class="bar-row">' +
        '<span class="bl"><span>' + meta.emo + '</span><span class="name">' + esc(c.name) + '</span></span>' +
        '<span class="bv num">' + moneyWon(c.krwTotal) + '<em>' + pctText(c.krwTotal, sum.expense.krwTotal, 1) + '</em></span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + Math.max(3, (c.krwTotal / max) * 100).toFixed(1) + '%"></span></span>' +
        '</div>';
    }).join('');

    const tableRows = list.map((c) => '<tr><td class="nmcell">' + catMeta(c.name, 'expense').emo + ' ' + esc(c.name) + '</td>' +
      '<td>' + curPair(c.php, c.krw) + '</td>' +
      '<td>' + moneyWon(c.krwTotal) + '</td>' +
      '<td class="c-share">' + pctText(c.krwTotal, sum.expense.krwTotal, 1) + '</td></tr>').join('');

    return '<div class="card">' +
      '<div class="card-head"><div><h2>항목별 지출 비중</h2><p>' + monthLabel(ui.month) + ' · ' + list.length + '개 항목 · 합계 ' + moneyWon(sum.expense.krwTotal) + '</p></div>' +
      '<button type="button" class="btn sm ghost" data-action="view" data-view="report">표로 보기</button></div>' +
      '<div class="chart">' + rows + '</div>' +
      '<details class="more"><summary>월별 정산표 자세히</summary><div class="tbl-wrap"><table class="tbl">' +
        '<thead><tr><th>항목</th><th>필리핀 / 한국</th><th>합계(₩)</th><th class="c-share">비중</th></tr></thead>' +
        '<tbody>' + tableRows + '</tbody>' +
        '<tfoot><tr><td>지출 합계</td><td>' + curPair(sum.expense.php, sum.expense.krw) + '</td><td>' + moneyWon(sum.expense.krwTotal) + '</td><td class="c-share">100%</td></tr></tfoot>' +
      '</table></div></details>' +
      '</div>';
  }

  function regionHTML(sum) {
    if (!sum.expense.krwTotal) {
      return '<div class="card"><div class="card-head"><div><h2>🇵🇭 현지 vs 🇰🇷 한국 지출</h2><p>이번 달 지출이 없습니다</p></div></div>' +
        '<div class="tiny muted">지출을 적을 때 <b>지역</b>을 고르면 현지 지출과 한국 지출이 자동으로 나뉩니다.</div></div>';
    }
    const phPct = pct(sum.ph.krwTotal, sum.expense.krwTotal);
    const krPct = 100 - phPct;
    return '<div class="card">' +
      '<div class="card-head"><div><h2>🇵🇭 현지 vs 🇰🇷 한국 지출</h2><p>환산 ₩ 기준 비교 · ' + monthLabel(ui.month) + '</p></div></div>' +
      '<div class="region-grid">' +
        '<div class="region-box ph"><div class="rh">🇵🇭 필리핀 현지 <span class="pct">' + Math.round(phPct) + '%</span></div>' +
          '<div class="rv num">' + moneyWon(sum.ph.krwTotal) + '</div>' +
          '<div class="rs">' + (sum.ph.php ? '₱' + fmtNum(sum.ph.php) : '') + (sum.ph.php && sum.ph.krw ? ' + ' : '') + (sum.ph.krw ? '₩' + fmtNum(sum.ph.krw) : '') + ' · ' + sum.ph.count + '건</div></div>' +
        '<div class="region-box kr"><div class="rh">🇰🇷 한국 <span class="pct">' + Math.round(krPct) + '%</span></div>' +
          '<div class="rv num">' + moneyWon(sum.kr.krwTotal) + '</div>' +
          '<div class="rs">' + (sum.kr.php ? '₱' + fmtNum(sum.kr.php) : '') + (sum.kr.php && sum.kr.krw ? ' + ' : '') + (sum.kr.krw ? '₩' + fmtNum(sum.kr.krw) : '') + ' · ' + sum.kr.count + '건</div></div>' +
      '</div>' +
      '<div class="compare-split"><span class="a" style="width:' + phPct.toFixed(1) + '%"></span><span class="b" style="width:' + krPct.toFixed(1) + '%"></span></div>' +
      '<div class="legend"><span class="li-ph">🇵🇭 현지 지출 ' + moneyWon(sum.ph.krwTotal) + '</span><span class="li-kr">🇰🇷 한국 지출 ' + moneyWon(sum.kr.krwTotal) + '</span></div>' +
      '</div>';
  }

  function momHTML(sum, prev, ym) {
    const diff = (a, b) => num(a) - num(b);
    const mk = (label, cur, base) => {
      const d = diff(cur, base);
      const rate = base ? (d / base) * 100 : 0;
      const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
      const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '–';
      return '<div class="mom-item"><div class="mk">' + label + '</div>' +
        '<div class="mv num">' + signMoney(d) + '</div>' +
        '<div class="md ' + cls + '">' + arrow + ' ' + (base ? Math.abs(rate).toFixed(rate >= 10 || rate === 0 ? 0 : 1) + '%' : '비교 없음') + '</div></div>';
    };
    return '<div class="card">' +
      '<div class="card-head"><div><h2>전월 대비</h2><p>' + monthLabel(addMonths(ym, -1)) + ' → ' + monthLabel(ym) + '</p></div></div>' +
      '<div class="mom">' +
        mk('수입', sum.income.krwTotal, prev.income.krwTotal) +
        mk('지출', sum.expense.krwTotal, prev.expense.krwTotal) +
        mk('순수익', sum.net, prev.net) +
      '</div>' +
      '<div class="tiny muted" style="margin-top:9px">지출이 늘면 빨강(▲), 줄면 초록(▼)입니다. 금액은 모두 ₩ 환산 기준입니다.</div>' +
      '</div>';
  }

  function entryRowHTML(e, opts) {
    const isExp = e.type === 'expense';
    const meta = catMeta(e.category, e.type);
    const reg = REGIONS[e.region] || REGIONS.PH;
    const native = money(e.amount, e.currency);
    const conv = e.currency === 'PHP' ? moneyWon(entryKRW(e)) : money(entryPHP(e), 'PHP');
    const showConv = !(opts && opts.noConvert);
    return '<button type="button" class="entry ' + (isExp ? 'exp' : 'inc') + '" data-action="edit-entry" data-id="' + esc(e.id) + '">' +
      '<span class="ico" aria-hidden="true">' + meta.emo + '</span>' +
      '<span class="main-line">' +
        '<span class="nm">' + esc(e.category) +
          '<span class="tag ' + (e.region === 'KR' ? 'kr' : 'ph') + '">' + reg.flag + ' ' + reg.short + '</span>' +
          (e.house !== 'ALL' ? '<span class="tag house">' + esc(e.house) + '</span>' : '') +
          (e.recurring ? '<span class="tag fix">고정</span>' : '') +
        '</span>' +
        '<span class="meta">' + (e.memo ? esc(e.memo) : houseLabel(e.house)) + '</span>' +
      '</span>' +
      '<span class="amt num">' + (isExp ? '−' : '+') + native + (showConv ? '<small>≈ ' + conv + '</small>' : '') + '</span>' +
      '</button>';
  }

  function recentHTML(list) {
    const sorted = list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
    const recent = sorted.slice(0, 5);
    return '<div class="card">' +
      '<div class="card-head"><div><h2>최근 내역</h2><p>' + monthLabel(ui.month) + ' · ' + list.length + '건</p></div>' +
      '<button type="button" class="btn sm ghost" data-action="view" data-view="ledger">전체 장부 →</button></div>' +
      (recent.length ? '<div class="list">' + recent.map((e) => entryRowHTML(e)).join('') + '</div>'
        : '<div class="empty"><span class="big">📒</span>아직 내역이 없습니다.<br>＋ 버튼으로 수입·지출을 적으면 여기에 쌓입니다.</div>') +
      '</div>';
  }

  function renderDashboard() {
    const el = $('#viewDashboard');
    if (!el) return;
    const ym = ui.month;
    const list = entriesForMonth(ym);
    const sum = summarize(list);
    const prev = summarize(entriesForMonth(addMonths(ym, -1)));
    const bal = balance();
    el.innerHTML =
      balanceCardHTML(bal) +
      monthNavHTML(ym) +
      kpiHTML(sum) +
      fixedHTML(ym, fixedCandidates(ym)) +
      '<div class="grid-2">' + catChartHTML(sum) + regionHTML(sum) + '</div>' +
      momHTML(sum, prev, ym) +
      recentHTML(list);
  }

  /* ---------- 장부 ---------- */
  function entryMatches(e, f) {
    if (f.month !== 'all' && monthKey(e.date) !== ui.month) return false;
    if (f.type !== 'all' && e.type !== f.type) return false;
    if (f.region !== 'all' && e.region !== f.region) return false;
    if (f.house !== 'all' && e.house !== f.house) return false;
    if (f.category !== 'all' && e.category !== f.category) return false;
    const q = String(f.q || '').trim().toLowerCase();
    if (q) {
      const hay = (e.category + ' ' + e.memo + ' ' + houseLabel(e.house) + ' ' + e.date).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }
  function filteredEntries() {
    const f = ui.filters;
    return state.entries.filter((e) => entryMatches(e, f));
  }

  function renderLedger() {
    const el = $('#viewLedger');
    if (!el) return;
    const f = ui.filters;
    const list = filteredEntries().slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
    const sum = summarize(list);
    const catOpts = '<option value="all">카테고리 전체</option>' +
      EXPENSE_CATS.concat(state.settings.customCats.expense.map((n) => ({ name: n }))).map((c) => '<option value="' + esc(c.name) + '"' + (f.category === c.name ? ' selected' : '') + '>지출 · ' + esc(c.name) + '</option>').join('') +
      INCOME_CATS.concat(state.settings.customCats.income.map((n) => ({ name: n }))).map((c) => '<option value="' + esc(c.name) + '"' + (f.category === c.name ? ' selected' : '') + '>수입 · ' + esc(c.name) + '</option>').join('');

    const groups = {};
    list.forEach((e) => { (groups[e.date] = groups[e.date] || []).push(e); });

    const body = list.length ? Object.keys(groups).map((d) => {
      const items = groups[d];
      const dsum = items.reduce((a, e) => a + (e.type === 'income' ? entryKRW(e) : -entryKRW(e)), 0);
      return '<div class="day-head"><span>' + dayLabel(d) + '</span><span class="dsum num">' + signMoney(dsum) + '</span></div>' +
        '<div class="list">' + items.map((e) => entryRowHTML(e)).join('') + '</div>';
    }).join('') : '<div class="card"><div class="empty"><span class="big">🔍</span>조건에 맞는 내역이 없습니다.<br>필터를 풀거나 ＋ 버튼으로 새 내역을 추가하세요.</div></div>';

    el.innerHTML =
      monthNavHTML(ui.month) +
      '<div class="card tight"><div class="filters">' +
        '<div class="f-row">' +
          '<button type="button" class="chip ' + (f.type === 'all' ? 'on' : '') + '" data-action="filter" data-filter="type" data-value="all">전체</button>' +
          '<button type="button" class="chip ' + (f.type === 'expense' ? 'on' : '') + '" data-action="filter" data-filter="type" data-value="expense">− 지출</button>' +
          '<button type="button" class="chip ' + (f.type === 'income' ? 'on' : '') + '" data-action="filter" data-filter="type" data-value="income">＋ 수입</button>' +
          '<button type="button" class="chip ' + (f.month === 'all' ? 'on' : '') + '" data-action="filter" data-filter="month" data-value="' + (f.month === 'all' ? 'selected' : 'all') + '">' + (f.month === 'all' ? '전체 기간 보는 중' : '전체 기간') + '</button>' +
        '</div>' +
        '<div class="f-row">' +
          '<button type="button" class="chip sm ' + (f.region === 'all' ? 'on' : '') + '" data-action="filter" data-filter="region" data-value="all">지역 전체</button>' +
          '<button type="button" class="chip sm ' + (f.region === 'PH' ? 'on' : '') + '" data-action="filter" data-filter="region" data-value="PH">🇵🇭 현지</button>' +
          '<button type="button" class="chip sm ' + (f.region === 'KR' ? 'on' : '') + '" data-action="filter" data-filter="region" data-value="KR">🇰🇷 한국</button>' +
        '</div>' +
        '<div class="f-row">' +
          '<button type="button" class="chip sm ' + (f.house === 'all' ? 'on' : '') + '" data-action="filter" data-filter="house" data-value="all">하우스 전체</button>' +
          HOUSES.map((h) => '<button type="button" class="chip sm ' + (f.house === h.id ? 'on' : '') + '" data-action="filter" data-filter="house" data-value="' + h.id + '">' + esc(h.short) + '</button>').join('') +
        '</div>' +
        '<div class="f-row" style="gap:8px;align-items:center">' +
          '<select class="search" id="fCategory" style="flex:1;min-width:150px">' + catOpts + '</select>' +
        '</div>' +
        '<input class="search" id="fSearch" type="search" placeholder="메모 · 카테고리 검색" value="' + esc(f.q) + '">' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="kv"><span class="k">' + list.length + '건</span><span class="v num">수입 ' + moneyWon(sum.income.krwTotal) + ' · 지출 ' + moneyWon(sum.expense.krwTotal) + '</span></div>' +
      '</div>' +
      body;
  }

  /* ---------- 분석 ---------- */
  function yearSummaries(year) {
    const out = [];
    for (let m = 1; m <= 12; m++) {
      const ym = year + '-' + pad2(m);
      out.push({ ym: ym, sum: summarize(entriesForMonth(ym)) });
    }
    return out;
  }

  function reportTrendHTML(year) {
    const rows = yearSummaries(year);
    const max = Math.max(1, ...rows.map((r) => Math.max(r.sum.income.krwTotal, r.sum.expense.krwTotal)));
    const body = rows.map((r) => {
      const inc = r.sum.income.krwTotal;
      const exp = r.sum.expense.krwTotal;
      const net = r.sum.net;
      const isNow = r.ym === thisMonth();
      return '<div class="trend-row' + (isNow ? ' now' : '') + '">' +
        '<span class="tmon">' + Number(r.ym.slice(5)) + '월</span>' +
        '<span class="tbars">' +
          '<span class="tbar"><span class="tin" style="width:' + ((inc / max) * 100).toFixed(1) + '%"></span></span>' +
          '<span class="tbar"><span class="tex" style="width:' + ((exp / max) * 100).toFixed(1) + '%"></span></span>' +
        '</span>' +
        '<span class="tamt num">' + (inc || exp ? (net >= 0 ? '+' : '−') + moneyWon(Math.abs(net)) : '—') + '</span>' +
        '<span class="tsub num">' + (inc || exp ? '수 ' + fmtNum(inc) + ' / 지 ' + fmtNum(exp) : '') + '</span>' +
        '</div>';
    }).join('');
    const tot = rows.reduce((a, r) => {
      a.inc += r.sum.income.krwTotal; a.exp += r.sum.expense.krwTotal; return a;
    }, { inc: 0, exp: 0 });
    return '<div class="card">' +
      '<div class="card-head"><div><h2>' + year + '년 월별 추이</h2><p>수입·지출 모두 ₩ 환산 · 순수익 기준</p></div>' +
        '<div class="pill-row"><button type="button" class="chip sm" data-action="year-prev">‹</button><span class="tiny" style="font-weight:800">' + year + '년</span><button type="button" class="chip sm" data-action="year-next">›</button></div>' +
      '</div>' +
      '<div class="trend">' + body + '</div>' +
      '<div class="legend"><span class="li-in"><i></i>수입</span><span class="li-ex"><i></i>지출</span></div>' +
      '<div class="divider"></div>' +
      '<div class="kv"><span class="k">연간 합계</span><span class="v num">수입 ' + moneyWon(tot.inc) + ' · 지출 ' + moneyWon(tot.exp) + '</span></div>' +
      '<div class="kv"><span class="k">연간 순수익</span><span class="v num" style="color:' + (tot.inc - tot.exp < 0 ? 'var(--bad)' : 'var(--green)') + '">' + (tot.inc - tot.exp < 0 ? '−' : '') + moneyWon(Math.abs(tot.inc - tot.exp)) + '</span></div>' +
      '</div>';
  }

  function reportMonthTableHTML(sum) {
    const rows = sum.catsExpense;
    if (!rows.length) return '';
    return '<div class="card"><div class="card-head"><div><h2>' + monthLabel(ui.month) + ' 정산표</h2><p>항목별 지출 · 필리핀/한국 금액과 비중</p></div></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>항목</th><th>필리핀 / 한국</th><th>합계(₩)</th><th class="c-share">비중</th></tr></thead><tbody>' +
      rows.map((c) => '<tr><td class="nmcell">' + catMeta(c.name, 'expense').emo + ' ' + esc(c.name) + '</td>' +
        '<td>' + curPair(c.php, c.krw) + '</td>' +
        '<td>' + moneyWon(c.krwTotal) + '</td><td class="c-share">' + pctText(c.krwTotal, sum.expense.krwTotal, 1) + '</td></tr>').join('') +
      '</tbody><tfoot><tr><td>지출 합계</td><td>' + curPair(sum.expense.php, sum.expense.krw) + '</td><td>' + moneyWon(sum.expense.krwTotal) + '</td><td class="c-share">100%</td></tr>' +
      '<tr><td>수입 합계</td><td>' + curPair(sum.income.php, sum.income.krw) + '</td><td>' + moneyWon(sum.income.krwTotal) + '</td><td class="c-share">—</td></tr>' +
      '<tr><td>순수익</td><td class="cmute">—</td><td>' + (sum.net < 0 ? '−' : '') + moneyWon(Math.abs(sum.net)) + '</td><td class="c-share">' + (sum.income.krwTotal ? Math.round(sum.margin) + '%' : '—') + '</td></tr></tfoot></table></div></div>';
  }

  function reportHouseHTML(sum) {
    const rows = HOUSES.map((h) => {
      const b = sum.houses[h.id];
      return { h: h, inc: b.income.krwTotal, exp: b.expense.krwTotal, cnt: b.income.count + b.expense.count };
    }).filter((r) => r.cnt);
    if (!rows.length) return '';
    return '<div class="card"><div class="card-head"><div><h2>하우스별 정산</h2><p>' + monthLabel(ui.month) + ' · 태그된 내역 기준</p></div></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>하우스</th><th>수입(₩)</th><th>지출(₩)</th><th>차액(₩)</th><th>건수</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td class="nmcell">' + esc(r.h.name) + '</td><td>' + moneyWon(r.inc) + '</td><td>' + moneyWon(r.exp) + '</td><td>' + moneyWon(r.inc - r.exp) + '</td><td>' + r.cnt + '</td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="tiny muted" style="margin-top:8px">하우스 태그는 선택 사항입니다. 비워 두면 <b>공통(전체)</b>으로 잡힙니다.</div></div>';
  }

  function reportTopHTML() {
    const all = summarize(state.entries).catsExpense.slice(0, 6);
    if (!all.length) return '';
    const max = all[0].krwTotal || 1;
    return '<div class="card"><div class="card-head"><div><h2>전체 기간 지출 순위</h2><p>많이 나간 항목 top 6</p></div></div><div class="chart">' +
      all.map((c, i) => '<div class="bar-row">' +
        '<span class="bl"><span>' + (i + 1) + '.</span><span class="name">' + catMeta(c.name, 'expense').emo + ' ' + esc(c.name) + '</span></span>' +
        '<span class="bv num">' + moneyWon(c.krwTotal) + '</span>' +
        '<span class="bar-track"><span class="bar-fill alt" style="width:' + Math.max(3, (c.krwTotal / max) * 100).toFixed(1) + '%"></span></span>' +
        '</div>').join('') + '</div></div>';
  }

  function renderReport() {
    const el = $('#viewReport');
    if (!el) return;
    const sum = summarize(entriesForMonth(ui.month));
    el.innerHTML =
      reportTrendHTML(ui.year) +
      reportMonthTableHTML(sum) +
      '<div class="grid-2">' + reportHouseHTML(sum) + reportTopHTML() + '</div>' +
      '<div class="card tight"><div class="tiny muted">환율 <b>₱1 = ₩' + fmtRate(getRate()) + '</b> 기준입니다. 설정에서 바꾸면 모든 환산 금액이 다시 계산됩니다.</div></div>';
  }

  /* ---------- 설정 ---------- */
  function renderSettings() {
    const el = $('#viewSettings');
    if (!el) return;
    const s = state.settings;
    const b = balance();
    el.innerHTML =
      '<div class="card"><div class="card-head"><div><h2>💰 기초(시작) 잔액</h2><p>장부를 시작할 때 실제로 가지고 있던 돈</p></div></div>' +
        '<form id="openingForm" novalidate>' +
          '<div class="field-2">' +
            '<div class="field"><label for="sOpenPhp">필리핀 현지 (₱)</label><input type="text" id="sOpenPhp" inputmode="decimal" value="' + (s.opening.php || 0) + '"></div>' +
            '<div class="field"><label for="sOpenKrw">한국 (₩)</label><input type="text" id="sOpenKrw" inputmode="decimal" value="' + (s.opening.krw || 0) + '"></div>' +
          '</div>' +
          '<div class="set-note">지금 계산된 보유 잔액 — 🇵🇭 <b>' + money(b.php, 'PHP') + '</b> · 🇰🇷 <b>' + money(b.krw, 'KRW') + '</b> · 통합 <b>' + moneyWon(b.totalKRW) + '</b></div>' +
          '<div class="btn-row" style="margin-top:10px"><button type="submit" class="btn primary sm">기초 잔액 저장</button></div>' +
        '</form>' +
      '</div>' +

      '<div class="card"><div class="card-head"><div><h2>💱 환율</h2><p>페소를 원으로 바꾸는 기준</p></div></div>' +
        '<form id="rateForm" novalidate><div class="set-row" style="gap:10px">' +
          '<span class="lbl">₱1 =</span>' +
          '<input class="search" id="sRate" inputmode="decimal" value="' + fmtRate(s.rate) + '" style="max-width:120px;text-align:right">' +
          '<span class="lbl">₩</span>' +
          '<button type="submit" class="btn primary sm">저장</button>' +
        '</div>' +
        '<div class="set-note" style="margin-top:8px">예: 1페소가 24.5원이면 <b>24.5</b>. 바꾸면 모든 월별 합계·보유 잔액이 새 환율로 다시 계산됩니다.</div>' +
        '</form>' +
      '</div>' +

      '<div class="card"><div class="card-head"><div><h2>🔒 접속 비밀번호</h2><p>예약 앱과 <b>별개의</b> 회계 전용 비밀번호</p></div>' +
        (isDefaultPin() ? '<span class="tag fix">기본 0000</span>' : '') + '</div>' +
        '<form id="pinForm" novalidate>' +
          '<div class="field"><label for="pinCurrent">지금 비밀번호</label><input type="password" id="pinCurrent" inputmode="numeric" maxlength="12" autocomplete="current-password" placeholder="지금 쓰는 비밀번호"></div>' +
          '<div class="field-2">' +
            '<div class="field"><label for="pinNew">새 비밀번호 (4자 이상)</label><input type="password" id="pinNew" inputmode="numeric" maxlength="12" autocomplete="new-password" placeholder="예: 2580"></div>' +
            '<div class="field"><label for="pinNew2">새 비밀번호 확인</label><input type="password" id="pinNew2" inputmode="numeric" maxlength="12" autocomplete="new-password" placeholder="한 번 더"></div>' +
          '</div>' +
          '<div id="pinNotice" class="form-notice" role="alert"></div>' +
          '<div class="btn-row"><button type="submit" class="btn primary sm">비밀번호 바꾸기</button></div>' +
          '<div class="set-note" style="margin-top:8px">기본 비밀번호는 <b>0000</b>입니다. 비밀번호는 이 기기에만 저장되며, 장부 내보내기(JSON)에는 담기지 않습니다.</div>' +
        '</form>' +
      '</div>' +

      '<div class="card"><div class="card-head"><div><h2>💾 백업 · 내보내기</h2><p>장부를 파일로 보관하거나 엑셀로 받기</p></div></div>' +
        '<div class="btn-row">' +
          '<button type="button" class="btn sm" data-action="export-json">JSON 내보내기</button>' +
          '<button type="button" class="btn sm" data-action="import-json">JSON 가져오기</button>' +
          '<button type="button" class="btn sm" data-action="export-csv">CSV(엑셀) 정산표</button>' +
        '</div>' +
        '<div class="set-note" style="margin-top:8px">CSV는 지금 보고 있는 <b>' + monthLabel(ui.month) + '</b> 정산표입니다. 가져오기는 기존 장부에 <b>합쳐서</b> 넣습니다(같은 내역은 최신 것으로 갱신).</div>' +
        '<div class="divider"></div>' +
        '<div class="btn-row">' +
          '<button type="button" class="btn sm ghost" data-action="sample-data">샘플 데이터 넣기</button>' +
          '<button type="button" class="btn sm danger" data-action="reset-data">내역 전체 초기화</button>' +
        '</div>' +
        '<div class="set-note" style="margin-top:8px">초기화는 <b>지출·수입 내역만</b> 지우고 비밀번호와 기초 잔액은 남깁니다.</div>' +
      '</div>' +

      '<div class="card"><div class="card-head"><div><h2>☁️ 공동 편집 동기화 (선택)</h2><p>사장님과 엘레나가 같은 장부를 볼 때</p></div></div>' +
        '<form id="syncForm" novalidate>' +
          '<div class="field"><label for="sSyncUrl">Firebase Realtime Database 주소</label><input type="url" id="sSyncUrl" value="' + esc(s.sync.url) + '" placeholder="https://내프로젝트-default-rtdb.firebaseio.com"></div>' +
          '<div class="field"><label for="sSyncCode">공유 코드 (같은 코드끼리 같은 장부)</label><input type="text" id="sSyncCode" value="' + esc(s.sync.code) + '" placeholder="예: oraholic-acct-2026"></div>' +
          '<label class="toggle" for="sSyncOn" style="margin-bottom:10px"><input type="checkbox" id="sSyncOn"' + (s.sync.enabled ? ' checked' : '') + '> 동기화 사용</label>' +
          '<div class="btn-row"><button type="submit" class="btn sm">설정 저장</button><button type="button" class="btn sm primary" data-action="sync-now">지금 동기화</button></div>' +
          '<div class="set-note" style="margin-top:8px">저장 위치: <b>' + SYNC_PATH + '/{공유코드}.json</b> · ' +
            (s.sync.lastAt ? '마지막 동기화 ' + new Date(s.sync.lastAt).toLocaleString('ko-KR') + (s.sync.lastResult === 'err' ? ' (실패)' : ' (성공)') : '아직 동기화한 적 없음') +
          '</div>' +
        '</form>' +
      '</div>' +

      '<div class="card tight"><div class="card-head"><div><h2>앱 정보</h2><p>오라홀릭 회계 정산 v' + APP_VERSION + '</p></div></div>' +
        '<div class="kv"><span class="k">저장 위치</span><span class="v">이 기기 localStorage</span></div>' +
        '<div class="kv"><span class="k">저장 키</span><span class="v">' + LS_KEY + '</span></div>' +
        '<div class="kv"><span class="k">기록된 내역</span><span class="v">' + state.entries.length + '건</span></div>' +
        '<div class="kv"><span class="k">예약 앱과 분리</span><span class="v">별도 비밀번호 · 별도 저장소</span></div>' +
        '<div class="set-note" style="margin-top:10px">잠겨 있는 동안에는 어떤 지출·수입 금액도 화면에 그려지지 않습니다. 🔒 버튼을 누르면 즉시 잠깁니다.</div>' +
        '<div class="set-note" style="margin-top:8px">휴대폰 브라우저 메뉴에서 <b>홈 화면에 추가</b>하면 앱처럼 열립니다. 예약 앱과 <b>따로 설치</b>되고, 비밀번호도 따로입니다.</div>' +
      '</div>';
  }

  /* ---------- 6. 시트 (입력 / 기초잔액) ---------- */
  function toast(msg, kind) {
    const root = $('#toastRoot');
    if (!root) return;
    const d = document.createElement('div');
    d.className = 'toast ' + (kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : '');
    d.textContent = msg;
    root.appendChild(d);
    setTimeout(() => { try { d.remove(); } catch (e) {} }, 3400);
  }

  function sheetShell(inner) {
    const root = $('#sheetRoot');
    if (!root) return;
    root.innerHTML = '<div class="sheet-backdrop" data-action="backdrop">' + inner + '</div>';
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    const root = $('#sheetRoot');
    if (root) root.innerHTML = '';
    document.body.style.overflow = '';
    sheetState = null;
  }

  function defaultDate() {
    if (ui.month === thisMonth()) return todayStr();
    return ui.month + '-01';
  }

  function openEntrySheet(id, type) {
    const e = id ? getEntry(id) : null;
    sheetState = e ? Object.assign({}, e) : {
      id: null, type: type === 'income' ? 'income' : 'expense', date: defaultDate(),
      region: 'PH', currency: 'PHP', amount: '', category: '',
      house: 'ALL', memo: '', recurring: false
    };
    if (!e && sheetState.type === 'income') { sheetState.region = 'PH'; sheetState.currency = 'PHP'; }
    renderEntryForm();
  }

  function catsOf(type) {
    const base = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
    const custom = (state.settings.customCats[type] || []).map((n) => ({ name: n, emo: '🧾' }));
    return base.concat(custom);
  }

  function renderEntryForm() {
    const d = sheetState;
    if (!d) return;
    const isExp = d.type === 'expense';
    const catList = catsOf(d.type);
    const sym = d.currency === 'PHP' ? '₱' : '₩';
    const amt = num(String(d.amount).replace(/,/g, ''));
    let preview = '';
    if (amt > 0) {
      preview = d.currency === 'PHP'
        ? '≈ ' + moneyWon(amt * getRate()) + ' (₱1 = ₩' + fmtRate(getRate()) + ')'
        : '≈ ' + money(amt / getRate(), 'PHP') + ' (₱1 = ₩' + fmtRate(getRate()) + ')';
    }
    const catChips = catList.map((c) =>
      '<button type="button" class="cat-chip' + (d.category === c.name ? ' on' : '') + '" data-action="set-cat" data-cat="' + esc(c.name) + '"><span class="emo">' + c.emo + '</span><span>' + esc(c.name) + '</span></button>').join('');

    const html = '<form class="sheet" id="entryForm" novalidate autocomplete="off">' +
      '<div class="sheet-grip"></div>' +
      '<div class="sheet-head"><h2>' + (d.id ? '내역 수정' : (isExp ? '지출 추가' : '수입 추가')) + '</h2>' +
        '<button type="button" class="sheet-close" data-action="close-sheet" aria-label="닫기">✕</button></div>' +
      '<div class="seg">' +
        '<button type="button" data-action="set-type" data-type="expense" class="' + (isExp ? 'on exp' : '') + '">− 지출</button>' +
        '<button type="button" data-action="set-type" data-type="income" class="' + (!isExp ? 'on' : '') + '">＋ 수입</button>' +
      '</div>' +
      '<div class="field" style="margin-top:12px"><label for="eAmount">금액</label>' +
        '<div class="amount-box"><span class="cur" id="eCurSym">' + sym + '</span>' +
        '<input type="text" id="eAmount" inputmode="decimal" value="' + esc(d.amount) + '" placeholder="0"></div>' +
        '<div class="amount-preview" id="ePreview">' + preview + '</div></div>' +
      '<div class="field"><label>지역</label><div class="f-row">' +
        '<button type="button" class="chip ' + (d.region === 'PH' ? 'on' : '') + '" data-action="set-region" data-region="PH">🇵🇭 필리핀 현지</button>' +
        '<button type="button" class="chip ' + (d.region === 'KR' ? 'on' : '') + '" data-action="set-region" data-region="KR">🇰🇷 한국</button>' +
      '</div></div>' +
      '<div class="field"><label>통화</label><div class="f-row">' +
        '<button type="button" class="chip ' + (d.currency === 'PHP' ? 'on' : '') + '" data-action="set-cur" data-cur="PHP">₱ 페소</button>' +
        '<button type="button" class="chip ' + (d.currency === 'KRW' ? 'on' : '') + '" data-action="set-cur" data-cur="KRW">₩ 원</button>' +
        '<span class="tiny muted" style="align-self:center">지역을 고르면 통화가 자동으로 맞춰집니다</span>' +
      '</div></div>' +
      '<div class="field"><label for="eDate">날짜</label><input type="date" id="eDate" value="' + esc(d.date) + '"></div>' +
      '<div class="field"><label>항목</label><div class="cat-grid" id="catGrid">' + catChips + '</div>' +
        '<div class="f-row" style="margin-top:8px;gap:6px">' +
          '<input class="search" id="eNewCat" placeholder="새 항목 (예: 세탁비)" style="flex:1;min-width:110px">' +
          '<button type="button" class="btn sm" data-action="add-cat">추가</button>' +
        '</div></div>' +
      '<div class="field"><label>하우스 (선택)</label><div class="f-row">' +
        HOUSES.map((h) => '<button type="button" class="chip sm ' + (d.house === h.id ? 'on' : '') + '" data-action="set-house" data-house="' + h.id + '">' + esc(h.id === 'ALL' ? '공통(전체)' : h.name) + '</button>').join('') +
      '</div></div>' +
      '<div class="field"><label for="eMemo">메모</label><input type="text" id="eMemo" maxlength="120" value="' + esc(d.memo) + '" placeholder="예: 11월분 / 엘레나 전달"></div>' +
      (isExp ? '<label class="toggle" for="eRecurring" style="margin:2px 0 12px"><input type="checkbox" id="eRecurring"' + (d.recurring ? ' checked' : '') + '> 매달 나가는 고정 지출 (다음 달에 복사)</label>' : '') +
      '<div id="entryError" class="form-notice" role="alert"></div>' +
      '<div class="sheet-foot">' +
        (d.id ? '<button type="button" class="btn danger" data-action="delete-entry" data-id="' + esc(d.id) + '">삭제</button>' : '') +
        '<button type="submit" class="btn primary">저장</button>' +
      '</div>' +
      '</form>';
    sheetShell(html);
    setTimeout(() => { const a = $('#eAmount'); if (a && !TEST) { try { a.focus(); } catch (e) {} } }, 60);
  }

  function captureForm() {
    if (!sheetState) return;
    const a = $('#eAmount'); if (a) sheetState.amount = a.value;
    const dt = $('#eDate'); if (dt) sheetState.date = dt.value;
    const m = $('#eMemo'); if (m) sheetState.memo = m.value;
    const rc = $('#eRecurring'); if (rc) sheetState.recurring = rc.checked;
  }

  function openBalanceSheet() {
    const b = balance();
    const html = '<form class="sheet" id="openingSheetForm" novalidate>' +
      '<div class="sheet-grip"></div>' +
      '<div class="sheet-head"><h2>기초 잔액 설정</h2><button type="button" class="sheet-close" data-action="close-sheet" aria-label="닫기">✕</button></div>' +
      '<p class="tiny muted" style="margin-bottom:12px">장부를 시작한 날 실제로 가지고 있던 돈을 적으면, 그 뒤로는 수입·지출이 더해지고 빠져서 <b>현재 보유 잔액</b>이 자동으로 맞춰집니다.</p>' +
      '<div class="field-2">' +
        '<div class="field"><label for="bOpenPhp">필리핀 현지 (₱)</label><input type="text" id="bOpenPhp" inputmode="decimal" value="' + (state.settings.opening.php || 0) + '"></div>' +
        '<div class="field"><label for="bOpenKrw">한국 (₩)</label><input type="text" id="bOpenKrw" inputmode="decimal" value="' + (state.settings.opening.krw || 0) + '"></div>' +
      '</div>' +
      '<div class="notice">지금 장부 기준 누적 — 🇵🇭 수입 ' + money(b.phpIn, 'PHP') + ' − 지출 ' + money(b.phpOut, 'PHP') + ' · 🇰🇷 수입 ' + money(b.krwIn, 'KRW') + ' − 지출 ' + money(b.krwOut, 'KRW') + '<br>환산 기준 ₱1 = ₩' + fmtRate(getRate()) + '</div>' +
      '<div class="sheet-foot" style="margin-top:14px"><button type="button" class="btn" data-action="close-sheet">취소</button><button type="submit" class="btn primary">저장</button></div>' +
      '</form>';
    sheetShell(html);
  }

  /* ---------- 7. 잠금 ---------- */
  function hashPin(pin) {
    // 4자리 비밀번호가 저장소에 그대로 남지 않도록 두 개의 32비트 해시로 보관합니다.
    const s = 'oraholic-accounting:' + String(pin == null ? '' : pin);
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
  function isDefaultPin() { return state.settings.pinHash === hashPin(DEFAULT_PIN); }

  function readAuthRecord(store) {
    try {
      const raw = JSON.parse(store.getItem(AUTH_KEY) || 'null');
      return raw && typeof raw === 'object' ? raw : null;
    } catch (e) { return null; }
  }
  function authMatches(rec) { return !!(rec && rec.pinHash && rec.pinHash === state.settings.pinHash); }
  function hasValidSession() {
    try { if (authMatches(readAuthRecord(localStorage))) return true; } catch (e) {}
    try { if (authMatches(readAuthRecord(sessionStorage))) return true; } catch (e) {}
    return false;
  }
  function writeAuthRecord(remember) {
    const rec = JSON.stringify({ pinHash: state.settings.pinHash, at: Date.now() });
    try {
      if (remember) {
        localStorage.setItem(AUTH_KEY, rec);
        try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
      } else {
        sessionStorage.setItem(AUTH_KEY, rec);
        try { localStorage.removeItem(AUTH_KEY); } catch (e) {}
      }
    } catch (e) {}
  }
  function clearAuthRecord() {
    try { localStorage.removeItem(AUTH_KEY); } catch (e) {}
    try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
  }

  function clearProtectedViews() {
    closeSheet();
    const t = $('#toastRoot');
    if (t) t.innerHTML = '';
    ['viewDashboard', 'viewLedger', 'viewReport', 'viewSettings'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    const rc = $('#rateChipText'); if (rc) rc.textContent = '₱1 = ₩' + fmtRate(getRate());
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
      if (!(opts && opts.noFocus) && !TEST) setTimeout(() => { try { pin.focus(); } catch (e) {} }, 60);
    }
    document.body.style.overflow = 'hidden';
  }

  function unlockApp(opts) {
    if (!(opts && opts.force) && !hasValidSession()) return false;
    locked = false;
    const shell = $('#app-shell');
    if (shell) { shell.classList.remove('hidden'); shell.removeAttribute('hidden'); }
    const screen = $('#lockScreen');
    if (screen) screen.classList.add('hidden');
    document.body.style.overflow = '';
    renderAll();
    return true;
  }

  function attemptUnlock(pin, remember) {
    const val = String(pin == null ? '' : pin).trim();
    if (!val) { setLockError('비밀번호를 입력해 주세요.'); return false; }
    if (hashPin(val) !== state.settings.pinHash) {
      setLockError('비밀번호가 맞지 않습니다. 다시 확인해 주세요.');
      const card = $('#lockCard');
      if (card) { card.classList.add('shake'); setTimeout(() => { try { card.classList.remove('shake'); } catch (e) {} }, 400); }
      const el = $('#lockPin');
      if (el) { el.value = ''; if (!TEST) { try { el.focus(); } catch (e) {} } }
      return false;
    }
    writeAuthRecord(!!remember);
    unlockApp();
    if (isDefaultPin()) toast('기본 비밀번호 0000으로 열었습니다. ⚙️ 설정에서 새 비밀번호로 바꿔 주세요.', 'warn');
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
    const ag = String(again == null ? '' : again).trim();
    const notice = $('#pinNotice');
    const fail = (msg) => { if (notice) { notice.textContent = msg; notice.className = 'form-notice bad'; } toast(msg, 'err'); return false; };
    if (hashPin(cur) !== state.settings.pinHash) return fail('지금 비밀번호가 맞지 않습니다.');
    if (nw.length < PIN_MIN) return fail('새 비밀번호는 ' + PIN_MIN + '자 이상이어야 합니다.');
    if (nw.length > PIN_MAX) return fail('새 비밀번호는 ' + PIN_MAX + '자까지 됩니다.');
    if (nw !== ag) return fail('새 비밀번호 확인이 서로 다릅니다.');
    state.settings.pinHash = hashPin(nw);
    state.settings.pinUpdatedAt = Date.now();
    save();
    writeAuthRecord(true);
    renderAll();
    if (notice) { notice.textContent = '비밀번호를 바꿨습니다.'; notice.className = 'form-notice ok'; }
    toast('접속 비밀번호를 바꿨습니다.');
    return true;
  }

  /* ---------- 8. 백업 · CSV ---------- */
  function exportPayload() {
    return JSON.stringify({
      app: 'oraholic-accounting',
      schemaVersion: 1,
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      settings: {
        rate: getRate(),
        opening: { php: num(state.settings.opening.php), krw: num(state.settings.opening.krw) },
        customCats: state.settings.customCats
      },
      entries: state.entries
    }, null, 2);
  }

  function importPayload(text, opts) {
    let raw;
    try { raw = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { ok: false, error: 'JSON 형식이 아닙니다.' }; }
    if (!raw || typeof raw !== 'object') return { ok: false, error: '읽을 수 없는 파일입니다.' };
    const incoming = Array.isArray(raw.entries) ? raw.entries : (Array.isArray(raw) ? raw : null);
    if (!incoming) return { ok: false, error: '장부 내역(entries)을 찾지 못했습니다.' };
    let added = 0, updated = 0, skipped = 0;
    incoming.map(normEntry).filter(Boolean).forEach((e) => {
      const i = state.entries.findIndex((x) => x.id === e.id);
      if (i >= 0) {
        if (num(e.updatedAt) >= num(state.entries[i].updatedAt)) { state.entries[i] = e; updated += 1; }
        else skipped += 1;
      } else { state.entries.push(e); added += 1; }
    });
    const rs = raw.settings || {};
    if (num(rs.rate) > 0) state.settings.rate = num(rs.rate);
    if (rs.opening && typeof rs.opening === 'object') {
      state.settings.opening = { php: num(rs.opening.php), krw: num(rs.opening.krw) };
    }
    save();
    renderAll();
    if (!(opts && opts.silent)) toast('가져오기 완료 · 새로 ' + added + '건, 갱신 ' + updated + '건', 'ok');
    return { ok: true, added: added, updated: updated, skipped: skipped, total: state.entries.length };
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildCSV(ym) {
    const month = ym || ui.month;
    const list = entriesForMonth(month).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
    const sum = summarize(list);
    const b = balance();
    const EOL = '\r\n';
    const lines = [];
    const push = (arr) => lines.push(arr.map(csvCell).join(','));
    push(['오라홀릭 회계 정산 — ' + monthLabel(month)]);
    push(['환율', '1 PHP = ' + fmtRate(getRate()) + ' KRW']);
    push(['기초 잔액', 'PHP ' + fmtNum(state.settings.opening.php), 'KRW ' + fmtNum(state.settings.opening.krw)]);
    push([]);
    push(['날짜', '구분', '지역', '통화', '금액', '원화환산', '항목', '하우스', '고정지출', '메모']);
    list.forEach((e) => {
      push([
        e.date,
        e.type === 'income' ? '수입' : '지출',
        e.region === 'KR' ? '한국' : '필리핀 현지',
        e.currency === 'PHP' ? 'PHP (₱)' : 'KRW (₩)',
        Math.round(num(e.amount)),
        Math.round(entryKRW(e)),
        e.category,
        e.house === 'ALL' ? '공통(전체)' : e.house + '하우스',
        e.recurring ? '고정' : '',
        e.memo || ''
      ]);
    });
    push([]);
    push(['합계', '수입', '', '', Math.round(sum.income.php), Math.round(sum.income.krwTotal), 'PHP ' + Math.round(sum.income.php) + ' / KRW ' + Math.round(sum.income.krw)]);
    push(['합계', '지출', '', '', Math.round(sum.expense.php), Math.round(sum.expense.krwTotal), 'PHP ' + Math.round(sum.expense.php) + ' / KRW ' + Math.round(sum.expense.krw)]);
    push(['합계', '현지 지출', '🇵🇭 필리핀', '', Math.round(sum.ph.php), Math.round(sum.ph.krwTotal)]);
    push(['합계', '한국 지출', '🇰🇷 한국', '', Math.round(sum.kr.php), Math.round(sum.kr.krwTotal)]);
    push(['합계', '순수익', '', '', '', Math.round(sum.net), '수입 − 지출']);
    push([]);
    push(['현재 보유 잔액', '필리핀 (₱) ' + Math.round(b.php), '한국 (₩) ' + Math.round(b.krw), '통합 (₩) ' + Math.round(b.totalKRW)]);
    push(['건수', list.length]);
    return '\uFEFF' + lines.join(EOL) + EOL;
  }

  function download(filename, text, mime) {
    try {
      const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch (e) {} }, 200);
      return true;
    } catch (e) {
      toast('이 브라우저에서는 파일 저장을 지원하지 않습니다.', 'err');
      return false;
    }
  }

  /* ---------- 9. 동기화 ---------- */
  function syncEndpoint(s) {
    const base = String(s.url || '').replace(/\/+$/, '');
    const code = encodeURIComponent(String(s.code || '').trim());
    return base ? base + '/' + SYNC_PATH + '/' + code + '.json' : '';
  }

  async function syncNow(opts) {
    const s = state.settings.sync;
    if (!s.enabled || !s.url || !s.code) {
      if (!(opts && opts.silent)) toast('동기화 주소와 공유 코드를 먼저 저장해 주세요.', 'warn');
      return { ok: false, error: 'not_configured' };
    }
    const url = syncEndpoint(s);
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res && res.ok) {
        const remote = await res.json();
        if (remote && Array.isArray(remote.entries)) {
          remote.entries.map(normEntry).filter(Boolean).forEach((e) => {
            const i = state.entries.findIndex((x) => x.id === e.id);
            if (i < 0) state.entries.push(e);
            else if (num(e.updatedAt) >= num(state.entries[i].updatedAt)) state.entries[i] = e;
          });
        }
        if (remote && remote.settings && remote.settings.opening) {
          state.settings.opening = { php: num(remote.settings.opening.php), krw: num(remote.settings.opening.krw) };
        }
      }
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updatedAt: Date.now(),
          settings: { rate: getRate(), opening: state.settings.opening },
          entries: state.entries
        })
      });
      if (!put || !put.ok) throw new Error('push_failed');
      s.lastAt = Date.now(); s.lastResult = 'ok';
      save(); renderAll();
      if (!(opts && opts.silent)) toast('동기화했습니다 · ' + state.entries.length + '건', 'ok');
      return { ok: true, count: state.entries.length };
    } catch (e) {
      s.lastAt = Date.now(); s.lastResult = 'err';
      save(); renderAll();
      if (!(opts && opts.silent)) toast('동기화에 실패했습니다. 주소와 네트워크를 확인해 주세요.', 'err');
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /* ---------- 10. 샘플 · 초기화 ---------- */
  function sampleData() {
    const ym = thisMonth();
    const prev = addMonths(ym, -1);
    const prev2 = addMonths(ym, -2);
    const mk = (ym2, day, type, region, currency, amount, category, house, memo, recurring) => ({
      id: rid(), type: type, date: ym2 + '-' + pad2(clamp(day, 1, daysInMonth(ym2))),
      region: region, currency: currency, amount: amount, category: category,
      house: house || 'ALL', memo: memo || '', recurring: !!recurring,
      createdAt: Date.now(), updatedAt: Date.now(), by: state.settings.operator || '사장님', sample: true
    });
    const rows = [];
    const factors = [0.84, 1, 1.12];
    [prev2, prev, ym].forEach((m, idx) => {
      const f = factors[idx];
      const r = (n) => Math.round((n * f) / 100) * 100;
      rows.push(mk(m, 3, 'income', 'PH', 'PHP', r(185000), '숙박 수입 - 개별', 'A', '개별 예약'));
      rows.push(mk(m, 8, 'income', 'PH', 'PHP', r(96000), '숙박 수입 - 에어비앤비', 'B', '에어비앤비 정산'));
      rows.push(mk(m, 12, 'income', 'PH', 'PHP', r(12800), '추가 서비스(아떼/픽드랍/매트리스)', 'C', '아떼 · 픽드랍'));
      rows.push(mk(m, 20, 'income', 'PH', 'PHP', r(4200), '기타 수입', 'ALL', ''));
      rows.push(mk(m, 1, 'expense', 'PH', 'PHP', 35000, '월세', 'ALL', '4채 월세', true));
      rows.push(mk(m, 2, 'expense', 'PH', 'PHP', 1899, '인터넷 요금', 'ALL', 'PLDT', true));
      rows.push(mk(m, 4, 'expense', 'PH', 'PHP', 500, '마을 회비', 'ALL', '', true));
      rows.push(mk(m, 5, 'expense', 'PH', 'PHP', 2400, '에어비앤비 등록비/수수료', 'ALL', '', true));
      rows.push(mk(m, 6, 'expense', 'PH', 'PHP', Math.round(1350 * f), '수도세', 'ALL', ''));
      rows.push(mk(m, 7, 'expense', 'PH', 'PHP', Math.round(5200 * f), '전기세', 'ALL', ''));
      rows.push(mk(m, 10, 'expense', 'PH', 'PHP', 12000, '아떼 월급', 'ALL', '엘레나 전달', true));
      rows.push(mk(m, 15, 'expense', 'PH', 'PHP', r(3200), '수리 비용', 'B', '에어컨'));
      rows.push(mk(m, 18, 'expense', 'PH', 'PHP', r(2800), '물품 구입', 'ALL', '수건 · 세제'));
      rows.push(mk(m, 22, 'expense', 'KR', 'KRW', r(120000), '물품 구입', 'ALL', '한국에서 보낸 비품'));
      rows.push(mk(m, 25, 'expense', 'KR', 'KRW', Math.round(45000 * f), '기타 지출', 'ALL', '송금 수수료'));
    });
    state.entries = state.entries.concat(rows.map(normEntry).filter(Boolean));
    if (!num(state.settings.opening.php) && !num(state.settings.opening.krw)) {
      state.settings.opening = { php: 40000, krw: 800000 };
    }
    save(); renderAll();
    toast('샘플 데이터 ' + rows.length + '건을 넣었습니다. 설정에서 초기화할 수 있습니다.', 'ok');
    return rows.length;
  }

  function resetData(opts) {
    state.entries = [];
    save(); renderAll();
    if (!(opts && opts.silent)) toast('내역을 모두 지웠습니다. 비밀번호와 기초 잔액은 그대로입니다.');
    return true;
  }

  /* ---------- 11. 이벤트 ---------- */
  function showView(v) {
    ui.view = ['dashboard', 'ledger', 'report', 'settings'].indexOf(v) >= 0 ? v : 'dashboard';
    renderAll();
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { try { window.scrollTo(0, 0); } catch (e2) {} }
  }

  function goMonth(delta) {
    ui.month = addMonths(ui.month, delta);
    ui.year = Number(ui.month.slice(0, 4));
    renderAll();
  }

  function setFilter(k, v) {
    if (!(k in ui.filters)) return;
    ui.filters[k] = v;
    renderAll();
  }

  document.addEventListener('click', function (ev) {
    const el = ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!el) return;
    const a = el.getAttribute('data-action');
    const d = el.dataset || {};

    if (a === 'backdrop') {
      if (ev.target === el) closeSheet();
      return;
    }
    if (a === 'close-sheet') { closeSheet(); return; }
    if (a === 'lock') { lockNow(); return; }
    if (a === 'view') { showView(d.view); return; }
    if (a === 'goto-settings') { showView('settings'); return; }
    if (a === 'month-prev') { goMonth(-1); return; }
    if (a === 'month-next') { goMonth(1); return; }
    if (a === 'month-now') { ui.month = thisMonth(); ui.year = Number(ui.month.slice(0, 4)); renderAll(); return; }
    if (a === 'year-prev') { ui.year = ui.year - 1; renderAll(); return; }
    if (a === 'year-next') { ui.year = ui.year + 1; renderAll(); return; }
    if (a === 'new-entry') { ev.preventDefault(); openEntrySheet(null, 'expense'); return; }
    if (a === 'edit-entry') { openEntrySheet(d.id); return; }
    if (a === 'copy-fixed') { copyFixed(ui.month); return; }
    if (a === 'edit-opening') { openBalanceSheet(); return; }
    if (a === 'filter') { setFilter(d.filter, d.value); return; }

    /* --- 입력 시트 내부 --- */
    if (a === 'set-type') { captureForm(); sheetState.type = d.type === 'income' ? 'income' : 'expense'; if (sheetState.category && !catsOf(sheetState.type).some((c) => c.name === sheetState.category)) sheetState.category = ''; renderEntryForm(); return; }
    if (a === 'set-region') {
      captureForm();
      sheetState.region = d.region === 'KR' ? 'KR' : 'PH';
      sheetState.currency = sheetState.region === 'KR' ? 'KRW' : 'PHP';
      renderEntryForm(); return;
    }
    if (a === 'set-cur') { captureForm(); sheetState.currency = d.cur === 'KRW' ? 'KRW' : 'PHP'; renderEntryForm(); return; }
    if (a === 'set-cat') { captureForm(); sheetState.category = d.cat; renderEntryForm(); return; }
    if (a === 'set-house') { captureForm(); sheetState.house = d.house; renderEntryForm(); return; }
    if (a === 'add-cat') {
      captureForm();
      const inp = $('#eNewCat');
      const name = String(inp && inp.value || '').trim();
      if (!name) { toast('새 항목 이름을 입력해 주세요.', 'warn'); return; }
      const type = sheetState.type;
      const exists = catsOf(type).some((c) => c.name === name);
      if (!exists) {
        state.settings.customCats[type] = (state.settings.customCats[type] || []).concat(name).slice(0, 60);
        save();
      }
      sheetState.category = name;
      renderEntryForm();
      toast('‘' + name + '’ 항목을 추가했습니다.', 'ok');
      return;
    }
    if (a === 'delete-entry') {
      const id = d.id || (sheetState && sheetState.id);
      if (!id) return;
      if (deleteEntry(id)) { closeSheet(); toast('내역을 삭제했습니다.'); }
      return;
    }

    /* --- 설정 버튼 --- */
    if (a === 'export-json') {
      download('오라홀릭_회계_장부_' + todayStr() + '.json', exportPayload(), 'application/json;charset=utf-8');
      toast('JSON 파일로 내보냈습니다.', 'ok');
      return;
    }
    if (a === 'import-json') {
      const f = $('#importFile');
      if (f) f.click();
      return;
    }
    if (a === 'export-csv') {
      download('오라홀릭_회계_정산표_' + ui.month + '.csv', buildCSV(ui.month), 'text/csv;charset=utf-8');
      toast(monthLabel(ui.month) + ' 정산표를 CSV로 내보냈습니다.', 'ok');
      return;
    }
    if (a === 'sample-data') { sampleData(); return; }
    if (a === 'reset-data') {
      if (window.confirm && !TEST) {
        if (!window.confirm('내역을 모두 지울까요? 되돌릴 수 없습니다. (비밀번호·기초 잔액은 남습니다)')) return;
      }
      resetData();
      return;
    }
    if (a === 'sync-now') { syncNow(); return; }
  });

  document.addEventListener('submit', function (ev) {
    const f = ev.target;
    if (!f || !f.id) return;
    ev.preventDefault();

    if (f.id === 'lockForm') {
      const pin = $('#lockPin');
      const keep = $('#lockKeep');
      attemptUnlock(pin ? pin.value : '', keep ? keep.checked : true);
      return;
    }
    if (f.id === 'entryForm') {
      captureForm();
      const d = sheetState;
      if (!d) return;
      const amount = num(String(d.amount).replace(/[^0-9.]/g, ''));
      const err = $('#entryError');
      const bad = (m) => { if (err) { err.textContent = m; err.className = 'form-notice bad'; } toast(m, 'err'); };
      if (!(amount > 0)) return bad('금액을 입력해 주세요.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return bad('날짜를 확인해 주세요.');
      const cat = d.category || (d.type === 'income' ? '기타 수입' : '기타 지출');
      const saved = upsertEntry(Object.assign({}, d, { amount: amount, category: cat }));
      if (!saved) return bad('저장하지 못했습니다. 입력값을 확인해 주세요.');
      closeSheet();
      toast((d.id ? '내역을 수정했습니다' : (saved.type === 'income' ? '수입' : '지출') + ' ' + money(saved.amount, saved.currency) + '을 기록했습니다'), 'ok');
      return;
    }
    if (f.id === 'openingForm' || f.id === 'openingSheetForm') {
      const php = $('#bOpenPhp') || $('#sOpenPhp');
      const krw = $('#bOpenKrw') || $('#sOpenKrw');
      setOpening(php ? php.value : 0, krw ? krw.value : 0);
      if ($('#bOpenPhp')) closeSheet();
      toast('기초 잔액을 저장했습니다.', 'ok');
      return;
    }
    if (f.id === 'rateForm') {
      const v = $('#sRate');
      if (!setRate(v ? v.value : 0)) toast('환율을 숫자로 입력해 주세요.', 'err');
      else toast('환율을 ₱1 = ₩' + fmtRate(getRate()) + '로 바꿨습니다.', 'ok');
      return;
    }
    if (f.id === 'pinForm') {
      changePin($('#pinCurrent') && $('#pinCurrent').value, $('#pinNew') && $('#pinNew').value, $('#pinNew2') && $('#pinNew2').value);
      return;
    }
    if (f.id === 'syncForm') {
      const s = state.settings.sync;
      s.url = ($('#sSyncUrl') && $('#sSyncUrl').value || '').trim();
      s.code = ($('#sSyncCode') && $('#sSyncCode').value || '').trim();
      s.enabled = !!($('#sSyncOn') && $('#sSyncOn').checked);
      save(); renderAll();
      toast(s.enabled ? '동기화 설정을 저장했습니다.' : '동기화를 껐습니다. 이 기기에만 저장됩니다.', 'ok');
      return;
    }
  });

  document.addEventListener('change', function (ev) {
    const t = ev.target;
    if (!t) return;
    if (t.id === 'fCategory') { setFilter('category', t.value); return; }
    if (t.id === 'importFile') {
      const file = t.files && t.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        const res = importPayload(String(reader.result || ''));
        if (!res.ok) toast(res.error || '가져오기에 실패했습니다.', 'err');
      };
      reader.readAsText(file);
      t.value = '';
      return;
    }
  });

  document.addEventListener('input', function (ev) {
    const t = ev.target;
    if (!t) return;
    if (t.id === 'fSearch') { setFilter('q', t.value); return; }
    if (t.id === 'eAmount') {
      const p = $('#ePreview');
      const prev = sheetState;
      if (!p || !prev) return;
      const amt = num(String(t.value).replace(/[^0-9.]/g, ''));
      p.textContent = amt > 0
        ? (prev.currency === 'PHP' ? '≈ ' + moneyWon(amt * getRate()) + ' (₱1 = ₩' + fmtRate(getRate()) + ')'
          : '≈ ' + money(amt / getRate(), 'PHP') + ' (₱1 = ₩' + fmtRate(getRate()) + ')')
        : '';
      const sym = $('#eCurSym');
      if (sym) sym.textContent = prev.currency === 'PHP' ? '₱' : '₩';
      return;
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { closeSheet(); }
  });

  /* ---------- 12. 시작 ---------- */
  function boot() {
    refreshLockHint();
    if (hasValidSession()) unlockApp({ silent: true });
    else showLock({ noFocus: TEST });
  }

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () {
      try { navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {}); } catch (e) {}
    });
  }

  boot();

  /* ---------- 13. 테스트 훅 ---------- */
  window.__AC = {
    get state() { return state; },
    get locked() { return locked; },
    get ui() { return ui; },
    LS_KEY: LS_KEY, AUTH_KEY: AUTH_KEY, DEFAULT_PIN: DEFAULT_PIN, APP_VERSION: APP_VERSION,
    REGIONS: REGIONS, HOUSES: HOUSES, EXPENSE_CATS: EXPENSE_CATS, INCOME_CATS: INCOME_CATS, RECUR_CATS: RECUR_CATS,
    hashPin: hashPin, isDefaultPin: isDefaultPin,
    attemptUnlock: attemptUnlock, lockNow: lockNow, changePin: changePin,
    hasValidSession: hasValidSession, showLock: showLock,
    getRate: getRate, setRate: setRate, setOpening: setOpening, balance: balance,
    entryKRW: entryKRW, entryPHP: entryPHP,
    entriesForMonth: entriesForMonth, summarize: summarize, filteredEntries: filteredEntries,
    fixedCandidates: fixedCandidates, copyFixed: copyFixed,
    addEntry: addEntry, upsertEntry: upsertEntry, deleteEntry: deleteEntry, getEntry: getEntry,
    buildCSV: buildCSV, exportPayload: exportPayload, importPayload: importPayload,
    sampleData: sampleData, resetData: resetData,
    syncNow: syncNow, syncEndpoint: syncEndpoint,
    showView: showView, goMonth: goMonth, setFilter: setFilter,
    openEntrySheet: openEntrySheet, openBalanceSheet: openBalanceSheet, closeSheet: closeSheet,
    renderAll: renderAll, toast: toast,
    todayStr: todayStr, monthKey: monthKey, addMonths: addMonths, monthLabel: monthLabel,
    money: money, fmtNum: fmtNum, catsOf: catsOf
  };
})();
