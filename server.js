const express   = require('express');
const fetch     = require('node-fetch');
const path      = require('path');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;

const META_TOKEN      = process.env.META_API_TOKEN      || '';
const META_ACCOUNT_ID = process.env.META_API_ACCOUNT_ID || '';
const META_API_BASE   = 'https://mt-client-api-v1.london.agiliumtrade.ai';

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'bot.html')));

// ── MetaApi isteği ──────────────────────────────────────────────────────────
async function mtRequest(method, endpoint, body = null) {
  try {
    const opts = {
      method,
      headers: { 'auth-token': META_TOKEN, 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(`${META_API_BASE}${endpoint}`, opts);
    const data = await r.json();
    if (data.error || data.message) {
      console.error(`[MT] HATA ${endpoint}:`, data.message || data.error);
      return null;
    }
    return data;
  } catch(e) { console.error('[MT] fetch hatası:', e.message); return null; }
}

// ── Bakiye ──────────────────────────────────────────────────────────────────
let balance = 0;
async function updateBalance() {
  const info = await mtRequest('GET', `/users/current/accounts/${META_ACCOUNT_ID}/account-information`);
  if (info && info.balance !== undefined) {
    balance = info.balance;
    console.log(`💰 Bakiye: $${balance.toFixed(2)}`);
  }
}

// ── Emir gönder ─────────────────────────────────────────────────────────────
async function sendOrder(symbol, type, lots, sl, tp) {
  const side = type === 'LONG' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
  const body = {
    actionType: side,
    symbol,
    volume: lots,
    stopLoss: sl,
    takeProfit: tp,
    comment: 'ScalpBot',
  };
  console.log(`[Bot] 📤 ${type} ${lots} ${symbol} | SL:${sl} TP:${tp}`);
  const r = await mtRequest('POST', `/users/current/accounts/${META_ACCOUNT_ID}/trade`, body);
  if (r && (r.orderId || r.positionId)) {
    console.log(`[Bot] ✅ Emir OK! ID:${r.orderId || r.positionId}`);
    return r.orderId || r.positionId;
  }
  console.error('[Bot] ❌ Emir başarısız');
  return null;
}

// ── Pozisyon kapat ──────────────────────────────────────────────────────────
async function closePosition(positionId) {
  const r = await mtRequest('POST', `/users/current/accounts/${META_ACCOUNT_ID}/trade`, {
    actionType: 'POSITION_CLOSE_ID',
    positionId,
  });
  return r;
}

// ── Açık pozisyonları al ────────────────────────────────────────────────────
async function getPositions() {
  const r = await mtRequest('GET', `/users/current/accounts/${META_ACCOUNT_ID}/positions`);
  return Array.isArray(r) ? r : [];
}

// ── Kline verisi ─────────────────────────────────────────────────────────────
app.get('/bot/klines', async (req, res) => {
  const { symbol, interval } = req.query;
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=200`);
    const data = await r.json();
    res.json(data);
  } catch(e) { res.json({ error: e.message }); }
});

// ── Sinyal kanalları ─────────────────────────────────────────────────────────
const PAIRS      = ['BTCUSDT', 'ETHUSDT'];
const TIMEFRAMES = ['1m', '3m', '5m'];
const RISK_PCT   = 0.10;   // bakiyenin %10'u risk
const TP_MULT    = 2.0;    // 1:2 RR
const SL_MULT    = 1.5;
const ATR_PERIOD = 14;

// MT5 sembol adları
const MT5_SYMBOL = { BTCUSDT: 'BTCUSDm', ETHUSDT: 'ETHUSDm' };

let botRunning  = false;
let totalPnl    = 0;
let tradeCount  = 0;
let wins        = 0;
let tradeLog    = [];

const channels  = {};
PAIRS.forEach(pair => TIMEFRAMES.forEach(tf => {
  channels[`${pair}_${tf}`] = { pair, tf, klines: [], srLevels: [], position: null, cooldown: 0, lastSignal: 'WAIT', lastScore: 0 };
}));

// ── ATR ──────────────────────────────────────────────────────────────────────
function calcATR(klines, period = ATR_PERIOD) {
  if (klines.length < period + 1) return klines[klines.length-1]?.high - klines[klines.length-1]?.low || 1;
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i-1].close;
    sum += Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
  }
  return sum / period;
}

// ── S/R seviyeleri ───────────────────────────────────────────────────────────
function calcSRLevels(klines) {
  if (klines.length < 20) return { supports: [], resistances: [] };
  const lb = 5;
  const supports = [], resistances = [];
  const price = klines[klines.length-1].close;
  for (let i = lb; i < klines.length - lb; i++) {
    const isLow  = klines.slice(i-lb,i+lb+1).every(k => k.low  >= klines[i].low);
    const isHigh = klines.slice(i-lb,i+lb+1).every(k => k.high <= klines[i].high);
    if (isLow  && Math.abs(klines[i].low  - price) / price < 0.05) supports.push({ price: klines[i].low,  strength: 1 });
    if (isHigh && Math.abs(klines[i].high - price) / price < 0.05) resistances.push({ price: klines[i].high, strength: 1 });
  }
  return { supports: supports.slice(-3), resistances: resistances.slice(-3) };
}

// ── Sinyal skoru ─────────────────────────────────────────────────────────────
function scoreSignal(klines, srLevels) {
  if (klines.length < 30) return { type: 'WAIT', score: 0, reasons: [], price: 0 };
  const closes = klines.map(k => k.close);
  const price  = closes[closes.length-1];

  // RSI
  let gains = 0, losses = 0;
  for (let i = closes.length-14; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    d > 0 ? gains += d : losses -= d;
  }
  const rs  = gains / (losses || 1);
  const rsi = 100 - 100 / (1 + rs);

  // MACD
  const ema = (arr, p) => arr.slice(-p*3).reduce((s,v,i,a) => i===0?v:s*(1-2/(p+1))+v*2/(p+1), 0);
  const hist = ema(closes, 12) - ema(closes, 26);

  // EMA 9/21
  const v9  = ema(closes, 9);
  const v21 = ema(closes, 21);

  // S/R yakınlık
  const nearSup = srLevels.filter(s => s.type==='support'    && Math.abs(s.price-price)/price < 0.005).length > 0;
  const nearRes = srLevels.filter(s => s.type==='resist'     && Math.abs(s.price-price)/price < 0.005).length > 0;

  let score = 0;
  const reasons = [];

  if (rsi > 60)  { score += 1.0; reasons.push('RSI yüksek'); }
  if (rsi < 40)  { score -= 1.0; reasons.push('RSI düşük'); }
  if (rsi > 70)  { score -= 0.5; reasons.push('RSI aşırı alım'); }
  if (rsi < 30)  { score += 0.5; reasons.push('RSI aşırı satım'); }
  if (hist > 0)  { score += 1.5; reasons.push('MACD yukarı'); }
  if (hist < 0)  { score -= 1.5; reasons.push('MACD aşağı'); }
  if (v9 > v21)  { score += 1.0; reasons.push('EMA↑'); }
  if (v9 < v21)  { score -= 1.0; reasons.push('EMA↓'); }
  if (nearSup)   { score += 0.5; reasons.push('Destek'); }
  if (nearRes)   { score -= 0.5; reasons.push('Direnç'); }

  let type = 'WAIT';
  if (score >= 1.0)  type = 'LONG';
  if (score <= -1.0) type = 'SHORT';
  return { type, score, rsi, hist, v9, v21, reasons, price };
}

// ── fetchKlines ───────────────────────────────────────────────────────────────
async function fetchKlines(ch) {
  const urls = [
    `https://fapi.binance.com/fapi/v1/klines?symbol=${ch.pair}&interval=${ch.tf}&limit=200`,
    `https://api.binance.com/api/v3/klines?symbol=${ch.pair}&interval=${ch.tf}&limit=200`,
  ];
  for (const url of urls) {
    try {
      const r    = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) continue;
      ch.klines = data.map(k => ({ time: Math.floor(k[0]/1000), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
      const { supports, resistances } = calcSRLevels(ch.klines);
      ch.srLevels = [...supports.map(s => ({...s, type:'support'})), ...resistances.map(r => ({...r, type:'resist'}))];
      console.log(`[fetchKlines] ✅ ${ch.pair} ${ch.tf} — ${ch.klines.length} kline`);
      return;
    } catch(e) { console.error(`[fetchKlines] HATA ${ch.pair} ${ch.tf}:`, e.message); }
  }
}

// ── WebSocket (Binance fiyat akışı) ──────────────────────────────────────────
function connectWS(key) {
  const ch  = channels[key];
  const ws  = new WebSocket(`wss://fstream.binance.com/ws/${ch.pair.toLowerCase()}@kline_${ch.tf}`);
  ch.ws = ws;
  ws.on('message', d => {
    const k = JSON.parse(d).k;
    if (!k) return;
    const candle = { time: Math.floor(k.t/1000), open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v) };
    const last   = ch.klines[ch.klines.length-1];
    if (last && last.time === candle.time) ch.klines[ch.klines.length-1] = candle;
    else { ch.klines.push(candle); if (ch.klines.length > 500) ch.klines.shift(); }
    if (k.x) {
      const sig = scoreSignal(ch.klines, ch.srLevels);
      ch.lastSignal = sig.type; ch.lastScore = sig.score;
      const { supports, resistances } = calcSRLevels(ch.klines);
      ch.srLevels = [...supports.map(s => ({...s, type:'support'})), ...resistances.map(r => ({...r, type:'resist'}))];
      if (ch.cooldown > 0) ch.cooldown--;
    }
  });
  ws.on('close', () => setTimeout(() => connectWS(key), 3000));
  ws.on('error', () => ws.close());
}

// ── Pozisyon aç ──────────────────────────────────────────────────────────────
async function openPosition(ch, sig) {
  if (balance <= 0) return;
  const atr    = calcATR(ch.klines);
  const price  = sig.price;
  const slDist = atr * SL_MULT;
  const tpDist = atr * TP_MULT;
  const sl     = sig.type === 'LONG' ? price - slDist : price + slDist;
  const tp     = sig.type === 'LONG' ? price + tpDist : price - tpDist;

  // Lot hesabı: 1:2 RR
  const riskUsd = balance * RISK_PCT;
  const slPct   = slDist / price;
  const notional = Math.min(riskUsd / slPct, balance * 5);
  const lots     = parseFloat((notional / price).toFixed(2));

  console.log(`[Bot] 🟢 ${ch.pair} ${sig.type} @ $${price.toFixed(2)} | SL:${sl.toFixed(2)} TP:${tp.toFixed(2)} lots:${lots}`);

  const mt5Symbol = MT5_SYMBOL[ch.pair] || ch.pair;
  const orderId   = await sendOrder(mt5Symbol, sig.type, lots, parseFloat(sl.toFixed(2)), parseFloat(tp.toFixed(2)));

  if (orderId) {
    ch.position = { type: sig.type, entry: price, qty: lots, sl, tp, risk: riskUsd, orderId, ts: new Date().toLocaleTimeString('tr-TR') };
  }
}

// ── En iyi sinyali seç ve pozisyon aç ───────────────────────────────────────
let hasOpenPos = false;

async function pickBestAndOpen() {
  if (!botRunning || hasOpenPos) return;
  let best = null;
  Object.values(channels).forEach(ch => {
    if (ch.position || ch.cooldown > 0 || ch.klines.length < 30) return;
    const sig = scoreSignal(ch.klines, ch.srLevels);
    ch.lastSignal = sig.type; ch.lastScore = sig.score;
    if (sig.type === 'WAIT') return;
    if (!best || Math.abs(sig.score) > Math.abs(best.sig.score)) best = { ch, sig };
  });
  if (best) {
    console.log(`[Bot] 🏆 ${best.ch.pair}_${best.ch.tf} ${best.sig.type} score:${best.sig.score.toFixed(2)}`);
    hasOpenPos = true;
    await openPosition(best.ch, best.sig);
  }
}

// ── MT5 pozisyon takibi ───────────────────────────────────────────────────────
async function checkMT5Positions() {
  const positions = await getPositions();
  hasOpenPos = positions.length > 0;

  Object.keys(channels).forEach(key => {
    const ch = channels[key];
    if (!ch.position) return;
    const mt5sym = MT5_SYMBOL[ch.pair] || ch.pair;
    const open   = positions.find(p => p.symbol === mt5sym);
    if (!open) {
      console.log(`[Bot] 🔴 ${ch.pair} pozisyon kapandı`);
      tradeCount++; ch.cooldown = 3; ch.position = null;
    } else {
      ch.position._pnl = open.unrealizedProfit;
    }
  });

  await updateBalance();
}

// ── Endpoint'ler ──────────────────────────────────────────────────────────────
app.get('/bot/status', (req, res) => {
  const chData = {};
  Object.keys(channels).forEach(key => {
    const ch = channels[key];
    chData[key] = { pair: ch.pair, tf: ch.tf, lastSignal: ch.lastSignal, lastScore: ch.lastScore, cooldown: ch.cooldown, position: ch.position,
      srLevels: ch.srLevels.slice(-6), klineCount: ch.klines.length };
  });
  res.json({ botRunning, balance, totalPnl, tradeCount, wins, tradeLog: tradeLog.slice(0,30), channels: chData });
});

app.get('/bot/positions', async (req, res) => {
  const p = await getPositions();
  res.json(p);
});

app.post('/bot/start',  (req, res) => { botRunning = true;  res.json({ ok: true }); });
app.post('/bot/stop',   (req, res) => { botRunning = false; res.json({ ok: true }); });

app.post('/bot/test', async (req, res) => {
  const info = await mtRequest('GET', `/users/current/accounts/${META_ACCOUNT_ID}/account-information`);
  if (info) res.json({ ok: true, balance: info.balance, broker: info.broker, server: info.server });
  else res.json({ ok: false, error: 'Bağlantı başarısız' });
});

// ── Bot başlat ────────────────────────────────────────────────────────────────
async function startBot() {
  console.log('🤖 Scalp Bot (MT5/MetaApi) başlatılıyor...');
  if (!META_TOKEN || !META_ACCOUNT_ID) {
    console.warn('⚠️ META_API_TOKEN veya META_API_ACCOUNT_ID eksik!');
  } else {
    await updateBalance();
    console.log(`✅ MetaApi bağlantısı hazır | Bakiye: $${balance.toFixed(2)}`);
    botRunning = true;
  }

  await Promise.all(Object.keys(channels).map(key => fetchKlines(channels[key])));
  Object.keys(channels).forEach(key => connectWS(key));

  setInterval(() => pickBestAndOpen(), 30000);
  setInterval(() => checkMT5Positions(), 10000);
  setInterval(() => updateBalance(), 60000);

  console.log(`✅ Bot çalışıyor — 6 kanal`);
}

app.listen(PORT, () => { console.log(`🌐 Sunucu: http://localhost:${PORT}`); startBot(); });
