const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const crypto   = require('crypto');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── API Key'leri Railway env'den al ─────────────────────────
const TN_BASE  = 'https://testnet.binancefuture.com';
const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Ana sayfa ────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'bot.html')));

// ── Binance Proxy ────────────────────────────────────────────
app.all('/api/binance/*', async (req, res) => {
  const bnPath  = req.path.replace('/api/binance', '');
  const bnUrl   = TN_BASE + bnPath;
  const qs      = new URLSearchParams(req.query).toString();
  const fullUrl = qs ? `${bnUrl}?${qs}` : bnUrl;
  try {
    const opts = {
      method: req.method,
      headers: {
        'X-MBX-APIKEY': req.headers['x-mbx-apikey'] || API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };
    if (req.method === 'POST' || req.method === 'PUT')
      opts.body = new URLSearchParams(req.body).toString();
    const r    = await fetch(fullUrl, opts);
    const text = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-MBX-APIKEY, Content-Type');
    res.setHeader('Content-Type', 'application/json');
    res.status(r.status).send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.options('/api/binance/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-MBX-APIKEY, Content-Type');
  res.sendStatus(200);
});

// ── Bot durumu — dashboard'a veri ver ───────────────────────
app.get('/bot/status', (req, res) => {
  const channelData = {};
  Object.keys(channels).forEach(key => {
    const ch = channels[key];
    channelData[key] = {
      pair: ch.pair, tf: ch.tf,
      lastSignal: ch.lastSignal,
      lastScore: ch.lastScore,
      cooldown: ch.cooldown,
      position: ch.position,
      lastPrice: ch.klines.length ? ch.klines[ch.klines.length-1].close : 0,
    };
  });
  res.json({
    running: botRunning,
    apiReady: !!(API_KEY && API_SECRET),
    balance, totalPnl, tradeCount, wins,
    tradeLog: tradeLog.slice(0, 25),
    channels: channelData,
  });
});
app.post('/bot/toggle', (req, res) => {
  botRunning = !botRunning;
  console.log(`[Bot] ${botRunning ? 'BAŞLATILDI' : 'DURDURULDU'}`);
  res.json({ running: botRunning });
});

app.post('/bot/test', async (req, res) => {
  try {
    const pr = await fetch(`${TN_BASE}/fapi/v1/ticker/price?symbol=ETHUSDT`);
    const pd = await pr.json();
    const price = parseFloat(pd.price);
    await bnRequest('POST', '/fapi/v1/leverage', { symbol: 'ETHUSDT', leverage: 10 });
    const mkt = await bnRequest('POST', '/fapi/v1/order', { symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', quantity: '0.02' });
    if (!mkt) return res.json({ success: false, error: 'Emir gönderilemedi' });
    const tp = (price * 1.01).toFixed(2);
    const sl = (price * 0.995).toFixed(2);
    await bnRequest('POST', '/fapi/v1/order', { symbol: 'ETHUSDT', side: 'SELL', type: 'LIMIT', price: tp, quantity: '0.02', timeInForce: 'GTC', reduceOnly: 'true' });
    await bnRequest('POST', '/fapi/v1/order', { symbol: 'ETHUSDT', side: 'SELL', type: 'LIMIT', price: sl, quantity: '0.02', timeInForce: 'GTC', reduceOnly: 'true' });
    res.json({ success: true, msg: `ETHUSDT BUY @ $${price.toFixed(2)} | ID: ${mkt.orderId}` });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/bot/positions', async (req, res) => {
  const data = await bnRequest('GET', '/fapi/v2/positionRisk', {});
  if (!data) return res.json({ error: 'Pozisyon alınamadı' });
  res.json(data);
});

/* ════════════════════════════════════════════════════════════
   TRADING ENGINE — tüm mantık sunucuda
════════════════════════════════════════════════════════════ */
const PAIRS      = ['BTCUSDT', 'ETHUSDT'];
const TIMEFRAMES = ['1m', '3m', '5m'];
const RISK_PCT   = 0.10;
const TP_MULT    = 2.0;
const SL_MULT    = 1.0;
const ATR_PERIOD = 14;
const INITIAL_BALANCE = 1000; // Testnet bakiyene göre ayarla

let balance   = INITIAL_BALANCE;
let totalPnl  = 0;
let tradeCount = 0;
let wins      = 0;
let tradeLog  = [];
let botRunning = true;

const channels = {};
PAIRS.forEach(p => TIMEFRAMES.forEach(tf => {
  channels[`${p}_${tf}`] = {
    pair: p, tf, klines: [], srLevels: [],
    position: null, lastSignal: 'WAIT', lastScore: 0,
    ws: null, cooldown: 0,
  };
}));

// ── İndikatörler ─────────────────────────────────────────────
function calcEMA(arr, period) {
  const k = 2 / (period + 1); let ema = arr[0]; const out = [ema];
  for (let i = 1; i < arr.length; i++) { ema = arr[i] * k + ema * (1 - k); out.push(ema); }
  return out;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; d > 0 ? g += d : l += -d; }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + (d > 0 ? d : 0)) / period;
    al = (al * (period-1) + (d < 0 ? -d : 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function calcMACD(closes) {
  if (closes.length < 26) return { hist: 0 };
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  const ml = e12.map((v, i) => v - e26[i]);
  const sl = calcEMA(ml.slice(-9), 9);
  return { hist: ml[ml.length-1] - sl[sl.length-1] };
}
function calcATR(klines, period = ATR_PERIOD) {
  if (klines.length < period + 1) return klines[klines.length-1].high - klines[klines.length-1].low;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function calcSRLevels(klines) {
  if (klines.length < 20) return { supports: [], resistances: [] };
  const highs = klines.map(k => k.high), lows = klines.map(k => k.low);
  const price = klines[klines.length-1].close;
  const lb = 8; let ph = [], pl = [];
  for (let i = lb; i < klines.length - lb; i++) {
    let isH = true, isL = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isH = false;
      if (lows[j] <= lows[i]) isL = false;
    }
    if (isH) ph.push(highs[i]);
    if (isL) pl.push(lows[i]);
  }
  const cluster = (arr, tol) => {
    arr.sort((a, b) => a - b); const cls = [];
    for (let v of arr) {
      const f = cls.find(c => Math.abs(c.avg - v) / c.avg < tol);
      if (f) { f.vals.push(v); f.avg = f.vals.reduce((a,b)=>a+b,0)/f.vals.length; }
      else cls.push({ avg: v, vals: [v] });
    }
    return cls.filter(c => c.vals.length >= 2).map(c => ({ level: c.avg, strength: c.vals.length }));
  };
  const tol = 0.003;
  return {
    resistances: cluster(ph, tol).filter(c => c.level > price).sort((a,b) => a.level - b.level).slice(0,5),
    supports: cluster(pl, tol).filter(c => c.level < price).sort((a,b) => b.level - a.level).slice(0,5),
  };
}
function scoreSignal(klines, srLevels) {
  if (klines.length < 30) return { type: 'WAIT', score: 0, reasons: [] };
  const closes = klines.map(k => k.close);
  const price  = closes[closes.length-1];
  const rsi    = calcRSI(closes);
  const { hist } = calcMACD(closes);
  const e9 = calcEMA(closes, 9), e21 = calcEMA(closes, 21);
  const v9 = e9[e9.length-1], v21 = e21[e21.length-1];
  const nearSup = srLevels.filter(s => s.type==='support' && Math.abs(price-s.level)/price < 0.008);
  const nearRes = srLevels.filter(s => s.type==='resist'  && Math.abs(price-s.level)/price < 0.008);
  let score = 0; const reasons = [];
  if (rsi < 32)       { score += 2.5; reasons.push('RSI aşırı satım'); }
  else if (rsi < 45)  { score += 1;   reasons.push('RSI düşük'); }
  else if (rsi > 68)  { score -= 2.5; reasons.push('RSI aşırı alım'); }
  else if (rsi > 55)  { score -= 1;   reasons.push('RSI yüksek'); }
  if (hist > 0)       { score += 1.5; reasons.push('MACD yukarı'); }
  else                { score -= 1.5; reasons.push('MACD aşağı'); }
  if (v9 > v21)       { score += 1;   reasons.push('EMA↑'); }
  else                { score -= 1;   reasons.push('EMA↓'); }
  if (nearSup.length) { score += 2;   reasons.push('Destek'); }
  if (nearRes.length) { score -= 2;   reasons.push('Direnç'); }
  let type = 'WAIT';
  if (score >= 1.5)  type = 'LONG';
  if (score <= -1.5) type = 'SHORT';
  return { type, score, rsi, hist, v9, v21, reasons, price };
}

// ── Binance imzalı istek ─────────────────────────────────────
function sign(queryStr) {
  return crypto.createHmac('sha256', API_SECRET).update(queryStr).digest('hex');
}
async function bnRequest(method, endpoint, params = {}) {
  if (!API_KEY || !API_SECRET) {
    console.warn('[Bot] API Key/Secret yok — emir atlaındı');
    return null;
  }
  params.timestamp = Date.now();
  const qs  = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const sig  = sign(qs);
  const body = `${qs}&signature=${sig}`;
  const url  = method === 'GET'
    ? `${TN_BASE}${endpoint}?${body}`
    : `${TN_BASE}${endpoint}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method !== 'GET' ? body : undefined,
    });
    const data = await r.json();
    if (!r.ok) { console.error(`[Binance Hata] ${endpoint}`, data); return null; }
    return data;
  } catch(e) {
    console.error(`[bnRequest Hata] ${endpoint}`, e.message);
    return null;
  }
}

// ── Emir gönder ──────────────────────────────────────────────
async function sendOrder(ch, sig) {
  const symbol    = ch.pair;
  const side      = sig.type === 'LONG' ? 'BUY' : 'SELL';
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
  const atr       = calcATR(ch.klines);
  const price     = sig.price;
  const slDist    = atr * SL_MULT;
  const tpDist    = atr * TP_MULT;
  const riskUsd   = balance * RISK_PCT;
  const rawQty    = riskUsd / slDist;
  const minQty    = Math.max(rawQty, 20 / price);
  const qty       = Math.max(0.001, minQty).toFixed(3);
  const tickDp    = symbol.startsWith('BTC') ? 1 : 2;
  const rt        = n => parseFloat(n.toFixed(tickDp)).toFixed(tickDp);
  const tp = rt(sig.type === 'LONG' ? price + tpDist : price - tpDist);
  const sl = rt(sig.type === 'LONG' ? price - slDist : price + slDist);

  console.log(`[Bot] 📤 ${side} ${qty} ${symbol} @ $${price.toFixed(2)} TP:${tp} SL:${sl}`);
  await bnRequest('POST', '/fapi/v1/leverage', { symbol, leverage: 10 });
  const mkt = await bnRequest('POST', '/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty });
  if (!mkt) return;
  console.log(`[Bot] ✅ Emir OK! ID:${mkt.orderId}`);
  await bnRequest('POST', '/fapi/v1/order', { symbol, side: closeSide, type: 'LIMIT', price: tp, quantity: qty, timeInForce: 'GTC', reduceOnly: 'true' });
  await bnRequest('POST', '/fapi/v1/order', { symbol, side: closeSide, type: 'LIMIT', price: sl, quantity: qty, timeInForce: 'GTC', reduceOnly: 'true' });
}

// ── Pozisyon aç ──────────────────────────────────────────────
function hasAnyOpenPosition() {
  return Object.values(channels).some(c => c.position);
}
function openPosition(ch, sig) {
  if (balance <= 0) return;
  const atr     = calcATR(ch.klines);
  const riskUsd = balance * RISK_PCT;
  const price   = sig.price;
  const slDist  = atr * SL_MULT;
  const tpDist  = atr * TP_MULT;
  const qty     = riskUsd / slDist;
  const sl = sig.type === 'LONG' ? price - slDist : price + slDist;
  const tp = sig.type === 'LONG' ? price + tpDist : price - tpDist;
  ch.position = { type: sig.type, entry: price, qty, sl, tp, risk: riskUsd, breakeven: false, ts: new Date().toLocaleTimeString('tr-TR') };
  console.log(`[Bot] 🟢 Pozisyon açıldı: ${ch.pair} ${sig.type} @ $${price.toFixed(2)}`);
  sendOrder(ch, sig);
}

// ── Pozisyon kontrol ─────────────────────────────────────────
function checkPosition(ch, currentPrice) {
  if (!ch.position) return;
  const pos = ch.position;
  let closed = false, pnl = 0, exitPrice = currentPrice;
  if (!pos.breakeven) {
    const beReached = pos.type === 'LONG'
      ? currentPrice >= pos.entry + (pos.tp - pos.entry) * 0.5
      : currentPrice <= pos.entry - (pos.entry - pos.tp) * 0.5;
    if (beReached) { pos.sl = pos.entry; pos.breakeven = true; }
  }
  if (pos.type === 'LONG') {
    if (currentPrice >= pos.tp)      { pnl = pos.risk * TP_MULT; exitPrice = pos.tp; closed = true; }
    else if (currentPrice <= pos.sl) { pnl = pos.breakeven ? 0 : -pos.risk; exitPrice = pos.sl; closed = true; }
  } else {
    if (currentPrice <= pos.tp)      { pnl = pos.risk * TP_MULT; exitPrice = pos.tp; closed = true; }
    else if (currentPrice >= pos.sl) { pnl = pos.breakeven ? 0 : -pos.risk; exitPrice = pos.sl; closed = true; }
  }
  if (closed) {
    balance = Math.max(0, balance + pnl);
    totalPnl += pnl; tradeCount++; if (pnl > 0) wins++;
    tradeLog.unshift({ pair: ch.pair, tf: ch.tf, type: pos.type, entry: pos.entry, exit: exitPrice, pnl, ts: pos.ts, be: pos.breakeven || false });
    if (tradeLog.length > 60) tradeLog.pop();
    ch.position = null; ch.cooldown = 3;
    console.log(`[Bot] 🔴 Pozisyon kapandı: ${ch.pair} PnL: ${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  }
}

// ── En iyi sinyali seç ve aç ─────────────────────────────────
function pickBestAndOpen() {
  if (!botRunning || hasAnyOpenPosition()) return;
  let best = null;
  Object.values(channels).forEach(ch => {
    if (ch.position || ch.cooldown > 0 || ch.klines.length < 30) return;
    const sig = scoreSignal(ch.klines, ch.srLevels);
    ch.lastSignal = sig.type; ch.lastScore = sig.score;
    if (sig.type === 'WAIT') return;
    if (!best || Math.abs(sig.score) > Math.abs(best.sig.score)) best = { ch, sig };
  });
  if (best) openPosition(best.ch, best.sig);
}

// ── Kline çek ───────────────────────────────────────────────
async function fetchKlines(ch) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${ch.pair}&interval=${ch.tf}&limit=200`);
    const data = await r.json();
    if (!Array.isArray(data)) return;
    ch.klines = data.map(k => ({
      time: Math.floor(k[0]/1000),
      open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
    const { supports, resistances } = calcSRLevels(ch.klines);
    ch.srLevels = [
      ...supports.map(s => ({ ...s, type: 'support' })),
      ...resistances.map(r => ({ ...r, type: 'resist' })),
    ];
  } catch(e) { console.error(`[fetchKlines] ${ch.pair} ${ch.tf}`, e.message); }
}

// ── WebSocket bağlantısı ─────────────────────────────────────
function connectWS(key) {
  const ch = channels[key];
  if (ch.ws) { try { ch.ws.terminate(); } catch(_) {} }
  const stream = `${ch.pair.toLowerCase()}@kline_${ch.tf}`;
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
  ch.ws = ws;
  ws.on('message', (raw) => {
    try {
      const d = JSON.parse(raw);
      if (!d.k) return;
      const k = d.k;
      const candle = {
        time: Math.floor(k.t/1000), open: parseFloat(k.o),
        high: parseFloat(k.h), low: parseFloat(k.l),
        close: parseFloat(k.c), volume: parseFloat(k.v),
      };
      const last = ch.klines[ch.klines.length-1];
      if (last && last.time === candle.time) ch.klines[ch.klines.length-1] = candle;
      else { ch.klines.push(candle); if (ch.klines.length > 500) ch.klines.shift(); }
      checkPosition(ch, candle.close);
      if (k.x) { // mum kapandı
        const { supports, resistances } = calcSRLevels(ch.klines);
        ch.srLevels = [
          ...supports.map(s => ({ ...s, type: 'support' })),
          ...resistances.map(r => ({ ...r, type: 'resist' })),
        ];
        const sig = scoreSignal(ch.klines, ch.srLevels);
        ch.lastSignal = sig.type; ch.lastScore = sig.score;
        if (ch.cooldown > 0) ch.cooldown--;
        pickBestAndOpen();
      }
    } catch(e) {}
  });
  ws.on('close', () => setTimeout(() => connectWS(key), 3000));
  ws.on('error', () => {});
}

// ── Başlat ──────────────────────────────────────────────────
async function startBot() {
  console.log('🤖 Scalp Bot sunucusu başlatılıyor...');
  if (API_KEY && API_SECRET) {
    console.log('✅ API Key/Secret bulundu — gerçek emirler aktif');
    const acc = await bnRequest('GET', '/fapi/v2/account', {});
    if (acc) {
      const usdt = (acc.assets || []).find(a => a.asset === 'USDT');
      if (usdt) {
        balance = parseFloat(usdt.walletBalance);
        console.log(`💰 Testnet bakiye: $${balance.toFixed(2)} USDT`);
      }
    }
  } else {
    console.log('⚠️  API Key/Secret yok — sadece sinyal modu (emir gönderilmez)');
  }
  await Promise.all(Object.keys(channels).map(key => fetchKlines(channels[key])));
  Object.keys(channels).forEach(key => connectWS(key));
  // Her 30 saniyede SR seviyeleri yenile
  setInterval(async () => {
    await Promise.all(Object.keys(channels).map(key => fetchKlines(channels[key])));
    pickBestAndOpen();
  }, 30000);
  console.log(`✅ Bot çalışıyor — ${Object.keys(channels).length} kanal aktif`);
}

app.listen(PORT, () => {
  console.log(`🌐 Sunucu: http://localhost:${PORT}`);
  startBot();
});

// Binance bakiye
app.get('/bot/bnbalance', async (req, res) => {
  const acc = await bnRequest('GET', '/fapi/v2/account', {});
  if (!acc) return res.json({ error: 'Bakiye alınamadı' });
  const usdt = (acc.assets || []).find(a => a.asset === 'USDT');
  res.json({
    wallet: usdt ? parseFloat(usdt.walletBalance).toFixed(2) : '0',
    unrealized: usdt ? parseFloat(usdt.unrealizedProfit).toFixed(2) : '0',
    available: usdt ? parseFloat(usdt.availableBalance || usdt.walletBalance).toFixed(2) : '0',
  });
});

// Gerçek işlem geçmişi
app.get('/bot/trades', async (req, res) => {
  const pairs = ['BTCUSDT', 'ETHUSDT'];
  const allTrades = [];
  for (const symbol of pairs) {
    const data = await bnRequest('GET', '/fapi/v1/userTrades', { symbol, limit: 10 });
    if (Array.isArray(data)) {
      data.forEach(t => allTrades.push({
        symbol: t.symbol,
        side: t.side,
        price: parseFloat(t.price).toFixed(2),
        qty: parseFloat(t.qty),
        pnl: parseFloat(t.realizedPnl || 0).toFixed(3),
        time: new Date(t.time).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }),
        ts: t.time,
      }));
    }
  }
  allTrades.sort((a, b) => b.ts - a.ts);
  res.json(allTrades.slice(0, 20));
});
