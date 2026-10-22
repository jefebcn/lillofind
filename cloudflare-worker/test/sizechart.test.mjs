// Categorie Yupoo con la tabella taglie in un album a parte (es. yolo66).
import { parseAlbumList, pairSizeCharts, priceFromTitle, sizesFromTitle, modelKey, albumPagePriceCNY, mapWooProduct } from '../src/handlers/scrapers.js';

let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };

const card = (id, title, ext = 'jpg') => `<div class="album__main"><a class="album__imgwrap" href="/albums/${id}?uid=1" title="${title}"><img data-src="//photo.yupoo.com/yolo66/c${id}/small.${ext}"></a><div class="album__title">${title}</div></div>`;
const html = [
  card(1, 'Size 500Y 【SJ Batch】Solano down Hoody 女款 S-XL', 'png'),
  card(2, '500Y 【SJ Batch】Solano down Hoody 女款 S-XL 层云蓝'),
  card(3, '500Y 【SJ Batch】Solano down Hoody 女款 S-XL 黑色'),
  card(4, '220Y 【TZ Batch】Atom2.0 S-XXL', 'png'),
  card(5, '220Y 【TZ Batch】Atom2.0 S-XXL 雅致棕'),
  card(6, 'Size', 'png'),
  card(7, '270 【XF Batch】Beta LW S-XXL 波尔多红'),
  card(8, '270 【XF Batch】Beta LW S-XXL 黑色'),
  card(9, '210【TZ Batch】Covert S-XXL 灰色'),
  card(10, '250Y 【TZ Batch】Beta LT XS-XXL 以太蓝'),
  card(11, 'Size【TZ Batch】Beta LT S-XXL', 'png'),
  card(12, '330Y 【TZ Batch】 ALPHA SV 7代 S-XXL 烟灰色'),
  card(13, 'Size 330Y 【TZ Batch】 ALPHA SV 7代', 'png'),
].join('\n');

const list = parseAlbumList(html);
eq(list.length, 13, 'tutti gli album in ordine');
eq([list[0].id, list[0].title, list[0].cover], ['1', 'Size 500Y 【SJ Batch】Solano down Hoody 女款 S-XL', 'https://photo.yupoo.com/yolo66/c1/small.png'], 'id, titolo e copertina');

eq(priceFromTitle('330Y 【TZ Batch】 ALPHA SV 7代'), 330, 'prezzo "330Y"');
eq(priceFromTitle('270 【XF Batch】Beta LW'), 270, 'prezzo "270 【"');
eq(priceFromTitle('Size'), null, 'nessun prezzo');
eq(albumPagePriceCNY('prezzo 239元 + 15 CNY nome', ''), 239, 'album: prezzo base, add-on ignorato');
eq(albumPagePriceCNY('foto', '330Y 【TZ Batch】Polo'), 330, 'album: prezzo dal titolo "330Y"');
eq(albumPagePriceCNY('foto', 'Polo'), null, 'album: nessun prezzo');
eq(sizesFromTitle('… S-XXL 黑色'), ['S', 'M', 'L', 'XL', 'XXL'], 'taglie S-XXL');
eq(sizesFromTitle('… XS-2XL'), ['XS', 'S', 'M', 'L', 'XL', 'XXL'], 'taglie XS-2XL');
eq(sizesFromTitle('Felpa'), [], 'nessuna taglia');
eq(modelKey('500Y 【SJ Batch】Solano down Hoody 女款 S-XL 层云蓝'), modelKey('Size 500Y 【SJ Batch】Solano down Hoody 女款 S-XL'), 'stesso modello senza prezzo, lotto, Size e colore');

const { sizeAlbums, sizeChartOf } = pairSizeCharts(list);
eq(sizeAlbums.sort(), ['1', '11', '13', '4', '6'], 'tabelle riconosciute ("Size", PNG senza colore, "Size" da solo)');
const big = (n) => `https://photo.yupoo.com/yolo66/c${n}/big.png`;
eq([sizeChartOf['2'], sizeChartOf['3']], [big(1), big(1)], 'Solano: tabella prima dei colori');
eq(sizeChartOf['5'], big(4), 'Atom2.0: tabella senza la parola Size');
eq([sizeChartOf['7'], sizeChartOf['8']], [big(6), big(6)], '"Size" senza nome: ai prodotti che seguono');
eq(sizeChartOf['9'], undefined, 'Covert: nessuna tabella, nessun abbinamento');
eq(sizeChartOf['10'], big(11), 'Beta LT XS-XXL ~ tabella Beta LT S-XXL (dopo i prodotti)');
eq(sizeChartOf['12'], big(13), 'ALPHA SV 7代: tabella con titolo più corto');

// Negozi WooCommerce (es. earhive.com): prodotto dalla Store API
const woo = mapWooProduct({ id: 7, name: 'AirPods Pro 2 &#8211; Gen 2', permalink: 'https://earhive.com/product/airpods-pro-2/',
  images: [{ src: 'https://earhive.com/a.jpg' }, { src: '' }, { src: 'https://earhive.com/b.jpg' }],
  prices: { price: '6700', regular_price: '7900', currency_code: 'USD', currency_minor_unit: 2 },
  categories: [{ name: 'Pro &amp; Gen', slug: 'pro-gen' }], short_description: '<p>Con custodia</p>', is_in_stock: true });
eq([woo.title, woo.price, woo.currency, woo.images.length, woo.category, woo.categorySlugs, woo.inStock], ['AirPods Pro 2 – Gen 2', 67, 'USD', 2, 'Pro & Gen', ['pro-gen'], true], 'WooCommerce: prezzo in centesimi, entità HTML, foto vuote tolte');
eq(mapWooProduct({ id: 8, name: 'X', prices: { regular_price: '1500', currency_minor_unit: 2 }, is_in_stock: false }).price, 15, 'WooCommerce: senza prezzo scontato usa il prezzo pieno');

console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
