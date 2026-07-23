/* ══════════════════════════════════════════════════════════════
   LILLOFIND — Catalog QC helpers (condivisi)
   Logica canonica di normalizzazione catalogo, usata sia
   dall'importer (arricchimento al salvataggio) sia dal pannello
   admin (Controllo Qualità Catalogo).  Espone window.LFCatalog.
   ══════════════════════════════════════════════════════════════ */
(function () {
  // Mappa canonica marchi — allineata a canonBrand di index.html.
  var BRAND_CANON = {
    nike:'Nike', airjordan:'Jordan', jordan:'Jordan', adidas:'Adidas', adidasoriginals:'Adidas',
    yeezy:'Yeezy', newbalance:'New Balance', nb:'New Balance', asics:'Asics', puma:'Puma', reebok:'Reebok',
    converse:'Converse', vans:'Vans', offwhite:'Off-White', supreme:'Supreme', bape:'Bape', abathingape:'Bape',
    stussy:'Stüssy', stssy:'Stüssy', trapstar:'Trapstar', corteiz:'Corteiz', crtz:'Corteiz', palmangels:'Palm Angels',
    essentials:'Essentials', fearofgod:'Fear of God', fearofgodessentials:'Essentials', fog:'Fear of God',
    thenorthface:'The North Face', northface:'The North Face', tnf:'The North Face',
    ralphlauren:'Ralph Lauren', poloralphlauren:'Ralph Lauren', polo:'Ralph Lauren',
    louisvuitton:'Louis Vuitton', lv:'Louis Vuitton', gucci:'Gucci', balenciaga:'Balenciaga', dior:'Dior',
    yvessaintlaurent:'Saint Laurent', saintlaurent:'Saint Laurent', ysl:'Saint Laurent',
    moncler:'Moncler', stoneisland:'Stone Island', carhartt:'Carhartt', carharttwip:'Carhartt',
    represent:'Represent', amiri:'Amiri', ericemanuel:'Eric Emanuel', hellstar:'Hellstar', denimtears:'Denim Tears',
    lacoste:'Lacoste', tommyhilfiger:'Tommy Hilfiger', tommy:'Tommy Hilfiger', calvinklein:'Calvin Klein', ck:'Calvin Klein',
    burberry:'Burberry', prada:'Prada', fendi:'Fendi', versace:'Versace', armani:'Armani', emporioarmani:'Armani', ea7:'Armani',
    hugoboss:'Hugo Boss', boss:'Hugo Boss', kenzo:'Kenzo', huf:'HUF', amiparis:'Ami Paris', ami:'Ami Paris',
    casablanca:'Casablanca', loropiana:'Loro Piana', miumiu:'Miu Miu', acnestudios:'Acne Studios', acne:'Acne Studios',
    fredperry:'Fred Perry', patagonia:'Patagonia', aloyoga:'Alo Yoga', alo:'Alo Yoga', oakley:'Oakley', celine:'Celine',
    hermes:'Hermès', herms:'Hermès', cline:'Celine', coach:'Coach', patta:'Patta', travisscott:'Travis Scott',
    nocta:'Nocta', drew:'Drew House', alexandermcqueen:'Alexander McQueen', mcqueen:'Alexander McQueen',
    brunellocucinelli:'Brunello Cucinelli'
  };
  function brandKey(b) { return (b || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function canonBrand(b) {
    if (!b) return '';
    var k = brandKey(b);
    if (BRAND_CANON[k]) return BRAND_CANON[k];
    // Fallback: Title Case per parola (gestisce lettere accentate senza spezzarle)
    return String(b).trim().replace(/\s+/g, ' ').toLowerCase()
      .split(' ').map(function (w) { return w ? w[0].toUpperCase() + w.slice(1) : w; }).join(' ');
  }

  // Deduce la categoria dal nome/modello. Ritorna '' se non deducibile.
  function inferCategory(p) {
    var t = ((p.name || '') + ' ' + (p.model || '')).toLowerCase();
    if (/scarpa|scarpe|sneaker|dunk|air\s?max|air\s?force|jordan\s?\d|yeezy|runner|trainer|samba|gazelle|990|550|force\s?1|blazer|superstar/.test(t)) return 'scarpe';
    if (/polo\b/.test(t)) return 'tshirt_branded';
    if (/t-?shirt|tee\b|maglietta|canott/.test(t)) return 'tshirt';
    if (/felpa|hoodie|cappuccio|crewneck|sweatshirt|girocollo/.test(t)) return 'felpa';
    if (/giacchett|giacca|bomber|giubbott|piumino|parka|trench|cappotto|jacket|gilet|smanicat/.test(t)) return 'giacchetto';
    if (/pantalon|jeans|cargo|tuta\b|jogger|trouser|leggings/.test(t)) return 'pantaloni';
    if (/short|bermuda|costume|boxer\s?short/.test(t)) return 'shorts';
    if (/cappell|beanie|berretto|bucket|cap\b|hat\b|visiera/.test(t)) return 'cappello';
    if (/borsa|bag|pochette|clutch|tote|zaino|marsupio|tracolla|shopper|speedy|baguette/.test(t)) return 'borsa';
    if (/maglia|maglione|cardigan|dolcevita|knit|pile|fleece|camicia/.test(t)) return 'felpa';
    if (/occhial|cintura|portafogl|sciarpa|guant|calz|boxer|intimo|set\b|accessori|orolog|collana|bracciale/.test(t)) return 'accessori';
    return '';
  }

  var CAT_LABEL = {
    tshirt: 'T-shirt', tshirt_branded: 'Polo/T-shirt griffata', felpa: 'Felpa', scarpe: 'Scarpe',
    scarpe_box: 'Scarpe (con box)', pantaloni: 'Pantaloni', shorts: 'Shorts', cappello: 'Cappello',
    giacchetto: 'Giacca', borsa: 'Borsa', accessori: 'Accessori'
  };

  // Peso di spedizione predefinito (kg) per categoria — usato dal calcolo spedizione.
  var CAT_WEIGHT = {
    tshirt: 0.3, tshirt_branded: 0.3, felpa: 0.7, scarpe: 1.2, scarpe_box: 1.5, pantaloni: 0.6,
    shorts: 0.4, cappello: 0.2, giacchetto: 1.0, borsa: 0.8, accessori: 0.3
  };
  function defaultWeight(cat) { return CAT_WEIGHT[cat] != null ? CAT_WEIGHT[cat] : 0.5; }

  // Nome generico = marca seguita solo dal tipo di capo (nessun modello/colore).
  function isGenericName(p) {
    var n = (p.name || '').trim();
    if (!n) return true;
    var esc = canonBrand(p.brand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var nb = n.replace(new RegExp('^' + esc, 'i'), '').trim();
    var rest = (nb || n.split(' ').slice(1).join(' ')).trim();
    return /^(t-?shirt|felpa|polo|maglia|maglietta|giacchett|giacca|cappell|scarp|sneaker|canott|pantalon|short|boxer|borsa|accessori|hoodie|camicia|costume|piumino|giubbott|bermuda|tuta|zaino)\b/i.test(rest) || rest.length < 3;
  }

  // Descrizione template (deterministica) — usata quando manca del tutto.
  function genDescription(p) {
    var brand = canonBrand(p.brand) || '';
    var cat = (p.category || inferCategory(p));
    var catLbl = (CAT_LABEL[cat] || 'capo').toLowerCase();
    var colors = Array.isArray(p.colors) ? p.colors.filter(Boolean) : [];
    var colorTxt = colors.length ? ' nella colorazione ' + colors.slice(0, 3).join(', ') : '';
    var model = (p.model && !/^-$/.test(p.model)) ? p.model : '';
    var head = [brand, model].filter(Boolean).join(' ');
    return (head ? head + ' — ' : '') + catLbl.charAt(0).toUpperCase() + catLbl.slice(1) +
      (brand ? ' firmato ' + brand : '') + colorTxt +
      '. Materiali e finiture di qualità premium, in perfetto stile streetwear. Ogni capo è verificato con foto QC prima della spedizione tracciata.';
  }

  window.LFCatalog = {
    canonBrand: canonBrand,
    inferCategory: inferCategory,
    genDescription: genDescription,
    isGenericName: isGenericName,
    defaultWeight: defaultWeight,
    CAT_LABEL: CAT_LABEL
  };
})();
