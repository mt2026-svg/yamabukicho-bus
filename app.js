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
let currentTab  = 'shinjuku';
let allArrivals = { shinjuku: [], nerima: [] };
let tickTimer   = null;
let fetchTimer  = null;
let speedMode   = false;
let speedOffset = 0;
let lastTickAt  = null;

// ── 方面判定 ──────────────────────────────────────────
function classifyDirection(destSign) {
  if (!destSign) return null;
  if (destSign.includes('新宿')) return 'shinjuku';
  if (destSign.includes('練馬')) return 'nerima';
  return null;
}

// ── 時刻 → Date ──────────────────────────────────────
function timeStrToDate(hhmm) {
  if (!hhmm) return null;
  const [hRaw, mm] = hhmm.split(':').map(Number);
  const h = hRaw >= 24 ? hRaw - 24 : hRaw;
  const d = new Date();
  d.setHours(h, mm, 0, 0);
  if (hRaw >= 24) d.setDate(d.getDate() + 1);
  return d;
}

function formatHHMM(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function getEffectiveNow() { return Date.now() + speedOffset; }
function msUntil(d) { return d.getTime() - getEffectiveNow(); }

// null安全なsetText
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
    renderEndOfService();
  }
}

function processTimetable(timetables) {
  const todayType = getTodayType();
  const now       = getEffectiveNow();
  const result    = { shinjuku: [], nerima: [] };

  for (const tt of timetables) {
    const pole = tt['odpt:busstopPole'] || '';
    if (!pole.includes('Yamabukicho')) continue;

    const calId   = (tt['odpt:calendar'] || '').split('Calendar:')[1] || '';
    const calType = CALENDAR_MAP[calId];
    if (!calType) continue;
    if (calType !== todayType) continue;

    const objs = tt['odpt:busstopPoleTimetableObject'] || [];
    if (!objs.length) continue;

    const destSign = objs[0]['odpt:destinationSign'] || '';
    const dir = classifyDirection(destSign);
    if (!dir) continue;

    const routeRaw = tt['odpt:busroute'] || tt['odpt:busroutePattern'] || '';
    const routeKey = routeRaw.split('.').pop() || '';
    const route    = ROUTE_NAMES[routeKey] || routeKey;

    for (const obj of objs) {
      const eta = timeStrToDate(obj['odpt:departureTime'] || obj['odpt:arrivalTime']);
      if (!eta) continue;
      if (eta.getTime() < now - 60000) continue;
      result[dir].push({ eta, destSign, route });
    }
  }

  for (const dir of ['shinjuku', 'nerima']) {
    result[dir].sort((a, b) => a.eta - b.eta);
    const seen = new Set();
    result[dir] = result[dir].filter(b => {
      const key = `${dir}-${b.eta.getHours()}-${b.eta.getMinutes()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    result[dir] = result[dir].slice(0, 10);
  }

  const total = result.shinjuku.length + result.nerima.length;
  if (total === 0) { renderEndOfService(); return; }

  allArrivals = result;
  renderAll();
}

// ── デモ ──────────────────────────────────────────────
function useDemo() {
  const base = getEffectiveNow();
  allArrivals = {
    shinjuku: [
      { eta: new Date(base + 4*60000 + 44000), destSign: '新宿駅西口', route: '白61' },
      { eta: new Date(base + 12*60000),         destSign: '新宿駅西口', route: '白61' },
      { eta: new Date(base + 21*60000),         destSign: '新宿駅西口', route: '白61' },
    ],
    nerima: [
      { eta: new Date(base + 7*60000 + 15000), destSign: '練馬駅',    route: '白61' },
      { eta: new Date(base + 17*60000),         destSign: '練馬車庫前', route: '白61' },
      { eta: new Date(base + 28*60000),         destSign: '練馬駅',    route: '白61' },
    ]
  };
  renderAll();
}

// ── 運行終了 ──────────────────────────────────────────
function renderEndOfService() {
  allArrivals = { shinjuku: [], nerima: [] };
  const destEl = document.getElementById('destName');
  if (destEl) {
    destEl.textContent = '本日の運行は終了しました';
    destEl.style.color = '#e03030';
    destEl.style.fontSize = '22px';
  }
  setText('trainType', '');
  setText('directionBadge', '');
  setText('departTime', '');
  setDisplay('cdLabel', 'none');
  setDisplay('cdNormal', 'none');
  setDisplay('cdArriving', 'none');
  const listArea = document.getElementById('listArea');
  if (listArea) listArea.innerHTML =
    '<div style="text-align:center;color:#bbb;padding:24px;font-size:13px;">翌日の時刻表は始発時刻よりご確認ください</div>';
}

// ── タブ ──────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-shinjuku').classList.toggle('active', tab === 'shinjuku');
  document.getElementById('tab-nerima').classList.toggle('active', tab === 'nerima');
  renderAll();
}

// ── レンダリング ──────────────────────────────────────
function renderAll() {
  const now = getEffectiveNow();
  for (const dir of ['shinjuku', 'nerima']) {
    allArrivals[dir] = (allArrivals[dir] || []).filter(b => b.eta.getTime() > now - 60000);
  }
  const buses = allArrivals[currentTab];
  if (!buses || buses.length === 0) { renderEmpty(); return; }
  renderNextBus(buses[0]);
  renderList(buses.slice(1));
}

function renderNextBus(bus) {
  const ms   = msUntil(bus.eta);
  const secs = ms / 1000;

  setText('destName', bus.destSign || '―');
  setText('trainType', bus.route    || '');
  setText('directionBadge', bus.destSign || '―');
  setText('departTime', `発車予定 ${formatHHMM(bus.eta)}`);

  const cdNormal   = document.getElementById('cdNormal');
  const cdArriving = document.getElementById('cdArriving');
  const cdLabel    = document.getElementById('cdLabel');

  if (secs <= 0) {
    cdNormal.style.display   = 'none';
    cdArriving.style.display = 'block';
    cdLabel.style.display    = 'none';
    return;
  }

  cdNormal.style.display   = 'flex';
  cdArriving.style.display = 'none';
  cdLabel.style.display    = 'block';

  const totalSecs = Math.floor(secs);
  const mins      = Math.floor(totalSecs / 60);
  const secsR     = totalSecs % 60;
  const cents     = Math.floor((secs - totalSecs) * 100);

  document.getElementById('cdMin').textContent   = String(mins).padStart(2, '0');
  document.getElementById('cdSec').textContent   = String(secsR).padStart(2, '0');
  document.getElementById('cdCents').textContent = String(cents).padStart(2, '0');
}

function renderList(buses) {
  const el = document.getElementById('listArea');
  if (!buses.length) {
    el.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px;font-size:13px;">後続バスなし</div>';
    return;
  }
  const labels = ['次便', '次々便', '次々々便'];
  el.innerHTML = buses.slice(0, 3).map((bus, i) => {
    const timeStr = msUntil(bus.eta) <= 0 ? 'まもなく' : `${formatHHMM(bus.eta)}発`;
    const cls = i === 0 ? 'bus-row row-next' : 'bus-row row-later';
    return `
    <div class="${cls}">
      <span class="row-label">${labels[i]}</span>
      <span class="row-type">${bus.destSign || '―'}</span>
      <span class="row-time">${timeStr}</span>
    </div>`;
  }).join('');
}

function renderEmpty() {
  setText('destName', 'データなし');
  setText('trainType', '');
  setText('directionBadge', '―');
  setText('departTime', '');
  setText('cdMin', '--');
  setText('cdSec', '--');
  setText('cdCents', '--');
  setDisplay('cdNormal', 'flex');
  setDisplay('cdArriving', 'none');
  const listArea = document.getElementById('listArea');
  if (listArea) listArea.innerHTML =
    '<div style="text-align:center;color:#bbb;padding:24px;font-size:13px;">この時間帯のバス情報がありません</div>';
}

// ── tick ──────────────────────────────────────────────
function tick() {
  const now = Date.now();
  if (speedMode && lastTickAt !== null) speedOffset += (now - lastTickAt) * 9;
  lastTickAt = now;
  renderAll();
}

// ── 初期化 ────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  lastTickAt = Date.now();
  fetchTimetable();
  fetchTimer = setInterval(fetchTimetable, 30 * 60 * 1000);
  tickTimer  = setInterval(tick, 50);
});
