/**
 * 都営バス 山吹町 リアルタイム接近情報
 * Cloudflare Worker プロキシ経由で ODPT API から時刻表を取得
 */

const PROXY_URL = 'https://odpt-proxy.takahara-design.workers.dev';

// ── 状態 ──────────────────────────────────────────────
let currentTab  = 'shinjuku';
let allArrivals = { shinjuku: [], iidabashi: [] };
let tickTimer   = null;
let fetchTimer  = null;
let speedMode   = false;
let speedOffset = 0;
let lastTickAt  = null;

// ── 方面判定 ──────────────────────────────────────────
function classifyDirection(destName) {
  if (!destName) return null;
  if (destName.includes('新宿')) return 'shinjuku';
  if (destName.includes('上野') || destName.includes('早稲田') || destName.includes('九段下')) return 'iidabashi';
  return null;
}

// ── 曜日判定 ──────────────────────────────────────────
function getTodayCalendar() {
  const day = new Date().getDay();
  if (day === 0) return 'Sunday';
  if (day === 6) return 'Saturday';
  return 'Weekday';
}

// ── 時刻文字列 → 今日のDateオブジェクト ──────────────
function timeStrToDate(hhmm) {
  if (!hhmm) return null;
  const [hRaw, mm] = hhmm.split(':').map(Number);
  const h = hRaw >= 24 ? hRaw - 24 : hRaw;
  const dayOffset = hRaw >= 24 ? 1 : 0;
  const d = new Date();
  d.setHours(h, mm, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d;
}

function formatHHMM(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function getEffectiveNow() {
  return Date.now() + speedOffset;
}

function msUntilEffective(d) {
  return d.getTime() - getEffectiveNow();
}

// ── API フェッチ ──────────────────────────────────────
async function fetchTimetable() {
  try {
    const res = await fetch(PROXY_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    processTimetable(data);
  } catch (e) {
    console.warn('フェッチ失敗、デモモードにフォールバック:', e.message);
    useDemo();
  }
}

function processTimetable(timetables) {
  const calendar = getTodayCalendar();
  const now      = getEffectiveNow();
  const result   = { shinjuku: [], iidabashi: [] };

  for (const tt of timetables) {
    // カレンダーフィルタ
    const cal = tt['odpt:calendar'] || '';
    if (cal && !cal.includes(calendar) && !cal.includes('Holiday')) continue;

    const destName =
      tt['odpt:destinationBusstopPoleTitle']?.ja ||
      tt['odpt:destinationBusstopTitle']?.ja ||
      tt['odpt:destinationBusstop'] || '';

    const dir = classifyDirection(destName);
    if (!dir) continue;

    const route =
      (tt['odpt:busroutePattern'] || tt['odpt:busRoute'] || '').match(/\.([^.]+)$/)?.[1] || '';

    const busTimes = tt['odpt:busstopPoleTimetableObject'] || [];
    for (const obj of busTimes) {
      const timeStr = obj['odpt:departureTime'] || obj['odpt:arrivalTime'];
      const eta = timeStrToDate(timeStr);
      if (!eta) continue;
      if (eta.getTime() < now - 60000) continue;

      result[dir].push({ eta, destName, route });
    }
  }

  for (const dir of ['shinjuku', 'iidabashi']) {
    result[dir].sort((a, b) => a.eta - b.eta);
    result[dir] = result[dir].slice(0, 10);
  }

  const total = result.shinjuku.length + result.iidabashi.length;
  if (total === 0) {
    console.warn('該当データなし。デモモードにフォールバック。');
    useDemo();
    return;
  }

  allArrivals = result;
  document.getElementById('demoLabel').style.display = 'none';
  renderAll();
}

// ── デモデータ ────────────────────────────────────────
function useDemo() {
  document.getElementById('demoLabel').style.display = 'inline';
  const base = getEffectiveNow();
  allArrivals = {
    shinjuku: [
      { eta: new Date(base + 4*60000 + 44000), destName: '新宿駅西口', route: '早77' },
      { eta: new Date(base + 12*60000),         destName: '新宿駅西口', route: '飯62' },
      { eta: new Date(base + 21*60000),         destName: '新宿駅西口', route: '早77' },
    ],
    iidabashi: [
      { eta: new Date(base + 7*60000 + 15000), destName: '九段下',   route: '飯62' },
      { eta: new Date(base + 17*60000),         destName: '上野公園', route: '上58' },
      { eta: new Date(base + 28*60000),         destName: '早稲田',   route: '早77' },
    ]
  };
  renderAll();
}

// ── タブ ──────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-shinjuku').classList.toggle('active', tab === 'shinjuku');
  document.getElementById('tab-iidabashi').classList.toggle('active', tab === 'iidabashi');
  renderAll();
}

// ── レンダリング ──────────────────────────────────────
function renderAll() {
  const now = getEffectiveNow();
  for (const dir of ['shinjuku', 'iidabashi']) {
    allArrivals[dir] = (allArrivals[dir] || []).filter(b => b.eta.getTime() > now - 60000);
  }

  const buses = allArrivals[currentTab];
  if (!buses || buses.length === 0) { renderEmpty(); return; }
  renderNextBus(buses[0]);
  renderList(buses.slice(1));
}

function renderNextBus(bus) {
  const ms   = msUntilEffective(bus.eta);
  const secs = ms / 1000;

  document.getElementById('destName').textContent       = bus.destName || '―';
  document.getElementById('trainType').textContent      = bus.route    || '';
  document.getElementById('directionBadge').textContent = bus.destName || '―';

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
  if (buses.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:#bbb;padding:20px;font-size:13px;">後続バスなし</div>';
    return;
  }
  const labels = ['次便', '次々便', '次々々便'];
  el.innerHTML = buses.slice(0, 3).map((bus, i) => {
    const timeStr = msUntilEffective(bus.eta) <= 0 ? 'まもなく' : `${formatHHMM(bus.eta)}発`;
    const cls = i === 0 ? 'bus-row row-next' : 'bus-row row-later';
    return `
    <div class="${cls}">
      <span class="row-label">${labels[i] || ''}</span>
      <span class="row-type">${bus.route || '―'}</span>
      <span class="row-time">${timeStr}</span>
    </div>`;
  }).join('');
}

function renderEmpty() {
  document.getElementById('destName').textContent       = 'データなし';
  document.getElementById('trainType').textContent      = '';
  document.getElementById('directionBadge').textContent = '―';
  document.getElementById('cdMin').textContent          = '--';
  document.getElementById('cdSec').textContent          = '--';
  document.getElementById('cdCents').textContent        = '--';
  document.getElementById('cdNormal').style.display     = 'flex';
  document.getElementById('cdArriving').style.display   = 'none';
  document.getElementById('listArea').innerHTML         =
    '<div style="text-align:center;color:#bbb;padding:24px;font-size:13px;">この方面のバス情報がありません</div>';
}

// ── tick（~20fps） ────────────────────────────────────
function tick() {
  const now = Date.now();
  if (speedMode && lastTickAt !== null) {
    speedOffset += (now - lastTickAt) * 9;
  }
  lastTickAt = now;
  renderAll();
}

// ── 30分おきに再フェッチ ──────────────────────────────
function scheduleRefetch() {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(async () => {
    await fetchTimetable();
    scheduleRefetch();
  }, 30 * 60 * 1000); // 時刻表は30分おきで十分
}

// ── 初期化 ────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  lastTickAt = Date.now();
  fetchTimetable().then(scheduleRefetch);
  tickTimer = setInterval(tick, 50);
});
