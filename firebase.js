/* ══════════════════════════════════════════════
   LILLOFIND — Firebase Shared Init
   Usato da: index.html, admin.html, vault.html
   ══════════════════════════════════════════════ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore,collection,addDoc,getDocs,doc,getDoc,setDoc,updateDoc,deleteDoc,deleteField,serverTimestamp,query,orderBy,where } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth,createUserWithEmailAndPassword,signInWithEmailAndPassword,signOut,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,updatePassword,EmailAuthProvider,reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFunctions,httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const cfg={apiKey:"AIzaSyAZJ69_Nv-oTEINkhLAxjmPjsOO6QfIFkg",authDomain:"lillofind-c455c.firebaseapp.com",projectId:"lillofind-c455c",storageBucket:"lillofind-c455c.firebasestorage.app",messagingSenderId:"49368493660",appId:"1:49368493660:web:22e02baaa3a2f1cf2a0099"};
const app=initializeApp(cfg);
const _googleProvider=new GoogleAuthProvider();
_googleProvider.setCustomParameters({prompt:'select_account'});
const _functions=getFunctions(app,'europe-west1');
const _auth=getAuth(app);
window.__fb={db:getFirestore(app),auth:_auth,functions:_functions,httpsCallable,collection,addDoc,getDocs,doc,getDoc,setDoc,updateDoc,deleteDoc,deleteField,serverTimestamp,query,orderBy,where,createUserWithEmailAndPassword,signInWithEmailAndPassword,signOut,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,updatePassword,EmailAuthProvider,reauthenticateWithCredential,_googleProvider};

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
