/* ══════════════════════════════════════════════
   LILLOFIND — Firebase Shared Init
   Usato da: index.html, admin.html, vault.html
   ══════════════════════════════════════════════ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore,collection,addDoc,getDocs,doc,getDoc,setDoc,updateDoc,deleteDoc,deleteField,serverTimestamp,query,orderBy,where,limit,startAfter,writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth,updateProfile,createUserWithEmailAndPassword,signInWithEmailAndPassword,signInAnonymously,signOut,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,updatePassword,EmailAuthProvider,reauthenticateWithCredential,sendPasswordResetEmail,sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFunctions,httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const cfg={apiKey:"AIzaSyAZJ69_Nv-oTEINkhLAxjmPjsOO6QfIFkg",authDomain:"lillofind-c455c.firebaseapp.com",projectId:"lillofind-c455c",storageBucket:"lillofind-c455c.firebasestorage.app",messagingSenderId:"49368493660",appId:"1:49368493660:web:22e02baaa3a2f1cf2a0099"};
const app=initializeApp(cfg);
const _googleProvider=new GoogleAuthProvider();
_googleProvider.setCustomParameters({prompt:'select_account'});
const _functions=getFunctions(app,'europe-west1');
const _auth=getAuth(app);
window.__fb={db:getFirestore(app),auth:_auth,functions:_functions,httpsCallable,collection,addDoc,getDocs,doc,getDoc,setDoc,updateDoc,deleteDoc,deleteField,serverTimestamp,query,orderBy,where,limit,startAfter,writeBatch,createUserWithEmailAndPassword,signInWithEmailAndPassword,signInAnonymously,signOut,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,updatePassword,EmailAuthProvider,reauthenticateWithCredential,sendPasswordResetEmail,sendEmailVerification,updateProfile,_googleProvider};

/* ══════════════════════════════════════════════
   Campi privati dei prodotti → products_private
   costEUR, supplierPriceCNY, sourceUrl… stavano nei documenti `products`,
   che chiunque può leggere: margini e fornitori erano pubblici. Ora le
   scritture su products/{id} li mandano in products_private/{id} (solo
   admin, vedi firestore.rules) e le letture dell'admin li rimettono
   insieme, così le pagine admin non cambiano. Stesso elenco del Worker
   (cloudflare-worker/src/lib/product-private.js).
   ══════════════════════════════════════════════ */
(function(fb){
  const PRIV=['costEUR','costFx','costFxDate','costUpdatedAt','supplierPriceCNY','sourceUrl'];
  const isProdRef=(r)=>!!(r&&r.parent&&r.parent.id==='products'&&r.id);
  // Testi del fornitore ripuliti PRIMA di salvarli (importer, scraper,
  // admin): niente tag HTML in nome, marchio, modello, stile, descrizione.
  // Lo shop scappa comunque tutto in visualizzazione: questa è la seconda difesa.
  const TESTI=['name','brand','model','style','description','category','size'];
  const pulisci=(v)=>typeof v==='string'?v.replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'').replace(/[<>]/g,''):v;
  const split=(o)=>{ const pub={},priv={}; for(const k of Object.keys(o||{})){ const v=TESTI.includes(k)?pulisci(o[k]):(k==='sizes'&&Array.isArray(o[k])?o[k].map(pulisci):o[k]); (PRIV.includes(k)?priv:pub)[k]=v; } return {pub,priv}; };
  const privRef=(id)=>doc(fb.db,'products_private',id);
  const scriviPriv=(id,priv)=>Object.keys(priv).length?setDoc(privRef(id),priv,{merge:true}):Promise.resolve();
  const _add=fb.addDoc,_set=fb.setDoc,_upd=fb.updateDoc,_del=fb.deleteDoc,_getDocs=fb.getDocs,_getDoc=fb.getDoc;
  fb.addDoc=async function(col,data){
    if(!(col&&col.path==='products')) return _add.apply(this,arguments);
    const {pub,priv}=split(data); const ref=await _add.call(this,col,pub); await scriviPriv(ref.id,priv); return ref;
  };
  fb.setDoc=async function(ref,data,opts){
    if(!isProdRef(ref)) return _set.apply(this,arguments);
    const {pub,priv}=split(data); const r=await _set.call(this,ref,pub,opts); await scriviPriv(ref.id,priv); return r;
  };
  fb.updateDoc=async function(ref,data){
    if(!isProdRef(ref)||typeof data!=='object') return _upd.apply(this,arguments);
    const {pub,priv}=split(data); if(Object.keys(pub).length) await _upd.call(this,ref,pub); await scriviPriv(ref.id,priv);
  };
  // Anche le scritture a lotti (admin: correzioni di massa, link alla fonte).
  const _batch=fb.writeBatch;
  fb.writeBatch=function(){
    const b=_batch.apply(this,arguments);
    const scrivi=(metodo)=>function(ref,data,opts){
      if(!isProdRef(ref)||typeof data!=='object') return b[metodo](ref,data,opts);
      const {pub,priv}=split(data);
      if(Object.keys(pub).length||metodo==='set') (opts?b[metodo](ref,pub,opts):b[metodo](ref,pub));
      if(Object.keys(priv).length) b.set(privRef(ref.id),priv,{merge:true});
      return w;
    };
    const w={ set:scrivi('set'), update:scrivi('update'), delete:(ref)=>{ b.delete(ref); return w; }, commit:()=>b.commit() };
    return w;
  };
  fb.deleteDoc=async function(ref){
    const r=await _del.apply(this,arguments);
    if(isProdRef(ref)) { try{ await _del.call(this,privRef(ref.id)); }catch(_){ /* non admin o già assente */ } }
    return r;
  };
  // Letture: per l'admin si aggiungono i campi privati; per tutti gli altri
  // la lettura di products_private è negata e si restituisce il dato com'è.
  // Ci prova solo chi potrebbe essere admin (account vero con email
  // verificata), e una volta che gli e' stato negato non ci riprova: i
  // visitatori dello shop non devono fare una lettura negata a ogni pagina.
  let negato=false;
  const potrebbeEssereAdmin=()=>{ const u=fb.auth.currentUser; return !negato&&!!u&&!u.isAnonymous&&u.emailVerified; };
  const unisci=(snap,priv)=>priv?{id:snap.id,ref:snap.ref,metadata:snap.metadata,exists:()=>snap.exists(),get:(k)=>({...snap.data(),...priv})[k],data:()=>snap.exists()?{...snap.data(),...priv}:undefined}:snap;
  fb.getDocs=async function(q){
    const s=await _getDocs.apply(this,arguments);
    if(!s.docs.length||!s.docs.some(d=>isProdRef(d.ref))||!potrebbeEssereAdmin()) return s;
    let privati;
    try{
      privati={};
      // pochi prodotti: si leggono solo i loro; tanti: tutta la collezione in una volta
      const ids=s.docs.filter(d=>isProdRef(d.ref)).map(d=>d.id);
      if(ids.length<=50){ (await Promise.all(ids.map(id=>_getDoc.call(this,privRef(id))))).forEach(p=>{ if(p.exists()) privati[p.id]=p.data(); }); }
      else { const p=await _getDocs.call(this,collection(fb.db,'products_private')); p.docs.forEach(d=>{privati[d.id]=d.data();}); }
    }
    catch(_){ negato=true; return s; }
    const docs=s.docs.map(d=>unisci(d,privati[d.id]));
    return {docs,size:s.size,empty:s.empty,metadata:s.metadata,query:s.query,docChanges:()=>s.docChanges(),forEach:(f,t)=>docs.forEach(f,t)};
  };
  fb.getDoc=async function(ref){
    const s=await _getDoc.apply(this,arguments);
    if(!isProdRef(ref)||!s.exists()||!potrebbeEssereAdmin()) return s;
    try{ const p=await _getDoc.call(this,privRef(ref.id)); return p.exists()?unisci(s,p.data()):s; }catch(_){ negato=true; return s; }
  };
})(window.__fb);

// Un utente serve per scrivere richieste e avvisi (firestore.rules ora lo
// chiede: prima chiunque, anche senza sessione, poteva riempire quelle
// collezioni). Chi non ha fatto l'accesso entra come ospite anonimo, come
// già succede al checkout.
window.lfAssicuraUtente = async function(){
  if(_auth.currentUser) return _auth.currentUser;
  const c = await signInAnonymously(_auth);
  return c.user;
};

/* ══════════════════════════════════════════════
   BACKEND su Cloudflare Workers (sostituisce le Cloud Functions)
   ⚠️  IMPOSTA QUI l'URL del tuo Worker dopo il deploy (vedi
       cloudflare-worker/README.md). Esempio:
       const WORKER_BASE = "https://lillofind-worker.tuonome.workers.dev";
   ══════════════════════════════════════════════ */
const WORKER_BASE = "https://lillofind.conti9708.workers.dev";
window.LF_WORKER_BASE = WORKER_BASE;

// Shim compatibile con httpsCallable: lfCallable('nome')(data) → {data: result}
// Replica il protocollo Firebase callable ma punta al Worker Cloudflare.
window.lfCallable = function(name){
  return async function(data){
    let token = '';
    try { if(_auth.currentUser) token = await _auth.currentUser.getIdToken(); } catch(_){}
    const resp = await fetch(WORKER_BASE + '/' + name, {
      method:'POST',
      headers: Object.assign({'Content-Type':'application/json'}, token?{'Authorization':'Bearer '+token}:{}),
      body: JSON.stringify({ data: data || {} }),
    });
    let json = {};
    try { json = await resp.json(); } catch(_){}
    if(!resp.ok || (json && json.error)){
      const err = new Error((json && json.error && json.error.message) || ('Errore HTTP '+resp.status));
      if(json && json.error && json.error.status) err.code = json.error.status;
      throw err;
    }
    return { data: json.result };
  };
};
