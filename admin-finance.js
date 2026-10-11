/* ══════════════════════════════════════════════════════════════════════
   LILLOFIND admin — Conto economico (lordo → netto) e registro movimenti
   ──────────────────────────────────────────────────────────────────────
   Lordo   = quanto hanno pagato i clienti (totale ordine: merce + spedizione
             − sconti), solo ordini PAGATI (confermati, o carta già incassata).
   Netto   = lordo − commissioni di pagamento − costo merce − spese
             + altre entrate. Opzionale: accantonamento tasse.
   Costo merce per articolo, in quest'ordine:
     1. costo reale salvato sul prodotto (costEUR, da ricevuta agente:
        prezzo + spedizione unitaria) → «reale»
     2. prezzo fornitore in yuan × cambio live (+ spedizione stimata
        dalle impostazioni) → «stimato»
     3. niente → «mancante» (non sottratto, segnalato in rosso)
   Spese/entrate manuali: collezione finance_entries (solo admin).
   Impostazioni (commissioni, tasse…): documento finance/settings.
   I dati arrivano da loadAdminStats (stessa lettura degli ordini: niente
   letture Firestore in più) tramite lfFinance.feed().
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  const DEF = {
    paypalPct: 2.99, paypalFix: 0.35,   // PayPal transazioni commerciali Italia
    cardPct: 1.5, cardFix: 0.25,        // Stripe carte europee standard
    bonificoPct: 0, bonificoFix: 0,
    extraPerOrder: 0,                   // imballo, etichetta… per ordine fisico
    estFreight: 0,                      // spedizione agente stimata per articolo senza costo reale
    taxPct: 0,                          // accantonamento tasse sul netto (0 = non mostrato)
  };
  const CATS = ['Spedizione / corriere', 'Agente / fornitore', 'Pubblicità', 'Abbonamenti e strumenti', 'Imballaggi', 'Rimborso cliente', 'Tasse e contributi', 'Vendita fuori sito', 'Altro'];
  const PERIODS = [['oggi', 'Oggi'], ['7g', '7 giorni'], ['mese', 'Questo mese'], ['mesePrec', 'Mese scorso'], ['anno', "Quest'anno"], ['tutto', 'Tutto']];

  const st = { orders: [], catalog: [], entries: null, settings: { ...DEF }, fx: null, period: 'mese', ready: false, showLog: false, showSet: false, showAdd: false };
  const fb = () => window.__fb;
  const eur = (v) => (v < 0 ? '−' : '') + '€' + Math.abs(Math.round((+v || 0) * 100) / 100).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tsMs = (t) => !t ? 0 : (typeof t === 'number' ? t : t.seconds ? t.seconds * 1000 : t.toMillis ? t.toMillis() : (t instanceof Date ? t.getTime() : Date.parse(t) || 0));
  const isPaid = (o) => o.status !== 'cancelled' && o.status !== 'expired' && (o.status === 'confirmed' || o.paymentStatus === 'paid');
  window.lfIsPaidOrder = isPaid;

  function range(p) {
    const n = new Date(), y = n.getFullYear(), m = n.getMonth();
    const day0 = new Date(y, m, n.getDate()).getTime();
    switch (p) {
      case 'oggi': return [day0, Infinity];
      case '7g': return [day0 - 6 * 864e5, Infinity];
      case 'mese': return [new Date(y, m, 1).getTime(), Infinity];
      case 'mesePrec': return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
      case 'anno': return [new Date(y, 0, 1).getTime(), Infinity];
      default: return [0, Infinity];
    }
  }

  function fee(o) {
    // commissione vera comunicata da PayPal all'incasso (PayPal automatico)
    if (typeof o.paymentFee === 'number' && o.paymentFee >= 0) return o.paymentFee;
    const s = st.settings, t = +o.total || 0;
    if (!t) return 0;
    const pm = o.payment || o.paymentMethod || 'card';
    if (pm === 'paypal') return t * s.paypalPct / 100 + s.paypalFix;
    if (pm === 'bonifico') return t * s.bonificoPct / 100 + s.bonificoFix;
    return t * s.cardPct / 100 + s.cardFix;
  }

  // Costo di un articolo: { eur, kind: 'reale'|'stimato'|'mancante' }
  function itemCost(i, catMap) {
    const qty = +i.qty || 1, p = catMap[i.id] || {};
    if (typeof p.costEUR === 'number' && p.costEUR > 0) return { eur: p.costEUR * qty, kind: 'reale' };
    const cny = p.supplierPriceCNY != null && p.supplierPriceCNY !== '' ? +p.supplierPriceCNY : (i.supplierPriceCNY != null ? +i.supplierPriceCNY : NaN);
    const rate = st.fx && st.fx.cnyEur;
    if (cny > 0 && rate) return { eur: (cny * rate + (+st.settings.estFreight || 0)) * qty, kind: 'stimato' };
    return { eur: 0, kind: 'mancante' };
  }

  function orderRow(o, catMap) {
    let cogs = 0, real = 0, est = 0, miss = 0;
    const missing = [];
    (o.items || []).forEach((i) => {
      const c = itemCost(i, catMap), q = +i.qty || 1;
      cogs += c.eur;
      if (c.kind === 'reale') real += q; else if (c.kind === 'stimato') est += q; else { miss += q; missing.push(i); }
    });
    const lordo = +o.total || 0, f = fee(o);
    const extra = o.isDigitalOrder ? 0 : (+st.settings.extraPerOrder || 0);
    return { kind: 'ordine', ms: tsMs(o.createdAt), id: o._docId || o.id, ref: o.orderId || o._docId || o.id,
      who: o.name || o.email || '', pay: o.payment || 'card', lordo, fee: f, cogs, extra, netto: lordo - f - cogs - extra,
      real, est, miss, missing, ship: +o.shipping || 0, disc: +o.discount || 0, items: (o.items || []).reduce((s, i) => s + (+i.qty || 1), 0) };
  }

  function compute(period) {
    const [a, b] = range(period);
    const catMap = {}; st.catalog.forEach((p) => { catMap[p.id] = p; });
    const rows = st.orders.filter(isPaid).map((o) => orderRow(o, catMap)).filter((r) => r.ms >= a && r.ms < b);
    const ents = (st.entries || []).map((e) => ({ kind: 'mov', ms: Date.parse(e.date) || tsMs(e.createdAt), id: e.id, type: e.type, cat: e.category, note: e.note || '', amount: +e.amount || 0 }))
      .filter((r) => r.ms >= a && r.ms < b);
    const T = { lordo: 0, fee: 0, cogs: 0, extra: 0, spese: 0, entrate: 0, ordini: rows.length, items: 0, real: 0, est: 0, miss: 0, ship: 0, disc: 0 };
    rows.forEach((r) => { T.lordo += r.lordo; T.fee += r.fee; T.cogs += r.cogs; T.extra += r.extra; T.items += r.items; T.real += r.real; T.est += r.est; T.miss += r.miss; T.ship += r.ship; T.disc += r.disc; });
    ents.forEach((e) => { if (e.type === 'entrata') T.entrate += e.amount; else T.spese += e.amount; });
    T.netto = T.lordo + T.entrate - T.fee - T.cogs - T.extra - T.spese;
    T.margine = (T.lordo + T.entrate) > 0 ? T.netto / (T.lordo + T.entrate) * 100 : 0;
    T.tasse = T.netto > 0 ? T.netto * (+st.settings.taxPct || 0) / 100 : 0;
    // prodotti venduti senza alcun costo, per sistemarli in Costi & Margini
    const miss = {}; rows.forEach((r) => r.missing.forEach((i) => { const k = i.id || i.name; miss[k] = miss[k] || { name: i.name || k, qty: 0 }; miss[k].qty += +i.qty || 1; }));
    T.missList = Object.values(miss).sort((x, y) => y.qty - x.qty);
    return { T, rows, ents, log: rows.concat(ents).sort((x, y) => y.ms - x.ms) };
  }

  function months(n) {
    const out = [], now = new Date();
    const catMap = {}; st.catalog.forEach((p) => { catMap[p.id] = p; });
    const paid = st.orders.filter(isPaid).map((o) => orderRow(o, catMap));
    const ents = st.entries || [];
    for (let k = n - 1; k >= 0; k--) {
      const a = new Date(now.getFullYear(), now.getMonth() - k, 1).getTime(), b = new Date(now.getFullYear(), now.getMonth() - k + 1, 1).getTime();
      let l = 0, ne = 0;
      paid.forEach((r) => { if (r.ms >= a && r.ms < b) { l += r.lordo; ne += r.netto; } });
      ents.forEach((e) => { const ms = Date.parse(e.date) || 0; if (ms >= a && ms < b) { const v = +e.amount || 0; if (e.type === 'entrata') { l += v; ne += v; } else ne -= v; } });
      out.push({ label: new Date(a).toLocaleDateString('it-IT', { month: 'short' }), l, n: ne });
    }
    return out;
  }

  function chart(ms) {
    const W = 560, H = 150, pad = 22, max = Math.max(1, ...ms.map((m) => Math.max(m.l, Math.abs(m.n))));
    const bw = (W - pad * 2) / ms.length;
    let g = '';
    ms.forEach((m, i) => {
      const x = pad + i * bw, hl = (m.l / max) * (H - 44), hn = (Math.max(0, m.n) / max) * (H - 44);
      g += `<rect x="${x + bw * 0.14}" y="${H - 24 - hl}" width="${bw * 0.34}" height="${hl}" rx="3" fill="rgba(255,255,255,.22)"><title>${m.label}: lordo ${eur(m.l)}</title></rect>`;
      g += `<rect x="${x + bw * 0.52}" y="${H - 24 - hn}" width="${bw * 0.34}" height="${hn}" rx="3" fill="${m.n >= 0 ? '#b8c77e' : '#ff7b6b'}"><title>${m.label}: netto ${eur(m.n)}</title></rect>`;
      g += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="rgba(255,255,255,.5)">${m.label}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block" role="img" aria-label="Lordo e netto degli ultimi mesi">${g}</svg>
      <div class="fin-leg"><span><i style="background:rgba(255,255,255,.3)"></i>Lordo</span><span><i style="background:#b8c77e"></i>Netto</span></div>`;
  }

  function tile(label, val, sub, cls) {
    return `<div class="fin-t ${cls || ''}"><div class="hud-k">${label}</div><div class="fin-v">${val}</div>${sub ? `<div class="hud-s">${sub}</div>` : ''}</div>`;
  }

  function render() {
    const box = document.getElementById('fin-box'); if (!box) return;
    if (!st.ready) { box.innerHTML = '<p style="font-size:12px;color:var(--dim);">Calcolo il conto economico…</p>'; return; }
    const { T, log } = compute(st.period);
    const s = st.settings;
    const chips = PERIODS.map(([k, l]) => `<button class="fin-chip${k === st.period ? ' on' : ''}" onclick="lfFinance.period('${k}')">${l}</button>`).join('');
    const costSub = `${T.real} reali · ${T.est} stimati` + (T.miss ? ` · <b style="color:#ff9b8b">${T.miss} senza costo</b>` : '');
    const avg = T.ordini ? T.lordo / T.ordini : 0;
    let html = `
      <div class="fin-head"><div class="fin-chips">${chips}</div>
        <div class="fin-acts">
          <button class="btn-k fin-b" onclick="lfFinance.toggle('showAdd')">＋ Movimento</button>
          <button class="btn-k fin-b" onclick="lfFinance.toggle('showLog')">${st.showLog ? 'Nascondi' : 'Registro'} movimenti</button>
          <button class="btn-k fin-b" onclick="lfFinance.csv()">⬇︎ CSV</button>
          <button class="btn-k fin-b" onclick="lfFinance.toggle('showSet')" title="Commissioni, tasse, stime">⚙︎</button>
        </div></div>
      <div class="fin-grid">
        ${tile('💶 Lordo incassato', eur(T.lordo + T.entrate), `${T.ordini} ordini pagati · media ${eur(avg)}` + (T.entrate ? ` · +${eur(T.entrate)} altre entrate` : ''))}
        ${tile('💳 Commissioni', eur(-T.fee), 'PayPal / carta, stimate')}
        ${tile('📦 Costo merce', eur(-T.cogs), costSub)}
        ${tile('🧾 Spese', eur(-(T.spese + T.extra)), T.extra ? `di cui ${eur(T.extra)} imballi/ordine` : 'registrate a mano')}
        ${tile('✅ Netto', eur(T.netto), `margine ${T.margine.toFixed(1)}%` + (s.taxPct ? ` · dopo tasse ${eur(T.netto - T.tasse)}` : ''), T.netto >= 0 ? 'good big' : 'bad big')}
      </div>
      <div class="fin-row2"><div class="fin-chart">${chart(months(6))}</div>
        <div class="fin-notes">
          <p><b>Incluso nel lordo:</b> spedizioni pagate dai clienti ${eur(T.ship)}${T.disc ? ` · sconti LFPoints già tolti ${eur(T.disc)}` : ''}.</p>
          ${T.est ? `<p>📐 <b>${T.est}</b> articoli hanno il costo <b>stimato</b> (prezzo fornitore × cambio ${st.fx && st.fx.cnyEur ? (1 / st.fx.cnyEur).toFixed(2) + ' ¥/€' : ''}${s.estFreight ? ` + ${eur(s.estFreight)} spedizione` : ', senza spedizione agente'}). Per il dato reale carica la ricevuta in <a href="#" onclick="showAdminPg('costi');return false;">Costi &amp; Margini</a>.</p>` : ''}
          ${T.miss ? `<p style="color:#ff9b8b">⚠️ ${T.miss} articoli venduti <b>senza nessun costo</b>: il netto è più alto del vero. ${T.missList.slice(0, 4).map((m) => esc(m.name) + ' ×' + m.qty).join(' · ')}</p>` : ''}
          ${!T.ordini && !T.spese && !T.entrate ? '<p>Nessun movimento nel periodo.</p>' : ''}
        </div></div>`;
    if (st.showAdd) html += addForm();
    if (st.showSet) html += setForm();
    if (st.showLog) html += logTable(log);
    box.innerHTML = html;
    // HUD in cima: incasso e netto del mese corrente, stessa definizione
    const M = compute('mese').T;
    window._finKpi = { lordo: M.lordo + M.entrate, netto: M.netto, margine: M.margine, ordini: M.ordini, miss: M.miss };
    try { window.renderDashHud && window.renderDashHud(); } catch (_) {}
  }

  function addForm() {
    const today = new Date().toISOString().slice(0, 10);
    return `<div class="fin-form"><p class="fin-ft">Nuovo movimento</p>
      <div class="fin-fields">
        <label>Tipo<select id="fin-type"><option value="uscita">Uscita (spesa)</option><option value="entrata">Entrata</option></select></label>
        <label>Data<input type="date" id="fin-date" value="${today}"></label>
        <label>Importo €<input type="number" id="fin-amount" step="0.01" min="0" placeholder="0,00"></label>
        <label>Categoria<select id="fin-cat">${CATS.map((c) => `<option>${c}</option>`).join('')}</select></label>
        <label class="wide">Nota<input id="fin-note" maxlength="200" placeholder="es. Ads Instagram ottobre, ordine agente #123…"></label>
      </div>
      <button class="btn-led" style="padding:10px 18px;font-size:12px;" onclick="lfFinance.add()">Salva movimento</button></div>`;
  }

  function setForm() {
    const s = st.settings, f = (k, l, step) => `<label>${l}<input type="number" step="${step || 0.01}" min="0" id="fin-s-${k}" value="${s[k]}"></label>`;
    return `<div class="fin-form"><p class="fin-ft">Impostazioni calcolo</p>
      <div class="fin-fields">
        ${f('paypalPct', 'PayPal %')}${f('paypalFix', 'PayPal € fissi')}${f('cardPct', 'Carta (Stripe) %')}${f('cardFix', 'Carta € fissi')}
        ${f('bonificoPct', 'Bonifico %')}${f('bonificoFix', 'Bonifico € fissi')}
        ${f('extraPerOrder', 'Imballo € per ordine')}${f('estFreight', 'Spedizione agente stimata € / articolo')}${f('taxPct', 'Accantonamento tasse %', 0.5)}
      </div>
      <p class="fin-hint">Le commissioni reali le trovi negli estratti PayPal e Stripe: correggi qui le percentuali e tutti i numeri si ricalcolano. «Spedizione agente stimata» si usa solo per gli articoli senza costo reale. «Tasse» è solo un accantonamento indicativo, non un calcolo fiscale.</p>
      <button class="btn-led" style="padding:10px 18px;font-size:12px;" onclick="lfFinance.saveSettings()">Salva impostazioni</button></div>`;
  }

  function logTable(log) {
    if (!log.length) return '<div class="fin-form"><p class="fin-ft">Registro movimenti</p><p class="fin-hint">Nessun movimento nel periodo.</p></div>';
    const rows = log.slice(0, 300).map((r) => {
      const d = new Date(r.ms).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
      if (r.kind === 'ordine') {
        const warn = r.miss ? ' <span title="articoli senza costo" style="color:#ff9b8b">⚠︎</span>' : (r.est ? ' <span title="costo stimato" style="color:rgba(255,255,255,.4)">≈</span>' : '');
        return `<tr><td>${d}</td><td>🛒 Ordine <b>${esc(r.ref)}</b> · ${esc(r.who)} <span class="fin-pay">${esc(r.pay)}</span></td><td class="n">${eur(r.lordo)}</td><td class="n">${eur(-(r.fee + r.cogs + r.extra))}${warn}</td><td class="n ${r.netto >= 0 ? 'pos' : 'neg'}">${eur(r.netto)}</td><td></td></tr>`;
      }
      const v = r.type === 'entrata' ? r.amount : -r.amount;
      return `<tr><td>${d}</td><td>${r.type === 'entrata' ? '⬆︎' : '⬇︎'} ${esc(r.cat)}${r.note ? ' · ' + esc(r.note) : ''}</td><td class="n">${r.type === 'entrata' ? eur(r.amount) : ''}</td><td class="n">${r.type === 'entrata' ? '' : eur(-r.amount)}</td><td class="n ${v >= 0 ? 'pos' : 'neg'}">${eur(v)}</td><td><button class="fin-del" title="Elimina movimento" onclick="lfFinance.del('${esc(r.id)}')">✕</button></td></tr>`;
    }).join('');
    return `<div class="fin-form"><p class="fin-ft">Registro movimenti (${log.length})</p><div class="fin-tw"><table class="fin-tab">
      <thead><tr><th>Data</th><th>Movimento</th><th class="n">Entrata</th><th class="n">Costi</th><th class="n">Netto</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${log.length > 300 ? '<p class="fin-hint">Mostro i 300 più recenti: il CSV li contiene tutti.</p>' : ''}</div>`;
  }

  async function loadExtra() {
    const f = fb(); if (!f) return;
    const jobs = [];
    if (!st.fx) jobs.push(fetch((window.LF_WORKER_BASE || '') + '/fx', { cache: 'no-store' }).then((r) => r.json()).then((j) => { if (j && j.ok) st.fx = j; }).catch(() => {}));
    jobs.push(f.getDoc(f.doc(f.db, 'finance', 'settings')).then((s) => { if (s.exists()) st.settings = { ...DEF, ...s.data() }; }).catch(() => {}));
    jobs.push(f.getDocs(f.collection(f.db, 'finance_entries')).then((s) => { st.entries = s.docs.map((d) => ({ id: d.id, ...d.data() })); }).catch((e) => { console.warn('finance_entries', e && e.code); st.entries = []; }));
    await Promise.all(jobs);
  }

  window.lfFinance = {
    // chiamato da loadAdminStats con gli stessi dati già letti
    async feed({ orders, catalog }) {
      st.orders = orders || []; st.catalog = catalog || [];
      if (!st.ready) render();
      await loadExtra();
      st.ready = true; render();
    },
    period(p) { st.period = p; try { localStorage.setItem('lf_fin_period', p); } catch (_) {} render(); },
    toggle(k) { st[k] = !st[k]; render(); },
    async add() {
      const f = fb(), g = (id) => document.getElementById(id);
      const amount = Math.round((+String(g('fin-amount').value).replace(',', '.') || 0) * 100) / 100;
      if (!(amount > 0)) { window.showToast && showToast('⚠️ Inserisci un importo'); return; }
      const e = { type: g('fin-type').value, date: g('fin-date').value || new Date().toISOString().slice(0, 10), amount, category: g('fin-cat').value, note: g('fin-note').value.trim().slice(0, 200), createdAt: f.serverTimestamp() };
      try {
        const ref = await f.addDoc(f.collection(f.db, 'finance_entries'), e);
        (st.entries = st.entries || []).push({ ...e, id: ref.id, createdAt: Date.now() });
        st.showAdd = false; render(); window.showToast && showToast('✅ Movimento salvato');
      } catch (err) { window.showToast && showToast('⚠️ Non salvato (' + ((err && err.code) || 'errore') + ')'); }
    },
    async del(id) {
      if (!confirm('Eliminare questo movimento?')) return;
      const f = fb();
      try { await f.deleteDoc(f.doc(f.db, 'finance_entries', id)); st.entries = (st.entries || []).filter((e) => e.id !== id); render(); }
      catch (err) { window.showToast && showToast('⚠️ Non eliminato (' + ((err && err.code) || 'errore') + ')'); }
    },
    async saveSettings() {
      const f = fb(), n = {};
      Object.keys(DEF).forEach((k) => { const el = document.getElementById('fin-s-' + k); if (el) n[k] = Math.max(0, +String(el.value).replace(',', '.') || 0); });
      try { await f.setDoc(f.doc(f.db, 'finance', 'settings'), n, { merge: true }); st.settings = { ...DEF, ...n }; st.showSet = false; render(); window.showToast && showToast('✅ Impostazioni salvate'); }
      catch (err) { window.showToast && showToast('⚠️ Non salvate (' + ((err && err.code) || 'errore') + ')'); }
    },
    csv() {
      const { log, T } = compute(st.period);
      const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const num = (v) => (Math.round((+v || 0) * 100) / 100).toFixed(2).replace('.', ',');
      const lines = [['Data', 'Tipo', 'Riferimento', 'Cliente/Categoria', 'Pagamento', 'Lordo', 'Commissioni', 'Costo merce', 'Spese', 'Netto', 'Costo', 'Nota'].map(q).join(';')];
      log.forEach((r) => {
        const d = new Date(r.ms).toISOString().slice(0, 10);
        if (r.kind === 'ordine') lines.push([d, 'Ordine', r.ref, r.who, r.pay, num(r.lordo), num(r.fee), num(r.cogs), num(r.extra), num(r.netto), r.miss ? 'mancante' : (r.est ? 'stimato' : 'reale'), ''].map(q).join(';'));
        else { const v = r.type === 'entrata' ? r.amount : -r.amount; lines.push([d, r.type === 'entrata' ? 'Entrata' : 'Uscita', '', r.cat, '', r.type === 'entrata' ? num(r.amount) : '', '', '', r.type === 'entrata' ? '' : num(r.amount), num(v), '', r.note].map(q).join(';')); }
      });
      lines.push(''); lines.push([q('TOTALE'), '', '', '', '', q(num(T.lordo + T.entrate)), q(num(T.fee)), q(num(T.cogs)), q(num(T.spese + T.extra)), q(num(T.netto))].join(';'));
      const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'lillofind-movimenti-' + st.period + '-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    },
    _compute: compute, _state: st,
  };
  try { const p = localStorage.getItem('lf_fin_period'); if (p && PERIODS.some(([k]) => k === p)) st.period = p; } catch (_) {}

  const css = document.createElement('style');
  css.textContent = `
  .fin-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:14px}
  .fin-chips{display:flex;gap:6px;flex-wrap:wrap}.fin-chip{background:var(--hud-surf);border:1px solid var(--hud-line);color:rgba(255,255,255,.7);border-radius:999px;padding:7px 12px;font:600 12px 'Manrope',sans-serif;cursor:pointer}
  .fin-chip.on{background:var(--hud-bg);border-color:rgba(184,199,126,.55);color:#fff}
  .fin-acts{display:flex;gap:6px;flex-wrap:wrap}.fin-b{padding:7px 12px!important;font-size:11px!important}
  .fin-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
  @media(max-width:600px){.fin-grid{grid-template-columns:1fr 1fr}.fin-t.big{grid-column:1/-1;order:-1}.fin-v{font-size:21px}.fin-t{padding:12px}}
  .fin-t{background:var(--hud-surf);border:1px solid var(--hud-line);border-radius:14px;padding:14px 16px}
  .fin-t.big{border-color:rgba(184,199,126,.45)}.fin-t.bad{border-color:rgba(255,123,107,.5)}
  .fin-v{font-family:'Bricolage Grotesque',sans-serif;font-size:26px;line-height:1.1;margin-top:8px;font-variant-numeric:tabular-nums;color:#fff}
  .fin-t.good .fin-v{color:#b8c77e}.fin-t.bad .fin-v{color:#ff7b6b}
  .fin-row2{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:14px;align-items:start}
  @media(max-width:860px){.fin-row2{grid-template-columns:1fr}}
  .fin-leg{display:flex;gap:14px;font-size:11px;color:rgba(255,255,255,.55);margin-top:4px}.fin-leg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
  .fin-notes p{font-size:12.5px;color:rgba(255,255,255,.6);line-height:1.6;margin:0 0 8px}.fin-notes a{color:#b8c77e}
  .fin-form{margin-top:14px;padding:14px;border:1px solid var(--hud-line);border-radius:14px;background:rgba(255,255,255,.02)}
  .fin-ft{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.5);font-weight:700;margin:0 0 10px}
  .fin-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
  .fin-fields label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:rgba(255,255,255,.55)}.fin-fields .wide{grid-column:1/-1}
  .fin-fields input,.fin-fields select{background:#0a0a0a;border:1px solid #333;color:#fff;border-radius:8px;padding:9px 10px;font-size:13px}
  .fin-hint{font-size:11.5px;color:rgba(255,255,255,.45);line-height:1.6;margin:0 0 10px}
  .fin-tw{overflow-x:auto}.fin-tab{width:100%;border-collapse:collapse;font-size:12.5px}
  .fin-tab th{text-align:left;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,.45);padding:6px 8px;border-bottom:1px solid var(--hud-line)}
  .fin-tab td{padding:8px;border-bottom:1px solid rgba(255,255,255,.05);color:rgba(255,255,255,.8);white-space:nowrap}
  .fin-tab td:nth-child(2){white-space:normal;min-width:220px}.fin-tab .n{text-align:right;font-variant-numeric:tabular-nums}
  .fin-tab .pos{color:#b8c77e}.fin-tab .neg{color:#ff7b6b}.fin-pay{font-size:10px;color:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.15);border-radius:6px;padding:1px 5px;margin-left:4px}
  .fin-del{background:none;border:none;color:rgba(255,255,255,.35);cursor:pointer;font-size:13px}.fin-del:hover{color:#ff7b6b}`;
  document.head.appendChild(css);
})();
