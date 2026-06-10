// ─── 🔥 Firebase Configuration ──────────────────────────
// 1. Зайди на https://console.firebase.google.com
// 2. Создай проект → Add project
// 3. Realtime Database → Create Database → Start in test mode
// 4. Project Settings → Web App → Скопируй config сюда:

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCIjm_PiSp2mUDH5rfjuDT-oDgFq7Am8gc",
  authDomain: "pixelsgift.firebaseapp.com",
  databaseURL: "https://pixelsgift-default-rtdb.firebaseio.com",
  projectId: "pixelsgift",
  storageBucket: "pixelsgift.firebasestorage.app",
  messagingSenderId: "96389364670",
  appId: "1:96389364670:web:01f1ae122205fe25fed7ef",
  measurementId: "G-HZ4T6WBRN9"
};

// ─── 🤖 Telegram Bot ─────────────────────────────────────
// 1. Создай бота через @BotFather в Telegram
// 2. Получи username бота и токен
// 3. В BotFather → Bot Settings → Domain → укажи домен своего сайта
const TELEGRAM_BOT_USERNAME = 'MememTradingRobot';

// ─── 💰 Master Wallet ────────────────────────────────────
// Мнемоника для подписи выводов (24 слова).
// Адрес кошелька, на который пользователи отправляют TON с комментарием = tg_{ID}.
// Если MASTER_ADDRESS не задан — берётся из мнемоники.
const MASTER_MNEMONIC = 'cherry end awful cousin burden excite matrix twist practice egg pattern march wait until weather wink coconut over flee task report catch display fruit';
const MASTER_ADDRESS = '0QBbz6lrdck00jKezlUKQAn1QzV1uOB1uUs5caKFv-m1zxCM';

// ─── Bonding Curve ────────────────────────────────────────
// price = K * supply ^ EXPONENT
const CURVE_EXPONENT = 1.8;
const CURVE_INITIAL_SUPPLY = 100;
const CURVE_INITIAL_PRICE = 0.01;
const CURVE_K = CURVE_INITIAL_PRICE / Math.pow(CURVE_INITIAL_SUPPLY, CURVE_EXPONENT);

function bondingPrice(supply) {
  return CURVE_K * Math.pow(Math.max(supply, 1), CURVE_EXPONENT);
}

function buyCost(supply, amount) {
  const n = CURVE_EXPONENT, k = CURVE_K;
  const s2 = supply + amount;
  return k * (Math.pow(s2, n + 1) - Math.pow(supply, n + 1)) / (n + 1);
}

function sellReturn(supply, amount) {
  const n = CURVE_EXPONENT, k = CURVE_K;
  const s2 = supply - amount;
  if (s2 <= 0) return 0;
  return k * (Math.pow(supply, n + 1) - Math.pow(s2, n + 1)) / (n + 1);
}

// ─── Meme Token ──────────────────────────────────────────
const MEMES = [];

function initMemes() {
  MEMES.push({
    id: 'pepe',
    emoji: '🐸',
    name: 'Pepe Classic',
    ticker: '$PEPC',
    bg: '#1a2e1a',
    color: '#22C55E',
    supply: CURVE_INITIAL_SUPPLY,
    maxSupply: 100000,
    price: CURVE_INITIAL_PRICE,
    change: 0,
    viral: 72,
    vol: 0,
    holders: 1,
    trades: [],
    priceHistory: [],
  });
}

function updateDerivedStats(m) {
  m.vol = Math.round(m.price * m.supply * 0.1);
  m.change = parseFloat(m.change.toFixed(1));
}

// ─── User Identity ───────────────────────────────────────
function generateUserId() {
  const id = 'user_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const short = id.slice(-8);
  return {
    id,
    addr: '0x' + short,
    label: 'Trader ' + short.toUpperCase(),
    emoji: ['🧑‍💻', '👨‍💼', '👩‍💻', '🦊', '🐯', '🐲'][Math.floor(Math.random() * 6)],
  };
}
