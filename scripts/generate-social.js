/* ══════════════════════════════════════════════════════════════
   LILLOFIND — Generatore automatico contenuti social (stile brand)
   Eseguito settimanalmente da GitHub Actions (social-content.yml).
   Legge i prodotti più recenti da Firestore (lettura pubblica), scarica
   le FOTO REALI via il Worker proxy e genera 3 storie Instagram
   1080×1920 nello stile del brand (bianco/nero + giallo, logo, icone
   outline) + le caption pronte, in social/<data>/.
   ════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROJECT = 'lillofind-c455c';
const API_KEY = process.env.FIREBASE_API_KEY || ''; // secret del workflow
const WORKER = 'https://lillofind.conti9708.workers.dev';

// Logo ufficiale (PNG trasparente) → base64 per l'embedding
let LOGO_B64 = '';
try { LOGO_B64 = fs.readFileSync(path.join('assets', 'logo-mark.png')).toString('base64'); } catch (_) {}

function pImg(url) {
  if (!url) return '';
  if (/yupoo\.com|yunjifen\.com/.test(url)) return WORKER + '/proxyImage?url=' + encodeURIComponent(url);
  return url;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function val(f) {
  if (!f) return undefined;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  if ('timestampValue' in f) return f.timestampValue;
  return undefined;
}
async function fetchProducts() {
  if (!API_KEY) { console.warn('FIREBASE_API_KEY non impostata: niente foto prodotto.'); return []; }
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products?key=${API_KEY}&pageSize=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Firestore list failed: ' + res.status);
  const data = await res.json();
  const docs = (data.documents || []).map(d => {
    const f = d.fields || {};
    return { name: val(f.name) || '', brand: val(f.brand) || '', price: val(f.price) || 0, img: val(f.imageUrl) || '', created: val(f.createdAt) || d.createTime || '' };
  });
  docs.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
  return docs.filter(p => p.img && p.name);
}

// ── Stili condivisi (stile brand) ─────────────────────────────
const CSS = `
  *{margin:0;padding:0;box-sizing:border-box;}
  :root{--paper:#f1efe9;--ink:#141310;--yellow:#f5cf00;}
  .s{width:1080px;height:1920px;position:relative;overflow:hidden;font-family:'Helvetica Neue',Arial,sans-serif;}
  .grain{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
  .paper{background:var(--paper);color:var(--ink);} .paper .grain{opacity:.05;mix-blend-mode:multiply;}
  .ink{background:var(--ink);color:var(--paper);} .ink .grain{opacity:.07;mix-blend-mode:screen;}
  .logo-img{height:66px;width:auto;display:block;}
  .ink .logo-img{filter:invert(1);}
  .top{position:absolute;top:66px;left:78px;right:78px;display:flex;justify-content:space-between;align-items:center;z-index:6;}
  .tag{font-size:22px;font-weight:700;letter-spacing:5px;text-transform:uppercase;opacity:.8;}
  .bottom{position:absolute;bottom:64px;left:78px;right:78px;display:flex;justify-content:space-between;align-items:center;font-size:23px;letter-spacing:1px;font-weight:600;z-index:6;}
  .mono{font-family:'Courier New',monospace;letter-spacing:1px;}
  .block{position:absolute;left:78px;right:78px;z-index:5;}
  .kick{font-size:26px;letter-spacing:7px;font-weight:800;text-transform:uppercase;}
  .cond{display:inline-block;font-weight:800;text-transform:uppercase;letter-spacing:-2px;line-height:.9;transform:scaleX(.8);transform-origin:left;}
  .h{font-size:176px;} .h.sm{font-size:148px;}
  .sub{font-size:38px;line-height:1.4;font-weight:500;max-width:840px;}
  .hl{background:var(--yellow);color:var(--ink);padding:0 10px;}
  .tri{position:absolute;width:0;height:0;z-index:2;}
  .tri.tl{top:0;left:0;border-top:150px solid var(--yellow);border-right:150px solid transparent;}
  .tri.br{bottom:0;right:0;border-bottom:190px solid var(--yellow);border-left:190px solid transparent;}
  .cards{position:absolute;left:78px;right:78px;display:grid;grid-template-columns:1fr 1fr;gap:20px;z-index:5;}
  .card{aspect-ratio:1/1;border:2px solid currentColor;position:relative;overflow:hidden;display:flex;align-items:flex-end;background:#ddd9cf;}
  .card img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
  .card .cinfo{position:relative;padding:14px 16px;width:100%;background:rgba(20,19,16,.82);color:#fff;}
  .card .cb{font-size:20px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--yellow);}
  .card .cp{font-size:34px;font-weight:800;}
  .hero-bg{position:absolute;inset:0;background-size:cover;background-position:center;filter:brightness(.5);}
  .hero-ov{position:absolute;inset:0;background:linear-gradient(0deg,rgba(20,19,16,.95) 22%,rgba(20,19,16,.1) 72%);}
  .badge{display:inline-flex;align-items:center;gap:12px;background:var(--yellow);color:var(--ink);font-weight:800;letter-spacing:2px;font-size:26px;text-transform:uppercase;padding:12px 24px;border-radius:6px;}
`;
const GRAIN = '<svg width="0" height="0"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/></filter></svg>';
const LOGO = LOGO_B64 ? `<img class="logo-img" alt="LilloFind" src="data:image/png;base64,${LOGO_B64}">` : `<span style="font-weight:800;font-size:40px;">LILLOFIND</span>`;
const grainRect = '<svg class="grain"><rect width="100%" height="100%" filter="url(#g)"/></svg>';

// Storia 1 — Fresh Drops con 4 foto reali
function storyDrops(products) {
  const g = products.slice(0, 4);
  const cards = g.map(p => `<div class="card">
      <img src="${esc(pImg(p.img))}" onerror="this.style.display='none'"/>
      <div class="cinfo"><div class="cb">${esc((p.brand || '').slice(0, 14))}</div><div class="cp">€${Number(p.price || 0).toFixed(0)}</div></div>
    </div>`).join('');
  return `<div class="s paper" id="s1">${grainRect}<div class="tri tl"></div><div class="tri br"></div>
    <div class="top">${LOGO}<span class="tag">Just In</span></div>
    <div class="block" style="top:200px;"><p class="kick" style="margin-bottom:18px;">New Arrivals</p><h1 class="cond h">Fresh<br>Drops</h1></div>
    <div class="cards" style="top:760px;color:var(--ink);">${cards}</div>
    <div class="bottom"><span class="mono">lillofind.shop</span><span>Shop now →</span></div>
  </div>`;
}
// Storia 2 — New In hero con foto reale
function storyHero(p) {
  return `<div class="s ink" id="s2">
    <div class="hero-bg" style="background-image:url('${esc(pImg(p.img))}')"></div><div class="hero-ov"></div>${grainRect}
    <div class="top">${LOGO}<span class="tag" style="color:var(--paper);">New In</span></div>
    <div class="block" style="bottom:220px;top:auto;">
      <span class="badge">New In</span>
      <p style="font-size:26px;letter-spacing:3px;text-transform:uppercase;color:var(--yellow);font-weight:800;margin-top:26px;">${esc(p.brand || '')}</p>
      <h1 class="cond h sm" style="margin-top:6px;">${esc((p.name || '').slice(0, 34))}</h1>
      <p class="cond" style="font-size:150px;margin-top:10px;color:var(--yellow);">€${Number(p.price || 0).toFixed(0)}</p>
    </div>
    <div class="bottom"><span class="mono" style="color:var(--paper);">lillofind.shop</span><span>Get it now →</span></div>
  </div>`;
}
// Storia 3 — messaggio brand rotante
const ICONS = {
  ship: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M16 10h4a2 2 0 0 1 0 4h-4l-4 7h-3l2 -7h-4l-2 2h-3l2 -4l-2 -4h3l2 2h4l-2 -7h3z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 2l8 4v6c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
};
const MESSAGES = [
  { bg: 'paper', tri: true, kick: 'Shipping', h: 'Worldwide<br>Shipping', sub: 'We ship <span class="hl">everywhere</span>, tracking included. DHL Express, no customs risk.', cta: 'Order now →', icon: ICONS.ship, iconColor: 'var(--ink)' },
  { bg: 'paper', tri: true, kick: 'Guarantee', h: 'Safe<br>Purchase', sub: 'Pay in <span class="hl">full safety</span>. Satisfied or refunded until you receive your order.', cta: 'Shop safe →', icon: ICONS.shield, iconColor: 'var(--ink)' },
  { bg: 'ink', tri: false, kick: 'QC Service', h: 'Photo before<br>we ship', sub: 'Get <span class="hl">real photos</span> of your item before we ship. No surprises.', cta: 'How it works →', icon: ICONS.cam, iconColor: 'var(--yellow)' },
];
function storyMessage(m) {
  return `<div class="s ${m.bg}" id="s3">${grainRect}${m.tri ? '<div class="tri tl"></div>' : ''}
    <div class="top">${LOGO}<span class="tag" ${m.bg === 'ink' ? 'style="color:var(--paper)"' : ''}>LilloFind</span></div>
    <div style="position:absolute;top:470px;right:90px;width:330px;color:${m.iconColor};z-index:3;">${m.icon}</div>
    <div class="block" style="top:1000px;">
      <p class="kick" style="margin-bottom:22px;${m.bg==='ink'?'color:var(--yellow);':''}">${m.kick}</p>
      <h1 class="cond h sm">${m.h}</h1>
      <p class="sub" style="margin-top:36px;">${m.sub}</p>
    </div>
    <div class="bottom"><span class="mono" ${m.bg==='ink'?'style="color:var(--paper)"':''}>lillofind.shop</span><span>${m.cta}</span></div>
  </div>`;
}

function captions(products) {
  const p0 = products[0] || {};
  return `# Caption pronte — set social LilloFind

## Storia 1 — Fresh Drops
🔥 FRESH DROPS on LilloFind! New sneakers & streetwear from the best brands, QC photo before shipping.
👉 lillofind.shop
#lillofind #freshdrops #sneakers #streetwear #newin #nike #adidas #jordan #sneakerhead

## Storia 2 — New In (${esc(p0.brand)} ${esc(p0.name)})
🆕 New in: ${esc(p0.brand)} ${esc(p0.name)} — €${Number(p0.price || 0).toFixed(0)}. Available now.
👉 lillofind.shop
#lillofind #newin #sneakers #streetwear #shoponline

## Storia 3 — Brand
✅ Worldwide shipping · Safe purchase · QC photo before we ship. Join +20.000 orders delivered.
👉 lillofind.shop
#lillofind #worldwideshipping #safepurchase #streetwear
`;
}

(async () => {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  const week = Math.floor(now.getTime() / (7 * 864e5));
  const outDir = path.join('social', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  let products = [];
  try { products = await fetchProducts(); } catch (e) { console.error('Fetch prodotti:', e.message); }

  const msg = MESSAGES[week % MESSAGES.length];
  const s1 = products.length ? storyDrops(products) : '';
  const s2 = products.length ? storyHero(products[0]) : '';
  const s3 = storyMessage(msg);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${GRAIN}${s1}${s2}${s3}</body></html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(4500); // attende le foto proxied
  for (const id of ['s1', 's2', 's3']) {
    const el = await page.$('#' + id);
    if (el) await el.screenshot({ path: path.join(outDir, 'story-' + id + '.jpg'), type: 'jpeg', quality: 90 });
  }
  await browser.close();

  fs.writeFileSync(path.join(outDir, 'captions.md'), captions(products));
  console.log('Contenuti social generati in', outDir, '(prodotti:', products.length + ')');
})().catch(e => { console.error(e); process.exit(1); });
