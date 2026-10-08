// ══════════════════════════════════════════════════════════════════
// LILLOFIND — smoke test del frontend (gira in CI su ogni PR e su main)
//   node smoke.mjs            (dalla cartella tests/smoke, dopo npm ci)
// Serve il sito in locale, sostituisce Firebase con dati finti (niente rete,
// niente quota Firestore) e controlla in chiaro e in dark, a 390 e 1280px:
//   · nessun errore JavaScript
//   · nessuno scroll orizzontale
//   · contrasto WCAG AA su tutto il testo visibile
//   · le viste principali si aprono (home, shop, prodotto, carrello, LFPoints, profilo)
// In caso di errore salva gli screenshot in tests/smoke/out/.
// ══════════════════════════════════════════════════════════════════
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const CONTRAST = fs.readFileSync(path.join(HERE, 'contrast.js'), 'utf8');

// ── server statico ────────────────────────────────────────────────
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── dati finti ────────────────────────────────────────────────────
const img = (c) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="${c}"/><circle cx="300" cy="340" r="160" fill="#ffffff30"/></svg>`);
const now = Math.floor(Date.now() / 1000);
const COLORS = ['#3b4a5a', '#5a4a3b', '#2f3b2f', '#6b6b6b', '#4a3b5a', '#3b5a55'];
const PRODUCTS = [
  ['Barbour', 'Giacca Transport Wax 130th Anniversary', 'Giacche', 129, ['XS', 'S', 'M', 'L', 'XL', 'XXL'], 1],
  ['Stone Island', 'Overseas purchase of brand new authentic Stone Island crinkle reps jacket for men and women! 100% quality 正品代购', 'Giacche', 149, ['S', 'M', 'L'], 90],
  ['Nike', 'Air Force 1 Low White', 'Sneakers', 89, ['40', '41', '42', '43', '44'], 3],
  ['Ralph Lauren', 'Polo Custom Fit Navy', 'Polo', 49, ['S', 'M', 'L', 'XL'], 30],
  ['Carhartt', 'Detroit Jacket Brown', 'Giacche', 99, ['M', 'L'], 60],
  ['Lacoste', 'Felpa Half Zip Grigio', 'Felpe', 59, ['S', 'M', 'L'], 70],
  ['Stussy', 'Hoodie Basic Logo', 'Felpe', 69, ['S', 'M', 'L', 'XL'], 2],
  ['Adidas', 'Samba OG White Black', 'Sneakers', 79, ['39', '40', '41', '42'], 80],
].map(([brand, name, category, price, sizes, days], i) => ({
  id: 'p' + i, brand, name, category, price, sizes, imageUrl: img(COLORS[i % COLORS.length]),
  createdAt: { seconds: now - days * 86400 }, ...(i === 5 ? { soldOut: true } : {}), ...(i === 4 ? { stock: 2 } : {}),
  ...(i === 3 ? { style: 'Old Money' } : {}),
}));
const REVIEWS = [{ productId: 'p0', rating: 5, text: 'Giacca arrivata perfetta, taglia giusta.', userName: 'Marco', createdAt: { seconds: now - 5000 } }];
const CART = JSON.stringify([{ id: 'p0', name: PRODUCTS[0].name, price: 129, qty: 1, size: 'M', brand: 'Barbour', img: PRODUCTS[0].imageUrl }]);

const FIREBASE_STUB = `
const PRODUCTS=${JSON.stringify(PRODUCTS)}, REVIEWS=${JSON.stringify(REVIEWS)};
const mk=(id,d)=>({id,data:()=>d,exists:()=>!!d});
const snap=a=>({docs:a,size:a.length,empty:!a.length,forEach:f=>a.forEach(f)});
const user={uid:'u1',email:'test@example.it',displayName:'Test',isAnonymous:false,emailVerified:true,getIdToken:async()=>''};
const udoc={email:'test@example.it',displayName:'Giulia Rossi',lfpoints:120,totalSpent:120,preferredSize:'M',preferredBrands:[],createdAt:{seconds:1700000000}};
window.__fb={db:{},auth:{currentUser:user},functions:{},
  collection:(db,n)=>({n,path:n}),doc:(db,n,id)=>({n,id,path:n+'/'+id}),query:c=>c,where:()=>({}),orderBy:()=>({}),limit:()=>({}),startAfter:()=>({}),
  getDocs:async c=>snap(c.n==='products'?PRODUCTS.map(p=>mk(p.id,p)):c.n==='reviews'?REVIEWS.map((r,i)=>mk('r'+i,r)):[]),
  getDoc:async r=>r.n==='users'?mk(r.id,udoc):r.n==='products'?mk(r.id,PRODUCTS.find(p=>p.id===r.id)||null):mk(r.id,null),
  onAuthStateChanged:(a,cb)=>{setTimeout(()=>cb(user),20);return()=>{};},
  serverTimestamp:()=>({seconds:Math.floor(Date.now()/1000)}),deleteField:()=>null,
  updateDoc:async()=>{},setDoc:async()=>{},addDoc:async()=>({id:'x'}),deleteDoc:async()=>{},
  writeBatch:()=>({set(){},update(){},delete(){},commit:async()=>{}}),httpsCallable:()=>async()=>({data:{}}),
  signInAnonymously:async()=>({user:{uid:'anon',isAnonymous:true}}),getRedirectResult:async()=>null,signOut:async()=>{},
  GoogleAuthProvider:function(){},EmailAuthProvider:{credential(){}},_googleProvider:{}};
window.LF_WORKER_BASE='https://worker.invalid';
window.lfCallable=()=>async()=>({data:{}});
`;
const CHART_STUB = 'window.Chart=function(){return{destroy(){},update(){},resize(){},data:{datasets:[]}}};window.Chart.register=function(){};';
const STRIPE_STUB = 'window.Stripe=function(){const el={mount(){},on(){},unmount(){},destroy(){}};return{elements:()=>({create:()=>el,getElement:()=>el}),confirmCardPayment:async()=>({})};};';

// ── controlli ─────────────────────────────────────────────────────
// Eccezioni note al contrasto: loghi di marchi (WCAG li esclude) e decorazioni.
const AA_IGNORE = (x) => /foot-wordmark/.test(x.cls) || /^0[1-9]$/.test(x.t) || /^(PAY|PAL|Pay|Pal)$/.test(x.t)
  || /SVGAnimatedString/.test(x.cls); // testo dentro un SVG = logo/icona
const failures = [];
fs.rmSync(OUT, { recursive: true, force: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

async function run(pageFile, steps, { width, theme }) {
  const mobile = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE)) {
      if (/\/firebase\.js(\?|$)/.test(u)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_STUB });
      return route.continue();
    }
    if (/js\.stripe\.com/.test(u)) return route.fulfill({ contentType: 'text/javascript', body: STRIPE_STUB });
    if (/chart(\.umd)?(\.min)?\.js/i.test(u)) return route.fulfill({ contentType: 'text/javascript', body: CHART_STUB });
    return route.abort(); // niente rete esterna: font, Firestore, Worker, analytics
  });
  await ctx.addInitScript(([cart, theme]) => {
    try {
      ['lf_cookie', 'lf_promo_group', 'lf_onboarded', 'lf_pwa_dismiss'].forEach(k => localStorage.setItem(k, '1'));
      localStorage.setItem('lf_cart', cart); localStorage.setItem('lf_theme', theme);
    } catch (_) {}
  }, [CART, theme]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/' + pageFile, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  for (const [name, js, expect] of steps) {
    const tag = `${pageFile} ${name} ${width}px ${theme}`;
    if (js) { try { await page.evaluate(js); } catch (e) { errors.push(`step ${name}: ${e.message}`); } await page.waitForTimeout(700); }
    const problems = [];
    if (expect) { const ok = await page.evaluate(expect).catch(() => false); if (!ok) problems.push('controllo vista fallito: ' + expect); }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) problems.push(`scroll orizzontale di ${overflow}px`);
    const aa = (await page.evaluate(CONTRAST)).filter(x => !AA_IGNORE(x));
    aa.slice(0, 8).forEach(x => problems.push(`contrasto ${x.ratio}:1 (${x.px}px) "${x.t}" ${x.id || x.cls}`));
    if (errors.length) problems.push(...errors.splice(0).map(e => 'errore JS: ' + e));
    if (problems.length) {
      failures.push([tag, problems]);
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, tag.replace(/[^a-z0-9]+/gi, '_') + '.png'), fullPage: true }).catch(() => {});
      console.log('✗', tag); problems.forEach(p => console.log('    ' + p));
    } else console.log('✓', tag);
  }
  await ctx.close();
}

const INDEX = [
  ['home', null, "document.querySelectorAll('#home-prods .pcard').length>0"],
  ['shop', "showPg('shop')", "document.querySelectorAll('#pg-shop .pcard').length>0"],
  ['prodotto', "openProduct('p0')", "document.getElementById('prod-modal').classList.contains('open')"],
  ['carrello', "closeProd();showPg('cart')", "document.querySelector('#pg-cart.on')!==null"],
  ['lfpoints', "showPg('lfpoints')", "document.querySelector('#pg-lfpoints.on')!==null"],
  ['profilo', "showPg('profile')", "document.querySelector('#pg-profile.on')!==null"],
];
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null; // es. ONLY=vault.html
const want = f => !ONLY || ONLY.includes(f);
for (const width of [390, 1280]) {
  if (want('index.html')) for (const theme of ['light', 'dark']) await run('index.html', INDEX, { width, theme });
  for (const f of ['subscriptions.html', 'vault.html', 'stream.html']) if (want(f)) await run(f, [['pagina', null, null]], { width, theme: 'light' });
}

await browser.close(); server.close();
if (failures.length) { console.log(`\n${failures.length} viste con problemi (screenshot in tests/smoke/out/)`); process.exit(1); }
console.log('\nTutte le viste ok.');
