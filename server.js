const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const app     = express();

const PORT     = process.env.PORT || 3000;
const TN_BASE  = 'https://testnet.binancefuture.com';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Ana sayfa: botu sun ──────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'bot.html'));
});

// ── Binance Proxy: /api/binance/* → testnet.binancefuture.com ──
app.all('/api/binance/*', async (req, res) => {
  // /api/binance/fapi/v1/order → /fapi/v1/order
  const bnPath = req.path.replace('/api/binance', '');
  const bnUrl  = TN_BASE + bnPath;

  // Query string'i aktar
  const qs = new URLSearchParams(req.query).toString();
  const fullUrl = qs ? `${bnUrl}?${qs}` : bnUrl;

  try {
    const opts = {
      method:  req.method,
      headers: {
        'X-MBX-APIKEY': req.headers['x-mbx-apikey'] || '',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };

    if (req.method === 'POST' || req.method === 'PUT') {
      // Body'yi form-encoded olarak ilet
      const body = new URLSearchParams(req.body).toString();
      opts.body  = body;
    }

    const r    = await fetch(fullUrl, opts);
    const text = await r.text();

    // CORS header ekle (tarayıcıdan erişim için)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-MBX-APIKEY, Content-Type');
    res.setHeader('Content-Type', 'application/json');
    res.status(r.status).send(text);

  } catch (e) {
    console.error('[Proxy Hata]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// CORS preflight
app.options('/api/binance/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-MBX-APIKEY, Content-Type');
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Scalp Bot sunucusu çalışıyor: http://localhost:${PORT}`);
});
