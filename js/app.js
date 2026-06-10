// ─── Network ─────────────────────────────────────────────
const NETWORKS = {
  testnet: { name: 'Testnet', endpoint: 'https://testnet.toncenter.com/api/v2', explorer: 'https://testnet.tonscan.org' },
  mainnet: { name: 'Mainnet', endpoint: 'https://toncenter.com/api/v2', explorer: 'https://tonscan.org' }
};
const TONCENTER_API_KEY = '9f2d68b9c97f918c6c3f6143d2036610a2dd335ff323109e8e65e9ba48991bb7';

let currentNetwork = 'testnet';
let currentUser = null;
let selectedMeme = null;
let activeTab = 'market';
let tradeDir = 'buy';
let chartTF = '24H';
let tonBalance = 0;
let portfolio = {};
let walletHistory = [];
let firebaseReady = false;
let marketRef = null;
let userRef = null;
let userLoaded = false;
let tradeCount = 0;
let tradeVolume = 0;
const ADMIN_TG_ID = '6809441100';
const TRADE_FEE = 0.05;

// ─── Master Wallet (приёма депозитов и отправки выводов) ─
let masterWallet = null;
let masterKeyPair = null;
let masterAddress = '0QBbz6lrdck00jKezlUKQAn1QzV1uOB1uUs5caKFv-m1zxCM';
let masterBalance = 0;
let depositPollInterval = null;
let lastProcessedLt = '0';

function getToncenterUrl() {
  return currentNetwork === 'testnet'
    ? 'https://testnet.toncenter.com/api/v2'
    : 'https://toncenter.com/api/v2';
}

async function toncenterCall(method, params = {}) {
  if (TONCENTER_API_KEY) params.api_key = TONCENTER_API_KEY;
  const qs = new URLSearchParams(params).toString();
  const url = `${getToncenterUrl()}/${method}${qs ? '?' + qs : ''}`;
  try {
    const res = await fetch(url);
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Master Wallet Init ──────────────────────────────────
async function initMasterWallet() {
    if (!MASTER_MNEMONIC || typeof TonWeb === 'undefined' || typeof TonWeb.mnemonic === 'undefined') {
      if (MASTER_ADDRESS) {
        masterAddress = MASTER_ADDRESS;
        console.log('Master wallet address (from config):', masterAddress);
        startMasterDepositMonitor();
      } else {
        console.log('Master wallet not configured');
      }
      return;
    }
  try {
    const words = MASTER_MNEMONIC.trim().split(/\s+/);
    if (words.length !== 24) { console.warn('Master mnemonic must be 24 words'); return; }

    // Try both derivation methods
    let keyPair = null;
    try {
      keyPair = await TonWeb.mnemonic.mnemonicToKeyPair(words);
    } catch (e) {
      const seed = await TonWeb.mnemonic.mnemonicToSeed(words);
      keyPair = TonWeb.utils.nacl.sign.keyPair.fromSeed(seed);
    }
    masterKeyPair = keyPair;
    const tonweb = new TonWeb();

    const versions = ['v4R2', 'v4R1', 'v3R2', 'v3R1', 'v2', 'v1'];
    const workchains = [0, -1];
    let found = false;
    for (const ver of versions) {
      for (const wc of workchains) {
        const w = tonweb.wallet.create({ publicKey: keyPair.publicKey, walletVersion: ver, workchain: wc });
        const a = await w.getAddress();
        const fmtMain = a.toString(true, true, false);
        const fmtTest = a.toString(true, true, false, true);
        const fmtBounce = a.toString(true, true, true);
        console.log(`Wallet ${ver} wc=${wc}: ${fmtMain} (testnet: ${fmtTest}, bounce: ${fmtBounce})`);
        if (MASTER_ADDRESS) {
          if (fmtMain === MASTER_ADDRESS || fmtTest === MASTER_ADDRESS || fmtBounce === MASTER_ADDRESS) {
            masterWallet = w;
            masterAddress = MASTER_ADDRESS;
            found = true;
            console.log('✓ Match found! Using', ver, 'workchain', wc);
            break;
          }
        } else if (!found) {
          masterWallet = w;
          masterAddress = fmtTest;
          found = true;
        }
      }
      if (found) break;
    }

    if (!found) {
      if (MASTER_ADDRESS) {
        console.log('W5 (or custom) wallet — address:', MASTER_ADDRESS);
        masterAddress = MASTER_ADDRESS;
      } else {
        masterAddress = '';
        masterKeyPair = null;
      }
    }

    startMasterDepositMonitor();
  } catch (e) {
    console.error('Master wallet init error:', e);
  }
}

function startMasterDepositMonitor() {
  if (depositPollInterval) return;
  depositPollInterval = setInterval(checkMasterDeposits, 30000);
}

async function checkMasterDeposits() {
  if (!masterAddress || !firebaseReady) return;
  try {
    const data = await toncenterCall('getTransactions', { address: masterAddress, limit: 20 });
    if (!data.ok || !data.result) return;
    // Normalize master address to raw format for comparison
    let rawMaster = '';
    try { rawMaster = new TonWeb.Address(masterAddress).toRaw().toLowerCase(); } catch (e) { rawMaster = ''; }
    if (!rawMaster) return;

    for (const tx of data.result) {
      const lt = tx.transaction_id?.lt;
      if (!lt || lt <= lastProcessedLt) continue;
      const inMsg = tx.in_msg;
      if (inMsg && inMsg.source && inMsg.source !== '') {
        // Normalize destination address to raw format
        let rawDest = '';
        try { rawDest = new TonWeb.Address(inMsg.destination).toRaw().toLowerCase(); } catch (e) { continue; }
        if (rawDest !== rawMaster) continue;

        const valueNano = parseInt(inMsg.value) || 0;
        if (valueNano > 0) {
          // Extract comment (message body)
          let comment = '';
          if (inMsg.msg_data && inMsg.msg_data['@type'] === 'msg.dataText') {
            try {
              comment = atob(inMsg.msg_data.text || '');
            } catch (e) { comment = ''; }
          }
          if (comment.startsWith('tg_')) {
            const tgId = comment.replace('tg_', '');
            await creditUserDeposit(tgId, valueNano / 1e9, lt);
          }
        }
      }
      if (lt > lastProcessedLt) lastProcessedLt = lt;
    }
  } catch (e) { /* silent */ }
}

async function creditUserDeposit(tgId, amountTon, lt) {
  try {
    const db = firebase.database();
    const ref = db.ref('users/tg_' + tgId);
    const snap = await ref.once('value');
    const data = snap.val() || {};
    const newBalance = (data.balance || 0) + amountTon;
    const history = data.walletHistory || [];
    history.push({ type: 'deposit', amount: amountTon, status: 'done', time: new Date().toLocaleTimeString('ru') });
    await ref.update({ balance: newBalance, walletHistory: history.slice(-20), updatedAt: Date.now() });
    console.log(`Credited tg_${tgId}: +${amountTon} TON (lt:${lt})`);
    // If this user is currently connected, update their balance
    if (currentUser && String(currentUser.id) === tgId) {
      tonBalance = newBalance;
      updateWalletUI();
      if (activeTab === 'wallet') renderWalletTab();
      showToast(`📥 Зачислено ${amountTon.toFixed(4)} TON`);
    }
  } catch (e) { console.error('Credit error:', e); }
}

async function creditAdminFee(amountTon) {
  if (!firebaseReady || amountTon <= 0) return;
  try {
    const db = firebase.database();
    const ref = db.ref('users/tg_' + ADMIN_TG_ID);
    const snap = await ref.once('value');
    const data = snap.val() || {};
    const newBalance = (data.balance || 0) + amountTon;
    await ref.update({ balance: newBalance, updatedAt: Date.now() });
  } catch (e) { console.error('Admin fee credit error:', e); }
}

// ─── Firebase Init ──────────────────────────────────────
function initFirebase() {
  try {
    if (!FIREBASE_CONFIG.apiKey || !FIREBASE_CONFIG.databaseURL) {
      console.warn('Firebase not configured');
      return;
    }
    firebase.initializeApp(FIREBASE_CONFIG);
    const db = firebase.database();
    marketRef = db.ref('market/pepe');

    marketRef.on('value', (snap) => {
      const data = snap.val();
      if (!data) {
        marketRef.set({
          supply: CURVE_INITIAL_SUPPLY,
          maxSupply: 100000,
          price: CURVE_INITIAL_PRICE,
          change: 0,
          holders: 1,
          updatedAt: Date.now()
        });
        return;
      }
      applyMarketData(data);
    });

    firebaseReady = true;
    console.log('Firebase connected');
  } catch (e) {
    console.error('Firebase init error:', e);
    showToast('Firebase not configured');
  }
}

function applyMarketData(data) {
  const m = MEMES[0];
  if (!m) return;
  const changed = m.supply !== data.supply || m.price !== data.price;
  m.supply = data.supply;
  m.maxSupply = data.maxSupply || 100000;
  m.price = data.price;
  m.change = data.change;
  m.holders = data.holders || 1;
  updateDerivedStats(m);

  if (changed) {
    const now = Date.now();
    m.priceHistory.push({ price: m.price, time: now });
    if (m.priceHistory.length > 2000) m.priceHistory.splice(0, m.priceHistory.length - 1000);
  }

  refreshCurrentView();
}

// ─── User Data in Firebase ──────────────────────────────
function loadUserData(tgId) {
  if (!firebaseReady) return;
  const db = firebase.database();
  userRef = db.ref('users/tg_' + tgId);

  userRef.once('value').then(snap => {
    const data = snap.val();
    if (data) {
      portfolio = data.portfolio || {};
      tonBalance = data.balance || 0;
      if (data.walletHistory) walletHistory = data.walletHistory;
    } else {
      portfolio = {};
      tonBalance = 0;
      walletHistory = [];
    }
    userLoaded = true;
    updateWalletUI();
    if (activeTab === 'portfolio') renderPortfolio();
    if (activeTab === 'wallet') renderWalletTab();
  }).catch(() => {
    userLoaded = true;
  });
}

function saveUserData() {
  if (!firebaseReady || !userRef) return;
  userRef.set({
    balance: tonBalance,
    portfolio: portfolio,
    walletHistory: walletHistory.slice(-20),
    updatedAt: Date.now(),
    telegram: currentUser && currentUser.source === 'telegram' ? { id: currentUser.id, name: currentUser.first_name + ' ' + (currentUser.last_name || ''), username: currentUser.username } : { source: 'anonymous' }
  }).catch(() => {});
}

// ─── Auto User Detection ────────────────────────────────
function getOrCreateAnonId() {
  let id = localStorage.getItem('mfm_anon_id');
  if (!id) {
    id = 'anon_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    localStorage.setItem('mfm_anon_id', id);
  }
  return id;
}

function detectUser() {
  try {
    const tg = window.Telegram?.WebApp?.initDataUnsafe;
    if (tg?.user) {
      return {
        source: 'telegram',
        id: String(tg.user.id),
        first_name: tg.user.first_name || '',
        last_name: tg.user.last_name || '',
        username: tg.user.username || ''
      };
    }
  } catch (e) {}
  return {
    source: 'anonymous',
    id: getOrCreateAnonId(),
    first_name: 'Anonymous',
    last_name: '',
    username: null
  };
}

async function ensureUserInFirebase() {
  if (!firebaseReady || !currentUser) return;
  const db = firebase.database();
  const ref = db.ref('users/tg_' + currentUser.id);
  const snap = await ref.once('value');
  if (!snap.exists()) {
    await ref.set({
      balance: 0,
      portfolio: {},
      walletHistory: [],
      createdAt: Date.now(),
      telegram: currentUser.source === 'telegram' ? {
        id: currentUser.id,
        name: (currentUser.first_name + ' ' + currentUser.last_name).trim(),
        username: currentUser.username
      } : null
    });
  }
}

function autoInitUser() {
  currentUser = detectUser();
  document.getElementById('walletAddr').textContent = currentUser.source === 'telegram'
    ? '@' + (currentUser.username || currentUser.first_name)
    : 'Anonymous';
  document.getElementById('walletBalance').style.display = 'inline';
  ensureUserInFirebase().then(() => {
    loadUserData(currentUser.id);
  });
}

// ─── Init App ────────────────────────────────────────────
initMemes();
selectedMeme = MEMES[0].id;
initFirebase();
initMasterWallet();
autoInitUser();

setInterval(tickVisuals, 3000);

function startApp() {
  renderMarket();
}

startApp();

// ─── RENDER: Market ──────────────────────────────────────
function renderMarket() {
  const m = MEMES[0];
  const el = document.getElementById('tab-market');
  el.innerHTML = `
    <div class="section-label">Рынок</div>
    ${renderMemeCard(m, false)}`;
  drawMiniChart(m.id);
}

function renderMemeCard(m, selected) {
  const changeStr = (m.change >= 0 ? '+' : '') + m.change.toFixed(1) + '%';
  const cls = m.change >= 0 ? 'up' : 'down';
  return `
  <div class="meme-card ${selected ? 'selected' : ''}" onclick="selectMeme('${m.id}')">
    <div class="meme-card-top">
      <div class="meme-avatar" style="background:${m.bg}">${m.emoji}</div>
      <div class="meme-meta">
        <div class="meme-name">${m.name} <span class="badge-chip badge-gold">TOP</span></div>
        <div class="meme-ticker">${m.ticker} · ${m.holders} holders</div>
      </div>
      <div class="meme-price-col">
        <div class="meme-price">${m.price.toFixed(4)} <small>TON</small></div>
        <div class="meme-change ${cls}">${changeStr}</div>
      </div>
    </div>
    <div class="mini-chart-wrap">
      <canvas class="mini-chart-canvas" id="mini-${m.id}" width="400" height="40"></canvas>
    </div>
    <div class="meme-stats">
      <div class="stat-item"><div class="stat-val">${m.supply.toLocaleString()}</div><div class="stat-lbl">Supply</div></div>
      <div class="stat-item"><div class="stat-val">${(m.maxSupply - m.supply).toLocaleString()}</div><div class="stat-lbl">Available</div></div>
      <div class="stat-item"><div class="stat-val">${Math.round(m.price * m.supply).toLocaleString()} TON</div><div class="stat-lbl">Market Cap</div></div>
    </div>
    <div class="viral-bar-wrap">
      <span class="viral-label">Virality</span>
      <div class="viral-bar"><div class="viral-fill" style="width:${m.viral}%"></div></div>
      <span class="viral-score">${m.viral}</span>
    </div>
  </div>`;
}

function drawMiniChart(id) {
  const canvas = document.getElementById('mini-' + id);
  if (!canvas) return;
  const m = MEMES.find(x => x.id === id);
  if (!m || !m.priceHistory.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const slice = m.priceHistory.slice(-80);
  if (slice.length < 2) return;
  const max = Math.max(...slice.map(p => p.price));
  const min = Math.min(...slice.map(p => p.price));
  const range = max - min || 1;
  const pad = 2, drawW = w - pad * 2, drawH = h - pad * 2;
  const step = drawW / (slice.length - 1);
  ctx.beginPath();
  slice.forEach((p, i) => {
    const x = pad + i * step;
    const y = pad + drawH - ((p.price - min) / range) * drawH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  const isUp = slice[slice.length - 1].price >= slice[0].price;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, isUp ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)');
  grad.addColorStop(1, isUp ? 'rgba(34,197,94,1)' : 'rgba(239,68,68,1)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ─── Select ──────────────────────────────────────────────
function selectMeme(id) {
  selectedMeme = id;
  tradeDir = 'buy';
  switchTab('trade', document.querySelector('.tab:nth-child(2)'));
}

// ─── RENDER: Trade ───────────────────────────────────────
function renderTradePanel() {
  const container = document.getElementById('tab-trade');
  const m = selectedMeme ? MEMES.find(x => x.id === selectedMeme) : null;
  let detailHtml = '';

  if (m) {
    const pos = portfolio[m.id];
    const pnl = pos ? ((m.price - pos.avgPrice) * pos.tokens) : null;
    const changeStr = (m.change >= 0 ? '+' : '') + m.change.toFixed(1) + '%';
    const changeCls = m.change >= 0 ? 'up' : 'down';

    detailHtml = `
    <div class="detail-panel">
      <div class="detail-header">
        <div class="detail-avatar" style="background:${m.bg}">${m.emoji}</div>
        <div class="detail-info">
          <div class="detail-title">${m.name}</div>
          <div class="detail-subtitle">${m.ticker} · Max ${m.maxSupply.toLocaleString()} PEPE</div>
        </div>
      </div>
      <div class="price-header">
        <span class="price-big" id="detailPrice">${m.price.toFixed(4)}</span>
        <span class="price-unit">TON</span>
        <span class="price-change-large ${changeCls}">${changeStr}</span>
      </div>

      <div class="chart-container">
        <canvas id="mainChart" width="440" height="180" style="height:180px"></canvas>
      </div>
      <div class="chart-timeframes">
        ${['1H','6H','24H','7D','ALL'].map(tf =>
          `<button class="tf-btn ${chartTF === tf ? 'active' : ''}" onclick="setChartTF('${tf}')">${tf}</button>`
        ).join('')}
      </div>

      ${pos && pos.tokens > 0 ? `
      <div class="holding-banner">
        <div>
          <div class="holding-label">Portfolio</div>
          <div class="holding-qty">${pos.tokens.toLocaleString()} ${m.ticker}</div>
        </div>
        <div style="text-align:right">
          <div class="holding-label">PnL</div>
          <div class="holding-pnl ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} TON</div>
        </div>
      </div>` : ''}

      <div class="trade-form">
        <div class="trade-tabs">
          <div class="trade-tab buy ${tradeDir === 'buy' ? 'active' : ''}" onclick="setTradeDir('buy')">Buy</div>
          <div class="trade-tab sell ${tradeDir === 'sell' ? 'active' : ''}" onclick="setTradeDir('sell')">Sell</div>
        </div>
        <div class="amount-input-wrap">
          <div class="amount-label">
            <span>Amount</span>
            <span>Balance: <span style="color:var(--gold)">${tonBalance.toFixed(2)}</span> TON</span>
          </div>
          <input class="amount-input" type="number" id="tradeAmt" value="10" min="1" step="1" oninput="updateTradeInfo()">
        </div>
        <div class="trade-details" id="tradeDetails">
          ${tradeDir === 'buy' ? renderBuyDetails(m, 10) : renderSellDetails(m, 10)}
        </div>
        <button class="btn-action ${tradeDir === 'buy' ? 'btn-buy-action' : 'btn-sell-action'}" id="actionBtn" onclick="executeTrade()">
          ${tradeDir === 'buy' ? 'Buy ' + m.ticker : 'Sell ' + m.ticker}
        </button>
      </div>
    </div>`;
  }

  container.innerHTML = `
    <div class="section-label">Trade</div>
    ${detailHtml}`;

  if (m) drawMainChart(m);
}

function renderBuyDetails(m, amt) {
  if (amt <= 0) amt = 1;
  if (m.supply + amt > m.maxSupply) {
    return `<div class="td-row" style="color:var(--red)"><span class="td-label">Max Supply reached (${m.maxSupply})</span></div>`;
  }
  const cost = buyCost(m.supply, amt);
  const fee = cost * TRADE_FEE;
  const newPrice = bondingPrice(m.supply + amt);
  const effectivePrice = cost / amt;
  const slippage = ((newPrice - m.price) / m.price * 100).toFixed(2);
  return `
    <div class="td-row"><span class="td-label">Current Price</span><span class="td-val">${m.price.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Avg Price</span><span class="td-val">${effectivePrice.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Cost (curve)</span><span class="td-val" style="color:var(--gold)" id="detailCost">${cost.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Fee (5%)</span><span class="td-val" style="color:var(--red)">${fee.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Total</span><span class="td-val" style="color:var(--text)">${(cost + fee + 0.01).toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Price After</span><span class="td-val">${newPrice.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Slippage</span><span class="td-val" style="color:${parseFloat(slippage) > 5 ? 'var(--red)' : 'var(--muted)'}">${slippage}%</span></div>
    <div class="td-row"><span class="td-label">Network</span><span class="td-val">0.01 TON</span></div>`;
}

function renderSellDetails(m, amt) {
  const pos = portfolio[m.id];
  const actualAmt = Math.min(amt, pos ? pos.tokens : 0);
  if (!pos || actualAmt <= 0) {
    return '<div class="td-row" style="color:var(--red)"><span class="td-label">No tokens to sell</span></div>';
  }
  const ret = sellReturn(m.supply, actualAmt);
  const fee = ret * TRADE_FEE;
  const newPrice = bondingPrice(Math.max(m.supply - actualAmt, 1));
  const effectivePrice = ret / actualAmt;
  const slippage = ((m.price - newPrice) / m.price * 100).toFixed(2);
  return `
    <div class="td-row"><span class="td-label">Current Price</span><span class="td-val">${m.price.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Avg Price</span><span class="td-val">${effectivePrice.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">You Receive (curve)</span><span class="td-val" style="color:var(--gold)" id="detailCost">${ret.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Fee (5%)</span><span class="td-val" style="color:var(--red)">-${fee.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Net</span><span class="td-val" style="color:var(--text)">${(ret - fee - 0.01).toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Price After</span><span class="td-val">${newPrice.toFixed(4)} TON</span></div>
    <div class="td-row"><span class="td-label">Slippage</span><span class="td-val">${slippage}%</span></div>
    <div class="td-row"><span class="td-label">Network</span><span class="td-val">0.01 TON</span></div>`;
}

function updateTradeInfo() {
  const m = selectedMeme ? MEMES.find(x => x.id === selectedMeme) : null;
  if (!m) return;
  const amt = parseInt(document.getElementById('tradeAmt')?.value) || 0;
  const el = document.getElementById('tradeDetails');
  if (el) el.innerHTML = tradeDir === 'buy' ? renderBuyDetails(m, amt) : renderSellDetails(m, amt);
}

function setTradeDir(dir) {
  tradeDir = dir;
  document.querySelectorAll('.trade-tab').forEach(el => el.classList.remove('active'));
  const tabs = document.querySelectorAll('.trade-tab');
  if (dir === 'buy' && tabs[0]) tabs[0].classList.add('active');
  else if (dir === 'sell' && tabs[1]) tabs[1].classList.add('active');
  const btn = document.getElementById('actionBtn');
  if (btn) {
    const m = selectedMeme ? MEMES.find(x => x.id === selectedMeme) : null;
    btn.className = `btn-action ${dir === 'buy' ? 'btn-buy-action' : 'btn-sell-action'}`;
    btn.textContent = dir === 'buy' ? 'Buy ' + (m ? m.ticker : '') : 'Sell ' + (m ? m.ticker : '');
  }
  updateTradeInfo();
}

function setChartTF(tf) {
  chartTF = tf;
  document.querySelectorAll('.tf-btn').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tf-btn').forEach(el => {
    if (el.textContent === tf) el.classList.add('active');
  });
  const m = selectedMeme ? MEMES.find(x => x.id === selectedMeme) : null;
  if (m) drawMainChart(m);
}

// ─── Chart ───────────────────────────────────────────────
function drawMainChart(m) {
  const canvas = document.getElementById('mainChart');
  if (!canvas) return;
  const parent = canvas.parentElement;
  const w = parent.offsetWidth || 440;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = 180 * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = '180px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const hist = m.priceHistory;
  let slice;
  switch (chartTF) {
    case '1H': slice = hist.slice(-12); break;
    case '6H': slice = hist.slice(-72); break;
    case '24H': slice = hist.slice(-288); break;
    case '7D': slice = hist; break;
    default: slice = hist;
  }
  if (slice.length < 2) return;

  const pad = { l: 48, r: 12, t: 16, b: 24 };
  const drawW = w - pad.l - pad.r;
  const drawH = 180 - pad.t - pad.b;
  const max = Math.max(...slice.map(p => p.price));
  const min = Math.min(...slice.map(p => p.price));
  const range = max - min || max * 0.1 || 1;
  const paddedMax = max + range * 0.1;
  const paddedMin = Math.max(0, min - range * 0.1);
  const paddedRange = paddedMax - paddedMin || 1;
  const toX = i => pad.l + (i / (slice.length - 1)) * drawW;
  const toY = v => pad.t + drawH - ((v - paddedMin) / paddedRange) * drawH;

  ctx.clearRect(0, 0, w, 180);

  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (i / 3) * drawH;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#555566';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText((paddedMax - (i / 3) * paddedRange).toFixed(4), pad.l - 6, y + 3);
  }
  ctx.fillStyle = '#555566';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor((i / 3) * (slice.length - 1));
    const d = new Date(slice[idx].time);
    ctx.fillText(d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0'), toX(idx), 180 - 6);
  }

  const isUp = slice[slice.length - 1].price >= slice[0].price;
  const lineColor = isUp ? '#22C55E' : '#EF4444';
  ctx.beginPath();
  slice.forEach((p, i) => { const x = toX(i), y = toY(p.price); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.lineTo(toX(slice.length - 1), pad.t + drawH);
  ctx.lineTo(toX(0), pad.t + drawH);
  ctx.closePath();
  const fillGrad = ctx.createLinearGradient(0, pad.t, 0, pad.t + drawH);
  fillGrad.addColorStop(0, isUp ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)');
  fillGrad.addColorStop(1, isUp ? 'rgba(34,197,94,0.01)' : 'rgba(239,68,68,0.01)');
  ctx.fillStyle = fillGrad;
  ctx.fill();
  ctx.beginPath();
  slice.forEach((p, i) => { const x = toX(i), y = toY(p.price); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.strokeStyle = isUp ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.beginPath();
  slice.forEach((p, i) => { const x = toX(i), y = toY(p.price); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  const lx = toX(slice.length - 1), ly = toY(slice[slice.length - 1].price);
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fillStyle = lineColor; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2); ctx.fillStyle = isUp ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)'; ctx.fill();
}

// ─── EXECUTE TRADE ───────────────────────────────────────
function executeTrade() {
  if (!currentUser) { showToast('User not initialized'); return; }
  if (!firebaseReady) { showToast('Firebase not connected'); return; }
  const m = MEMES.find(x => x.id === selectedMeme);
  if (!m) { showToast('Select a token'); return; }
  const amt = parseInt(document.getElementById('tradeAmt')?.value) || 0;
  if (amt <= 0) { showToast('Amount must be > 0'); return; }

  if (tradeDir === 'buy') {
    if (m.supply + amt > m.maxSupply) {
      showToast(`Max Supply (${m.maxSupply}) reached`);
      return;
    }
    const cost = buyCost(m.supply, amt);
    const fee = cost * TRADE_FEE;
    const totalCost = cost + fee + 0.01;
    if (totalCost > tonBalance) {
      showToast(`Insufficient TON. Need: ${totalCost.toFixed(3)}`);
      return;
    }

    marketRef.transaction((current) => {
      if (!current) return current;
      const newSupply = current.supply + amt;
      if (newSupply > current.maxSupply) return;
      const newPrice = bondingPrice(newSupply);
      return {
        ...current,
        supply: newSupply,
        price: newPrice,
        change: parseFloat((current.change + 0.8).toFixed(1)),
        holders: current.holders + (current.holders < 9999 ? 1 : 0),
        updatedAt: Date.now()
      };
    }, (error, committed) => {
      if (error || !committed) { showToast('Transaction failed. Try again'); return; }
      tonBalance -= totalCost;
      creditAdminFee(fee);
      if (!portfolio[m.id]) portfolio[m.id] = { tokens: 0, avgPrice: m.price };
      const old = portfolio[m.id];
      old.avgPrice = (old.avgPrice * old.tokens + cost) / (old.tokens + amt);
      old.tokens += amt;
      tradeCount += 2;
      tradeVolume += amt;
      saveUserData();
      updateWalletUI();
      showToast(`Bought ${amt} ${m.ticker} for ${cost.toFixed(3)} TON`);
    });
  } else {
    const pos = portfolio[m.id];
    if (!pos || pos.tokens < amt) {
      showToast(`Insufficient ${m.ticker}. In portfolio: ${pos ? pos.tokens : 0}`);
      return;
    }
    const ret = sellReturn(m.supply, amt);
    const fee = ret * TRADE_FEE;
    const totalRet = ret - fee - 0.01;

    marketRef.transaction((current) => {
      if (!current) return current;
      const newSupply = current.supply - amt;
      if (newSupply < 1) return;
      const newPrice = bondingPrice(newSupply);
      return {
        ...current,
        supply: newSupply,
        price: newPrice,
        change: parseFloat((current.change - 0.6).toFixed(1)),
        updatedAt: Date.now()
      };
    }, (error, committed) => {
      if (error || !committed) { showToast('Transaction failed. Try again'); return; }
      pos.tokens -= amt;
      tonBalance += totalRet;
      creditAdminFee(fee);
      if (pos.tokens <= 0) delete portfolio[m.id];
      tradeCount += 2;
      tradeVolume += amt;
      saveUserData();
      updateWalletUI();
      showToast(`Sold ${amt} ${m.ticker} for ${ret.toFixed(3)} TON`);
    });
  }
}

// ─── Portfolio ───────────────────────────────────────────
function renderPortfolio() {
  const entries = Object.entries(portfolio).filter(([,v]) => v.tokens > 0);
  const el = document.getElementById('tab-portfolio');
  if (!entries.length) {
    el.innerHTML = `
      <div class="section-label">Portfolio</div>
      <div class="empty-state">
        <div class="emoji">📭</div>
        <div class="title">Portfolio is empty</div>
        <div class="desc">Buy tokens on the Trade tab</div>
      </div>`;
    return;
  }
  const m = MEMES[0];
  let totalVal = 0, totalCost = 0, html = '';
  entries.forEach(([id, pos]) => {
    const val = m.price * pos.tokens;
    const cost = pos.avgPrice * pos.tokens;
    const pnl = val - cost;
    totalVal += val; totalCost += cost;
    const cls = pnl >= 0 ? 'up' : 'down';
    html += `<div class="pos-row">
      <div class="pos-left">
        <div class="pos-avatar" style="background:${m.bg}">${m.emoji}</div>
        <div class="pos-info">
          <div class="pos-ticker">${m.ticker}</div>
          <div class="pos-qty">${pos.tokens.toLocaleString()} · avg ${pos.avgPrice.toFixed(4)} TON</div>
        </div>
      </div>
      <div class="pos-right">
        <div class="pos-value">${val.toFixed(3)} TON</div>
        <div class="pos-pnl ${cls}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} TON</div>
      </div>
    </div>`;
  });
  const totalPnl = totalVal - totalCost;
  const totalCls = totalPnl >= 0 ? 'green' : 'red';
  const pnlPercent = totalCost > 0 ? ((totalPnl / totalCost) * 100) : 0;
  el.innerHTML = `
    <div class="section-label">Portfolio</div>
    <div class="port-summary">
      <div class="port-card">
        <div class="port-label">Value</div>
        <div class="port-value gold">${totalVal.toFixed(2)} TON</div>
        <div class="port-sub">${entries.reduce((s, [id]) => s + (portfolio[id]?.tokens || 0), 0).toLocaleString()} tokens</div>
      </div>
      <div class="port-card">
        <div class="port-label">P&L</div>
        <div class="port-value ${totalCls}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}</div>
        <div class="port-sub ${totalPnl >= 0 ? 'up' : 'down'}">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%</div>
      </div>
    </div>
    <div class="section-label">Positions <span class="badge">${entries.length}</span></div>
    ${html}`;
}

// ─── Wallet ──────────────────────────────────────────────
function updateWalletUI() {
  const balEl = document.getElementById('walletBalance');
  if (balEl) balEl.textContent = tonBalance.toFixed(2) + ' TON';
}

function renderWalletTab() {
  const net = NETWORKS[currentNetwork];
  const el = document.getElementById('tab-wallet');

  const histHtml = walletHistory.length
    ? walletHistory.slice(-10).reverse().map(h => `
      <div class="history-item">
        <span class="hi-type ${h.type}">${h.type === 'deposit' ? 'Deposit' : 'Withdraw'}</span>
        <span class="hi-amount" style="color:${h.type === 'deposit' ? 'var(--green)' : 'var(--red)'}">${h.type === 'deposit' ? '+' : '-'}${h.amount.toFixed(2)} TON</span>
        <span class="hi-status done">Done</span>
        <span class="hi-time">${h.time}</span>
      </div>
    `).join('')
    : '<div style="font-size:11px;color:var(--muted2);text-align:center;padding:12px">No history</div>';

  const userLabel = currentUser && currentUser.source === 'telegram'
    ? `Telegram: ${currentUser.first_name} ${currentUser.last_name || ''}${currentUser.username ? ' (@' + currentUser.username + ')' : ''}`
    : 'Anonymous';
  const userInfo = `<div class="wallet-intro" style="padding:4px 0 8px;font-size:12px;color:var(--muted)">
       ${userLabel}
       <br>Your Comment: <strong style="color:var(--gold);font-family:var(--font-mono)">tg_${currentUser ? currentUser.id : '?'}</strong>
     </div>`;

  el.innerHTML = `
    <div class="section-label">Wallet</div>
    ${userInfo}
    <div class="wallet-intro">
      <div class="big-balance">${tonBalance.toFixed(2)}</div>
      <div class="bal-label">Balance TON</div>
      <div class="bal-usd">≈ $${(tonBalance * 2.45).toFixed(2)} USD</div>
    </div>
    <div class="wallet-cards">
      <button class="wc-btn-card" onclick="toggleWalletCard('deposit')">
        <div class="wc-icon green">📥</div>
        <div><div class="wc-lbl">Deposit</div><div class="wc-sub">Send TON to master wallet</div></div>
      </button>
      <button class="wc-btn-card" onclick="toggleWalletCard('withdraw')">
        <div class="wc-icon red">📤</div>
        <div><div class="wc-lbl">Withdraw</div><div class="wc-sub">Send TON to your wallet</div></div>
      </button>
    </div>
    <div class="wallet-card" id="depositCard">
      <div class="wc-title">📥 Deposit TON</div>
      <div class="wallet-intro" style="padding:8px 0 12px;font-size:12px;color:var(--muted);line-height:1.5">
        Send TON to the <strong>master wallet</strong> address below.<br>
        <strong style="color:var(--gold)">IMPORTANT:</strong> Include your unique comment in the transfer message.
      </div>
      ${currentUser ? `
      <div class="field-label">Your Unique Comment</div>
      <div class="addr-display" style="margin-bottom:10px">
        <span style="color:var(--gold);font-weight:700;font-size:13px">tg_${currentUser.id}</span>
        <button class="copy-btn" onclick="copyText('tg_${currentUser.id}')">Copy</button>
      </div>
      ` : ''}
      <div class="field-label">Master Wallet Address (${net.name})</div>
      <div class="addr-display" style="margin-bottom:12px">
        <span id="masterAddrDisplay">${masterAddress || 'Not configured'}</span>
        ${masterAddress ? `<button class="copy-btn" onclick="copyText('${masterAddress}')">Copy</button>` : ''}
      </div>
      <div style="font-size:10px;color:var(--muted2);text-align:center;margin-top:8px">Auto-credit every 30s. Min deposit: 0.1 TON</div>
    </div>
    <div class="wallet-card" id="withdrawCard">
      <div class="wc-title">📤 Withdraw TON</div>
      <div class="field-group">
        <div class="field-label">Recipient Address</div>
        <input class="field-input" type="text" id="withdrawAddr" placeholder="0:xxxx... or EQ...">
      </div>
      <div class="field-group">
        <div class="field-label">Amount</div>
        <input class="field-input" type="number" id="withdrawAmt" value="5" min="0.1" step="0.1" oninput="updateWithdrawFee()">
      </div>
      <div class="wallet-fee-summary">
        <div class="td-row"><span class="td-label">You send</span><span class="td-val" id="wdSend">5.0000 TON</span></div>
        <div class="td-row"><span class="td-label">Network fee</span><span class="td-val">0.0500 TON</span></div>
        <div class="td-row"><span class="td-label" style="color:var(--red)">Debited</span><span class="td-val" style="color:var(--red)" id="wdTotal">5.0500 TON</span></div>
        <div class="td-row"><span class="td-label" style="color:var(--green)">Recipient gets</span><span class="td-val" style="color:var(--green)" id="wdReceive">4.9500 TON</span></div>
      </div>
      <button class="btn-primary" id="withdrawBtn" onclick="executeWithdraw()" ${!currentUser || (!masterWallet && !masterKeyPair) ? 'disabled' : ''}>
        📤 Confirm Withdraw
      </button>
      <div style="font-size:10px;color:var(--muted2);text-align:center;margin-top:8px">${masterWallet ? 'Signed by master wallet mnemonic' : masterKeyPair ? 'W5 — signed via @ton/ton CDN' : 'W5 withdrawals coming soon'}</div>
    </div>
    <div class="section-label" style="margin-top:12px">Transaction History</div>
    <div class="wallet-card" style="padding:8px 0">${histHtml}</div>
    <div class="footer-link">Explorer: <a href="${net.explorer}" target="_blank">${net.explorer.replace('https://','')}</a></div>`;
}

let activeWalletCard = null;
function toggleWalletCard(card) {
  const dep = document.getElementById('depositCard');
  const wd = document.getElementById('withdrawCard');
  dep.classList.toggle('visible', card === 'deposit' && activeWalletCard !== 'deposit');
  wd.classList.toggle('visible', card === 'withdraw' && activeWalletCard !== 'withdraw');
  activeWalletCard = activeWalletCard === card ? null : card;
}

function updateWithdrawFee() {
  const v = parseFloat(document.getElementById('withdrawAmt')?.value) || 5;
  const s = document.getElementById('wdSend');
  const r = document.getElementById('wdReceive');
  const t = document.getElementById('wdTotal');
  if (s) s.textContent = v.toFixed(4) + ' TON';
  if (r) r.textContent = Math.max(0, v - 0.05).toFixed(4) + ' TON';
  if (t) t.textContent = (v + 0.05).toFixed(4) + ' TON';
}

async function executeWithdraw() {
  if (!currentUser) { showToast('User not initialized'); return; }
  if (!masterAddress) { showToast('Master wallet not configured'); return; }
  if (!masterKeyPair) { showToast('Master key not available'); return; }
  const amt = parseFloat(document.getElementById('withdrawAmt')?.value) || 5;
  const destAddr = document.getElementById('withdrawAddr')?.value?.trim();
  if (!destAddr) { showToast('Enter recipient address'); return; }
  if (amt <= 0) { showToast('Amount must be > 0'); return; }
  const total = amt + 0.05;
  if (total > tonBalance) { showToast(`Insufficient TON. Available: ${tonBalance.toFixed(2)}`); return; }

  const btn = document.getElementById('withdrawBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

  try {
    const amountNano = TonWeb.utils.toNano(String(amt));
    let result;

    if (masterWallet) {
      // v4/v3/v2 wallet via TonWeb
      const seqno = await masterWallet.methods.getSeqno().catch(() => 0);
      const transfer = masterWallet.methods.transfer({
        secretKey: masterKeyPair.secretKey,
        toAddress: destAddr,
        amount: amountNano,
        seqno: seqno,
        payload: '',
        sendMode: 3,
      });
      const bocBytes = await transfer.toBoc();
      const bocBase64 = TonWeb.utils.bytesToBase64(bocBytes);
      result = await toncenterCall('sendBoc', { boc: bocBase64 });
    } else {
      // W5 wallet via @ton/ton CDN
      result = await w5Transfer(destAddr, amt);
    }

    if (result.ok) {
      tonBalance -= total;
      walletHistory.push({
        type: 'withdraw',
        amount: amt,
        status: 'done',
        time: new Date().toLocaleTimeString('ru')
      });
      updateWalletUI();
      saveUserData();
      showToast(`Sent ${amt.toFixed(2)} TON to ${destAddr.slice(0,6)}...${destAddr.slice(-4)}`);
      renderWalletTab();
    } else {
      showToast('Transaction broadcast failed');
    }
  } catch (e) {
    console.error('Withdraw error:', e);
    showToast('Withdrawal error: ' + e.message);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Confirm Withdraw'; }
}

async function w5Transfer(destAddr, amountTon) {
  let tonMod, coreMod;
  try {
    tonMod = await import('https://cdn.jsdelivr.net/npm/@ton/ton@15.3.0/+esm');
    coreMod = await import('https://cdn.jsdelivr.net/npm/@ton/core@0.61.0/+esm');
  } catch (e) {
    console.error('Failed to load TON libraries from CDN', e);
    return { ok: false, error: 'Failed to load TON libraries' };
  }
  const { WalletContractV5R1 } = tonMod;
  const { Address, Cell, toNano } = coreMod;

  const seqnoRes = await toncenterCall('runGetMethod', {
    address: masterAddress, method: 'seqno', stack: []
  });
  let seqno = 0;
  if (seqnoRes.ok && seqnoRes.result && seqnoRes.result.stack && seqnoRes.result.stack.length > 0) {
    const item = seqnoRes.result.stack[0];
    seqno = parseInt(item[1] || item.value || item, 16) || 0;
  }

  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: masterKeyPair.publicKey,
  });

  const destAddress = Address.parse(destAddr);
  const msgRelaxed = {
    info: {
      type: 'internal',
      ihrDisabled: true,
      bounce: false,
      bounced: false,
      src: Address.EMPTY,
      dest: destAddress,
      value: { coins: toNano(String(amountTon)) },
      ihrFee: 0n,
      fwdFee: 0n,
      createdLt: 0n,
      createdAt: 0,
    },
    body: new Cell(),
  };

  const transfer = wallet.createTransfer({
    seqno,
    secretKey: masterKeyPair.secretKey,
    sendMode: 3,
    messages: [{
      type: 'sendMsg',
      mode: 3,
      outMsg: msgRelaxed,
    }],
    timeout: Math.floor(Date.now() / 1000) + 600,
  });

  const bocBytes = transfer.toBoc();
  const bocBase64 = TonWeb.utils.bytesToBase64(new Uint8Array(bocBytes));
  return await toncenterCall('sendBoc', { boc: bocBase64 });
}

// ─── NETWORK ─────────────────────────────────────────────
function toggleNetwork() {
  currentNetwork = currentNetwork === 'testnet' ? 'mainnet' : 'testnet';
  const badge = document.getElementById('networkBadge');
  const dot = document.getElementById('netDot');
  const label = document.getElementById('netLabel');
  if (currentNetwork === 'mainnet') {
    badge.className = 'network-badge net-mainnet';
    dot.className = 'dot dot-main';
    label.textContent = 'Mainnet';
    showToast('Mainnet');
  } else {
    badge.className = 'network-badge net-testnet';
    dot.className = 'dot dot-test';
    label.textContent = 'Testnet';
    showToast('Testnet');
  }
  renderWalletTab();
}

// ─── TAB SWITCHING ───────────────────────────────────────
function switchTab(name, el) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['market','trade','portfolio','wallet'].forEach(t => {
    document.getElementById('tab-' + t).style.display = t === name ? 'block' : 'none';
  });
  switch (name) {
    case 'market': renderMarket(); break;
    case 'trade': renderTradePanel(); break;
    case 'portfolio': renderPortfolio(); break;
    case 'wallet': renderWalletTab(); break;
  }
}

// ─── UTILS ───────────────────────────────────────────────
function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  container.appendChild(toast);
  requestAnimationFrame(() => { setTimeout(() => toast.classList.add('hidden'), 100); });
  setTimeout(() => toast.remove(), 2600);
}

function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
  showToast('Copied: ' + text.slice(0, 20) + '...');
}

function tickVisuals() {
  MEMES.forEach(m => {
    const activity = tradeCount + tradeVolume * 0.5;
    m.viral = Math.min(100, Math.max(10, 20 + activity));
    tradeCount = Math.max(0, tradeCount - 1);
    tradeVolume = Math.max(0, tradeVolume - 0.5);
  });
  if (activeTab === 'market') renderMarket();
}

function refreshCurrentView() {
  if (activeTab === 'market') renderMarket();
  else if (activeTab === 'trade') renderTradePanel();
}

// ─── RESIZE ──────────────────────────────────────────────
window.addEventListener('resize', () => {
  if (activeTab === 'trade') {
    const m = selectedMeme ? MEMES.find(x => x.id === selectedMeme) : null;
    if (m) drawMainChart(m);
  }
});
