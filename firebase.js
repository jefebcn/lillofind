/* ══════════════════════════════════════════════
   LILLOFIND — Firebase Shared Init
   Usato da: index.html, admin.html
   ══════════════════════════════════════════════ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore,collection,addDoc,getDocs,doc,getDoc,setDoc,updateDoc,deleteDoc,deleteField,serverTimestamp,query,orderBy,where } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth,createUserWithEmailAndPassword,signInWithEmailAndPassword,signOut,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,updatePassword,EmailAuthProvider,reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const cfg={apiKey:"AIzaSyAZJ69_Nv-oTEINkhLAxjmPjsOO6QfIFkg",authDomain:"lillofind-c455c.firebaseapp.com",projectId:"lillofind-c455c",storageBucket:"lillofind-c455c.firebasestorage.app",messagingSenderId:"49368493660",appId:"1:49368493660:web:22e02baaa3a2f1cf2a0099"};
const app=initializeApp(cfg);
const _googleProvider=new GoogleAuthProvider();
_googleProvider.setCustomParameters({prompt:'select_account'});
window.__fb={db:getFirestore(app),auth:getAuth(app),collection,addDoc,getDocs,doc,getDoc,setDoc,updateDoc,deleteDoc,deleteField,serverTimestamp,query,orderBy,where,createUserWithEmailAndPassword,signInWithEmailAndPassword,signOut,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,updatePassword,EmailAuthProvider,reauthenticateWithCredential,_googleProvider};
