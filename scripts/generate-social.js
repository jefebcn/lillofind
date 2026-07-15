/* ══════════════════════════════════════════════════════════════
   LILLOFIND — Generatore automatico contenuti social
   Eseguito settimanalmente da GitHub Actions (.github/workflows/social-content.yml).
   Legge i prodotti più recenti da Firestore (lettura pubblica), genera 3 storie
   Instagram 1080×1920 + le caption pronte, e le salva in social/<data>/.
   ════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROJECT = 'lillofind-c455c';
const API_KEY = 'AIzaSyAZJ69_Nv-oTEINkhLAxjmPjsOO6QfIFkg'; // chiave web pubblica
const WORKER = 'https://lillofind.conti9708.workers.dev';

function pImg(url) {
  if (!url) return '';
  if (/yupoo\.com|yunjifen\.com/.test(url)) return WORKER + '/proxyImage?url=' + encodeURIComponent(url);
  return url;
}

// Legge un valore tipizzato Firestore REST
function val(f) {
  if (!f) return undefined;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('timestampValue' in f) return f.timestampValue;
  return undefined;
}

async function fetchProducts() {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products?key=${API_KEY}&pageSize=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Firestore list failed: ' + res.status);
  const data = await res.json();
  const docs = (data.documents || []).map(d => {
    const f = d.fields || {};
    return {
      name: val(f.name) || '',
      price: val(f.price) || 0,
      brand: val(f.brand) || '',
      imageUrl: val(f.imageUrl) || '',
      createdAt: val(f.createdAt) || d.createTime || '',
    };
  });
  docs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return docs.filter(p => p.imageUrl && p.name);
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function storyHTML(products) {
  const p0 = products[0] || {};
  const grid = products.slice(0, 4);
  const css = `*{margin:0;padding:0;box-sizing:border-box;font-family:'Helvetica Neue',Arial,sans-serif;}
    .story{width:1080px;height:1920px;position:relative;overflow:hidden;color:#f5f2ec;}
    .disp{font-family:'Arial Black',Impact,sans-serif;font-weight:900;letter-spacing:-2px;}
    .wm{position:absolute;top:70px;left:0;right:0;text-align:center;font-weight:800;letter-spacing:12px;font-size:30px;z-index:3;}
    .foot{position:absolute;bottom:60px;left:0;right:0;text-align:center;font-weight:700;letter-spacing:5px;font-size:26px;z-index:3;}`;
  // Story 1 — Fresh Drops collage
  const s1 = `<div class="story" id="s1" style="background:#161812;">
    <div class="wm">LILLOFIND</div>
    <div style="position:absolute;top:150px;left:0;right:0;text-align:center;z-index:3;">
      <div class="disp" style="font-size:96px;line-height:.9;">FRESH<br><span style="color:#c8ff00;">DROPS</span></div>
      <p style="font-size:34px;color:#c9cbbe;margin-top:20px;">Appena arrivati su LilloFind</p>
    </div>
    <div style="position:absolute;top:520px;left:40px;right:40px;bottom:180px;display:grid;grid-template-columns:1fr 1fr;gap:20px;z-index:2;">
      ${grid.map(p => `<div style="position:relative;border-radius:20px;overflow:hidden;background:#20221b;">
        <img src="${esc(pImg(p.imageUrl))}" style="width:100%;height:100%;object-fit:cover;filter:brightness(.9);" onerror="this.style.display='none'"/>
        <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(0deg,rgba(0,0,0,.85),transparent);padding:24px 20px 18px;">
          <p style="font-size:22px;color:#c8ff00;font-weight:800;letter-spacing:2px;text-transform:uppercase;">${esc(p.brand || '')}</p>
          <p class="disp" style="font-size:46px;color:#fff;">€${Number(p.price || 0).toFixed(0)}</p>
        </div></div>`).join('')}
    </div>
    <div class="foot" style="color:#a9ab9c;">lillofind.shop</div>
  </div>`;
  // Story 2 — hero prodotto
  const s2 = `<div class="story" id="s2" style="background:#0e0f09;">
    <img src="${esc(pImg(p0.imageUrl))}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(.55);" onerror="this.style.display='none'"/>
    <div style="position:absolute;inset:0;background:linear-gradient(0deg,rgba(14,15,9,.95) 20%,rgba(14,15,9,.1) 70%);"></div>
    <div class="wm">LILLOFIND</div>
    <div style="position:absolute;bottom:220px;left:60px;right:60px;z-index:3;">
      <span style="display:inline-block;background:#c8ff00;color:#12140d;font-weight:800;letter-spacing:3px;font-size:26px;padding:12px 28px;border-radius:999px;">NEW IN</span>
      <p style="font-size:24px;color:#c8ff00;font-weight:800;letter-spacing:3px;text-transform:uppercase;margin-top:28px;">${esc(p0.brand || '')}</p>
      <p class="disp" style="font-size:72px;color:#fff;line-height:1;margin-top:8px;">${esc((p0.name || '').slice(0, 40))}</p>
      <p class="disp" style="font-size:100px;color:#fff;margin-top:14px;">€${Number(p0.price || 0).toFixed(0)}</p>
    </div>
    <div class="foot" style="color:#c9cbbe;">Scopri su lillofind.shop →</div>
  </div>`;
  // Story 3 — LFPoints promo (statica)
  const s3 = `<div class="story" id="s3" style="background:linear-gradient(160deg,#26271f,#161812);display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 90px;">
    <div class="wm">LILLOFIND</div>
    <div style="font-size:60px;color:#99a074;">⬡</div>
    <div class="disp" style="font-size:300px;color:#fff;line-height:.82;">+50</div>
    <div style="font-weight:800;letter-spacing:14px;font-size:52px;color:#99a074;">LFPOINTS</div>
    <p style="font-size:60px;font-weight:900;margin-top:40px;">GRATIS ALL'ISCRIZIONE</p>
    <p style="font-size:42px;color:#cfd0c4;margin-top:24px;">= €5 sul primo ordine</p>
    <span style="margin-top:60px;background:#99a074;color:#1a1b15;font-weight:800;letter-spacing:2px;font-size:32px;padding:22px 54px;border-radius:999px;">Iscriviti gratis →</span>
    <div class="foot" style="color:#a9ab9c;">lillofind.shop</div>
  </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${s1}${s2}${s3}</body></html>`;
}

function captions(products) {
  const p0 = products[0] || {};
  return `# Caption pronte — set social LilloFind

## Storia 1 — Fresh Drops
🔥 FRESH DROPS — appena arrivati su LilloFind! Sneakers e streetwear dei migliori brand, foto QC prima della spedizione.
👉 lillofind.shop
#lillofind #freshdrops #sneakers #streetwearitalia #newin #nike #adidas #jordan #sneakerhead #dropnuovi

## Storia 2 — New In (${esc(p0.brand)} ${esc(p0.name)})
🆕 Nuovo arrivo: ${esc(p0.brand)} ${esc(p0.name)} — €${Number(p0.price || 0).toFixed(0)}. Disponibile ora su LilloFind.
👉 lillofind.shop
#lillofind #newin #${(p0.brand || 'streetwear').toLowerCase().replace(/[^a-z0-9]/g, '')} #sneakers #streetwear #outfitinspo #shoponline

## Storia 3 — LFPoints
🎁 +50 LFPOINTS in regalo solo per iscriverti = €5 di sconto sul primo ordine.
👉 lillofind.shop
#lillofind #lfpoints #sconto #streetwear #sneakers #promo #couponitalia
`;
}

(async () => {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const outDir = path.join('social', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  let products = [];
  try { products = await fetchProducts(); } catch (e) { console.error('Fetch prodotti fallito:', e.message); }
  if (!products.length) { console.log('Nessun prodotto: genero comunque la storia LFPoints.'); }

  const html = storyHTML(products);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.setContent(html, { waitUntil: 'load' });
  // aspetta il caricamento delle immagini proxied
  await page.waitForTimeout(3500);
  for (const id of ['s1', 's2', 's3']) {
    const el = await page.$('#' + id);
    if (el) await el.screenshot({ path: path.join(outDir, 'story-' + id + '.jpg'), type: 'jpeg', quality: 88 });
  }
  await browser.close();

  fs.writeFileSync(path.join(outDir, 'captions.md'), captions(products));
  console.log('Contenuti social generati in', outDir);
})().catch(e => { console.error(e); process.exit(1); });
