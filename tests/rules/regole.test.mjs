// Prova di firestore.rules nell'emulatore (npm test in questa cartella).
// Ogni controllo corrisponde a un punto dell'audit di sicurezza (blocco A).
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, addDoc, updateDoc, collection, getDocs, query, where, serverTimestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-lillofind',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

let pass = 0, fail = 0;
async function prova(nome, fn) {
  try { await fn(); pass++; console.log('  ok  ' + nome); }
  catch (e) { fail++; console.log('  KO  ' + nome + ' — ' + (e && e.message ? e.message.split('\n')[0] : e)); }
}

const db = (uid, token) => (uid ? env.authenticatedContext(uid, token) : env.unauthenticatedContext()).firestore();
const verificata = (email, extra = {}) => ({ email, email_verified: true, ...extra });
const nonVerificata = (email) => ({ email, email_verified: false });
const anonimo = { firebase: { sign_in_provider: 'anonymous' } };

await env.withSecurityRulesDisabled(async (ctx) => {
  const a = ctx.firestore();
  await setDoc(doc(a, 'products', 'p1'), { name: 'Polo', price: 20 });
  await setDoc(doc(a, 'products_private', 'p1'), { costEUR: 7, supplierPriceCNY: 50, sourceUrl: 'https://x.yupoo.com/1' });
  await setDoc(doc(a, 'orders', 'o1'), { uid: 'cliente', email: 'cliente@x.it', total: 50 });
  await setDoc(doc(a, 'users', 'cliente'), { email: 'cliente@x.it', lfpoints: 10 });
  await setDoc(doc(a, 'groupOrders', 'LFPRIV01'), { code: 'LFPRIV01', title: 'Privato', hostUid: 'host', maxPeople: 5,
    visibility: 'private', status: 'open', members: [{ uid: 'host', name: 'H' }], memberUids: ['host'] });
  await setDoc(doc(a, 'groupOrders', 'LFPUBB01'), { code: 'LFPUBB01', title: 'Pubblico', hostUid: 'host', maxPeople: 5,
    visibility: 'public', status: 'open', members: [{ uid: 'host', name: 'H' }], memberUids: ['host'] });
});

console.log('== 2. admin: email della lista solo se verificata, o claim admin ==');
await prova('email admin NON verificata non è admin', () => assertFails(getDocs(collection(db('x', nonVerificata('admin@lillofind.com')), 'orders'))));
await prova('email admin verificata è admin', () => assertSucceeds(getDocs(collection(db('y', verificata('yishionvt@gmail.com')), 'orders'))));
await prova('claim admin:true è admin', () => assertSucceeds(getDocs(collection(db('z', { admin: true }), 'orders'))));

console.log('== 3. ordini e profili per email: solo con email verificata ==');
await prova('email del cliente NON verificata non legge il suo ordine', () => assertFails(getDoc(doc(db('altro', nonVerificata('cliente@x.it')), 'orders', 'o1'))));
await prova('email del cliente verificata lo legge', () => assertSucceeds(getDoc(doc(db('altro2', verificata('cliente@x.it')), 'orders', 'o1'))));
await prova('profilo per email NON verificata negato', () => assertFails(getDoc(doc(db('altro', nonVerificata('cliente@x.it')), 'users', 'cliente'))));
await prova('il proprio ordine per uid resta leggibile', () => assertSucceeds(getDoc(doc(db('cliente', {}), 'orders', 'o1'))));

console.log('== 7. costi fornitore privati ==');
await prova('chiunque legge products', () => assertSucceeds(getDoc(doc(db(null), 'products', 'p1'))));
await prova('un visitatore NON legge products_private', () => assertFails(getDoc(doc(db(null), 'products_private', 'p1'))));
await prova('un cliente NON legge products_private', () => assertFails(getDoc(doc(db('cliente', verificata('cliente@x.it')), 'products_private', 'p1'))));
await prova('l\'admin legge products_private', () => assertSucceeds(getDoc(doc(db('y', verificata('yishionvt@gmail.com')), 'products_private', 'p1'))));

console.log('== 12. collezioni pubbliche ==');
await prova('stock_alerts senza utente: negato', () => assertFails(addDoc(collection(db(null), 'stock_alerts'), { productId: 'p1', email: 'a@b.it', notified: false })));
await prova('stock_alerts da ospite anonimo col proprio uid: ok', () => assertSucceeds(addDoc(collection(db('anon1', anonimo), 'stock_alerts'), { productId: 'p1', email: 'a@b.it', uid: 'anon1', notified: false })));
await prova('product_requests senza utente: negato', () => assertFails(addDoc(collection(db(null), 'product_requests'), { note: 'ciao' })));
await prova('product_requests con l\'uid di un altro: negato', () => assertFails(addDoc(collection(db('anon1', anonimo), 'product_requests'), { note: 'ciao', userId: 'altro' })));
await prova('product_requests col proprio uid: ok', () => assertSucceeds(addDoc(collection(db('anon1', anonimo), 'product_requests'), { note: 'ciao', userId: 'anon1' })));
await prova('sessions con country come array: negato', () => assertFails(setDoc(doc(db(null), 'sessions', 's1'), { lastSeen: serverTimestamp(), country: ['IT', 'XX'] })));
await prova('sessions con campi stringa: ok', () => assertSucceeds(setDoc(doc(db(null), 'sessions', 's2'), { lastSeen: serverTimestamp(), vid: 'v1', sid: 's2', country: 'IT', city: 'Roma', ua: 'UA', page: '/' })));

console.log('== 13. recensioni ==');
const rec = (uid, pid, nome) => ({ productId: pid, userId: uid, userName: nome, rating: 5, text: 'ok' });
await prova('recensione con id uid_prodotto e nome dell\'account: ok', () => assertSucceeds(setDoc(doc(db('r1', verificata('mario@x.it', { name: 'Mario' })), 'reviews', 'r1_p1'), rec('r1', 'p1', 'Mario'))));
await prova('seconda recensione sullo stesso prodotto: negata', () => assertFails(setDoc(doc(db('r1', verificata('mario@x.it', { name: 'Mario' })), 'reviews', 'r1_p1'), rec('r1', 'p1', 'Mario'))));
await prova('recensione con id casuale: negata', () => assertFails(addDoc(collection(db('r1', verificata('mario@x.it', { name: 'Mario' })), 'reviews'), rec('r1', 'p1', 'Mario'))));
await prova('recensione con un nome inventato: negata', () => assertFails(setDoc(doc(db('r2', verificata('luigi@x.it', { name: 'Luigi' })), 'reviews', 'r2_p1'), rec('r2', 'p1', 'Brad Pitt'))));
await prova('senza nome nel token vale la parte prima della @', () => assertSucceeds(setDoc(doc(db('r3', verificata('anna@x.it')), 'reviews', 'r3_p1'), rec('r3', 'p1', 'anna'))));

console.log('== 4 e 14. spedizione di gruppo ==');
const gruppo = (code, extra = {}) => ({ code, title: 'Gruppo', hostUid: 'g1', maxPeople: 6, visibility: 'public', status: 'open',
  members: [{ uid: 'g1', name: 'G' }], memberUids: ['g1'], ...extra });
const g1 = () => db('g1', verificata('g1@x.it'));
await prova('creare un gruppo con id = codice: ok', () => assertSucceeds(setDoc(doc(g1(), 'groupOrders', 'LFABC234'), gruppo('LFABC234'))));
await prova('maxPeople non intero (HTML): negato', () => assertFails(setDoc(doc(g1(), 'groupOrders', 'LFABC235'), gruppo('LFABC235', { maxPeople: '<img src=x onerror=alert(1)>' }))));
await prova('codice non valido: negato', () => assertFails(setDoc(doc(g1(), 'groupOrders', 'LF"x\'1'), gruppo('LF"x\'1'))));
await prova('visibility fuori elenco: negata', () => assertFails(setDoc(doc(g1(), 'groupOrders', 'LFABC236'), gruppo('LFABC236', { visibility: 'tutti' }))));
await prova('elenco dei gruppi pubblici: ok', () => assertSucceeds(getDocs(query(collection(db('u9', verificata('u9@x.it')), 'groupOrders'), where('visibility', '==', 'public')))));
await prova('elenco di TUTTI i gruppi (anche privati): negato', () => assertFails(getDocs(collection(db('u9', verificata('u9@x.it')), 'groupOrders'))));
await prova('elenco dei propri gruppi (memberUids): ok', () => assertSucceeds(getDocs(query(collection(db('host', verificata('h@x.it')), 'groupOrders'), where('memberUids', 'array-contains', 'host')))));
await prova('entrare in un gruppo privato col codice (get per id): ok', () => assertSucceeds(getDoc(doc(db('u9', verificata('u9@x.it')), 'groupOrders', 'LFPRIV01'))));
await prova('unirsi aggiungendo solo se stessi: ok', () => assertSucceeds(updateDoc(doc(db('u9', verificata('u9@x.it')), 'groupOrders', 'LFPUBB01'),
  { members: [{ uid: 'host', name: 'H' }, { uid: 'u9', name: 'U' }], memberUids: ['host', 'u9'] })));
await prova('aggiungere un altro al posto proprio: negato', () => assertFails(updateDoc(doc(db('u8', verificata('u8@x.it')), 'groupOrders', 'LFPUBB01'),
  { members: [{ uid: 'host', name: 'H' }, { uid: 'u9', name: 'U' }, { uid: 'u7', name: 'X' }], memberUids: ['host', 'u9', 'u7'] })));

console.log('== 21. newsletter ==');
const nl = (uid, email, extra = {}) => ({ email, uid, ts: serverTimestamp(), ...extra });
await prova('iscrizione col proprio uid (anche anonimo): ok', () => assertSucceeds(addDoc(collection(db('anon1', anonimo), 'newsletter'), nl('anon1', 'a@b.it'))));
await prova('iscrizione senza login: negata', () => assertFails(addDoc(collection(db(null), 'newsletter'), nl('x', 'a@b.it'))));
await prova('iscrizione con l\'uid di un altro: negata', () => assertFails(addDoc(collection(db('anon1', anonimo), 'newsletter'), nl('altro', 'a@b.it'))));
await prova('email non valida: negata', () => assertFails(addDoc(collection(db('anon1', anonimo), 'newsletter'), nl('anon1', '<script>'))));
await prova('campi in piu\': negati', () => assertFails(addDoc(collection(db('anon1', anonimo), 'newsletter'), nl('anon1', 'a@b.it', { admin: true }))));
await prova('leggere la lista iscritti da utente: negato', () => assertFails(getDocs(collection(db('anon1', anonimo), 'newsletter'))));
await prova('l\'admin legge la lista iscritti', () => assertSucceeds(getDocs(collection(db('y', verificata('yishionvt@gmail.com')), 'newsletter'))));

await env.cleanup();
console.log(`\n${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
