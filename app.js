/**
 * 都営バス 山吹町 接近情報
 * Cloudflare Worker経由でODPT時刻表を取得
 */

const PROXY_URL = 'https://odpt-proxy2.takahara-design.workers.dev';

const CALENDAR_MAP = {
  'Toei.37-170': 'weekday',
  'Toei.37-160': 'saturday',
  'Toei.37-100': 'holiday',
};

const ROUTE_NAMES = {
  'Shiro61': '白61', 'Haya77': '早77', 'Shiro62': '白62',
};

function getTodayType() {
  const day = new Date().getDay();
  if (day === 0) return 'holiday';
  if (day === 6) return 'saturday';
  return 'weekday';
}

// ── 状態 ──────────────────────────────────────────────
let currentTab   = 'shinjuku';
let allArrivals  = { shinjuku: [], nerima: [] };
let firstBusTime = null;  // 翌日始発のDate
let endOfService = false;
let tickTimer    = null;
let fetchTimer   = null;
let speedOffset  = 0;
let lastTickAt   = null;

// ── 方面判定 ──────────────────────────────────────────
function classifyDirection(destSign) {
  if (!destSign) return null;
  if (destSign.includes('新宿')) return 'shinjuku';
  if (destSign.includes('練馬')) return 'nerima';
  return null;
}

// ── 時刻 → Date ──────────────────────────────────────
function timeStrToDate(hhmm, tomorrow) {
  if (!hhmm) return null;
  const [hRaw, mm] = hhmm.split(':').map(Number);
  const h = hRaw >= 24 ? hRaw - 24 : hRaw;
  const d = new Date();
  if (tomorrow) d.setDate(d.getDate() + 1);
  d.setHours(h, mm, 0, 0);
  if (hRaw >= 24) d.setDate(d.getDate() + 1);
  return d;
}

function formatHHMM(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function getEffectiveNow() { return Date.now() + speedOffset; }
function msUntil(d) { return d.getTime() - getEffectiveNow(); }

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setDisplay(id, val) {
  const el = document.getElementById(id);
  if (el) el.style.display = val;
}

// ── フェッチ ──────────────────────────────────────────
async function fetchTimetable() {
  try {
    const res = await fetch(PROXY_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    processTimetable(data);
  } catch (e) {
    console.warn('フェッチ失敗:', e.message);
    endOfService = true;
    firstBusTime = null;
    renderAll();
  }
}

function processTimetable(timetables) {
  const todayType = getTodayType();
  const now       = getEffectiveNow();
  const result    = { shinjuku: [], nerima: [] };
  let   earliest  = null;

  for (const tt of timetables) {
    const pole = tt['odpt:busstopPole'] || '';
    if (!pole.includes('Yamabukicho')) continue;

    const calId   = (tt['odpt:calendar'] || '').split('Calendar:')[1] || '';
    const calType = CALENDAR_MAP[calId];
    if (!calType || calType !== todayType) continue;

    const objs = tt['odpt:busstopPoleTimetableObject'] || [];
    if (!objs.length) continue;

    const destSign = objs[0]['odpt:destinationSign'] || '';
    const dir = classifyDirection(destSign);
    if (!dir) continue;

    const routeRaw = tt['odpt:busroute'] || tt['odpt:busroutePattern'] || '';
    const route    = ROUTE_NAMES[routeRaw.split('.').pop()] || routeRaw.split('.').pop();

    for (const obj of objs) {
      const timeStr = obj['odpt:departureTime'] || obj['odpt:arrivalTime'];
      if (!timeStr) continue;

      // 始発候補：今日の時刻がまだ未来なら今日、過ぎていれば明日
      const etaToday    = timeStrToDate(timeStr, false);
      const etaTomorrow = timeStrToDate(timeStr, true);
      const firstCandidate = (etaToday && etaToday.getTime() > now) ? etaToday : etaTomorrow;
      if (!earliest || firstCandidate < earliest) earliest = firstCandidate;

      const eta = timeStrToDate(timeStr, false);
      if (!eta || eta.getTime() < now - 60000) continue;
      result[dir].push({ eta, destSign, route });
    }
  }

  for (const dir of ['shinjuku', 'nerima']) {
    result[dir].sort((a, b) => a.eta - b.eta);
    const seen = new Set();
    result[dir] = result[dir].filter(b => {
      const key = `${b.eta.getHours()}-${b.eta.getMinutes()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    result[dir] = result[dir].slice(0, 10);
  }

  const total = result.shinjuku.length + result.nerima.length;
  console.log(`[DEBUG] total=${total} earliest=${earliest ? formatHHMM(earliest) : 'none'} now=${formatHHMM(new Date(now))}`);
  if (total === 0) {
    endOfService = true;
    firstBusTime = earliest;
    allArrivals  = { shinjuku: [], nerima: [] };
  } else {
    endOfService = false;
    firstBusTime = earliest;
    allArrivals  = result;
  }
  renderAll();
}

// ── タブ ──────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  const sh = document.getElementById('tab-shinjuku');
  const ne = document.getElementById('tab-nerima');
  if (sh) sh.classList.toggle('active', tab === 'shinjuku');
  if (ne) ne.classList.toggle('active', tab === 'nerima');
  renderAll();
}

// ── メインレンダリング ─────────────────────────────────
function renderAll() {
  if (endOfService) {
    renderEndOfService();
    return;
  }
  const now = getEffectiveNow();
  for (const dir of ['shinjuku', 'nerima']) {
    allArrivals[dir] = (allArrivals[dir] || []).filter(b => b.eta.getTime() > now - 60000);
  }
  const buses = allArrivals[currentTab];
  if (!buses || buses.length === 0) { renderEmpty(); return; }
  renderNextBus(buses[0]);
  renderList(buses.slice(1));
}

// ── 運行終了 or 始発カウントダウン ────────────────────
function renderEndOfService() {
  const now         = getEffectiveNow();
  const msToFirst   = firstBusTime ? firstBusTime.getTime() - now : Infinity;
  const SIXTY_MIN   = 60 * 60 * 1000;

  setText('trainType', '');
  setText('directionBadge', '');
  setDisplay('cdArriving', 'none');
  setDisplay('cdLabel', 'none');

  const destEl = document.getElementById('destName');

  if (firstBusTime && msToFirst > 0 && msToFirst <= SIXTY_MIN) {
    // ── 始発60分前：カウントダウン ──
    if (destEl) {
      destEl.textContent   = '始発まであと';
      destEl.style.color   = 'var(--text-sub)';
      destEl.style.fontSize = '';
    }
    setText('departTime', `始発 ${formatHHMM(firstBusTime)} 発`);
    setDisplay('cdNormal', 'flex');

    const totalSecs = Math.floor(msToFirst / 1000);
    setText('cdMin',   String(Math.floor(totalSecs / 60)).padStart(2, '0'));
    setText('cdSec',   String(totalSecs % 60).padStart(2, '0'));
    setText('cdCents', String(Math.floor((msToFirst / 1000 - totalSecs) * 100)).padStart(2, '0'));
  } else {
    // ── 運行終了メッセージ ──
    if (destEl) {
      destEl.textContent    = '本日の運行は終了しました';
      destEl.style.color    = '#e03030';
      destEl.style.fontSize = '20px';
    }
    setText('departTime', firstBusTime ? `始発 ${formatHHMM(firstBusTime)}` : '');
    setDisplay('cdNormal', 'none');
  }

  const listArea = document.getElementById('listArea');
  if (listArea) listArea.innerHTML =
    '<div style="text-align:center;color:#bbb;padding:24px;font-size:13px;">翌日の時刻表は始発時刻よりご確認ください</div>';
}

// ── 次のバス表示 ──────────────────────────────────────
function renderNextBus(bus) {
  const secs = msUntil(bus.eta) / 1000;

  const destEl = document.getElementById('destName');
  if (destEl) { destEl.style.color = ''; destEl.style.fontSize = ''; }

  setText('destName',      bus.destSign || '―');
  setText('trainType',     bus.route    || '');
  setText('directionBadge', bus.destSign || '―');
  setText('departTime',    `発車予定 ${formatHHMM(bus.eta)}`);

  const cdNormal   = document.getElementById('cdNormal');
  const cdArriving = document.getElementById('cdArriving');
  const cdLabel    = document.getElementById('cdLabel');

  if (secs <= 0) {
    if (cdNormal)   cdNormal.style.display   = 'none';
    if (cdArriving) cdArriving.style.display = 'block';
    if (cdLabel)    cdLabel.style.display    = 'none';
    return;
  }

  if (cdNormal)   cdNormal.style.display   = 'flex';
  if (cdArriving) cdArriving.style.display = 'none';
  if (cdLabel)    cdLabel.style.display    = 'block';

  const totalSecs = Math.floor(secs);
  setText('cdMin',   String(Math.floor(totalSecs / 60)).padStart(2, '0'));
  setText('cdSec',   String(totalSecs % 60).padStart(2, '0'));
  setText('cdCents', String(Math.floor((secs - totalSecs) * 100)).padStart(2, '0'));
}

// ── 後続リスト ────────────────────────────────────────
function renderList(buses) {
  const el = document.getElementById('listArea');
  if (!el) return;
  if (!buses.length) {
    el.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px;font-size:13px;">後続バスなし</div>';
    return;
  }
  const labels = ['次便', '次々便', '次々々便'];
  el.innerHTML = buses.slice(0, 3).map((bus, i) => {
    const timeStr = msUntil(bus.eta) <= 0 ? 'まもなく' : `${formatHHMM(bus.eta)}発`;
    const cls = i === 0 ? 'bus-row row-next' : 'bus-row row-later';
    return `<div class="${cls}">
      <span class="row-label">${labels[i]}</span>
      <span class="row-type">${bus.destSign || '―'}</span>
      <span class="row-time">${timeStr}</span>
    </div>`;
  }).join('');
}

// ── データなし ────────────────────────────────────────
function renderEmpty() {
  const destEl = document.getElementById('destName');
  if (destEl) { destEl.textContent = 'データなし'; destEl.style.color = ''; destEl.style.fontSize = ''; }
  setText('trainType', '');
  setText('directionBadge', '―');
  setText('departTime', '');
  setText('cdMin',   '--');
  setText('cdSec',   '--');
  setText('cdCents', '--');
  setDisplay('cdNormal',   'flex');
  setDisplay('cdArriving', 'none');
  const listArea = document.getElementById('listArea');
  if (listArea) listArea.innerHTML =
    '<div style="text-align:center;color:#bbb;padding:24px;font-size:13px;">この時間帯のバス情報がありません</div>';
}

// ── tick ──────────────────────────────────────────────
function tick() {
  lastTickAt = Date.now();
  renderAll();
}

// ── 初期化 ────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  lastTickAt = Date.now();
  fetchTimetable();
  fetchTimer = setInterval(fetchTimetable, 5 * 60 * 1000);
  tickTimer  = setInterval(tick, 50);
});
