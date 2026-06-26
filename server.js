const express   = require('express');
const fetch     = require('node-fetch');
const path      = require('path');
const crypto    = require('crypto');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;

const TN_BASE    = 'https://demo-fapi.binance.com'; // demo.binance.com API
const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const LEVERAGE   = 10;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'bot.html')));

// ── Binance Proxy ─────────────────────────────────────────────
app.all('/api/binance/*', async (req, res) => {
  const bnPath  = req.path.replace('/api/binance', '');
  const bnUrl   = TN_BASE + bnPath;
  const qs      = new URLSearchParams(req.query).toString();
  const fullUrl = qs ? `${bnUrl}?${qs}` : bnUrl;
  try {
    const opts = {
      method: req.method,
      headers: { 'X-MBX-APIKEY': req.headers['x-mbx-apikey'] || API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    };
    if (req.method === 'POST' || req.method === 'PUT')
      opts.body = new URLSearchParams(req.body).toString();
    const r = await fetch(fullUrl, opts);
    const text = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-MBX-APIKEY, Content-Type');
    res.setHeader('Content-Type', 'application/json');
    res.status(r.status).send(text);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.options('/api/binance/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-MBX-APIKEY, Content-Type');
  res.sendStatus(200);
});

// ── Bot API ───────────────────────────────────────────────────
app.get('/bot/klines', async (req, res) => {
  const { symbol, interval } = req.query;
  if (!symbol || !interval) return res.json({ error: 'symbol ve interval gerekli' });
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=200`);
    const data = await r.json();
    res.json(data);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/bot/status', (req, res) => {
  const channelData = {};
  Object.keys(channels).forEach(key => {
    const ch = channels[key];
    channelData[key] = {
      pair: ch.pair, tf: ch.tf,
      lastSignal: ch.lastSignal, lastScore: ch.lastScore,
      cooldown: ch.cooldown, position: ch.position,
      lastPrice: ch.klines.length ? ch.klines[ch.klines.length-1].close : 0,
    };
  });
  res.json({ running: botRunning, apiReady: !!(API_KEY && API_SECRET), balance, totalPnl, tradeCount, wins, tradeLog: tradeLog.slice(0,25), channels: channelData });
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
    await bnRequest('POST', '/fapi/v1/leverage', { symbol: 'ETHUSDT', leverage: LEVERAGE });
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

app.get('/bot/trades', async (req, res) => {
  const pairs = ['BTCUSDT', 'ETHUSDT'];
  const allTrades = [];
  for (const symbol of pairs) {
    const data = await bnRequest('GET', '/fapi/v1/userTrades', { symbol, limit: 10 });
    if (Array.isArray(data)) {
      data.forEach(t => allTrades.push({
        symbol: t.symbol, side: t.side,
        price: parseFloat(t.price).toFixed(2),
        qty: parseFloat(t.qty),
        pnl: parseFloat(t.realizedPnl || 0).toFixed(3),
        time: new Date(t.time).toLocaleString('tr-TR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }),
        ts: t.time,
      }));
    }
  }
  allTrades.sort((a, b) => b.ts - a.ts);
  res.json(allTrades.slice(0, 20));
});

/* ════════════════════════════════════════════════════════════
   TRADING ENGINE
════════════════════════════════════════════════════════════ */
const PAIRS      = ['BTCUSDT', 'ETHUSDT'];
const TIMEFRAMES = ['1m', '3m', '5m'];
const RISK_PCT   = 0.05;   // bakiyenin %5'i risk
const TP_MULT    = 2.0; // 1:2 RR — TP her zaman SL'nin 2 katı
const SL_MULT    = 1.5; // SL = 1.5x ATR
const ATR_PERIOD = 14;

let balance    = 0;   // Binance'den çekilecek
let totalPnl   = 0;
let tradeCount = 0;
let wins       = 0;
let tradeLog   = [];
let botRunning = true;
let openOrderIds = {}; // key → { orderId, tpId, slId }

const channels = {};
PAIRS.forEach(p => TIMEFRAMES.forEach(tf => {
  channels[`${p}_${tf}`] = { pair: p, tf, klines: [], srLevels: [], position: null, lastSignal: 'WAIT', lastScore: 0, ws: null, cooldown: 0 };
}));

// ── İndikatörler ──────────────────────────────────────────────
function calcEMA(arr, period) {
  const k = 2/(period+1); let ema = arr[0]; const out = [ema];
  for (let i = 1; i < arr.length; i++) { ema = arr[i]*k + ema*(1-k); out.push(ema); }
  return out;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period+1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; d>0?g+=d:l+=-d; }
  let ag = g/period, al = l/period;
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag = (ag*(period-1)+(d>0?d:0))/period;
    al = (al*(period-1)+(d<0?-d:0))/period;
  }
  return al===0?100:100-100/(1+ag/al);
}
function calcMACD(closes) {
  if (closes.length < 26) return { hist: 0 };
  const e12 = calcEMA(closes,12), e26 = calcEMA(closes,26);
  const ml = e12.map((v,i)=>v-e26[i]);
  const sl = calcEMA(ml.slice(-9),9);
  return { hist: ml[ml.length-1]-sl[sl.length-1] };
}
function calcATR(klines, period = ATR_PERIOD) {
  if (klines.length < period+1) return klines[klines.length-1].high - klines[klines.length-1].low;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h=klines[i].high, l=klines[i].low, pc=klines[i-1].close;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function calcSRLevels(klines) {
  if (klines.length < 20) return { supports:[], resistances:[] };
  const highs=klines.map(k=>k.high), lows=klines.map(k=>k.low);
  const price=klines[klines.length-1].close;
  const lb=8; let ph=[],pl=[];
  for (let i=lb; i<klines.length-lb; i++) {
    let isH=true,isL=true;
    for (let j=i-lb;j<=i+lb;j++) {
      if(j===i)continue;
      if(highs[j]>=highs[i])isH=false;
      if(lows[j]<=lows[i])isL=false;
    }
    if(isH)ph.push(highs[i]);
    if(isL)pl.push(lows[i]);
  }
  const cluster=(arr,tol)=>{
    arr.sort((a,b)=>a-b);const cls=[];
    for(let v of arr){
      const f=cls.find(c=>Math.abs(c.avg-v)/c.avg<tol);
      if(f){f.vals.push(v);f.avg=f.vals.reduce((a,b)=>a+b,0)/f.vals.length;}
      else cls.push({avg:v,vals:[v]});
    }
    return cls.filter(c=>c.vals.length>=2).map(c=>({level:c.avg,strength:c.vals.length}));
  };
  const tol=0.003;
  return {
    resistances:cluster(ph,tol).filter(c=>c.level>price).sort((a,b)=>a.level-b.level).slice(0,5),
    supports:cluster(pl,tol).filter(c=>c.level<price).sort((a,b)=>b.level-a.level).slice(0,5),
  };
}
function scoreSignal(klines, srLevels) {
  if (klines.length < 30) return { type:'WAIT', score:0, reasons:[] };
  const closes=klines.map(k=>k.close);
  const price=closes[closes.length-1];
  const rsi=calcRSI(closes);
  const {hist}=calcMACD(closes);
  const e9=calcEMA(closes,9),e21=calcEMA(closes,21);
  const v9=e9[e9.length-1],v21=e21[e21.length-1];
  const nearSup=srLevels.filter(s=>s.type==='support'&&Math.abs(price-s.level)/price<0.008);
  const nearRes=srLevels.filter(s=>s.type==='resist'&&Math.abs(price-s.level)/price<0.008);
  let score=0;const reasons=[];
  if(rsi<32){score+=2.5;reasons.push('RSI aşırı satım');}
  else if(rsi<45){score+=1;reasons.push('RSI düşük');}
  else if(rsi>68){score-=2.5;reasons.push('RSI aşırı alım');}
  else if(rsi>55){score-=1;reasons.push('RSI yüksek');}
  if(hist>0){score+=1.5;reasons.push('MACD yukarı');}else{score-=1.5;reasons.push('MACD aşağı');}
  if(v9>v21){score+=1;reasons.push('EMA↑');}else{score-=1;reasons.push('EMA↓');}
  if(nearSup.length){score+=2;reasons.push('Destek');}
  if(nearRes.length){score-=2;reasons.push('Direnç');}
  let type='WAIT';
  if(score>=1.0)type='LONG';
  if(score<=-1.0)type='SHORT';
  return {type,score,rsi,hist,v9,v21,reasons,price};
}

// ── Binance imzalı istek ──────────────────────────────────────
function sign(qs) { return crypto.createHmac('sha256',API_SECRET).update(qs).digest('hex'); }
async function bnRequest(method, endpoint, params={}) {
  if (!API_KEY||!API_SECRET) { console.warn('[Bot] API Key yok'); return null; }
  params.timestamp = Date.now();
  const qs  = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
  const sig  = sign(qs);
  const body = `${qs}&signature=${sig}`;
  const url  = method==='GET' ? `${TN_BASE}${endpoint}?${body}` : `${TN_BASE}${endpoint}`;
  try {
    const r = await fetch(url, {
      method,
      headers:{'X-MBX-APIKEY':API_KEY,'Content-Type':'application/x-www-form-urlencoded'},
      body: method!=='GET'?body:undefined,
    });
    const data = await r.json();
    if (!r.ok) { console.error(`[Binance Hata] ${endpoint}`, JSON.stringify(data)); return null; }
    return data;
  } catch(e) { console.error(`[bnRequest] ${endpoint}`, e.message); return null; }
}

// ── Emir gönder (Binance'e) ───────────────────────────────────
async function sendOrder(ch, sig) {
  if (!API_KEY || !API_SECRET) return;
  const symbol    = ch.pair;
  const side      = sig.type==='LONG'?'BUY':'SELL';
  const closeSide = side==='BUY'?'SELL':'BUY';
  const atr       = calcATR(ch.klines);
  const price     = sig.price;
  const slDist    = atr * SL_MULT;
  const tpDist    = atr * TP_MULT;

  // 1:2 RR sistemi — bakiyenin %10'u risk
  const riskUsd    = balance * 0.10;                        // örn $4200 → $420 risk
  const atr2       = calcATR(ch.klines);
  const slDistPct  = (atr2 * SL_MULT) / price;             // SL mesafesi yüzde olarak
  const notional   = riskUsd / slDistPct;                   // pozisyon büyüklüğü USDT
  const maxNotional = balance * LEVERAGE * 0.8;             // max pozisyon (margin %80)
  const safeNotional = Math.min(notional, maxNotional);
  const rawQty     = safeNotional / price;                  // coin adedi
  const stepSize   = symbol.startsWith('BTC') ? 0.001 : 0.001;
  const qty        = (Math.floor(rawQty / stepSize) * stepSize).toFixed(3);
  console.log(`[Bot] RR Lot: risk=$${riskUsd.toFixed(0)} notional=$${safeNotional.toFixed(0)} qty=${qty} ${symbol}`);
  if (parseFloat(qty) <= 0) { console.warn('[Bot] Lot 0, emir atlandı'); return false; }

  const tickDp = symbol.startsWith('BTC') ? 1 : 2;
  const rt = n => parseFloat(n.toFixed(tickDp)).toFixed(tickDp);
  const tp = rt(sig.type==='LONG' ? price+tpDist : price-tpDist);
  const sl = rt(sig.type==='LONG' ? price-slDist : price+slDist);

  console.log(`[Bot] 📤 ${side} ${qty} ${symbol} @ $${price.toFixed(2)} | TP:${tp} SL:${sl} | Kaldıraç:${LEVERAGE}x`);

  // Kaldıraç ayarla
  await bnRequest('POST', '/fapi/v1/leverage', { symbol, leverage: LEVERAGE });

  // Market emir
  const mkt = await bnRequest('POST', '/fapi/v1/order', { symbol, side, type:'MARKET', quantity:qty });
  if (!mkt) { console.error('[Bot] Market emir başarısız'); return; }
  console.log(`[Bot] ✅ Emir OK! ID:${mkt.orderId}`);

  // TP emri - TAKE_PROFIT_MARKET
  const tpR = await bnRequest('POST', '/fapi/v1/order', {
    symbol, side:closeSide, type:'TAKE_PROFIT_MARKET', stopPrice:tp, closePosition:'true',
  });
  // SL emri - STOP_MARKET
  const slR = await bnRequest('POST', '/fapi/v1/order', {
    symbol, side:closeSide, type:'STOP_MARKET', stopPrice:sl, closePosition:'true',
  });

  // Açık emir ID'lerini sakla (pozisyon kapanınca iptal için)
  const chKey = `${ch.pair}_${ch.tf}`;
  openOrderIds[chKey] = {
    mktId: mkt.orderId,
    tpId: tpR ? tpR.orderId : null,
    slId: slR ? slR.orderId : null,
    symbol,
  };
  if (tpR) console.log(`[Bot] 🎯 TP: $${tp}`);
  if (slR) console.log(`[Bot] 🛡 SL: $${sl}`);
  return true; // başarılı
}

// Açık emirleri iptal et (pozisyon kapanınca)
async function cancelOpenOrders(chKey) {
  const ids = openOrderIds[chKey];
  if (!ids) return;
  const { symbol, tpId, slId } = ids;
  if (tpId) await bnRequest('DELETE', '/fapi/v1/order', { symbol, orderId: tpId });
  if (slId) await bnRequest('DELETE', '/fapi/v1/order', { symbol, orderId: slId });
  delete openOrderIds[chKey];
}

// ── Trading engine ────────────────────────────────────────────
// Binance'deki gerçek açık pozisyon sayısı
let binanceOpenPositions = 0;
function hasAnyOpenPosition() { 
  return binanceOpenPositions > 0 || Object.values(channels).some(c=>c.position); 
}

async function openPosition(ch, sig) {
  console.log(`[Bot] openPosition çağrıldı: ${ch.pair} ${sig.type} balance=$${balance.toFixed(2)}`);
  if (balance <= 0) return;
  const atr     = calcATR(ch.klines);
  const riskUsd = balance * RISK_PCT;
  const price   = sig.price;
  const slDist  = atr * SL_MULT;
  const tpDist  = atr * TP_MULT;
  const qty     = riskUsd / slDist;
  const sl = sig.type==='LONG' ? price-slDist : price+slDist;
  const tp = sig.type==='LONG' ? price+tpDist : price-tpDist;

  // Önce Binance'e gönder, başarılıysa pozisyon kaydet
  const success = await sendOrder(ch, sig);
  if (!success) {
    console.error(`[Bot] ❌ Binance emir başarısız, pozisyon AÇILMADI: ${ch.pair}`);
    return;
  }
  ch.position = { type:sig.type, entry:price, qty, sl, tp, risk:riskUsd, breakeven:false, ts:new Date().toLocaleTimeString('tr-TR') };
  console.log(`[Bot] 🟢 ${ch.pair} ${sig.type} @ $${price.toFixed(2)} | SL:${sl.toFixed(2)} TP:${tp.toFixed(2)}`);
}

async function checkPositionFromBinance() {
  // Binance'deki tüm açık pozisyonları say
  try {
    const all = await bnRequest('GET', '/fapi/v2/positionRisk', {});
    if (Array.isArray(all)) {
      binanceOpenPositions = all.filter(p => parseFloat(p.positionAmt) !== 0).length;
    }
  } catch(e) {}
  for (const key of Object.keys(channels)) {
    const ch = channels[key];
    if (!ch.position) continue;
    try {
      const positions = await bnRequest('GET', '/fapi/v2/positionRisk', {});
      if (!Array.isArray(positions)) continue;
      const openPos = positions.find(p => p.symbol === ch.pair && parseFloat(p.positionAmt) !== 0);
      if (!openPos) {
        // Pozisyon kapanmış (TP veya SL tetiklendi)
        console.log(`[Bot] 🔴 ${ch.pair} pozisyon kapandı (Binance teyidi)`);
        tradeCount++;
        tradeLog.unshift({ pair:ch.pair, tf:ch.tf, type:ch.position.type, entry:ch.position.entry, ts:ch.position.ts });
        if (tradeLog.length > 60) tradeLog.pop();
        const chKey = `${ch.pair}_${ch.tf}`;
        await cancelOpenOrders(chKey);
        ch.position = null; ch.cooldown = 3;
        // Bakiyeyi Binance'den güncelle
        const acc = await bnRequest('GET', '/fapi/v2/account', {});
        if (acc) { const usdt=(acc.assets||[]).find(a=>a.asset==='USDT'); if(usdt) { balance=parseFloat(usdt.walletBalance); console.log(`[Bot] 💰 Güncel bakiye: $${balance.toFixed(2)}`); } }
      } else {
        const upnl = parseFloat(openPos.unRealizedProfit);
        console.log(`[Bot] 📊 ${ch.pair} açık pozisyon | uPnL: ${upnl>=0?'+':''}$${upnl.toFixed(2)}`);
      }
    } catch(e) { console.error('[checkPos]', e.message); }
  }
}


function pickBestAndOpen() {
  console.log(`[Bot] pickBest çalıştı — botRunning:${botRunning} açıkPozisyon:${hasAnyOpenPosition()} balance:$${balance.toFixed(2)}`);
  if (!botRunning || hasAnyOpenPosition()) return;
  let best=null;
  Object.values(channels).forEach(ch => {
    const chKey = `${ch.pair}_${ch.tf}`;
    if (ch.position) { console.log(`[Bot] ${chKey} — pozisyon var, atlandı`); return; }
    if (ch.cooldown>0) { console.log(`[Bot] ${chKey} — cooldown:${ch.cooldown}, atlandı`); return; }
    if (ch.klines.length<30) { console.log(`[Bot] ${chKey} — yetersiz kline:${ch.klines.length}, atlandı`); return; }
    const sig=scoreSignal(ch.klines,ch.srLevels);
    ch.lastSignal=sig.type; ch.lastScore=sig.score;
    console.log(`[Bot] ${chKey} — score:${sig.score.toFixed(2)} signal:${sig.type} RSI:${sig.rsi?.toFixed(1)} reasons:[${sig.reasons?.join(',')}]`);
    if (sig.type==='WAIT') return;
    if (!best||Math.abs(sig.score)>Math.abs(best.sig.score)) best={ch,sig};
  });
  if (best) {
    console.log(`[Bot] 🏆 En iyi sinyal: ${best.ch.pair}_${best.ch.tf} ${best.sig.type} score:${best.sig.score.toFixed(2)}`);
    openPosition(best.ch, best.sig);
  } else {
    console.log(`[Bot] ⏳ Hiçbir kanaldan LONG/SHORT sinyali yok`);
  }
}

// ── Kline & WebSocket ─────────────────────────────────────────
async function fetchKlines(ch) {
  // REST API erişimi yoksa WS'den birikiyor, log bas
  if (ch.klines.length > 0) {
    const {supports,resistances}=calcSRLevels(ch.klines);
    ch.srLevels=[...supports.map(s=>({...s,type:'support'})),...resistances.map(r=>({...r,type:'resist'}))];
    console.log(`[fetchKlines] WS kline: ${ch.pair} ${ch.tf} — ${ch.klines.length} kline`);
    return;
  }
  // REST dene
  const urls = [
    `https://fapi.binance.com/fapi/v1/klines?symbol=${ch.pair}&interval=${ch.tf}&limit=200`,
    `https://api.binance.com/api/v3/klines?symbol=${ch.pair}&interval=${ch.tf}&limit=200`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) continue;
      ch.klines = data.map(k=>({ time:Math.floor(k[0]/1000), open:parseFloat(k[1]), high:parseFloat(k[2]), low:parseFloat(k[3]), close:parseFloat(k[4]), volume:parseFloat(k[5]) }));
      const {supports,resistances}=calcSRLevels(ch.klines);
      ch.srLevels=[...supports.map(s=>({...s,type:'support'})),...resistances.map(r=>({...r,type:'resist'}))];
      console.log(`[fetchKlines] REST OK ${ch.pair} ${ch.tf} — ${ch.klines.length} kline`);
      return;
    } catch(e) {}
  }
  console.warn(`[fetchKlines] ${ch.pair} ${ch.tf} — REST yok, WS birikmesi bekleniyor (${ch.klines.length} kline)`);
}

function connectWS(key) {
  const ch=channels[key];
  if (ch.ws) { try { ch.ws.terminate(); } catch(_) {} }
  const wsUrl = `wss://fstream.binance.com/ws/${ch.pair.toLowerCase()}@kline_${ch.tf}`;
  console.log(`[WS] Bağlanıyor: ${wsUrl}`);
  const ws=new WebSocket(wsUrl);
  ch.ws=ws;
  ws.on('message',(raw)=>{
    try {
      const d=JSON.parse(raw);
      if (!d.k) return;
      const k=d.k;
      const candle={time:Math.floor(k.t/1000),open:parseFloat(k.o),high:parseFloat(k.h),low:parseFloat(k.l),close:parseFloat(k.c),volume:parseFloat(k.v)};
      const last=ch.klines[ch.klines.length-1];
      if (last&&last.time===candle.time) ch.klines[ch.klines.length-1]=candle;
      else { ch.klines.push(candle); if(ch.klines.length>500)ch.klines.shift(); }
      if ([10,30,50,100,200].includes(ch.klines.length)) console.log(`[WS] ${key} kline birikiyor: ${ch.klines.length}`);
      // pozisyon takibi checkPositionFromBinance interval ile yapılıyor
      if (k.x) {
        const {supports,resistances}=calcSRLevels(ch.klines);
        ch.srLevels=[...supports.map(s=>({...s,type:'support'})),...resistances.map(r=>({...r,type:'resist'}))];
        const sig=scoreSignal(ch.klines,ch.srLevels);
        ch.lastSignal=sig.type; ch.lastScore=sig.score;
        if (ch.cooldown>0) ch.cooldown--;
        pickBestAndOpen();
      }
    } catch(e){}
  });
  ws.on('close',()=>setTimeout(()=>connectWS(key),3000));
  ws.on('error',()=>{});
}

// ── Başlat ────────────────────────────────────────────────────
async function startBot() {
  console.log('🤖 Scalp Bot başlatılıyor...');
  if (API_KEY && API_SECRET) {
    console.log('✅ API Key/Secret bulundu — gerçek emirler aktif');
    const acc = await bnRequest('GET', '/fapi/v2/account', {});
    if (acc) {
      const usdt=(acc.assets||[]).find(a=>a.asset==='USDT');
      if (usdt) { balance=parseFloat(usdt.walletBalance); console.log(`💰 Testnet bakiye: $${balance.toFixed(2)} USDT`); }
    }
  } else {
    console.log('⚠️  API Key yok — sinyal modu');
    balance = 1000;
  }
  // REST erişimi yoksa WS'den kline birikir, doğrudan WS başlat
  Object.keys(channels).forEach(key=>connectWS(key));
  console.log('[Bot] WebSocket bağlantıları başlatıldı, kline birikimi başlıyor...');
  setInterval(async ()=>{
    await Promise.all(Object.keys(channels).map(key=>fetchKlines(channels[key])));
    pickBestAndOpen();
  }, 30000);
  // Bakiyeyi her 60sn güncelle
  setInterval(async ()=>{
    if (!API_KEY||!API_SECRET) return;
    const acc=await bnRequest('GET','/fapi/v2/account',{});
    if (acc) { const usdt=(acc.assets||[]).find(a=>a.asset==='USDT'); if(usdt) balance=parseFloat(usdt.walletBalance); }
  }, 60000);
  // Pozisyon takibi — her 10sn Binance'den kontrol et
  setInterval(()=>checkPositionFromBinance(), 10000);
  console.log(`✅ Bot çalışıyor — ${Object.keys(channels).length} kanal | Kaldıraç: ${LEVERAGE}x`);
}

httpServer.listen(PORT, () => { console.log(`🌐 Sunucu: http://localhost:${PORT}`); startBot(); });
