/**
 * 都営バス 山吹町 リアルタイム接近情報
 * ODPT API v4
 * トークンは config.js (GitHub Actions が生成) の window.ODPT_CONFIG.accessToken から取得
 */

const BUSSTOP_ID  = 'odpt.Busstop:Toei.Yamabukicho';
const ARRIVAL_URL = 'https://api.odpt.org/api/4.0/odpt:BusPassingInformation';

// ── トークン取得 ──────────────────────────────────────
function getAccessToken() {
  return window.ODPT_CONFIG?.accessToken || '';
}

// ── 状態 ──────────────────────────────────────────────
let currentTab  = 'shinjuku';
let allArrivals = { shinjuku: [], iidabashi: [] };
let tickTimer   = null;
let fetchTimer  = null;
let isDemo      = false;
let speedMode   = false;
let speedOffset = 0;    // ms、10倍速で蓄積
let lastTickAt  = null;

// ── 方面判定 ──────────────────────────────────────────
function classifyDirection(destName) {
  if (!destName) return null;
  if (destName.includes('新宿')) return 'shinjuku';
  if (destName.includes('上野') || destName.includes('早稲田') || destName.includes('九段下')) return 'iidabashi';
  return null;
}

// ── 時刻ユーティリティ ────────────────────────────────
function parseTime(str) {
  if (!str) return null;
  // "HH:MM" or "HH:MM:SS"
  if (/^\d{2}:\d{2}/.test(str)) {
    const [hh, mm, ss] = str.split(':').map(Number);
    const d = new Date();
    d.setHours(hh, mm, ss || 0, 0);
    if (d < Date.now() - 60000) d.setDate(d.getDate() + 1);
    return d;
  }
  return new Date(str);
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

// ── フェッチ ──────────────────────────────────────────
async function fetchArrivals() {
  const token = getAccessToken();
  if (!token) {
    console.warn('ODPT_ACCESS_TOKEN が設定されていません。デモモードで動作します。');
    useDemo();
    return;
  }

  try {
    const url = `${ARRIVAL_URL}?odpt:busstop=${encodeURIComponent(BUSSTOP_ID)}&acl:consumerKey=${encodeURIComponent(token)}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    processData(data);
  } catch (e) {
    console.warn('フェッチ失敗、デモモードにフォールバック:', e.message);
    useDemo();
  }
}

function processData(data) {
  const result = { shinjuku: [], iidabashi: [] };

  for (const item of data) {
    const destName =
      item['odpt:destinationBusstopTitle']?.ja ||
      item['odpt:toStationTitle']?.ja ||
      item['odpt:destinationBusstop'] || '';

    const dir = classifyDirection(destName);
    if (!dir) continue;

    const etaStr =
      item['odpt:estimatedArrivalTime'] ||
      item['odpt:expectedArrivalTime']  ||
      item['odpt:arrivalTime'];

    const eta = parseTime(etaStr);
    if (!eta) continue;
    if (eta.getTime() - Date.now() < -60000) continue; // 1分以上過去はスキップ

    const routeRaw = item['odpt:busroutePattern'] || item['odpt:busRoute'] || '';
    const route = routeRaw.match(/\.([^.]+)$/)?.[1] || routeRaw;

    result[dir].push({ eta, destName, route });
  }

  for (const dir of ['shinjuku', 'iidabashi']) {
    result[dir].sort((a, b) => a.eta - b.eta);
  }

  allArrivals = result;
  isDemo = false;
  document.getElementById('demoLabel').style.display = 'none';
  renderAll();
}

// ── デモデータ ────────────────────────────────────────
function useDemo() {
  isDemo = true;
  document.getElementById('demoLabel').style.display = 'inline';
  resetDemoData();
  renderAll();
}

function resetDemoData() {
  const base = Date.now() + speedOffset;
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
}

// ── タブ ──────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-shinjuku').classList.toggle('active', tab === 'shinjuku');
  document.getElementById('tab-iidabashi').classList.toggle('active', tab === 'iidabashi');
  renderAll();
}

// ── 10倍速 ────────────────────────────────────────────
function toggleSpeed() {
  speedMode = !speedMode;
  const btn = document.getElementById('speedBtn');
  btn.textContent = speedMode ? '10倍速ON' : '10倍速OFF';
  btn.classList.toggle('on', speedMode);
  lastTickAt = Date.now();
}

// ── レンダリング ──────────────────────────────────────
function renderAll() {
  const buses = allArrivals[currentTab];
  if (!buses || buses.length === 0) { renderEmpty(); return; }
  renderNextBus(buses[0]);
  renderList(buses.slice(1));
}

function renderNextBus(bus) {
  const ms   = msUntilEffective(bus.eta);
  const secs = ms / 1000;

  document.getElementById('destName').textContent      = bus.destName || '―';
  document.getElementById('trainType').textContent     = bus.route    || '';
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
  document.getElementById('destName').textContent      = 'データなし';
  document.getElementById('trainType').textContent     = '';
  document.getElementById('directionBadge').textContent = '―';
  document.getElementById('cdMin').textContent         = '--';
  document.getElementById('cdSec').textContent         = '--';
  document.getElementById('cdCents').textContent       = '--';
  document.getElementById('cdNormal').style.display    = 'flex';
  document.getElementById('cdArriving').style.display  = 'none';
  document.getElementById('listArea').innerHTML        =
    '<div style="text-align:center;color:#bbb;padding:24px;font-size:13px;">この方面のバス情報がありません</div>';
}

// ── tick（~20fps） ────────────────────────────────────
function tick() {
  const now = Date.now();
  if (speedMode && lastTickAt !== null) {
    speedOffset += (now - lastTickAt) * 9; // 10倍速
  }
  lastTickAt = now;

  renderAll();

  // デモ：全バス過ぎたらリセット
  if (isDemo) {
    const all = [...(allArrivals.shinjuku || []), ...(allArrivals.iidabashi || [])];
    if (all.every(b => msUntilEffective(b.eta) < -5000)) {
      resetDemoData();
    }
  }
}

// ── 30秒ごと再フェッチ ────────────────────────────────
function scheduleRefetch() {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(async () => {
    await fetchArrivals();
    scheduleRefetch();
  }, 30000);
}

// ── 初期化 ────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  lastTickAt = Date.now();
  fetchArrivals().then(scheduleRefetch);
  tickTimer = setInterval(tick, 50); // ~20fps
});
