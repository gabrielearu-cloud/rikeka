// =====================================================================
// NOTIFICHE PUSH (anche ad app chiusa)
// - Il telefono/browser registra un "token" e lo salviamo in /pushTokens/{uid}
//   (leggibile e modificabile solo dal proprietario).
// - Quando succede qualcosa (nuovo messaggio, consegna, ...) l'app chiama
//   la funzione /api/notify su Vercel, che controlla che l'evento sia vero
//   e invia la notifica tramite Firebase Cloud Messaging (gratuito).
// =====================================================================
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { app, auth, db } from './firebase.js';
import { VAPID_KEY, NOTIFY_URL } from './config.js';
import { logEvent, reportError } from './logger.js';
import { $ } from './utils.js';

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

async function supported() {
  try {
    return !!VAPID_KEY && 'serviceWorker' in navigator && 'Notification' in window && (await isSupported());
  } catch (_) { return false; }
}

/**
 * Aggiorna i riquadri delle notifiche: nel Profilo (sempre visibile, mostra lo stato)
 * e in cima alla lista Chat (visibile solo finche' le notifiche non sono attive).
 */
function paint(stato, testo, mostraPulsante) {
  const profilo = $('push-box'), chat = $('push-box-chat');
  if (profilo) {
    profilo.classList.toggle('hidden', stato === 'off');
    $('push-info').textContent = testo;
    $('push-btn').classList.toggle('hidden', !mostraPulsante);
    $('push-test-btn')?.classList.toggle('hidden', stato !== 'attive');
  }
  if (chat) {
    // in Chat non disturbiamo se sono gia' attive o se il dispositivo non le supporta
    chat.classList.toggle('hidden', ['off', 'attive', 'non-supportate'].includes(stato));
    $('push-info-chat').textContent = stato === 'da-attivare'
      ? '🔔 Vuoi sapere subito quando qualcuno ti scrive, anche ad app chiusa?'
      : testo;
    $('push-btn-chat').classList.toggle('hidden', !mostraPulsante);
  }
}

export async function initPushUi() {
  if (!VAPID_KEY) return paint('off', '', false);

  if (isIos && !isStandalone) {
    return paint('ios-browser', "Su iPhone le notifiche funzionano solo dall'app installata: Safari → Condividi □↑ → Aggiungi alla schermata Home, poi apri Rikeka dall'icona.", false);
  }
  if (!(await supported())) return paint('non-supportate', 'Questo browser non supporta le notifiche.', false);
  if (Notification.permission === 'denied') {
    return paint('bloccate', 'Notifiche bloccate: riattivale dalle impostazioni del browser (icona del lucchetto accanto all\'indirizzo → Notifiche → Consenti).', false);
  }
  if (Notification.permission === 'granted') {
    // Rinnova il token in silenzio (i token possono cambiare nel tempo)
    registerToken().catch((e) => reportError('push.refresh', e));
    return paint('attive', '🔔 Notifiche attive su questo dispositivo.', false);
  }
  paint('da-attivare', 'Ricevi un avviso per nuovi messaggi e per i tuoi scambi, anche ad app chiusa.', true);
  proponiNotifiche();
}

// ---------- Invito automatico ad attivare le notifiche ----------
// Compare da solo (non serve cercarlo nel Profilo): subito al primo avvio dell'app
// installata, oppure nel browser. Se si sceglie "Più tardi" ricompare dopo 3 giorni,
// al massimo 4 volte. Il permesso vero lo chiede il browser al tocco su "Attiva".
const CHIAVE_INVITO = 'rk_invito_notifiche';
let invitoInCorso = false;
function leggiInvito() {
  try { return JSON.parse(localStorage.getItem(CHIAVE_INVITO) || 'null') || { volte: 0, ultimo: 0 }; }
  catch (_) { return { volte: 0, ultimo: 0 }; }
}
function salvaInvito(v) { try { localStorage.setItem(CHIAVE_INVITO, JSON.stringify(v)); } catch (_) {} }
const altraFinestraAperta = () => [...document.querySelectorAll('.modal-overlay')]
  .some((m) => m.id !== 'push-modal' && getComputedStyle(m).display !== 'none')
  || !document.getElementById('camera-modal')?.classList.contains('hidden');

function proponiNotifiche() {
  if (invitoInCorso || !auth.currentUser || Notification.permission !== 'default') return;
  const v = leggiInvito();
  // primo avvio dell'app installata: si propone sempre, anche se nel browser si era detto "Più tardi"
  const primoAvvioApp = isStandalone && !v.app;
  if (!primoAvvioApp && (v.volte >= 4 || (v.ultimo && Date.now() - v.ultimo < 3 * 864e5))) return;
  invitoInCorso = true;
  // aspetta che non ci siano altre finestre aperte (Termini, zona, benvenuto…)
  let tentativi = 0;
  const prova = () => {
    if (!auth.currentUser || Notification.permission !== 'default') { invitoInCorso = false; return; }
    if (altraFinestraAperta() && tentativi++ < 120) { setTimeout(prova, 2000); return; }
    const m = $('push-modal');
    if (!m) { invitoInCorso = false; return; }
    $('push-modal-app').classList.toggle('hidden', !isStandalone);
    m.style.display = 'flex';
    salvaInvito({ volte: v.volte + 1, ultimo: Date.now(), app: v.app || isStandalone });
    logEvent('push_prompt_shown', { standalone: isStandalone, volta: v.volte + 1 });
  };
  setTimeout(prova, isStandalone ? 1500 : 4000);
}

window.attivaDaInvito = async function () {
  $('push-modal').style.display = 'none';
  invitoInCorso = false;
  await window.enablePush();
  if (Notification.permission === 'granted') salvaInvito({ volte: 99, ultimo: Date.now(), app: true });
};
window.rimandaInvitoNotifiche = function () {
  $('push-modal').style.display = 'none';
  invitoInCorso = false;
  logEvent('push_prompt_later', {});
};

async function registerToken() {
  const me = auth.currentUser;
  if (!me) return null;
  const reg = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(app), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) return null;
  const ref = doc(db, 'pushTokens', me.uid);
  const snap = await getDoc(ref);
  const tokens = (snap.exists() ? snap.data().tokens || [] : []).filter((t) => t !== token);
  tokens.unshift(token);
  await setDoc(ref, { tokens: tokens.slice(0, 5), updatedAt: serverTimestamp() });
  return token;
}

window.enablePush = async function () {
  try {
    const perm = await Notification.requestPermission();   // va chiamato da un tocco dell'utente
    if (perm !== 'granted') { await initPushUi(); return; }
    await registerToken();
    logEvent('push_enabled', { ios: isIos });
    await initPushUi();
  } catch (e) {
    reportError('enablePush', e);
    alert('Non è stato possibile attivare le notifiche: ' + (e?.message || e));
  }
};

// Prova dal Profilo: registra di nuovo questo dispositivo e si manda una notifica
window.testPushProfilo = async function () {
  const btn = $('push-test-btn'), out = $('push-test-out');
  btn.disabled = true; btn.textContent = 'Verifica in corso…';
  out.classList.remove('hidden'); out.replaceChildren();
  try {
    const righe = await testPushDiagnostics();
    out.replaceChildren(...righe.map(([ok, testo]) => {
      const li = document.createElement('li');
      li.textContent = (ok === true ? '✓ ' : ok === false ? '✗ ' : 'ℹ ') + testo;
      li.className = ok === false ? 'text-red-700' : ok === true ? 'text-green-800' : 'text-gray-600';
      return li;
    }));
    logEvent('push_test_profile', { ok: righe.every(([ok]) => ok !== false) });
  } catch (e) {
    reportError('testPushProfilo', e);
  } finally {
    btn.disabled = false; btn.textContent = 'Mandami una notifica di prova';
  }
};

/** Da chiamare all'eliminazione dell'account. */
export async function removePushTokens(uid) {
  try { await deleteDoc(doc(db, 'pushTokens', uid)); } catch (_) { /* nessun token */ }
}

/**
 * Chiede al server di avvisare l'altra persona. Non blocca mai l'app:
 * se la notifica non parte, l'evento resta comunque salvato.
 * type: 'message' (chatId) | 'reserved' | 'delivered' | 'not_received' | 'concluded' | 'reviewed' (offerId)
 */
export async function notify(type, ids) {
  try {
    if (!VAPID_KEY || !auth.currentUser) return;
    const idToken = await auth.currentUser.getIdToken();
    await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
      body: JSON.stringify({ type, ...ids }),
      keepalive: true
    });
  } catch (e) {
    console.warn('Notifica non inviata:', e);
  }
}

/**
 * Verifica passo per passo perché le notifiche potrebbero non arrivare.
 * Restituisce righe [esito, testo]: true = ok, false = problema, null = informazione.
 */
export async function testPushDiagnostics() {
  const r = [];
  const esci = () => r;

  // 1. Dispositivo e browser
  if (isIos && !isStandalone) { r.push([false, "Su iPhone serve l'app installata sulla schermata Home (Safari → Condividi → Aggiungi alla schermata Home)."]); return esci(); }
  if (!(await supported())) { r.push([false, 'Questo browser non supporta le notifiche (es. browser vecchi o Windows 7). Prova da Chrome sul telefono.']); return esci(); }
  r.push([true, 'Il browser supporta le notifiche.']);

  // 2. Permesso
  if (Notification.permission === 'denied') { r.push([false, 'Notifiche bloccate per questo sito: lucchetto accanto all\'indirizzo → Notifiche → Consenti, poi riprova.']); return esci(); }
  if (Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') { r.push([false, 'Permesso non concesso.']); return esci(); }
  }
  r.push([true, 'Permesso concesso.']);

  // 3. Service worker e token
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg?.active) { r.push([false, 'Il service worker non è attivo: ricarica la pagina e riprova.']); return esci(); }
  try {
    const t = await registerToken();
    if (!t) throw new Error('nessun token');
    r.push([true, 'Dispositivo registrato per le notifiche.']);
  } catch (e) {
    r.push([false, 'Registrazione del dispositivo fallita: ' + (e?.message || e) + ' (controlla VAPID_KEY in js/config.js).']);
    return esci();
  }

  // 4. Server su Vercel
  let info;
  try {
    const res = await fetch(NOTIFY_URL, { cache: 'no-store' });
    if (res.status === 404) { r.push([false, 'La funzione /api/notify non esiste sul sito: su GitHub mancano la cartella "api" o il file "package.json" (nella cartella principale).']); return esci(); }
    info = await res.json();
  } catch (_) {
    r.push([false, 'La funzione /api/notify non risponde: controlla che "api/notify.js" e "package.json" siano su GitHub e che il deploy di Vercel sia riuscito.']);
    return esci();
  }
  if (!info.ok) { r.push([false, `Server non configurato: ${info.problem}. Vercel → Settings → Environment Variables → FIREBASE_SERVICE_ACCOUNT, poi Deployments → Redeploy.`]); return esci(); }
  if (info.projectId && info.projectId !== app.options.projectId) {
    r.push([false, `La chiave su Vercel è del progetto "${info.projectId}", l'app usa "${app.options.projectId}". Genera la chiave dal progetto giusto.`]);
    return esci();
  }
  r.push([true, 'Server configurato correttamente.']);

  // 5. Invio di prova a questo account
  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
      body: JSON.stringify({ type: 'test' })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { r.push([false, `Errore del server (${res.status}): ${out.code || out.error || 'sconosciuto'}. Dettagli in Vercel → Logs.`]); return esci(); }
    if (out.reason === 'throttled') { r.push([null, 'Hai già fatto una prova meno di un minuto fa: attendi e riprova.']); return esci(); }
    if (!out.sent) { r.push([false, `Notifica non consegnata${out.errors?.length ? ': ' + out.errors.join(', ') : ''}.`]); return esci(); }
    r.push([true, `Notifica di prova inviata a ${out.sent} dispositivo/i: dovrebbe comparire tra pochi secondi.`]);
    r.push([null, 'Se non compare: controlla che le notifiche di Chrome siano permesse nelle impostazioni del telefono e che non sia attiva la modalità "Non disturbare".']);
  } catch (e) {
    r.push([false, 'Invio di prova fallito: ' + (e?.message || e)]);
  }
  return r;
}
