// ════════════════════════════════════════════════════════════════
// Limiti di frequenza, salvati su Firestore (rate_limits/{chiave}).
//
// Prima un ospite anonimo poteva creare ordini bonifico/PayPal senza fine,
// e ognuno spediva un'email di conferma a un indirizzo scelto da lui: un
// modo gratuito per mandare spam firmato LilloFind. Qui ogni azione ha un
// tetto per finestra di tempo, per utente e per indirizzo IP.
//
// Non e' un contatore perfetto (due richieste nello stesso istante possono
// leggere lo stesso valore), ma per fermare gli abusi basta: chi spamma fa
// centinaia di richieste, non due.
// ════════════════════════════════════════════════════════════════
import { HttpsError } from './errors.js';

export async function limita(db, chiave, max, finestraSec, messaggio) {
  if (!db || !chiave) return;
  const id = String(chiave).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 140);
  const ora = Date.now();
  let count = 0, resetAt = ora + finestraSec * 1000;
  try {
    const s = await db.getDoc('rate_limits', id);
    if (s.exists) {
      const d = s.data() || {};
      if (Number(d.resetAt) > ora) { count = Number(d.count) || 0; resetAt = Number(d.resetAt); }
    }
  } catch (e) { console.error('limita: lettura', e && e.message); return; } // Firestore giu': non si blocca nessuno
  if (count >= max) throw new HttpsError('resource-exhausted', messaggio || 'Troppe richieste: riprova più tardi.');
  try { await db.setDoc('rate_limits', id, { count: count + 1, resetAt, key: id }); }
  catch (e) { console.error('limita: scrittura', e && e.message); }
}
