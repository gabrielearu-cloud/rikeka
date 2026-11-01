// =====================================================================
// RIKEKA - LOGICA PRINCIPALE
// Sezioni: 1 Import · 2 Stato locale · 3 Navigazione · 4 Catalogo
//          5 Form pubblicazione · 6 Auth · 7 Chat · 8 Annunci
//          9 Scambio e KP · 10 Segnalazioni · 11 Foto/lightbox
//          12 Render · 13 Profilo · 14 Avvio
// =====================================================================

// ---------- 1. IMPORT ----------
import { signInWithPopup, onAuthStateChanged, signOut, reauthenticateWithPopup, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, query, where, onSnapshot, doc, updateDoc, getDoc, setDoc, orderBy,
  getDocs, limit, runTransaction, serverTimestamp, writeBatch, increment, deleteField, deleteDoc,
  terminate, clearIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, googleProvider } from './firebase.js';
import { PAGE_SIZE, FOTO_MAX_CHARS, THUMB_MAX_CHARS, LEGAL } from './config.js';
import { valutaBene, valutaServizio, esitoPubblicazione, suggerisciSottocategorie, minFotoBeni, kpPrimoScambio, gruppiOrdinati, iconaGruppo, cercaSottocategorie, paroleChiaveAnnuncio, terminiRicerca, normalizzaTesto } from './catalog.js';
import { distanzaKm, etichettaDistanza, cercaComuni, posizioneAttuale, zonaValida } from './geo.js';
import { state } from './state.js';
import { logEvent, reportError, friendlyError } from './logger.js';
import { $, val, esc, sid, safeImg, tsToDate, compressImage } from './utils.js';
import { checkAdmin } from './admin.js';
import { notify, initPushUi, removePushTokens } from './push.js';
import './install.js';
import { parolaVietata } from './filtro.js';

// ---------- 2. STATO LOCALE ----------
let currentOfferType = 'bene';
let onlyAffordable = false;
let currentChatId = null;
const repCache = new Map();   // reputazione: uid -> dati utente (o Promise in corso)
let lastKnownKarma = null;
let homePages = 1;
let homeOffers = [];          // [{id, data}] annunci visibili in home
let myOffers = [];            // [{id, data}] annunci dell'utente (tutti gli stati)
let myOfferStatus = new Map();
let pendingFotos = [null, null, null];   // { full, thumb }
let lightboxState = { images: [], index: 0 };

let hasUnreadMessages = false;
let unreadChatIds = [];
let allChatsData = [];
let hasNewProfileUpdate = false;
let emailRemovalTried = false;

let toReceive = [];           // [{id, data}] annunci riservati a me (in trattativa o consegnati)
let toReceiveStatus = new Map();
let ricevutiConclusi = [];     // [{id, data}] scambi in cui ho ricevuto, già conclusi (per lo storico)

let unsub = { offers: null, myOffers: null, toReceive: null, chats: null, profile: null, messages: null, chatOffer: null, catalog: null, contestB: null, contestO: null };
const contestazioni = new Map();   // offerId -> contestazione (come chi riceve o chi regala)

// Il profilo nuovo va creato solo dopo aver letto il catalogo (serve kpIniziali)
let catalogReady, resolveCatalogReady;
function resetCatalogReady() { catalogReady = new Promise((r) => { resolveCatalogReady = r; }); }
resetCatalogReady();

const STATUS_LABEL = {
  disponibile:   { text: 'Disponibile',    cls: 'bg-green-100 text-green-700 border-green-200' },
  in_trattativa: { text: 'In Trattativa',  cls: 'bg-yellow-200 text-yellow-800 border-yellow-300' },
  consegnato:    { text: 'Da confermare',  cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  in_verifica:   { text: 'In verifica',    cls: 'bg-purple-100 text-purple-700 border-purple-200' },
  rifiutato:     { text: 'Rifiutato',      cls: 'bg-red-100 text-red-700 border-red-200' },
  concluso:      { text: 'Concluso',       cls: 'bg-gray-200 text-gray-700 border-gray-300' }
};

// ---------- 3. NAVIGAZIONE ----------
export function switchScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $(screenId);
  if (el) {
    el.classList.add('active');
    $('login-screen').style.display = 'none';
  }
}

window.navigate = function (screenId, element) {
  switchScreen(screenId);
  document.querySelectorAll('.tab-item').forEach((i) => i.classList.remove('active'));
  element?.classList.add('active');
  if (screenId === 'chat-list-screen') renderChatList();
  if (screenId === 'publish-screen') updateValuePreview();
  if (screenId === 'profile-screen') {
    hasNewProfileUpdate = false;
    updateProfileTabIndicator();
    document.querySelector('#profile-data .new-kp-badge')?.remove();
  }
};

function setIndicator(tabId, show) {
  const tab = $(tabId);
  if (!tab) return;
  let indicator = tab.querySelector('.unread-indicator');
  const box = tab.querySelector('div');
  if (show && !indicator) {
    indicator = document.createElement('span');
    indicator.className = 'unread-indicator absolute top-1 right-1 block h-2 w-2 rounded-full bg-red-500 ring-2 ring-white';
    box?.appendChild(indicator);
  }
  if (indicator) indicator.style.display = show ? 'block' : 'none';
}
// Scheda Chat: pallino rosso con il numero di chat da leggere (+ pallino sull'icona dell'app, dove supportato)
const updateChatTabIndicator = () => {
  const n = unreadChatIds.length;
  setIndicator('nav-chat', n > 0);
  const dot = $('nav-chat')?.querySelector('.unread-indicator');
  if (dot) { dot.textContent = n > 9 ? '9+' : String(n); dot.classList.add('unread-count'); }
  try { if (n > 0) navigator.setAppBadge?.(n); else navigator.clearAppBadge?.(); } catch (_) {}
};
// Pallino sul Profilo: novità, oppure qualcosa che tocca a me (confermare una ricezione, dare un giudizio)
let giudiziDaDare = 0;
const updateProfileTabIndicator = () => setIndicator('nav-profile', hasNewProfileUpdate || giudiziDaDare > 0
  || toReceive.some((o) => o.data.status === 'consegnato'));

window.switchHomeTab = function (type, element) {
  document.querySelectorAll('.home-tab-content').forEach((c) => c.classList.add('hidden'));
  ['tab-btn-beni', 'tab-btn-servizi'].forEach((id) => {
    $(id).classList.remove('bg-green-600', 'bg-blue-600', 'text-white', 'shadow-lg');
    $(id).classList.add('text-gray-700', 'hover:bg-gray-200');
  });
  $('home-' + type).classList.remove('hidden');
  element.classList.remove('text-gray-700', 'hover:bg-gray-200');
  element.classList.add(type === 'bene' ? 'bg-green-600' : 'bg-blue-600', 'text-white', 'shadow-lg');
};

window.toggleAffordable = function (checked) {
  onlyAffordable = !!checked;
  renderOffers();
};

// ---------- 4. CATALOGO ----------
function subscribeCatalog() {
  unsub.catalog = onSnapshot(doc(db, 'config', 'catalogo'), (snap) => {
    if (snap.exists()) {
      state.catalog = snap.data();
      state.catalogOnServer = true;
    } else {
      state.catalogOnServer = false;
    }
    resolveCatalogReady();
    populateSelects();
    renderOffers();
    renderMyOffers();
    document.dispatchEvent(new CustomEvent('catalog-changed'));
  }, (e) => { reportError('subscribeCatalog', e); resolveCatalogReady(); });
}

function populateSelects() {
  const c = state.catalog;
  const keepCond = val('bene-condizione') || 'buono', keepLiv = val('serv-livello');

  renderSottocategorie();
  $('bene-condizione').innerHTML = Object.entries(c.condizioni)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join('');
  $('serv-livello').innerHTML = Object.entries(c.servizi)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)} — ${v.kpOra} KP/ora</option>`).join('');

  if (c.condizioni[keepCond]) $('bene-condizione').value = keepCond;
  if (keepLiv && c.servizi[keepLiv]) $('serv-livello').value = keepLiv;

  const annoMax = new Date().getFullYear();
  $('bene-anno').max = String(annoMax);
  $('serv-ore').max = String(c.maxOre);

  $('valuation-help').innerHTML = `
    <p><b>Regola base:</b> 1 KP = ${c.kpEuro} € di valore residuo. Quando regali ricevi KP, quando prendi li spendi.</p>
    <p><b>Beni:</b> KP = prezzo da nuovo × condizione × svalutazione per età ÷ ${c.kpEuro}.</p>
    <p>Condizione: ${Object.values(c.condizioni).map((x) => `${esc(x.label)} ×${x.coeff}`).join(' · ')}</p>
    <p>Svalutazione: −${Math.round(c.svalutazioneAnnua * 100)}% per ogni anno dall'acquisto, mai sotto il ${Math.round(c.residuoMinimo * 100)}%.</p>
    <p>Il prezzo da nuovo deve stare nella fascia della sottocategoria: una bici da corsa e una bici da città hanno fasce diverse.</p>
    <p><b>Servizi:</b> KP = ore × tariffa oraria del tipo di prestazione (max ${c.maxOre} ore).</p>
    <p><b>Controlli:</b> sopra ${c.sogliaVerifica} KP l'annuncio viene verificato da un amministratore prima di essere pubblicato.
       Finché non concludi il primo scambio puoi pubblicare fino a ${c.maxKpNuovoUtente} KP.</p>`;
  $('publish-warning').classList.toggle('hidden', state.catalogOnServer);
  updateFotoLabels();
  updateValuePreview();
}

// ---------- 5. FORM PUBBLICAZIONE ----------

// ----- Selettore "Cosa stai regalando" -----
// Campo che apre un pannello con ricerca e gruppi; sotto il campo, i suggerimenti
// ricavati dal titolo come pulsanti rapidi. Il valore scelto sta nell'input nascosto
// #bene-sottocategoria, letto da calcolaValore().
let userPickedSub = false;   // l'utente ha scelto a mano: non cambiare piu' la selezione da solo
let lastSugg = { lista: [], migliore: null };

const fascia = (s) => `${s.min}–${s.max} €`;

function paintCatButton() {
  const c = state.catalog;
  const k = val('bene-sottocategoria');
  const s = c.sottocategorie[k];
  $('cat-button').innerHTML = s
    ? `<span class="cat-emoji">${iconaGruppo(s.gruppo)}</span>
       <span class="cat-text"><span class="cat-label">${esc(s.label)}</span>
       <span class="cat-sub">${esc(s.gruppo)} · nuovo ${fascia(s)}</span></span>
       <span class="cat-change">Cambia</span>`
    : `<span class="cat-emoji">🏷️</span>
       <span class="cat-text"><span class="cat-placeholder">Scegli una categoria</span></span>
       <span class="cat-change">Elenco ›</span>`;
  $('cat-button').classList.toggle('cat-field-empty', !s);
}

function renderCatChips() {
  const c = state.catalog;
  const box = $('cat-suggest');
  const sel = val('bene-sottocategoria');
  const lista = lastSugg.lista.filter((k) => c.sottocategorie[k]).slice(0, 5);
  if (!val('title').trim()) {
    box.innerHTML = '<p class="cat-hint">Scrivi il titolo: ti suggerirò la categoria giusta.</p>';
  } else if (!lista.length) {
    box.innerHTML = '<p class="cat-hint">Nessuna categoria riconosciuta dal titolo: sceglila dall\'elenco.</p>';
  } else {
    box.innerHTML = `<p class="cat-hint">${lista.length === 1 ? 'Categoria riconosciuta dal titolo:' : 'Suggerite dal titolo, scegli quella giusta:'}</p>
      <div class="cat-chips">${lista.map((k) => {
        const s = c.sottocategorie[k];
        return `<button type="button" class="cat-chip${k === sel ? ' cat-chip-on' : ''}" onclick="pickCat('${sid(k)}')">${iconaGruppo(s.gruppo)} ${esc(s.label)}</button>`;
      }).join('')}</div>`;
  }
}

function renderSottocategorie() {
  const c = state.catalog;
  const input = $('bene-sottocategoria');
  lastSugg = suggerisciSottocategorie(c, val('title'), val('description'));
  if (input.value && !c.sottocategorie[input.value]) { input.value = ''; userPickedSub = false; }
  if (!userPickedSub) input.value = (lastSugg.migliore && c.sottocategorie[lastSugg.migliore]) ? lastSugg.migliore : '';
  paintCatButton();
  renderCatChips();
}

window.pickCat = function (k) {
  if (!state.catalog.sottocategorie[k]) return;
  $('bene-sottocategoria').value = k;
  userPickedSub = true;
  window.closeCatSheet();
  paintCatButton();
  renderCatChips();
  updateValuePreview();
};

window.openCatSheet = function () {
  $('cat-search').value = '';
  renderCatSheet();
  $('cat-sheet').style.display = 'flex';
  setTimeout(() => {
    const on = document.querySelector('#cat-list .cat-row-on');
    if (on) on.scrollIntoView({ block: 'center' });
  }, 0);
};

window.closeCatSheet = function () { $('cat-sheet').style.display = 'none'; };

function renderCatSheet() {
  const c = state.catalog;
  const sel = val('bene-sottocategoria');
  const filtro = cercaSottocategorie(c, val('cat-search'));
  const riga = ([k, s]) => `
    <button type="button" class="cat-row${k === sel ? ' cat-row-on' : ''}" onclick="pickCat('${sid(k)}')">
      <span class="cat-row-label">${esc(s.label)}</span>
      <span class="cat-row-range">${fascia(s)}</span>
      <span class="cat-row-check">${k === sel ? '✓' : ''}</span>
    </button>`;

  let html = '';
  const sugg = lastSugg.lista.filter((k) => c.sottocategorie[k] && (!filtro || filtro.has(k)));
  if (sugg.length && !filtro) {
    html += `<div class="cat-group"><div class="cat-group-head">✨ Suggerite per «${esc(val('title').slice(0, 40))}»</div>
      ${sugg.map((k) => riga([k, c.sottocategorie[k]])).join('')}</div>`;
  }
  gruppiOrdinati(c).forEach(({ gruppo, icona, voci }) => {
    const visibili = filtro ? voci.filter(([k]) => filtro.has(k)) : voci;
    if (!visibili.length) return;
    html += `<div class="cat-group${gruppo === 'Altro' ? ' cat-group-last' : ''}">
      <div class="cat-group-head">${icona} ${esc(gruppo)}</div>${visibili.map(riga).join('')}</div>`;
  });
  if (!html) {
    const altro = Object.entries(c.sottocategorie).find(([k, s]) => k === 'altro' || s.gruppo === 'Altro');
    html = `<p class="cat-empty">Nessuna categoria trovata per «${esc(val('cat-search'))}».</p>` +
      (altro ? `<div class="cat-group cat-group-last"><div class="cat-group-head">📦 Altro</div>${riga(altro)}</div>` : '');
  }
  $('cat-list').innerHTML = html;
}
window.renderCatSheet = renderCatSheet;

// Lunghezze di titolo e descrizione (gli stessi limiti sono in firestore.rules)
const TITOLO_MIN = 5, TITOLO_MAX = 50, DESCR_MIN = 10, DESCR_MAX = 150;

function aggiornaContatori() {
  [['title', TITOLO_MIN, TITOLO_MAX], ['description', DESCR_MIN, DESCR_MAX]].forEach(([id, min, max]) => {
    const n = $(id).value.trim().length, el = $(id + '-count');
    if (!el) return;
    el.textContent = n > 0 && n < min ? `${n}/${max} · almeno ${min} caratteri` : `${n}/${max}`;
    el.classList.toggle('text-count-warn', (n > 0 && n < min) || n >= max);
  });
}

window.onOfferTextChange = function () {
  aggiornaContatori();
  if (currentOfferType === 'bene') renderSottocategorie();
  updateValuePreview();
};
window.toggleOfferType = function (type) {
  currentOfferType = type;
  const on = type === 'bene' ? $('type-bene') : $('type-servizio');
  const off = type === 'bene' ? $('type-servizio') : $('type-bene');
  off.classList.remove('bg-green-600', 'bg-blue-600', 'text-white', 'shadow-lg');
  off.classList.add('text-gray-700', 'hover:bg-gray-200');
  on.classList.remove('text-gray-700', 'hover:bg-gray-200');
  on.classList.add(type === 'bene' ? 'bg-green-600' : 'bg-blue-600', 'text-white', 'shadow-lg');
  $('fields-bene').classList.toggle('hidden', type !== 'bene');
  $('fields-servizio').classList.toggle('hidden', type !== 'servizio');
  updateFotoLabels();
  updateValuePreview();
};

function calcolaValore() {
  const c = state.catalog;
  if (currentOfferType === 'bene') {
    return valutaBene(c, {
      sottocategoria: val('bene-sottocategoria'),
      condizione: val('bene-condizione'),
      prezzoNuovo: val('bene-prezzo'),
      annoAcquisto: val('bene-anno'),
      marca: val('bene-marca'),
      modello: val('bene-modello')
    }, undefined, { libero: state.isAdmin });
  }
  return valutaServizio(c, { livello: val('serv-livello'), ore: val('serv-ore') }, { libero: state.isAdmin });
}

function updateValuePreview() {
  const box = $('kp-preview');
  if (!box) return;
  const sub = state.catalog.sottocategorie[val('bene-sottocategoria')];
  $('bene-prezzo-hint').textContent = !sub ? '' : state.isAdmin
    ? `Fascia consigliata: ${sub.min}–${sub.max} € (come amministratore puoi uscirne)`
    : `Fascia ammessa: ${sub.min}–${sub.max} €`;

  const r = calcolaValore();
  if (r.incomplete) {
    box.innerHTML = 'Compila tutti i campi per vedere il valore in KP.';
    return;
  }
  if (r.error) {
    box.innerHTML = `<span class="text-red-600">${esc(r.error)}</span>`;
    return;
  }
  const esito = esitoPubblicazione(state.catalog, r.kp, state.completedSwaps, { libero: state.isAdmin });
  let note = '';
  if (esito.error) note = `<br><span class="text-red-600">${esc(esito.error)}</span>`;
  else if (esito.status === 'in_verifica') note = `<br><span class="text-purple-700">Sopra ${state.catalog.sogliaVerifica} KP: sarà visibile dopo la verifica di un amministratore.</span>`;
  box.innerHTML = `Valore calcolato: <b class="text-lg">${r.kp} KP</b><br><span class="text-xs">${esc(r.formula)}</span>${note}`;
}
window.updateValuePreview = updateValuePreview;

function updateFotoLabels() {
  const minimo = currentOfferType === 'bene' && !state.isAdmin ? minFotoBeni(state.catalog) : 0;
  $('img-hint').textContent = minimo
    ? `Serve almeno ${minimo === 1 ? '1 foto reale' : minimo + ' foto reali'} del bene (max 3). Più foto (insieme, dettagli, difetti) aiutano chi riceve e la verifica del valore.`
    : 'Le foto sono facoltative (max 3).';
  [0, 1, 2].forEach((i) => {
    if (pendingFotos[i]) return;
    const star = i < minimo ? ' *' : '';
    $('slot-label-' + i).innerHTML = `<span style="font-size:1.5rem">＋</span><small>Foto ${i + 1}${star}</small>`;
  });
}

// Versione dell'app: deve essere uguale a VERSIONE in sw.js (si vede in fondo al Profilo)
export const APP_VERSIONE = 'rikeka-v33';

// Anti-flood (gli stessi valori sono in firestore.rules, match /quote)
const ANNUNCI_INTERVALLO_MS = 31 * 1000;   // 1 secondo di margine sui 30 delle regole
const ANNUNCI_MAX_GIORNO = 20;

// Miniatura in elenco: ~12 KB. Si scarica a ogni apertura della home, quindi e' il dato
// che pesa di piu' sui limiti gratuiti di Firebase. La foto grande si scarica solo se la tocchi.
const THUMB_LEGGERA = 16000;

// Elabora una foto (ridimensiona + miniatura) e la mette nello spazio indicato
async function setFoto(index, file) {
  if (!file.type.startsWith('image/')) { alert('Seleziona un file immagine.'); return; }
  const label = $('slot-label-' + index);
  label.innerHTML = '<span class="foto-loading">…</span>';
  try {
    const [full, thumb] = await Promise.all([
      compressImage(file, { maxSide: 900, quality: 0.72, maxChars: FOTO_MAX_CHARS }),
      compressImage(file, { maxSide: 360, quality: 0.55, maxChars: Math.min(THUMB_MAX_CHARS, THUMB_LEGGERA) })
    ]);
    pendingFotos[index] = { full, thumb };
    label.innerHTML = `<img src="${thumb}" alt="Anteprima foto ${index + 1}">`;
    $('slot-remove-' + index).classList.remove('hidden');
  } catch (e) {
    pendingFotos[index] = null;
    updateFotoLabels();
    reportError('setFoto', e, { size: file.size, type: file.type });
    alert('Impossibile usare questa foto: ' + e.message);
  }
}

// Tocco su uno spazio: sceglie la foto per quello spazio
window.handleImagePick = async function (index, input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (file) await setFoto(index, file);
};

// Pulsanti "Scatta foto" e "Galleria": riempiono gli spazi liberi in ordine
window.addPhotos = async function (input) {
  const files = [...(input.files || [])];
  input.value = '';
  if (!files.length) return;
  const liberi = [0, 1, 2].filter((i) => !pendingFotos[i]);
  if (!liberi.length) return alert('Hai già 3 foto: toccane una con la ✕ per sostituirla.');
  if (files.length > liberi.length) alert(`Puoi aggiungere ancora ${liberi.length} ${liberi.length === 1 ? 'foto' : 'foto'}: userò le prime.`);
  for (let i = 0; i < Math.min(files.length, liberi.length); i++) {
    pendingFotos[liberi[i]] = { loading: true };   // prenota lo spazio
    await setFoto(liberi[i], files[i]);
  }
};

window.removeImage = function (index) {
  pendingFotos[index] = null;
  $('slot-remove-' + index).classList.add('hidden');
  updateFotoLabels();
};

function resetPublishForm() {
  $('publish-form').reset();
  pendingFotos = [null, null, null];
  [0, 1, 2].forEach((i) => $('slot-remove-' + i).classList.add('hidden'));
  userPickedSub = false;
  renderSottocategorie();
  $('serv-ore').value = '1';
  if (state.catalog.condizioni.buono) $('bene-condizione').value = 'buono';
  updateFotoLabels();
  updateValuePreview();
  aggiornaContatori();
}

// ---------- 6. AUTENTICAZIONE ----------
window.handleAuth = async function () {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
      alert('Errore di accesso: ' + error.message);
    }
  }
};

// All'uscita si svuota la memoria locale: chi usa lo stesso telefono dopo non vede dati altrui
async function svuotaMemoriaLocale() {
  try { await terminate(db); await clearIndexedDbPersistence(db); } catch (e) { console.warn('Pulizia memoria locale:', e); }
}

window.handleLogout = async function () {
  await signOut(auth);
  await svuotaMemoriaLocale();
  location.reload();
};

function stopListeners() {
  Object.keys(unsub).forEach((k) => { try { unsub[k]?.(); } catch (_) {} unsub[k] = null; });
}

onAuthStateChanged(auth, (user) => {
  $('loading-screen').style.display = 'none';
  $('app-container').classList.remove('hidden');
  stopListeners();
  state.offers.clear();

  if (user) {
    $('app-header').style.display = 'flex';
    $('tab-bar').style.display = 'flex';
    $('profile-name-header').textContent = user.displayName || 'Utente Rikeka';
    homePages = 1;
    resetCatalogReady();
    subscribeCatalog();
    loadOffers();
    loadMyOffers(user.uid);
    loadToReceive(user.uid);
    loadContestazioni(user.uid);
    initPushUi();
    loadChatList();
    loadProfileData(user.uid);
    checkAdmin(user.uid);
    checkSuspended(user.uid);
    checkRimozioni(user.uid);
    switchScreen('home-screen');
    document.querySelectorAll('.tab-item').forEach((i) => i.classList.remove('active'));
    $('nav-home')?.classList.add('active');
    try {
      if (!sessionStorage.getItem('ec_login_logged')) {
        sessionStorage.setItem('ec_login_logged', '1');
        logEvent('login', {});
      }
    } catch (_) { /* sessionStorage non disponibile */ }
  } else {
    homeOffers = []; myOffers = []; allChatsData = []; unreadChatIds = [];
    state.karma = null; state.completedSwaps = 0; state.isAdmin = false; state.sospeso = false; lastKnownKarma = null;
    repCache.clear();
    $('profile-role').textContent = 'Membro Rikeka';
    myOfferStatus = new Map();
    toReceive = []; toReceiveStatus = new Map(); ricevutiConclusi = []; giudiziDaDare = 0; contestazioni.clear();
    state.zona = null; zonePromptShown = false;
    searchTerms = []; searchResults = null; groupFilter = '';
    $('consent-modal').style.display = 'none';
    consentMode = null;
    deletingAccount = false;
    try { sessionStorage.removeItem('ec_login_logged'); } catch (_) {}
    $('login-screen').style.display = 'flex';
    $('app-header').style.display = 'none';
    $('tab-bar').style.display = 'none';
    $('chat-screen').style.display = 'none';
  liberaChatDallaTastiera();
  }
});

// ---------- 7. CHAT ----------
window.openChat = function (chatId, offerTitle) {
  const chat = allChatsData.find((c) => c.id === chatId)?.data;
  const me = auth.currentUser;
  // riaperta (es. da "Avvia chat"): torna visibile nel proprio elenco
  if (chat?.nascosta?.[me.uid]) {
    updateDoc(doc(db, 'chats', chatId), { [`nascosta.${me.uid}`]: deleteField() }).catch((e) => reportError('mostraChat', e));
  }
  currentChatId = chatId;
  tellServiceWorkerChat();
  $('current-chat-id').value = chatId;
  $('current-chat-title').textContent = offerTitle || chat?.offerTitle || '';
  const otherId = (chat?.users || []).find((u) => u !== me.uid);
  const fallback = chat && chat.buyerId === me.uid ? 'Chi regala' : (chat?.buyerName || 'Utente');
  setChatPerson(fallback);
  $('current-chat-rep').textContent = '';
  if (otherId) {
    getDoc(doc(db, 'users', otherId))
      .then((u) => {
        if (currentChatId !== chatId || !u.exists()) return;
        setChatPerson(u.data().displayName || fallback);
        repCache.set(otherId, u.data());
        $('current-chat-rep').innerHTML = testoReputazione(u.data());
      })
      .catch(() => {});
  }
  $('chat-screen').style.display = 'flex';
  adattaChatAllaTastiera();
  $('app-header').style.display = 'none';
  $('tab-bar').style.display = 'none';
  segnaLetta(chatId);
  calcolaNonLette();
  loadChatMessages(chatId);
  watchChatOffer(chat);
  setTimeout(() => $('message-input').focus({ preventScroll: true }), 50);
};

// ----- Riquadro "scambio" in cima alla chat (come su Subito) -----
let chatCtx = null;   // { chat, offer, offerId }

function watchChatOffer(chat) {
  unsub.chatOffer?.(); unsub.chatOffer = null;
  chatCtx = { chat, offer: null, offerId: chat?.offerId || null };
  const box = $('chat-deal');
  if (!chat?.offerId) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<p class="deal-text">Caricamento dello scambio…</p>';
  const ctx = chatCtx;
  unsub.chatOffer = onSnapshot(doc(db, 'offerte', chat.offerId), (snap) => {
    if (chatCtx !== ctx) return;   // chat già chiusa o cambiata
    chatCtx.offer = snap.exists() ? snap.data() : null;
    if (chatCtx.offer) state.offers.set(chat.offerId, chatCtx.offer);
    renderChatDeal();
  }, (e) => { reportError('watchChatOffer', e); box.classList.add('hidden'); });
}

function renderChatDeal() {
  const box = $('chat-deal');
  const me = auth.currentUser;
  const { chat, offer: o, offerId } = chatCtx || {};
  if (!box || !chat || !me) return;
  if (!o) {
    box.className = 'chat-deal deal-off';
    box.innerHTML = '<p class="deal-text">Questo annuncio non è più disponibile.</p>';
    return;
  }
  const isOwner = o.ownerId === me.uid;
  const altro = chat.buyerId && chat.buyerId !== me.uid ? (chat.buyerName || 'questa persona') : (o.ownerName || 'chi regala');
  const perQuesto = o.reservedBy && o.reservedBy === chat.buyerId;
  const kp = `<b>${o.cpValue} KP</b>`;
  let stato = '', testo = '', azioni = '', cls = 'deal-info';

  let turno = false;   // tocca a me fare qualcosa: la barra diventa ben visibile
  const contest = contestazioni.get(offerId);

  if (o.status === 'concluso') {
    stato = '✅ Scambio concluso'; cls = 'deal-done';
    testo = perQuesto ? (isOwner ? `${esc(altro)} ha confermato la ricezione: hai ricevuto ${kp}. Ora puoi lasciargli l'oggetto. Grazie!` : `Hai donato ${kp} a chi ti ha aiutato.`) : 'L\'annuncio è stato assegnato.';
    if (isOwner && perQuesto) {
      if (o.feedbackGiver) testo += ` Il tuo giudizio su ${esc(altro)}: ${o.feedbackGiver === 'positivo' ? '👍 positivo' : '👎 negativo'}.`;
      else {
        testo += ` Com'è andata con ${esc(altro)}?`;
        cls = 'deal-action';
        azioni = `<button class="deal-btn deal-primary" onclick="rateReceiver('${sid(offerId)}', 'positivo')">👍 Positivo</button>
                  <button class="deal-btn deal-danger" onclick="rateReceiver('${sid(offerId)}', 'negativo')">👎 Negativo</button>`;
      }
    }
    if (perQuesto && contest) {
      testo += ` <br>${testoContestazione(contest, isOwner, altro)}`;
      cls = contest.stato === 'aperta' ? 'deal-action deal-contestata' : cls;
    } else if (perQuesto && !isOwner && finestraSegnalazione(o)) {
      testo += ` Se l'oggetto o il servizio ha un problema (rotto, non funzionante, diverso dalla descrizione), puoi segnalarlo fino a ${esc(finestraSegnalazione(o))}.`;
      azioni = `<button class="deal-btn deal-ghost" onclick="apriContestazione('${sid(offerId)}')">⚠️ Segnala un problema</button>`;
    }
  } else if (o.status === 'consegnato' && perQuesto) {
    stato = '📦 Consegna segnata'; cls = 'deal-action';
    if (isOwner) {
      turno = true;
      testo = `<b>Aspetta prima di lasciare l'oggetto:</b> chiedi a ${esc(altro)} di confermare la ricezione dal suo telefono. Quando conferma, qui comparirà ✅ e riceverai ${kp}. Solo allora consegnaglielo.`;
      const consegnatoMs = o.deliveredAt?.toMillis?.() || 0;
      if (o.aiutoRichiesto) testo += ' Hai chiesto aiuto: un amministratore se ne sta occupando.';
      else if (consegnatoMs && Date.now() - consegnatoMs > 7 * 864e5) {
        testo += ' Sono passati più di 7 giorni senza conferma.';
        azioni = `<button class="deal-btn deal-ghost" onclick="askAdminHelp('${sid(offerId)}')">🆘 Chiedi aiuto a un amministratore</button>`;
      }
    } else {
      turno = true;
      testo = `${esc(altro)} è pronto a consegnarti «${esc(o.title)}». <b>Conferma quando ce l'hai davanti</b>: ${esc(altro)} riceverà ${kp} e ti lascerà l'oggetto. Dopo la conferma hai 48 ore per segnalare eventuali problemi.`;
      azioni = `<button class="deal-btn deal-primary deal-big" onclick="confirmReceived('${sid(offerId)}')">✓ Confermo la ricezione</button>
                <button class="deal-btn deal-danger" onclick="notReceived('${sid(offerId)}')">Non ancora / non l'ho ricevuto</button>`;
    }
  } else if (o.status === 'in_trattativa' && perQuesto) {
    stato = '🤝 In trattativa'; cls = 'deal-action';
    if (isOwner) {
      turno = true;
      testo = `Hai scelto ${esc(altro)}. Quando vi incontrate premi <b>«Ho consegnato»</b>, poi aspetta che ${esc(altro)} confermi dal suo telefono <b>prima</b> di lasciargli l'oggetto.`;
      azioni = `<button class="deal-btn deal-primary deal-big" onclick="markDelivered('${sid(offerId)}')">📦 Ho consegnato</button>
                <button class="deal-btn deal-ghost" onclick="setDisponibile('${sid(offerId)}')">Annulla trattativa</button>`;
    } else {
      testo = `Sei stato scelto! Accordatevi qui su quando e dove fare lo scambio (${kp}). All'incontro ${esc(altro)} segnerà la consegna e tu confermerai dal telefono.`;
    }
  } else if (o.status === 'in_trattativa' || o.status === 'consegnato') {
    stato = '🤝 In trattativa con un\'altra persona'; cls = 'deal-off';
    testo = isOwner ? 'Puoi annullarla dalla scheda dell\'annuncio se l\'accordo salta.' : 'Se l\'accordo salta, l\'annuncio tornerà disponibile.';
  } else if (o.status === 'disponibile') {
    stato = '🟢 Disponibile';
    if (isOwner) {
      testo = `Vuoi regalarlo a ${esc(altro)}? Vale ${kp}.`;
      azioni = `<button class="deal-btn deal-primary" onclick="reserveFromChat()">Scegli ${esc(altro)}</button>`;
      cls = 'deal-action';
    } else testo = `Quando ${esc(altro)} ti sceglie, l'annuncio sarà riservato per te (${kp}).`;
  } else {
    stato = 'Annuncio non disponibile'; cls = 'deal-off';
  }
  if (turno) { cls += ' deal-turno'; stato = `👉 Tocca a te · ${stato}`; }
  box.className = `chat-deal ${cls}`;
  box.innerHTML = `<div class="deal-head"><span class="deal-state">${stato}</span><span class="deal-title">${esc(o.title)}</span></div>
    ${testo ? `<p class="deal-text">${testo}</p>` : ''}${azioni ? `<div class="deal-actions">${azioni}</div>` : ''}`;
}

// Chi regala sceglie la persona con cui sta chattando
window.reserveFromChat = async function () {
  const { chat, offer: o, offerId } = chatCtx || {};
  if (!chat || !o) return;
  const nome = chat.buyerName || 'questa persona';
  try {
    const u = await getDoc(doc(db, 'users', chat.buyerId));
    const karma = u.exists() ? (u.data().karmaPoints ?? 0) : 0;
    if (u.exists() && u.data().displayName) chat.buyerName = u.data().displayName;
    const buyerAdmin = (await getDoc(doc(db, 'admins', chat.buyerId))).exists();
    if (!buyerAdmin && karma < o.cpValue) return alert(`${nome} ha ${karma} KP: ne servono ${o.cpValue} per questo annuncio.`);
  } catch (_) { /* il controllo vero lo fanno le regole */ }
  if (!confirm(`Riservare «${o.title}» per ${chat.buyerName || nome}?\nGli altri non potranno più richiederlo finché la trattativa è in corso.`)) return;
  await window.confirmReserve(offerId, chat.buyerId, chat.buyerName || nome);
};

// Anteprima dell'ultimo messaggio: max 50 caratteri, tagliata a parola intera
// (un taglio a metà parola potrebbe creare per caso una parola vietata)
function anteprima(testo) {
  const t = String(testo).replace(/\s+/g, ' ').trim();
  if (t.length <= 50) return t;
  const taglio = t.slice(0, 51);
  const spazio = taglio.lastIndexOf(' ');
  return (spazio > 20 ? taglio.slice(0, spazio) : t.slice(0, 50)).trim() + '…';
}

async function postChatEventTo(chatId, testo) {
  try {
    const me = auth.currentUser;
    await addDoc(collection(db, 'chats', chatId, 'messages'), { senderId: me.uid, senderName: (me.displayName || 'Utente').slice(0, 80), text: testo, system: true, timestamp: serverTimestamp() });
    await updateDoc(doc(db, 'chats', chatId), { lastMessage: anteprima(testo), lastMessageTimestamp: serverTimestamp(), lastMessageSenderId: me.uid });
  } catch (e) { console.warn('Evento chat non scritto', e); }
}

// Messaggio automatico nella chat collegata all'annuncio (es. "📦 Consegnato")
async function postChatEvent(offerId, testo) {
  try {
    const me = auth.currentUser;
    const chat = allChatsData.find((c) => c.data.offerId === offerId && (c.data.users || []).includes(state.offers.get(offerId)?.reservedBy || chatCtx?.chat?.buyerId))
      || (chatCtx?.offerId === offerId ? { id: currentChatId } : null);
    if (!chat?.id || !me) return;
    await addDoc(collection(db, 'chats', chat.id, 'messages'), { senderId: me.uid, senderName: (me.displayName || 'Utente').slice(0, 80), text: testo, system: true, timestamp: serverTimestamp() });
    await updateDoc(doc(db, 'chats', chat.id), { lastMessage: anteprima(testo), lastMessageTimestamp: serverTimestamp(), lastMessageSenderId: me.uid });
  } catch (e) { console.warn('Evento chat non scritto', e); }
}

function setChatPerson(name) {
  $('current-chat-name').textContent = name;
  $('chat-avatar').textContent = (String(name).trim()[0] || '?').toUpperCase();
}

window.sendMessage = async function (event) {
  event.preventDefault();
  const input = $('message-input');
  const text = input.value.trim();
  const chatId = $('current-chat-id').value;
  const me = auth.currentUser;
  if (!text || !chatId || !me) return;
  if (state.sospeso) return alert('Il tuo account è sospeso: non puoi scrivere messaggi.');
  const vietata = parolaVietata(text);
  if (vietata) {
    logEvent('chat_blocked_word', { chatId }, 'warn');
    return alert(`⛔ Messaggio non inviato: contiene parole non consentite («${vietata}»).\n\n` +
      'Su Rikeka si scrive con rispetto: niente parolacce, bestemmie o insulti. Correggi il testo e riprova.');
  }
  input.value = '';
  try {
    await addDoc(collection(db, 'chats', chatId, 'messages'), {
      senderId: me.uid,
      senderName: (me.displayName || 'Utente').slice(0, 80),
      text,
      timestamp: serverTimestamp()
    });
    await updateDoc(doc(db, 'chats', chatId), {
      lastMessage: anteprima(text),
      lastMessageTimestamp: serverTimestamp(),
      lastMessageSenderId: me.uid
    });
    notify('message', { chatId });
  } catch (e) {
    if (!input.value) input.value = text;
    reportError('sendMessage', e, { chatId });
    alert('Impossibile inviare il messaggio: ' + friendlyError(e));
  }
};

const ora = (d) => d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
function etichettaGiorno(d) {
  const oggi = new Date(); const ieri = new Date(); ieri.setDate(oggi.getDate() - 1);
  const stesso = (a, b) => a.toDateString() === b.toDateString();
  if (stesso(d, oggi)) return 'Oggi';
  if (stesso(d, ieri)) return 'Ieri';
  return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== oggi.getFullYear() ? { year: 'numeric' } : {}) });
}

function loadChatMessages(chatId) {
  unsub.messages?.();
  const me = auth.currentUser;
  const box = $('messages-container');
  box.innerHTML = '<p class="chat-empty">Caricamento…</p>';
  const q = query(collection(db, 'chats', chatId, 'messages'), orderBy('timestamp', 'asc'));
  unsub.messages = onSnapshot(q, (snap) => {
    if (snap.empty) {
      box.innerHTML = `<div class="chat-empty">
        <p class="chat-empty-title">Inizia la conversazione 👋</p>
        <p>Accordatevi su quando e dove fare lo scambio. Per sicurezza incontratevi in un luogo pubblico.</p></div>`;
      return;
    }
    let html = '', giorno = '', prevSender = null, prevTime = 0;
    snap.docs.forEach((d) => {
      const m = d.data({ serverTimestamps: 'estimate' });
      const t = tsToDate(m.timestamp) || new Date();
      const g = t.toDateString();
      if (g !== giorno) { html += `<div class="chat-day"><span>${esc(etichettaGiorno(t))}</span></div>`; giorno = g; prevSender = null; }
      if (m.system) {
        html += `<div class="msg-system"><span>${esc(m.text)}</span><span class="msg-system-time">${ora(t)}</span></div>`;
        prevSender = null;
        return;
      }
      const isMe = m.senderId === me.uid;
      // messaggi consecutivi dello stesso autore entro 3 minuti: bolle raggruppate
      const continua = prevSender === m.senderId && t.getTime() - prevTime < 3 * 60 * 1000;
      html += `<div class="msg-row ${isMe ? 'msg-me' : 'msg-them'}${continua ? ' msg-cont' : ''}">
        <div class="msg-bubble"><span class="msg-text">${esc(m.text)}</span><span class="msg-time">${ora(t)}</span></div></div>`;
      prevSender = m.senderId; prevTime = t.getTime();
    });
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }, (e) => reportError('loadChatMessages', e, { chatId }));
}

window.navigateFromChat = function (screenId, element) {
  unsub.messages?.(); unsub.messages = null;
  unsub.chatOffer?.(); unsub.chatOffer = null; chatCtx = null;
  $('chat-screen').style.display = 'none';
  liberaChatDallaTastiera();
  $('app-header').style.display = 'flex';
  $('tab-bar').style.display = 'flex';
  currentChatId = null;
  tellServiceWorkerChat();
  window.navigate(screenId, element);
};

window.deleteChat = async function (event, chatId, opzioni = {}) {
  event?.stopPropagation();
  if (!opzioni.senzaConferma) return window.chiediEliminaChat(null, chatId);
  try {
    const msgs = await getDocs(collection(db, 'chats', chatId, 'messages'));
    // batch da max 450 operazioni (limite Firestore: 500)
    for (let i = 0; i < msgs.docs.length; i += 450) {
      const b = writeBatch(db);
      msgs.docs.slice(i, i + 450).forEach((m) => b.delete(m.ref));
      await b.commit();
    }
    const b = writeBatch(db);
    b.delete(doc(db, 'chats', chatId));
    await b.commit();
    unreadChatIds = unreadChatIds.filter((id) => id !== chatId);
    hasUnreadMessages = unreadChatIds.length > 0;
    updateChatTabIndicator();
    logEvent('chat_deleted', { chatId });
  } catch (e) {
    reportError('deleteChat', e, { chatId });
    alert('Impossibile eliminare la chat: ' + friendlyError(e));
  }
};

// ---------- Chat lette / da leggere (ricordate su questo dispositivo) ----------
const msChat = (c) => c?.lastMessageTimestamp?.toMillis?.() || 0;
function chiaveLetti() { return 'rk_letti_' + (auth.currentUser?.uid || ''); }
function leggiLetti() {
  try { return JSON.parse(localStorage.getItem(chiaveLetti()) || 'null'); } catch (_) { return null; }
}
function salvaLetti(l) { try { localStorage.setItem(chiaveLetti(), JSON.stringify(l)); } catch (_) {} }
function segnaLetta(chatId) {
  const c = allChatsData.find((x) => x.id === chatId)?.data;
  const l = leggiLetti() || {};
  l[chatId] = Math.max(l[chatId] || 0, msChat(c), 1);
  salvaLetti(l);
}
function calcolaNonLette() {
  const me = auth.currentUser;
  if (!me) return;
  let l = leggiLetti();
  if (!l) {   // primo avvio su questo dispositivo: tutto cio' che c'e' gia' conta come letto
    l = {}; allChatsData.forEach((c) => { l[c.id] = msChat(c.data) || 1; }); salvaLetti(l);
  }
  const vista = $('chat-screen').style.display === 'flex' ? currentChatId : null;
  if (vista) segnaLetta(vista);
  const letti = leggiLetti() || {};
  unreadChatIds = chatVisibili()
    .filter(({ id, data }) => id !== vista && data.lastMessageSenderId && data.lastMessageSenderId !== me.uid
      && msChat(data) > (letti[id] || 0))
    .map((c) => c.id);
  hasUnreadMessages = unreadChatIds.length > 0;
  updateChatTabIndicator();
}

// ---------- Chat nascoste ("Elimina" toglie la chat solo dal PROPRIO elenco) ----------
const msTs = (t) => t?.toMillis?.() || 0;
function nascostaPerMe(chat, uid) {
  const quando = msTs(chat?.nascosta?.[uid]);
  return !!quando && msChat(chat) <= quando;   // ricompare se arriva un messaggio dopo
}
function chatVisibili() {
  const uid = auth.currentUser?.uid;
  return allChatsData.filter((c) => !nascostaPerMe(c.data, uid));
}

// Orario compatto per l'elenco chat: oggi "08:30", ieri "Ieri", poi "12/10"
function quandoChat(d) {
  if (!d) return '';
  const oggi = new Date(), ieri = new Date(); ieri.setDate(oggi.getDate() - 1);
  if (d.toDateString() === oggi.toDateString()) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === ieri.toDateString()) return 'Ieri';
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
}

// Nome dell'altra persona della chat (subito un nome provvisorio, poi quello vero dal profilo)
function nomeProvvisorio(chat, me) {
  if (chat.ownerId === me.uid) return chat.buyerName || 'Utente';
  return state.offers.get(chat.offerId)?.ownerName || 'Chi regala';
}

const ICONA_CESTINO = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

function renderChatList() {
  const box = $('chat-list');
  const me = auth.currentUser;
  if (!box || !me) return;
  const visibili = chatVisibili();
  if (!visibili.length) {
    box.innerHTML = `<div class="chat-list-empty"><div class="chat-list-empty-icon">💬</div>
      <p class="chat-list-empty-title">Nessuna chat per ora</p>
      <p>Apri un annuncio che ti interessa e premi <b>Avvia chat</b> per scrivere a chi lo regala.</p></div>`;
    return;
  }
  const ms = (c) => c.data.lastMessageTimestamp?.toMillis?.() ?? Date.now();
  box.innerHTML = [...visibili].sort((a, b) => ms(b) - ms(a)).map(({ id, data: chat }) => {
    const unread = unreadChatIds.includes(id);
    const isOwner = chat.ownerId === me.uid;
    const otherId = (chat.users || []).find((u) => u !== me.uid) || '';
    const cache = repCache.get(otherId);
    const nome = (cache && !(cache instanceof Promise) && cache.displayName) || nomeProvvisorio(chat, me);
    const mio = chat.lastMessageSenderId === me.uid;
    return `
      <div class="chat-row${unread ? ' chat-row-unread' : ''}" role="button" tabindex="0" onclick="openChat('${sid(id)}')">
        <div class="chat-row-main">
          <div class="chat-row-top">
            <span class="chat-row-name" data-chat-name="${esc(otherId)}">${esc(nome)}</span>
            <span class="chat-row-time">${esc(quandoChat(tsToDate(chat.lastMessageTimestamp)))}</span>
          </div>
          <div class="chat-row-offer">
            <span class="chat-row-tag ${isOwner ? 'chat-row-tag-own' : ''}">${isOwner ? 'Regali' : 'Ricevi'}</span>
            <span class="chat-row-title">${esc(chat.offerTitle || 'Annuncio')}</span>
          </div>
          <div class="chat-row-bottom">
            <span class="chat-row-last">${mio ? '<span class="chat-row-you">Tu:</span> ' : ''}${esc(chat.lastMessage || '')}</span>
            ${unread ? '<span class="chat-row-dot" aria-label="Da leggere"></span>' : ''}
          </div>
        </div>
        <button type="button" class="chat-row-del" onclick="chiediEliminaChat(event, '${sid(id)}')" aria-label="Elimina chat" title="Elimina chat">${ICONA_CESTINO}</button>
      </div>`;
  }).join('');
  // nomi veri dai profili (una lettura per persona, poi restano in memoria)
  visibili.forEach(({ data: chat }) => {
    const otherId = (chat.users || []).find((u) => u !== me.uid);
    if (!otherId) return;
    datiUtente(otherId).then((d) => {
      if (!d?.displayName) return;
      document.querySelectorAll(`[data-chat-name="${CSS.escape(otherId)}"]`).forEach((el) => { el.textContent = d.displayName; });
    });
  });
}

// Eliminazione chat: finestra dell'app invece del riquadro del browser
let chatDaEliminare = null;
window.chiediEliminaChat = function (event, chatId) {
  event?.stopPropagation();
  if (!chatId) return;
  chatDaEliminare = chatId;
  const me = auth.currentUser;
  const chat = allChatsData.find((c) => c.id === chatId)?.data || {};
  const otherId = (chat.users || []).find((u) => u !== me?.uid);
  const cache = repCache.get(otherId);
  const nome = (cache && !(cache instanceof Promise) && cache.displayName) || nomeProvvisorio(chat, me);
  $('chatdel-title').textContent = `Eliminare la chat con ${nome}?`;
  $('chatdel-offer').textContent = chat.offerTitle ? `«${chat.offerTitle}»` : '';
  $('chatdel-modal').style.display = 'flex';
};
window.chiudiEliminaChat = function () { $('chatdel-modal').style.display = 'none'; chatDaEliminare = null; };
window.confermaEliminaChat = async function () {
  const id = chatDaEliminare;
  if (!id) return;
  const me = auth.currentUser;
  const btn = $('chatdel-go'); btn.disabled = true; btn.textContent = 'Eliminazione…';
  try {
    const chat = allChatsData.find((c) => c.id === id)?.data || {};
    const altro = (chat.users || []).find((u) => u !== me.uid);
    // prima la si nasconde per se'; se l'altra persona l'aveva gia' eliminata,
    // allora si cancella davvero (le regole lo permettono solo in questo caso)
    await updateDoc(doc(db, 'chats', id), { [`nascosta.${me.uid}`]: serverTimestamp() });
    logEvent('chat_hidden', { chatId: id });
    if (altro && nascostaPerMe(chat, altro)) {
      await window.deleteChat(null, id, { senzaConferma: true }).catch((e) => reportError('cancellaChatEntrambi', e, { chatId: id }));
    }
    if (currentChatId === id) currentChatId = null;
  } catch (e) {
    reportError('nascondiChat', e, { chatId: id });
    alert('Non è stato possibile eliminare la chat: ' + friendlyError(e));
  } finally {
    btn.disabled = false; btn.textContent = 'Elimina chat';
    window.chiudiEliminaChat();
  }
};

function loadChatList() {
  const me = auth.currentUser;
  const q = query(collection(db, 'chats'), where('users', 'array-contains', me.uid));
  unsub.chats = onSnapshot(q, (snap) => {
    allChatsData = snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) }));
    calcolaNonLette();
    renderChatList();
    apriChatInAttesa();
  }, (e) => reportError('loadChatList', e));
}

// ---------- 8. ANNUNCI ----------
window.publishOffer = async function (event) {
  event.preventDefault();
  const me = auth.currentUser;
  if (!me) return alert('Devi autenticarti per pubblicare un annuncio.');
  if (state.sospeso) return alert('Il tuo account è sospeso: non puoi pubblicare annunci.');
  if (!state.catalogOnServer) return alert("Il catalogo dei valori non è ancora stato attivato dall'amministratore.");

  const title = val('title').trim();
  const description = val('description').trim();
  if (!title || !description) return alert('Compila titolo e descrizione.');
  if (title.length < TITOLO_MIN || title.length > TITOLO_MAX) return alert(`Il titolo deve avere da ${TITOLO_MIN} a ${TITOLO_MAX} caratteri (ora sono ${title.length}).`);
  if (description.length < DESCR_MIN || description.length > DESCR_MAX) return alert(`La descrizione deve avere da ${DESCR_MIN} a ${DESCR_MAX} caratteri (ora sono ${description.length}).`);
  const vietata = parolaVietata(title, description);
  if (vietata) {
    logEvent('offer_bad_words', { parola: vietata }, 'warn');
    return alert(`⛔ Annuncio bloccato per l'uso di parole non consentite.\n\nLa parola «${vietata}» non è ammessa su Rikeka: non sono permesse parolacce, bestemmie e insulti.\nModifica il titolo o la descrizione e riprova.`);
  }

  const valore = calcolaValore();
  if (valore.incomplete) return alert('Compila tutti i campi di valutazione.');
  if (valore.error) return alert(valore.error);

  const esito = esitoPubblicazione(state.catalog, valore.kp, state.completedSwaps, { libero: state.isAdmin });
  if (esito.error) return alert(esito.error);

  const fotos = pendingFotos.filter((f) => f && f.full);
  const minimoFoto = currentOfferType === 'bene' && !state.isAdmin ? minFotoBeni(state.catalog) : 0;
  if (fotos.length < minimoFoto) return alert(`Per un bene serve almeno ${minimoFoto === 1 ? '1 foto' : minimoFoto + ' foto'}.`);

  const btn = $('publish-btn');
  btn.disabled = true; btn.textContent = 'Pubblicazione...';
  try {
    // Anti-flood (controllato anche dalle regole): 30 secondi tra due annunci, 20 al giorno
    let quota = null;
    if (!state.isAdmin) {
      const qRef = doc(db, 'quote', me.uid);
      const q = (await getDoc(qRef)).data();
      const d = new Date(), giorno = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
      const ultimo = tsToDate(q?.lastOfferAt)?.getTime() || 0;
      const attesa = Math.ceil((ultimo + ANNUNCI_INTERVALLO_MS - Date.now()) / 1000);
      if (attesa > 0) { alert(`Hai appena pubblicato un annuncio: aspetta ${attesa} secondi prima del prossimo.`); return; }
      const contati = q?.offerDay === giorno ? (q.offerCount || 0) : 0;
      if (contati >= ANNUNCI_MAX_GIORNO) { alert(`Hai raggiunto il massimo di ${ANNUNCI_MAX_GIORNO} annunci per oggi. Potrai pubblicarne altri domani.`); return; }
      quota = { ref: qRef, dati: { lastOfferAt: serverTimestamp(), offerDay: giorno, offerCount: contati + 1 } };
    }
    const offerRef = doc(collection(db, 'offerte'));
    const batch = writeBatch(db);
    if (quota) batch.set(quota.ref, quota.dati);
    batch.set(offerRef, {
      title,
      description,
      type: currentOfferType,
      cpValue: valore.kp,
      ...valore.dati,
      fotoCount: fotos.length,
      thumb: fotos.length ? fotos[0].thumb : null,
      reportCount: 0,
      ownerId: me.uid,
      ownerName: (me.displayName || 'Utente Rikeka').slice(0, 80),
      timestamp: serverTimestamp(),
      status: esito.status,
      keywords: paroleChiaveAnnuncio(state.catalog, { title, description, type: currentOfferType, ...valore.dati }),
      zona: zonaValida(state.zona) ? { nome: state.zona.nome, lat: state.zona.lat, lng: state.zona.lng } : null
    });
    fotos.forEach((f, i) => batch.set(doc(db, 'offerte', offerRef.id, 'foto', String(i)), { src: f.full }));
    await batch.commit();

    logEvent('offer_created', {
      offerId: offerRef.id, title, type: currentOfferType, kp: valore.kp, status: esito.status, photos: fotos.length, ...valore.dati
    }, esito.status === 'in_verifica' ? 'warn' : 'info');

    alert(esito.status === 'in_verifica'
      ? `Annuncio inviato! Vale ${valore.kp} KP, quindi sarà visibile dopo la verifica di un amministratore. Puoi seguirne lo stato nel tuo Profilo.`
      : 'Annuncio pubblicato con successo!');
    resetPublishForm();
    window.navigate(esito.status === 'in_verifica' ? 'profile-screen' : 'home-screen',
                    $(esito.status === 'in_verifica' ? 'nav-profile' : 'nav-home'));
  } catch (e) {
    reportError('publishOffer', e, {
      type: currentOfferType, kp: valore.kp, foto: fotos.length, admin: !!state.isAdmin,
      lunghezzaTitolo: title.length, lunghezzaDescrizione: description.length, versione: APP_VERSIONE
    });
    alert(e?.code === 'permission-denied'
      ? "Il server non ha accettato l'annuncio.\n\nSe hai appena aggiornato l'app, chiudila e riaprila (in fondo al Profilo controlla la versione: " + APP_VERSIONE + ") e riprova.\nSe il problema continua, usa 🐞 Segnala un problema dal Profilo."
      : 'Errore durante la pubblicazione: ' + friendlyError(e));
  } finally {
    btn.disabled = false; btn.textContent = 'Pubblica';
  }
};

/** Elimina annuncio e foto in un'unica operazione. Usata anche dal pannello admin. */
export async function deleteOfferWithFotos(docId) {
  const o = state.offers.get(docId) || (await getDoc(doc(db, 'offerte', docId))).data();
  const batch = writeBatch(db);
  const n = Number(o?.fotoCount) || 0;
  for (let i = 0; i < n; i++) batch.delete(doc(db, 'offerte', docId, 'foto', String(i)));
  batch.delete(doc(db, 'offerte', docId));
  await batch.commit();
  state.offers.delete(docId);
  return o;
}

window.deleteOffer = async function (docId) {
  if (!confirm('Sei sicuro di voler eliminare questo annuncio?')) return;
  try {
    const o = await deleteOfferWithFotos(docId);
    logEvent('offer_deleted', { offerId: docId, title: o?.title || null, kp: o?.cpValue || null, status: o?.status || null });
  } catch (e) {
    reportError('deleteOffer', e, { offerId: docId });
    alert("Errore durante l'eliminazione: " + friendlyError(e));
  }
};

window.loadMoreOffers = function () {
  homePages++;
  if (searchTerms.length) runSearch(); else loadOffers();
};

// In home si caricano gli annunci piu' recenti (HOME_BATCH per volta) e si
// mostrano ordinati per vicinanza alla zona dell'utente.
const HOME_BATCH = 60;

let offersTimer = null;
function loadOffers() {
  unsub.offers?.();
  clearTimeout(offersTimer);
  const lim = HOME_BATCH * homePages;
  const q = query(collection(db, 'offerte'),
    where('status', 'in', ['disponibile', 'in_trattativa']),
    orderBy('timestamp', 'desc'),
    limit(lim));
  // Se dopo 15 secondi il server non ha ancora risposto, lo diciamo invece di lasciare la pagina vuota
  offersTimer = setTimeout(async () => {
    if (await bloccoPubblicita()) return;   // AdBlock & co.: avviso dedicato
    mostraErroreAnnunci('Gli annunci non arrivano dal server. Può essere la connessione, un blocco della rete (Wi-Fi aziendale, antivirus) o una versione vecchia dell\'app salvata nel browser.');
    logEvent('offers_slow', { fromCache: true }, 'warn');
  }, 8000);
  unsub.offers = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    if (!snap.metadata?.fromCache) { clearTimeout(offersTimer); mostraErroreAnnunci(null); }
    homeOffers = snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) }));
    homeOffers.forEach((o) => state.offers.set(o.id, o.data));
    homeHasMore = snap.size >= lim;
    renderOffers();
  }, async (e) => {
    clearTimeout(offersTimer);
    reportError('loadOffers', e);
    if (e.code !== 'failed-precondition' && await bloccoPubblicita()) return;
    mostraErroreAnnunci(e.code === 'failed-precondition'
      ? 'Manca l\'indice Firestore per gli annunci: l\'amministratore deve crearlo (vedi LEGGIMI).'
      : `Non è stato possibile caricare gli annunci: ${String(friendlyError(e)).replace(/\.$/, '')}.`);
  });
}

// ---------- Blocco pubblicità (AdBlock, uBlock, Brave Shields…) ----------
// Alcune estensioni bloccano i server di Firebase: annunci e chat non arrivano.
// Prova: i file di Google (gstatic) si caricano ma il server del database no -> è un blocco del browser.
let esitoBlocco = null;
async function raggiungibile(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch (_) { return false; }
}
async function bloccoPubblicita() {
  if (esitoBlocco === null) {
    esitoBlocco = (async () => {
      if (navigator.onLine === false) return false;
      const progetto = encodeURIComponent('projects/' + (db?.app?.options?.projectId || 'x') + '/databases/(default)');
      const [google, database] = await Promise.all([
        raggiungibile('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        raggiungibile(`https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?database=${progetto}&VER=8&RID=prova&zx=${Date.now()}`)
      ]);
      return google && !database;
    })();
  }
  const bloccato = await esitoBlocco;
  if (bloccato) {
    mostraAvvisoBlocco();
    logEvent('adblock_detected', { ua: navigator.userAgent.slice(0, 120) }, 'warn');
  } else esitoBlocco = null;   // nessun blocco: la prossima volta si riprova da capo
  return bloccato;
}
function mostraAvvisoBlocco() {
  const box = $('offers-error');
  if (!box) return;
  box.classList.remove('hidden');
  box.classList.add('offers-adblock');
  box.innerHTML = `<p><b>🛑 Un blocco della pubblicità sta bloccando Rikeka</b></p>
    <p>Un'estensione come <b>AdBlock, uBlock Origin, AdGuard</b> o la protezione di <b>Brave/Opera</b> impedisce di caricare annunci e chat.
    Rikeka non mostra pubblicità: puoi disattivarlo solo per questo sito senza rischi.</p>
    <ol>
      <li>Clicca l'icona dell'estensione in alto a destra, accanto all'indirizzo (es. la mano rossa di AdBlock o lo scudo di uBlock/Brave).</li>
      <li>Scegli <b>«Non eseguire su questo sito»</b>, <b>«Disattiva su rikeka.it»</b> o il pulsante di accensione blu.</li>
      <li>Premi <b>Ricarica</b> qui sotto.</li>
    </ol>
    <div class="offers-error-actions"><button type="button" onclick="location.reload()">↻ Ricarica</button></div>`;
}

// Riquadro rosso in Home con "Riprova" e "Ripara l'app" (null = nasconde)
function mostraErroreAnnunci(testo) {
  const box = $('offers-error');
  if (!box) return;
  box.classList.remove('offers-adblock');
  box.classList.toggle('hidden', !testo);
  if (!testo) { box.replaceChildren(); return; }
  box.innerHTML = `<p>⚠️ ${esc(testo)}</p>
    <div class="offers-error-actions">
      <button type="button" onclick="riprovaAnnunci()">↻ Riprova</button>
      <button type="button" onclick="riparaApp()">🧹 Ripara l'app</button>
    </div>`;
}
window.riprovaAnnunci = function () {
  mostraErroreAnnunci(null);
  if (searchTerms.length) runSearch(); else loadOffers();
};
// Svuota la memoria del browser per questo sito (dati e vecchia versione dell'app) e ricarica
window.riparaApp = async function () {
  if (!confirm('Ripara l\'app: cancello la memoria di Rikeka in questo browser e ricarico la pagina. Resterai collegato. Procedo?')) return;
  logEvent('app_repair', {});
  await svuotaMemoriaLocale();
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(regs.map((r) => r.unregister()));
    const chiavi = await caches?.keys?.() || [];
    await Promise.all(chiavi.map((k) => caches.delete(k)));
  } catch (e) { console.warn('Pulizia cache:', e); }
  location.reload();
};

// ---------- Ricerca ----------
let searchTerms = [];          // termini cercati (normalizzati)
let searchResults = null;      // risultati dal database, oppure null se non si sta cercando
let searchTimer = null;
let searchSeq = 0;
let homeHasMore = false;
let groupFilter = '';          // gruppo di categorie scelto nei filtri rapidi

window.onSearchInput = function (value) {
  clearTimeout(searchTimer);
  $('search-clear').classList.toggle('hidden', !value);
  searchTimer = setTimeout(() => {
    searchTerms = terminiRicerca(value);
    homePages = 1;
    if (!searchTerms.length) { searchResults = null; renderOffers(); return; }
    runSearch();
  }, 300);
};

window.clearSearch = function () {
  $('search-input').value = '';
  window.onSearchInput('');
};

async function runSearch() {
  const seq = ++searchSeq;
  const lim = HOME_BATCH * homePages;
  $('search-status').textContent = 'Cerco…';
  try {
    const snap = await getDocs(query(collection(db, 'offerte'),
      where('keywords', 'array-contains', searchTerms[0]),
      where('status', 'in', ['disponibile', 'in_trattativa']),
      orderBy('timestamp', 'desc'),
      limit(lim)));
    if (seq !== searchSeq) return;                      // e' arrivata una ricerca piu' recente
    searchResults = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    searchResults.forEach((o) => state.offers.set(o.id, o.data));
    homeHasMore = snap.size >= lim;
    if (homePages === 1) logEvent('search', { q: searchTerms.join(' ').slice(0, 60), results: snap.size });
  } catch (e) {
    if (seq !== searchSeq) return;
    reportError('runSearch', e);
    // Se manca l'indice o c'e' un errore, cerca almeno tra gli annunci gia' caricati
    searchResults = homeOffers.filter((o) => (o.data.keywords || []).includes(searchTerms[0]) || normalizzaTesto(o.data.title + ' ' + o.data.description).includes(searchTerms[0]));
    homeHasMore = false;
  }
  renderOffers();
}

window.setGroupFilter = function (g) {
  groupFilter = groupFilter === g ? '' : g;
  renderOffers();
};

function renderGroupChips() {
  const box = $('group-chips');
  if (!box) return;
  box.innerHTML = [`<button type="button" class="filter-chip${groupFilter ? '' : ' filter-chip-on'}" onclick="setGroupFilter('')">Tutte</button>`]
    .concat(gruppiOrdinati(state.catalog).map(({ gruppo, icona }) =>
      `<button type="button" class="filter-chip${groupFilter === gruppo ? ' filter-chip-on' : ''}" data-g="${esc(gruppo)}" onclick="setGroupFilter(this.dataset.g)">${icona} ${esc(gruppo)}</button>`))
    .join('');
}

/** Annunci da mostrare: ricerca + filtri, ordinati per vicinanza (poi per data). */
function annunciVisibili() {
  const base = searchResults || homeOffers;
  const altri = searchTerms.slice(1);
  const lista = base.filter(({ data: o }) => {
    if (altri.length) {
      const kw = o.keywords || [];
      const testo = normalizzaTesto(`${o.title} ${o.description} ${o.marca || ''} ${o.modello || ''}`);
      if (!altri.every((t) => kw.includes(t) || testo.includes(t))) return false;
    }
    if (groupFilter) {
      const g = o.type === 'servizio' ? null : state.catalog.sottocategorie[o.sottocategoria]?.gruppo || 'Altro';
      if (g !== groupFilter) return false;
    }
    return true;
  }).map((x) => ({ ...x, km: distanzaKm(state.zona, x.data.zona) }));
  lista.sort((a, b) => {
    const da = a.km ?? Infinity, dbk = b.km ?? Infinity;
    if (da !== dbk) return da - dbk;
    return (b.data.timestamp?.toMillis?.() || 0) - (a.data.timestamp?.toMillis?.() || 0);
  });
  return lista;
}

function loadMyOffers(uid) {
  const q = query(collection(db, 'offerte'), where('ownerId', '==', uid));
  unsub.myOffers = onSnapshot(q, (snap) => {
    myOffers = snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) }));
    let changed = false;
    myOffers.forEach((o) => {
      state.offers.set(o.id, o.data);
      const prev = myOfferStatus.get(o.id);
      if (prev && prev !== o.data.status && ['disponibile', 'rifiutato'].includes(o.data.status) && prev === 'in_verifica') changed = true;
      myOfferStatus.set(o.id, o.data.status);
    });
    if (changed && !$('profile-screen').classList.contains('active')) {
      hasNewProfileUpdate = true;
      updateProfileTabIndicator();
    }
    renderMyOffers();
    renderStorico();
  }, (e) => reportError('loadMyOffers', e));
}

window.startChat = async function (offerId) {
  const me = auth.currentUser;
  if (!me) return;
  try {
    const snap = await getDoc(doc(db, 'offerte', offerId));
    if (!snap.exists()) return alert('Annuncio non trovato.');
    const offer = snap.data();
    if (offer.ownerId === me.uid) return alert('Non puoi chattare per il tuo annuncio.');
    if (state.sospeso) return alert('Il tuo account è sospeso: non puoi avviare chat.');
    if (offer.status !== 'disponibile') return alert("L'annuncio non è più disponibile.");
    if ((offer.reportCount || 0) >= state.catalog.sogliaSegnalazioni || offer.nascosto) return alert("L'annuncio è in revisione.");

    const cost = Number(offer.cpValue) || 0;
    if (!state.isAdmin && state.karma !== null && state.karma < cost) {
      logEvent('kp_blocked', { offerId, cost, balance: state.karma }, 'warn');
      return alert(`KP insufficienti: servono ${cost} KP, ne hai ${state.karma}. Regala qualcosa per accumularne!`);
    }

    const existing = await getDocs(query(collection(db, 'chats'), where('offerId', '==', offerId), where('users', 'array-contains', me.uid)));
    let chatId;
    if (!existing.empty) {
      chatId = existing.docs[0].id;
    } else {
      const ref = await addDoc(collection(db, 'chats'), {
        offerId,
        offerTitle: offer.title,
        ownerId: offer.ownerId,
        buyerId: me.uid,
        buyerName: (me.displayName || 'Utente').slice(0, 80),
        users: [offer.ownerId, me.uid],
        createdAt: serverTimestamp(),
        lastMessage: 'Chat avviata.',
        lastMessageTimestamp: serverTimestamp(),
        lastMessageSenderId: me.uid
      });
      chatId = ref.id;
      logEvent('chat_started', { offerId, chatId, kp: cost });
    }
    window.openChat(chatId, offer.title);
  } catch (e) {
    reportError('startChat', e, { offerId });
    alert('Impossibile avviare la chat: ' + friendlyError(e));
  }
};

// ---------- 9. SCAMBIO E TRASFERIMENTO KP ----------
window.closeBuyerModal = () => { $('buyer-modal').style.display = 'none'; };

window.setInTrattativa = async function (docId) {
  const me = auth.currentUser;
  try {
    const snap = await getDoc(doc(db, 'offerte', docId));
    if (!snap.exists()) return alert('Annuncio non trovato.');
    const offer = snap.data();
    const cost = Number(offer.cpValue) || 0;
    const chats = await getDocs(query(collection(db, 'chats'), where('offerId', '==', docId), where('users', 'array-contains', me.uid)));
    const buyerIds = [...new Set(chats.docs.map((c) => (c.data().users || []).find((u) => u !== me.uid)).filter(Boolean))];
    if (!buyerIds.length) return alert('Nessuno ha ancora scritto per questo annuncio: attendi che qualcuno avvii una chat.');

    const buyers = await Promise.all(buyerIds.map(async (uid) => {
      const chat = chats.docs.find((c) => (c.data().users || []).includes(uid))?.data() || {};
      let karma = 0, name = chat.buyerName || 'Utente', admin = false, rep = '';
      try {
        const u = await getDoc(doc(db, 'users', uid));
        if (u.exists()) { karma = u.data().karmaPoints ?? 0; name = u.data().displayName || name; rep = testoReputazione(u.data()); }
        admin = (await getDoc(doc(db, 'admins', uid))).exists();
      } catch (_) {}
      return { uid, name, karma, admin, rep };
    }));

    $('buyer-offer-info').textContent = `"${offer.title}" — valore ${cost} KP. Scegli a chi assegnarlo:`;
    $('buyer-list').innerHTML = buyers.map((b) => {
      const ok = b.admin || b.karma >= cost;
      return `<button ${ok ? '' : 'disabled'} data-uid="${esc(b.uid)}" data-name="${esc(b.name)}" onclick="confirmReserve('${sid(docId)}', this.dataset.uid, this.dataset.name)"
                class="w-full text-left p-3 rounded-lg border ${ok ? 'border-green-300 bg-green-50 hover:bg-green-100' : 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'}">
                <span class="font-medium">${esc(b.name)}</span>
                <span class="block text-xs">${b.karma} KP ${ok ? '' : `(ne servono ${cost})`} ${b.rep ? '· ' + b.rep : ''}</span>
              </button>`;
    }).join('');
    $('buyer-modal').style.display = 'flex';
  } catch (e) {
    reportError('setInTrattativa', e, { offerId: docId });
    alert('Impossibile aprire la selezione: ' + friendlyError(e));
  }
};

window.confirmReserve = async function (docId, buyerId, buyerName) {
  try {
    await updateDoc(doc(db, 'offerte', docId), {
      status: 'in_trattativa',
      reservedBy: buyerId,
      reservedByName: String(buyerName || 'Utente').slice(0, 80)
    });
    logEvent('offer_reserved', { offerId: docId, buyerId });
    notify('reserved', { offerId: docId });
    state.offers.set(docId, { ...(state.offers.get(docId) || {}), reservedBy: buyerId });
    postChatEvent(docId, `🤝 ${auth.currentUser.displayName || 'Chi regala'} ha riservato l'annuncio per ${String(buyerName || 'te').slice(0, 40)}`);
    window.closeBuyerModal();
  } catch (e) {
    reportError('confirmReserve', e, { offerId: docId, buyerId });
    alert('Impossibile mettere in trattativa: ' + friendlyError(e));
  }
};

window.setDisponibile = async function (docId) {
  if (!confirm("Rendere l'annuncio nuovamente disponibile a tutti?")) return;
  try {
    const prima = state.offers.get(docId);
    await updateDoc(doc(db, 'offerte', docId), { status: 'disponibile', reservedBy: null, reservedByName: null });
    logEvent('offer_released', { offerId: docId });
    if (prima?.reservedBy) {
      const c = allChatsData.find((x) => x.data.offerId === docId && (x.data.users || []).includes(prima.reservedBy));
      if (c) postChatEventTo(c.id, '↩️ Trattativa annullata: l\'annuncio è di nuovo disponibile');
    }
  } catch (e) {
    reportError('setDisponibile', e, { offerId: docId });
    alert("Impossibile ripristinare l'annuncio: " + friendlyError(e));
  }
};

window.closeFeedbackModal = function () {
  $('feedback-modal').style.display = 'none';
  $('feedback-modal').dataset.docId = '';
};

// --- Passo 1: chi regala segna "consegnato" (nessun KP si muove ancora) ---
window.markDelivered = async function (docId) {
  const o = state.offers.get(docId);
  if (!confirm(`Sei con ${o?.reservedByName || 'chi lo riceve'} e stai per consegnare "${o?.title || 'l\'annuncio'}"?\n\n` +
               'Dopo OK chiedigli di confermare la ricezione dal suo telefono: consegna l\'oggetto solo quando vedi la conferma ✅. In quel momento riceverai i KP.')) return;
  try {
    await updateDoc(doc(db, 'offerte', docId), { status: 'consegnato', deliveredAt: serverTimestamp(), aiutoRichiesto: false });
    logEvent('offer_delivered', { offerId: docId, buyerId: o?.reservedBy || null });
    notify('delivered', { offerId: docId });
    postChatEvent(docId, '📦 Consegna segnata: conferma la ricezione qui sopra, poi riceverai l\'oggetto');
  } catch (e) {
    reportError('markDelivered', e, { offerId: docId });
    alert('Operazione non riuscita: ' + friendlyError(e));
  }
};

// --- Passo 2: chi riceve conferma e valuta: solo ora i KP si spostano ---
window.confirmReceived = function (docId) {
  const o = toReceive.find((x) => x.id === docId)?.data || state.offers.get(docId);
  if (!o) return;
  $('feedback-modal').dataset.docId = docId;
  $('feedback-offer-title').textContent = `"${o.title}" da ${o.ownerName || 'chi lo regala'}`;
  $('feedback-kp-info').textContent = state.isAdmin
    ? `Confermando, ${o.ownerName || 'chi regala'} riceve ${o.cpValue} KP (come amministratore non li paghi).`
    : `Confermando, paghi −${o.cpValue} KP e ${o.ownerName || 'chi regala'} li riceve.`;
  $('feedback-modal').style.display = 'flex';
};

window.notReceived = async function (docId) {
  if (!confirm('Segnali di NON aver ricevuto il bene o il servizio?\nLo scambio torna "in trattativa" e nessun KP viene spostato. Scrivi all\'altra persona in chat per chiarire.')) return;
  try {
    await updateDoc(doc(db, 'offerte', docId), { status: 'in_trattativa', deliveredAt: null });
    logEvent('offer_not_received', { offerId: docId }, 'warn');
    notify('not_received', { offerId: docId });
    postChatEvent(docId, '⚠️ Ricezione non confermata: parliamone qui');
  } catch (e) {
    reportError('notReceived', e, { offerId: docId });
    alert('Operazione non riuscita: ' + friendlyError(e));
  }
};

window.submitFeedback = async function (feedbackType) {
  const docId = $('feedback-modal').dataset.docId;
  const me = auth.currentUser;
  if (!me || !docId) return alert('Errore nei dati.');
  if (!['positivo', 'negativo'].includes(feedbackType)) return;

  const offerRef = doc(db, 'offerte', docId);
  let summary = null;
  try {
    await runTransaction(db, async (tx) => {
      const offerSnap = await tx.get(offerRef);
      if (!offerSnap.exists()) throw new Error('Annuncio non trovato.');
      const o = offerSnap.data();
      if (o.reservedBy !== me.uid) throw new Error('Operazione non consentita.');
      if (o.status !== 'consegnato') throw new Error('Chi regala non ha ancora segnato la consegna.');
      const cp = Number(o.cpValue);
      if (!Number.isInteger(cp) || cp < 1) throw new Error('Valore KP non valido.');

      const buyerRef = doc(db, 'users', me.uid);
      const giverRef = doc(db, 'users', o.ownerId);
      const buyerSnap = await tx.get(buyerRef);
      const giverSnap = await tx.get(giverRef);
      if (!giverSnap.exists() || !buyerSnap.exists()) throw new Error('Profilo utente non trovato.');
      const g = giverSnap.data(), b = buyerSnap.data();
      const buyerKarma = b.karmaPoints ?? 0;
      const paga = state.isAdmin ? 0 : cp;   // gli amministratori non pagano KP
      // bonus di benvenuto: si incassa al primo scambio concluso (e torna a zero)
      const bonusB = Number.isInteger(b.bonusPrimoScambio) ? b.bonusPrimoScambio : 0;
      const bonusG = Number.isInteger(g.bonusPrimoScambio) ? g.bonusPrimoScambio : 0;
      if (buyerKarma + bonusB < paga) throw new Error(`Hai solo ${buyerKarma} KP: ne servono ${cp}.`);

      tx.update(offerRef, { status: 'concluso', feedback: feedbackType, completionDate: serverTimestamp() });
      tx.update(buyerRef, {
        karmaPoints: buyerKarma - paga + bonusB, completedSwaps: (b.completedSwaps ?? 0) + 1, lastOfferId: docId,
        ...('bonusPrimoScambio' in b ? { bonusPrimoScambio: 0 } : {})
      });
      tx.update(giverRef, {
        karmaPoints: (g.karmaPoints ?? 0) + cp + bonusG, completedSwaps: (g.completedSwaps ?? 0) + 1, lastOfferId: docId,
        ...('bonusPrimoScambio' in g ? { bonusPrimoScambio: 0 } : {}),
        ...(feedbackType === 'positivo' ? { fbPos: (g.fbPos ?? 0) + 1 } : { fbNeg: (g.fbNeg ?? 0) + 1 })
      });
      summary = { offerId: docId, title: o.title, type: o.type, kp: cp, giverId: o.ownerId, buyerId: me.uid, feedback: feedbackType, bonusB, bonusG };
    });
    logEvent('exchange_completed', summary, feedbackType === 'negativo' ? 'warn' : 'info');
    repCache.delete(summary.giverId);
    notify('concluded', { offerId: docId });
    postChatEvent(docId, `✅ Ricezione confermata: ${summary.kp} KP trasferiti. Ora puoi consegnare l'oggetto`);
    alert(`Ricezione confermata! ${summary.kp} KP sono passati a chi ti ha aiutato: ora può lasciarti l'oggetto.` +
      (summary.bonusB > 0 ? `\n\n🎁 Era il tuo primo scambio: hai ricevuto anche il bonus di benvenuto di ${summary.bonusB} KP!` : '') +
      `\n\nSe scopri un problema hai ${ORE_CONTESTAZIONE} ore per segnalarlo: Profilo → Scambi conclusi, oppure qui in chat.`);
  } catch (e) {
    reportError('submitFeedback', e, { offerId: docId });
    alert('Scambio non concluso: ' + friendlyError(e));
  } finally {
    window.closeFeedbackModal();
  }
};

// --- Annunci riservati a me ---
function loadToReceive(uid) {
  const q = query(collection(db, 'offerte'), where('reservedBy', '==', uid));
  unsub.toReceive = onSnapshot(q, (snap) => {
    const tutti = snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) }));
    toReceive = tutti.filter((o) => ['in_trattativa', 'consegnato'].includes(o.data.status));
    ricevutiConclusi = tutti.filter((o) => o.data.status === 'concluso');
    let nuovaConsegna = false;
    toReceive.forEach((o) => {
      state.offers.set(o.id, o.data);
      if (o.data.status === 'consegnato' && toReceiveStatus.get(o.id) !== 'consegnato') nuovaConsegna = true;
      toReceiveStatus.set(o.id, o.data.status);
    });
    if (nuovaConsegna && !$('profile-screen').classList.contains('active')) {
      hasNewProfileUpdate = true;
      updateProfileTabIndicator();
    }
    renderToReceive();
    renderStorico();
  }, (e) => reportError('loadToReceive', e));
}

function renderToReceive() {
  const box = $('to-receive');
  if (!box) return;
  $('to-receive-section').classList.toggle('hidden', !toReceive.length);
  box.innerHTML = toReceive.map(({ id, data: o }) => {
    const action = o.status === 'consegnato'
      ? `<p class="text-xs text-blue-700 mt-1">${esc(o.ownerName)} è pronto a consegnartelo: conferma quando ce l'hai davanti.</p>
         <button onclick="confirmReceived('${sid(id)}')" class="mt-2 w-full bg-green-600 hover:bg-green-700 text-white px-3 py-2 text-sm font-medium rounded-lg">✓ Confermo la ricezione</button>
         <button onclick="notReceived('${sid(id)}')" class="mt-1 w-full text-xs text-red-600 hover:underline">Non l'ho ricevuto</button>`
      : `<p class="text-xs text-gray-500 mt-1">Riservato per te: accordati in chat con ${esc(o.ownerName)} per la consegna.</p>`;
    return `
      <div class="p-3 border rounded-lg text-left ${o.status === 'consegnato' ? 'storico-urgente' : 'border-gray-200'}">
        <div class="flex justify-between items-center gap-2">
          <span class="font-medium text-sm text-gray-800 truncate">${o.status === 'consegnato' ? '👉 ' : ''}${esc(o.title)}</span>
          <span class="text-xs font-bold text-amber-700 whitespace-nowrap">${o.cpValue} KP</span>
        </div>
        <div class="mt-1">${statusTag(o.status)}</div>
        ${action}
      </div>`;
  }).join('');
}

// ---------- 10. SEGNALAZIONI ----------
// ---------- Segnalazioni (utenti) e rimozioni (amministratori): stessa finestra ----------
const MOTIVI = {
  valore: 'valore in KP non corretto',
  offensivo: 'contenuto volgare o offensivo',
  vietato: 'oggetto vietato o pericoloso',
  truffa: 'possibile truffa',
  altro: 'altro'
};
let reportCtx = null;   // { offerId, mode: 'segnala' | 'rimuovi' }

function openReportModal(offerId, mode) {
  const o = state.offers.get(offerId);
  reportCtx = { offerId, mode };
  const rimuovi = mode === 'rimuovi';
  document.querySelectorAll('input[name="report-tipo"]').forEach((r) => { r.checked = false; });
  $('report-nota').value = '';
  $('report-sospendi').checked = false;
  $('report-sospendi-wrap').classList.toggle('hidden', !rimuovi);
  $('report-heading').textContent = rimuovi ? '🛡 Rimuovi l\'annuncio' : '⚑ Segnala l\'annuncio';
  $('report-offer').textContent = o ? `«${o.title}» di ${o.ownerName || 'utente'}` : '';
  $('report-hint').textContent = rimuovi
    ? "L'annuncio viene eliminato e l'autore riceve un avviso con il motivo."
    : 'Contenuti volgari o vietati vengono nascosti subito, in attesa di un amministratore.';
  $('report-send').textContent = rimuovi ? 'Rimuovi annuncio' : 'Invia segnalazione';
  $('report-modal').style.display = 'flex';
}

window.closeReport = function () {
  $('report-modal').style.display = 'none';
  reportCtx = null;
};

window.reportOffer = async function (offerId) {
  const me = auth.currentUser;
  try {
    const mine = await getDoc(doc(db, 'offerte', offerId, 'segnalazioni', me.uid));
    if (mine.exists()) return alert('Hai già segnalato questo annuncio. Grazie!');
  } catch (_) { /* il controllo vero lo fanno le regole */ }
  openReportModal(offerId, 'segnala');
};

window.adminRemoveOffer = function (offerId) {
  if (!state.isAdmin) return;
  openReportModal(offerId, 'rimuovi');
};

window.sendReport = async function () {
  if (!reportCtx) return;
  const { offerId, mode } = reportCtx;
  const tipo = document.querySelector('input[name="report-tipo"]:checked')?.value;
  const nota = $('report-nota').value.trim().slice(0, 300);
  if (!tipo) return alert('Scegli un motivo.');
  if (tipo === 'altro' && !nota) return alert('Scrivi in breve il motivo.');
  const btn = $('report-send');
  btn.disabled = true;
  try {
    if (mode === 'rimuovi') await rimuoviAnnuncio(offerId, tipo, nota, $('report-sospendi').checked);
    else {
      const grave = tipo === 'offensivo' || tipo === 'vietato';
      const batch = writeBatch(db);
      batch.set(doc(db, 'offerte', offerId, 'segnalazioni', auth.currentUser.uid), { tipo, motivo: nota, ts: serverTimestamp() });
      batch.update(doc(db, 'offerte', offerId), { reportCount: increment(1), ...(grave ? { nascosto: true } : {}) });
      await batch.commit();
      logEvent('offer_reported', { offerId, tipo, motivo: nota }, 'warn');
      alert(grave ? 'Grazie: l\'annuncio è stato nascosto e un amministratore lo controllerà.' : 'Segnalazione inviata. Un amministratore la controllerà.');
    }
    window.closeReport();
  } catch (e) {
    reportError(mode === 'rimuovi' ? 'adminRemoveOffer' : 'reportOffer', e, { offerId });
    alert((mode === 'rimuovi' ? 'Rimozione non riuscita: ' : 'Impossibile inviare la segnalazione: ') + friendlyError(e));
  } finally { btn.disabled = false; }
};

// Elimina l'annuncio lasciando all'autore un avviso con il motivo (e, se richiesto, lo sospende)
async function rimuoviAnnuncio(offerId, tipo, nota, sospendi) {
  const snap = await getDoc(doc(db, 'offerte', offerId));
  if (!snap.exists()) throw new Error('Annuncio già eliminato.');
  const o = snap.data();
  await setDoc(doc(db, 'rimozioni', offerId), {
    ownerId: o.ownerId, title: String(o.title || '').slice(0, 100), motivo: tipo, nota,
    by: auth.currentUser.uid, at: serverTimestamp(), visto: false
  });
  await deleteOfferWithFotos(offerId);
  logEvent('offer_removed_by_admin', { offerId, title: o.title, ownerId: o.ownerId, motivo: tipo, nota }, 'warn');
  notify('removed', { offerId });
  if (sospendi) {
    try {
      await setDoc(doc(db, 'sospesi', o.ownerId), {
        nome: String(o.ownerName || 'Utente').slice(0, 80), motivo: `${MOTIVI[tipo]}${nota ? ': ' + nota : ''}`.slice(0, 300),
        by: auth.currentUser.uid, at: serverTimestamp()
      });
      logEvent('user_suspended', { uid: o.ownerId, nome: o.ownerName }, 'warn');
    } catch (e) {
      alert('Annuncio rimosso, ma non è stato possibile sospendere l\'autore (gli amministratori non si possono sospendere).');
    }
  }
  homeOffers = homeOffers.filter((x) => x.id !== offerId);
  if (searchResults) searchResults = searchResults.filter((x) => x.id !== offerId);
  renderOffers();
  document.dispatchEvent(new Event('offer-removed'));
}

// All'accesso: avvisa l'autore degli annunci rimossi da un amministratore
async function checkRimozioni(uid) {
  try {
    const snap = await getDocs(query(collection(db, 'rimozioni'), where('ownerId', '==', uid)));
    for (const d of snap.docs) {
      const r = d.data();
      if (r.visto) continue;
      alert(`🛡 Il tuo annuncio «${r.title}» è stato rimosso da un amministratore.\nMotivo: ${MOTIVI[r.motivo] || r.motivo}${r.nota ? ' — ' + r.nota : ''}\n\nSe non sei d'accordo puoi chiedere una revisione: trovi il contatto nei Termini.`);
      await updateDoc(d.ref, { visto: true });
    }
  } catch (e) { reportError('checkRimozioni', e); }
}

// ---------- 11. FOTO / LIGHTBOX ----------
window.openLightbox = async function (offerId) {
  const o = state.offers.get(offerId);
  if (!o) return;
  let images = [];
  try {
    if (Array.isArray(o.images) && o.images.length) {
      images = o.images.map(safeImg).filter(Boolean);           // annunci vecchi
    } else if (o.fotoCount) {
      $('lightbox-img').removeAttribute('src');
      $('lightbox-counter').textContent = 'Caricamento...';
      $('lightbox').style.display = 'flex';
      const snap = await getDocs(collection(db, 'offerte', offerId, 'foto'));
      images = snap.docs.sort((a, b) => Number(a.id) - Number(b.id)).map((d) => safeImg(d.data().src)).filter(Boolean);
    }
  } catch (e) {
    reportError('openLightbox', e, { offerId });
  }
  // Foto grandi archiviate (scambi conclusi da tempo): si mostra la miniatura
  if (!images.length && safeImg(o.thumb)) images = [safeImg(o.thumb)];
  if (!images.length) { window.closeLightbox(); return; }
  lightboxState = { images, index: 0 };
  paintLightbox();
  $('lightbox').style.display = 'flex';
};
function paintLightbox() {
  $('lightbox-img').src = lightboxState.images[lightboxState.index];
  $('lightbox-counter').textContent = `${lightboxState.index + 1} / ${lightboxState.images.length}`;
}
window.stepLightbox = function (d) {
  const n = lightboxState.images.length;
  if (!n) return;
  lightboxState.index = (lightboxState.index + d + n) % n;
  paintLightbox();
};
window.closeLightbox = () => { $('lightbox').style.display = 'none'; };

// ---------- 12. RENDER ----------
const ICON_BENE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';
const ICON_SERV = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z"/></svg>';

export function valuationLine(o) {
  const c = state.catalog;
  if (o.type === 'bene') {
    return [
      c.sottocategorie[o.sottocategoria]?.label,
      [o.marca, o.modello].filter(Boolean).join(' '),
      c.condizioni[o.condizione]?.label,
      o.annoAcquisto ? `acquistato nel ${o.annoAcquisto}` : null,
      o.prezzoNuovo ? `nuovo ≈ ${o.prezzoNuovo} €` : null
    ].filter(Boolean).map(esc).join(' · ');
  }
  return [c.servizi[o.livello]?.label?.split(' (')[0], o.ore ? `${o.ore} h` : null].filter(Boolean).map(esc).join(' · ');
}

export function thumbHtml(id, o) {
  const legacy = Array.isArray(o.images) ? o.images.map(safeImg).filter(Boolean) : [];
  const src = safeImg(o.thumb) || legacy[0];
  const count = o.fotoCount || legacy.length;
  if (!src) return '';
  return `<img src="${src}" loading="lazy" alt="Foto annuncio" class="offer-thumb" onclick="openLightbox('${sid(id)}')">
          <p class="text-xs text-gray-400 mb-3">📷 ${count ? `${count} foto · tocca per ingrandire` : 'foto archiviata'}</p>`;
}

function statusTag(status) {
  const s = STATUS_LABEL[status] || { text: status, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
  return `<span class="text-xs font-semibold px-2 py-0.5 rounded-full border ${s.cls}">${esc(s.text)}</span>`;
}

// Data e ora di pubblicazione: breve per l'elenco ("Oggi 08:30", "Ieri 18:12", "28 ott 14:05"),
// estesa per il dettaglio ("Pubblicato il 28 ottobre 2026 alle 14:05")
function quandoPubblicato(ts, estesa = false) {
  const d = tsToDate(ts);
  if (!d) return '';
  const ora = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (estesa) return `Pubblicato il ${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })} alle ${ora}`;
  const oggi = new Date(), ieri = new Date(); ieri.setDate(oggi.getDate() - 1);
  if (d.toDateString() === oggi.toDateString()) return `Oggi ${ora}`;
  if (d.toDateString() === ieri.toDateString()) return `Ieri ${ora}`;
  const giorno = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', ...(d.getFullYear() !== oggi.getFullYear() ? { year: '2-digit' } : {}) });
  return `${giorno.replace('.', '')} ${ora}`;
}

// Dati di un annuncio pronti per l'elenco (riga compatta) e per il dettaglio.
// Restituisce null se l'annuncio non va mostrato (nascosto, filtro "posso permettermi").
const kmAnnunci = new Map();
function infoAnnuncio(id, o, km) {
  const me = auth.currentUser;
  if (!me || !o) return null;
  const soglia = state.catalog.sogliaSegnalazioni;
  const cp = Number(o.cpValue) || 0;
  const isOwner = o.ownerId === me.uid;
  const hidden = (o.reportCount || 0) >= soglia || o.nascosto === true;
  if (hidden && !isOwner && !state.isAdmin) return null;
  const isTrattativa = o.status === 'in_trattativa';
  const affordable = state.isAdmin || state.karma === null || state.karma >= cp;
  const bene = o.type === 'bene';

  let buttons = '';
  if (isOwner) {
    if (hidden) {
      buttons = `<p class="ad-note ad-note-red">Annuncio nascosto per segnalazioni: un amministratore lo sta controllando.</p>`;
    } else if (isTrattativa) {
      buttons = `
        <p class="ad-note">Assegnato a: <b>${esc(o.reservedByName || 'acquirente')}</b></p>
        <button onclick="markDelivered('${sid(id)}')" class="ad-btn ad-btn-main">📦 Ho consegnato</button>
        <p class="ad-note">Riceverai ${cp} KP quando ${esc(o.reservedByName || 'l\'altra persona')} confermerà di averlo ricevuto.</p>
        <button onclick="setDisponibile('${sid(id)}')" class="ad-btn ad-btn-ghost">Rendi di nuovo disponibile</button>`;
    } else {
      buttons = `
        <button onclick="setInTrattativa('${sid(id)}')" class="ad-btn ad-btn-warn">Metti in trattativa</button>
        <button onclick="deleteOffer('${sid(id)}')" class="ad-btn ad-btn-danger">Elimina annuncio</button>`;
    }
  } else if (isTrattativa) {
    buttons = `<button disabled class="ad-btn ad-btn-off">${o.reservedBy === me.uid ? 'Riservato per te: conferma la ricezione dal Profilo' : 'In trattativa con un\'altra persona'}</button>`;
  } else {
    buttons = affordable
      ? `<button onclick="startChat('${sid(id)}')" class="ad-btn ad-btn-main">💬 Avvia chat</button>`
      : `<button disabled class="ad-btn ad-btn-off">KP insufficienti (servono ${cp}, hai ${state.karma})</button>`;
    buttons += `<button onclick="reportOffer('${sid(id)}')" class="ad-btn ad-btn-link">⚑ Segnala l'annuncio</button>`;
  }
  if (state.isAdmin && !isOwner) buttons += `<button onclick="adminRemoveOffer('${sid(id)}')" class="admin-remove">🛡 Rimuovi (amministratore)${hidden ? ' · nascosto per segnalazioni' : ''}</button>`;

  // Foto: miniatura (o icona del tipo) + numero di foto
  const legacy = Array.isArray(o.images) ? o.images.map(safeImg).filter(Boolean) : [];
  const src = safeImg(o.thumb) || legacy[0] || '';
  const nFoto = o.fotoCount || legacy.length;
  const c = state.catalog;
  const sub = bene ? c.sottocategorie?.[o.sottocategoria]?.label : c.servizi?.[o.livello]?.label?.split(' (')[0];
  const chips = bene
    ? [c.condizioni?.[o.condizione]?.label?.split(' (')[0], o.annoAcquisto ? `Anno ${o.annoAcquisto}` : null]
    : [o.ore ? `⏱ ${o.ore} h` : null];
  const stato = isTrattativa ? '<span class="ad-flag ad-flag-deal">In trattativa</span>'
    : o.status === 'in_verifica' ? '<span class="ad-flag ad-flag-check">In verifica</span>' : '';

  const card = `
    <article class="ad-card ${bene ? 'ad-bene' : 'ad-serv'}${hidden ? ' ad-hidden' : ''}" role="button" tabindex="0"
             onclick="apriAnnuncio('${sid(id)}')" onkeydown="if(event.key==='Enter')apriAnnuncio('${sid(id)}')">
      <div class="ad-thumb">
        ${src ? `<img src="${src}" loading="lazy" alt="">` : `<div class="ad-thumb-empty">${bene ? ICON_BENE : ICON_SERV}</div>`}
        ${nFoto > 1 ? `<span class="ad-photos">📷 ${nFoto}</span>` : ''}
        ${stato}
      </div>
      <div class="ad-body">
        <div class="ad-top"><p class="ad-type">${bene ? 'Bene' : 'Servizio'}${sub ? ` · ${esc(sub)}` : ''}</p>
          <span class="ad-date">${esc(quandoPubblicato(o.timestamp))}</span></div>
        <h3 class="ad-title">${esc(o.title)}</h3>
        <p class="ad-kp"><b>${cp}</b> KP</p>
        ${zonaAnnuncioHtml(o, km, isOwner)}
        <div class="ad-chips">${chips.filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</div>
        <p class="ad-owner">${isOwner ? '<b>Il tuo annuncio</b>' : `${esc(o.ownerName || 'Utente')} <span class="rep" data-rep="${esc(o.ownerId)}"></span>`}</p>
      </div>
    </article>`;

  const detail = `
    <div class="ad-detail ${bene ? 'ad-bene' : 'ad-serv'}">
      ${src ? `<div class="ad-detail-photo" onclick="openLightbox('${sid(id)}')"><img src="${src}" alt="Foto annuncio">
        ${nFoto ? `<span class="ad-photos">📷 ${nFoto} · tocca per ingrandire</span>` : ''}</div>` : ''}
      <p class="ad-type">${bene ? 'Bene' : 'Servizio'}${sub ? ` · ${esc(sub)}` : ''}</p>
      <h3 class="ad-detail-title">${esc(o.title)}</h3>
      <div class="ad-detail-row"><p class="ad-kp ad-kp-big"><b>${cp}</b> KP</p>${statusTag(o.status)}</div>
      ${zonaAnnuncioHtml(o, km, isOwner)}
      <p class="ad-detail-desc">${esc(o.description)}</p>
      <p class="ad-detail-val">${valuationLine(o)}</p>
      <p class="ad-detail-date">🕒 ${esc(quandoPubblicato(o.timestamp, true))}</p>
      <p class="ad-owner">Offerto da: <b>${esc(o.ownerName || 'Utente')}</b> <span class="rep" data-rep="${esc(o.ownerId)}"></span></p>
      <div class="ad-actions">${buttons}</div>
    </div>`;
  return { card, detail, bene };
}

function renderOffers() {
  const me = auth.currentUser;
  if (!me) return;
  let beni = '', servizi = '';
  renderGroupChips();
  renderZoneBanner();
  const lista = annunciVisibili();
  kmAnnunci.clear();

  const filtrati = { bene: 0, servizio: 0 };
  lista.forEach(({ id, data: o, km }) => {
    kmAnnunci.set(id, km);
    const cp = Number(o.cpValue) || 0;
    const affordable = state.isAdmin || state.karma === null || state.karma >= cp;
    if (onlyAffordable && o.ownerId !== me.uid && !affordable) { filtrati[o.type === 'servizio' ? 'servizio' : 'bene']++; return; }
    const info = infoAnnuncio(id, o, km);
    if (!info) return;
    if (info.bene) beni += info.card; else servizi += info.card;
  });

  $('item-list-bene').innerHTML = beni;
  $('item-list-servizio').innerHTML = servizi;
  const cerco = searchTerms.length > 0 || !!groupFilter;
  const vuoto = (tipo) => cerco
    ? `Nessun ${tipo === 'bene' ? 'bene' : 'servizio'} trovato${searchTerms.length ? ` per «${esc($('search-input').value.trim())}»` : ''}. Prova con un'altra parola o togli i filtri.`
    : `Nessun ${tipo === 'bene' ? 'bene' : 'servizio'} disponibile.`;
  const vuotoFiltro = (tipo) => filtrati[tipo]
    ? ` ${filtrati[tipo] === 1 ? '1 annuncio è nascosto perché costa' : `${filtrati[tipo]} annunci sono nascosti perché costano`} più dei tuoi ${state.karma} KP: togli la spunta «Mostra solo ciò che posso permettermi» per vederli.`
    : '';
  $('empty-bene').textContent = vuoto('bene') + vuotoFiltro('bene');
  $('empty-servizio').textContent = vuoto('servizio') + vuotoFiltro('servizio');
  $('empty-bene').classList.toggle('hidden', !!beni);
  $('empty-servizio').classList.toggle('hidden', !!servizi);
  $('load-more').classList.toggle('hidden', !homeHasMore);
  fillReputazioni();
  $('search-status').textContent = searchTerms.length
    ? `${lista.length} ${lista.length === 1 ? 'risultato' : 'risultati'}${state.zona ? ', i più vicini per primi' : ''}`
    : (state.zona ? `Ordinati per vicinanza a ${state.zona.nome}` : '');
  if (annuncioAperto) aggiornaDettaglio();
}

// ---------- Dettaglio annuncio (foglio dal basso) ----------
let annuncioAperto = null;
function aggiornaDettaglio() {
  const o = state.offers.get(annuncioAperto);
  const info = infoAnnuncio(annuncioAperto, o, kmAnnunci.get(annuncioAperto) ?? null);
  if (!info) { window.chiudiAnnuncio(); return; }
  $('offer-sheet-body').innerHTML = info.detail;
  fillReputazioni();
}
window.apriAnnuncio = function (id) {
  if (!id || !state.offers.get(id)) return;
  annuncioAperto = id;
  aggiornaDettaglio();
  $('offer-sheet').style.display = 'flex';
};
window.chiudiAnnuncio = function () {
  annuncioAperto = null;
  $('offer-sheet').style.display = 'none';
};

function renderMyOffers() {
  const box = $('my-offers');
  if (!box) return;
  const visible = myOffers
    .filter((o) => o.data.status !== 'concluso')
    .sort((a, b) => (b.data.timestamp?.toMillis?.() || 0) - (a.data.timestamp?.toMillis?.() || 0));
  if (!visible.length) {
    box.innerHTML = '<p class="text-sm text-gray-400">Non hai annunci attivi.</p>';
    return;
  }
  box.innerHTML = visible.map(({ id, data: o }) => {
    let note = '';
    if (o.status === 'in_verifica') note = '<p class="text-xs text-purple-700 mt-1">In attesa di verifica da parte di un amministratore.</p>';
    if (o.status === 'rifiutato') note = `<p class="text-xs text-red-600 mt-1">Motivo: ${esc(o.motivoRifiuto || 'non indicato')}. Puoi eliminarlo e ripubblicarlo con dati corretti.</p>`;
    if (o.status === 'consegnato') note = `<p class="text-xs text-blue-700 mt-1">Aspetta che ${esc(o.reservedByName || 'chi riceve')} confermi la ricezione dal suo telefono prima di lasciargli l'oggetto: poi riceverai ${o.cpValue} KP.</p>`;
    if ((o.reportCount || 0) >= state.catalog.sogliaSegnalazioni || o.nascosto) note += '<p class="text-xs text-red-600 mt-1">Nascosto per segnalazioni, in revisione.</p>';
    const canDelete = ['disponibile', 'in_verifica', 'rifiutato'].includes(o.status);
    return `
      <div class="p-3 border border-gray-200 rounded-lg text-left">
        <div class="flex justify-between items-center gap-2">
          <span class="font-medium text-sm text-gray-800 truncate">${esc(o.title)}</span>
          <span class="text-xs font-bold text-amber-700 whitespace-nowrap">${o.cpValue} KP</span>
        </div>
        <div class="mt-1">${statusTag(o.status)}</div>
        ${note}
        ${canDelete ? `<button onclick="deleteOffer('${sid(id)}')" class="mt-2 text-xs text-red-600 hover:underline">Elimina</button>` : ''}
      </div>`;
  }).join('');
}

// ---------- Storico: scambi conclusi e giudizi (dati e ricevuti) ----------
const GIUDIZIO = { positivo: '👍 positivo', negativo: '👎 negativo' };
function renderStorico() {
  const box = $('storico');
  if (!box) return;
  const quando = (o) => tsToDate(o.completionDate)?.getTime() || 0;
  const voci = [
    ...myOffers.filter((o) => o.data.status === 'concluso').map((o) => ({ ...o, regalato: true })),
    ...ricevutiConclusi.map((o) => ({ ...o, regalato: false }))
  ].sort((a, b) => quando(b.data) - quando(a.data));
  // giudizi che devo ancora dare (solo chi ha regalato: chi riceve giudica quando conferma)
  const daDare = voci.filter((v) => v.regalato && v.data.reservedBy && !v.data.feedbackGiver).length;
  $('storico-section').classList.toggle('hidden', !voci.length);
  $('storico-da-dare').classList.toggle('hidden', !daDare);
  $('storico-da-dare').textContent = daDare === 1
    ? '⭐ Hai 1 giudizio da dare: com\'è andata con chi ha ricevuto il tuo annuncio?'
    : `⭐ Hai ${daDare} giudizi da dare a chi ha ricevuto i tuoi annunci.`;
  box.innerHTML = voci.slice(0, 30).map(({ id, data: o, regalato }) => {
    const data = tsToDate(o.completionDate)?.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }) || '';
    const altro = esc(regalato ? (o.reservedByName || 'chi ha ricevuto') : (o.ownerName || 'chi ha regalato'));
    const ricevuto = regalato ? o.feedback : o.feedbackGiver;   // giudizio che ho ricevuto io
    const dato = regalato ? o.feedbackGiver : o.feedback;       // giudizio che ho dato io
    let mio;
    if (dato) mio = `<span>Il tuo giudizio: <b>${GIUDIZIO[dato] || '—'}</b></span>`;
    else if (regalato && o.reservedBy) mio = `<span class="storico-attesa">Com'è andata con ${altro}?</span>
        <span class="storico-btns"><button class="deal-btn deal-primary" onclick="rateReceiver('${sid(id)}', 'positivo')">👍 Positivo</button>
        <button class="deal-btn deal-danger" onclick="rateReceiver('${sid(id)}', 'negativo')">👎 Negativo</button></span>`;
    else mio = '<span class="text-gray-400">Il tuo giudizio: non dato</span>';
    return `<div class="storico-row${!dato && regalato && o.reservedBy ? ' storico-urgente' : ''}">
      <div class="storico-top">
        <span class="storico-titolo">${regalato ? '🎁' : '📦'} ${esc(o.title)}</span>
        <span class="storico-kp ${regalato ? 'kp-piu' : 'kp-meno'}">${regalato ? '+' : '−'}${Number(o.cpValue) || 0} KP</span>
      </div>
      <p class="storico-chi">${regalato ? `Regalato a ${altro}` : `Ricevuto da ${altro}`}${data ? ` · ${data}` : ''}${o.chiusoDaAdmin ? ' · chiuso da un amministratore' : ''}</p>
      <p class="storico-giudizi"><span>Giudizio ricevuto: <b>${ricevuto ? GIUDIZIO[ricevuto] : '<span class="text-gray-400">non ancora dato</span>'}</b></span>${mio}</p>
      ${contestazioni.has(id) ? `<p class="storico-contest">${testoContestazione(contestazioni.get(id), regalato, regalato ? (o.reservedByName || 'chi ha ricevuto') : (o.ownerName || 'chi ha regalato'))}</p>`
        : (!regalato && finestraSegnalazione(o) ? `<button class="storico-segnala" onclick="apriContestazione('${sid(id)}')">⚠️ Problemi con l'oggetto? Segnalalo entro ${esc(finestraSegnalazione(o))}</button>` : '')}
    </div>`;
  }).join('');
  aggiornaPallinoGiudizi(daDare);
}
function aggiornaPallinoGiudizi(n) {
  giudiziDaDare = n;
  updateProfileTabIndicator();
}

// ---------- Contestazioni: chi riceve segnala un problema entro 48 ore ----------
const ORE_CONTESTAZIONE = 48;
const TIPI_CONTESTAZIONE = {
  rotto: 'rotto o danneggiato', non_funziona: 'non funziona', pericoloso: 'pericoloso (surriscaldato, ha preso fuoco…)',
  diverso: 'diverso dalla descrizione', non_ricevuto: 'mai ricevuto', servizio: 'servizio non svolto o svolto male', altro: 'altro'
};
// Fino a quando si può segnalare (testo), oppure null se le 48 ore sono passate
function finestraSegnalazione(o) {
  const d = tsToDate(o?.completionDate);
  if (!d) return null;
  const fine = new Date(d.getTime() + ORE_CONTESTAZIONE * 3600e3);
  if (Date.now() >= fine.getTime() - 60e3) return null;
  return fine.toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
function testoContestazione(c, isOwner, altro) {
  const chi = isOwner ? esc(altro) + ' ha' : 'Hai';
  const kp = `${Number(c.cpValue) || 0} KP`;
  const nota = c.nota ? ` Nota dell'amministratore: «${esc(c.nota)}».` : '';
  if (c.stato === 'aperta') return `⚠️ <b>${chi} segnalato un problema</b> (${esc(TIPI_CONTESTAZIONE[c.tipo] || 'altro')}): un amministratore sta valutando.`;
  if (c.stato === 'respinta') return `⚖️ Segnalazione valutata da un amministratore: <b>respinta</b>, i KP restano dove sono.${nota}`;
  const storno = c.stato === 'rimborso_storno';
  return `⚖️ Segnalazione accolta: <b>${isOwner ? `${esc(altro)} ha riavuto ${kp}` : `ti sono stati restituiti ${kp}`}</b>${storno ? (isOwner ? ` e ti sono stati tolti ${kp}` : ` (tolti a ${esc(altro)})`) : ''}.${nota}`;
}

function loadContestazioni(uid) {
  const agg = (ruolo) => (snap) => {
    [...contestazioni.entries()].forEach(([id, c]) => { if (c._ruolo === ruolo) contestazioni.delete(id); });
    snap.docs.forEach((d) => contestazioni.set(d.id, { ...d.data(), _ruolo: ruolo }));
    renderStorico();
    if (chatCtx?.offerId) renderChatDeal();
  };
  unsub.contestB = onSnapshot(query(collection(db, 'contestazioni'), where('buyerId', '==', uid)), agg('b'), (e) => reportError('loadContestazioni', e));
  unsub.contestO = onSnapshot(query(collection(db, 'contestazioni'), where('ownerId', '==', uid)), agg('o'), (e) => reportError('loadContestazioni', e));
}

let contestCtx = null;
window.apriContestazione = function (offerId) {
  const o = state.offers.get(offerId) || ricevutiConclusi.find((x) => x.id === offerId)?.data;
  if (!o) return;
  if (!finestraSegnalazione(o)) return alert(`Sono passate più di ${ORE_CONTESTAZIONE} ore dalla conclusione dello scambio: non è più possibile segnalare problemi.`);
  if (contestazioni.has(offerId)) return alert('Hai già segnalato un problema per questo scambio.');
  contestCtx = { offerId, o };
  $('contest-offer').textContent = `«${o.title}» da ${o.ownerName || 'chi ha regalato'} · ${o.cpValue} KP · puoi segnalare fino a ${finestraSegnalazione(o)}`;
  document.querySelectorAll('input[name="contest-tipo"]').forEach((r) => { r.checked = false; r.onchange = window.aggiornaContestazione; });
  $('contest-testo').value = '';
  window.aggiornaContestazione();
  $('contest-modal').style.display = 'flex';
};
window.chiudiContestazione = function () { $('contest-modal').style.display = 'none'; contestCtx = null; };
window.aggiornaContestazione = function () {
  const testo = $('contest-testo').value.trim();
  $('contest-count').textContent = $('contest-testo').value.length;
  $('contest-send').disabled = testo.length < 10 || !document.querySelector('input[name="contest-tipo"]:checked');
};
window.inviaContestazione = async function () {
  const me = auth.currentUser;
  if (!contestCtx || !me) return;
  const { offerId, o } = contestCtx;
  const tipo = document.querySelector('input[name="contest-tipo"]:checked')?.value;
  const testo = $('contest-testo').value.trim();
  if (!tipo || testo.length < 10) return;
  const vietata = parolaVietata(testo);
  if (vietata) return alert(`⛔ Il testo contiene parole non consentite («${vietata}»): correggilo e riprova.`);
  $('contest-send').disabled = true;
  try {
    await setDoc(doc(db, 'contestazioni', offerId), {
      offerId, buyerId: me.uid, buyerName: (me.displayName || 'Utente').slice(0, 80),
      ownerId: o.ownerId, ownerName: String(o.ownerName || 'Utente').slice(0, 80), titolo: o.title, cpValue: o.cpValue,
      tipo, testo, stato: 'aperta', createdAt: serverTimestamp()
    });
    logEvent('dispute_opened', { offerId, tipo, kp: o.cpValue }, 'warn');
    notify('dispute', { offerId });
    postChatEvent(offerId, '⚠️ Segnalato un problema su questo scambio: un amministratore lo valuterà');
    window.chiudiContestazione();
    alert('Segnalazione inviata. Un amministratore la valuterà e deciderà se restituirti i KP: vedrai l\'esito nel Profilo e in chat.');
  } catch (e) {
    reportError('inviaContestazione', e, { offerId });
    alert('Segnalazione non inviata: ' + friendlyError(e));
    $('contest-send').disabled = false;
  }
};

// ---------- 13. PROFILO ----------
function loadProfileData(uid) {
  const userRef = doc(db, 'users', uid);
  unsub.profile = onSnapshot(userRef, (snap) => {
    if (!snap.exists()) {
      // Nuovo utente: il profilo si crea solo dopo l'accettazione dei Termini,
      // e solo se le iscrizioni sono aperte (gli admin entrano sempre)
      if (!deletingAccount) iscrizioniPerNuovo().then((ok) => { if (ok) showConsent({ newProfile: true }); });
      return;
    }
    const data = snap.data();
    if (data.termsVersion !== LEGAL.versioneTermini) showConsent({ newProfile: false });

    // Privacy: l'email non deve stare nel profilo pubblico (migrazione dei vecchi profili)
    if ('email' in data && !emailRemovalTried) {
      emailRemovalTried = true;   // un solo tentativo per sessione
      updateDoc(userRef, { email: deleteField() }).catch((e) => reportError('removeEmail', e));
    }

    // Zona dell'utente (per ordinare gli annunci per vicinanza)
    const zonaPrima = JSON.stringify(state.zona || null);
    state.zona = zonaValida(data.zona) ? data.zona : null;
    renderZoneProfile();
    if (JSON.stringify(state.zona) !== zonaPrima) renderOffers();
    if (!state.zona && !zonePromptShown && !consentMode && data.termsVersion === LEGAL.versioneTermini) {
      zonePromptShown = true;
      setTimeout(() => window.openZoneModal(true), 400);
    }

    const karma = data.karmaPoints ?? 0;
    state.completedSwaps = data.completedSwaps ?? 0;
    if (lastKnownKarma !== null && karma !== lastKnownKarma && !$('profile-screen').classList.contains('active')) {
      hasNewProfileUpdate = true;
      updateProfileTabIndicator();
    }
    lastKnownKarma = karma;
    state.karma = karma;
    $('home-karma-widget').textContent = `${karma} KP`;

    const thresholds = [0, 150, 300, 500, 1000];
    let level = 1, from = 0, to = 150;
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (karma >= thresholds[i]) { level = i + 1; from = thresholds[i]; to = thresholds[i + 1] ?? thresholds[i]; break; }
    }
    const pct = to > from ? Math.min(100, Math.floor(((karma - from) / (to - from)) * 100)) : 100;
    const badge = hasNewProfileUpdate ? '<span class="new-kp-badge ml-2 text-xs font-medium bg-green-100 text-green-700 px-2 py-0.5 rounded-full animate-pulse">NOVITÀ</span>' : '';

    $('profile-data').innerHTML = `
      <div class="mb-6">
        <div class="flex justify-between items-center mb-1">
          <span class="text-base font-semibold text-green-600">Livello ${level}</span>
          <span class="text-sm text-gray-500">${to > from ? `Prossimo livello: ${to} KP` : 'Livello massimo'}</span>
        </div>
        <div class="w-full bg-gray-200 rounded-full h-2.5"><div class="bg-green-600 h-2.5 rounded-full" style="width:${pct}%"></div></div>
      </div>
      <p class="text-3xl font-bold text-gray-900 flex items-center justify-center">${karma} ${badge}</p>
      <p class="text-sm text-gray-500 mb-1">Punti Karma (KP)</p>
      ${Number.isInteger(data.bonusPrimoScambio) && data.bonusPrimoScambio > 0 ? `<p class="bonus-attesa">🎁 +${data.bonusPrimoScambio} KP in arrivo al tuo primo scambio concluso</p>` : ''}
      <p id="kp-hint" class="text-xs text-gray-500 mb-4">${state.isAdmin ? 'Puoi richiedere e pubblicare senza limiti di KP.' : `Puoi richiedere beni e servizi fino a ${karma} KP. Regala per guadagnarne altri.`}</p>
      <div class="profile-stats">
        <div><p class="text-xl font-semibold text-gray-700">${state.completedSwaps}</p><p class="text-xs text-gray-500">Scambi completati</p></div>
        <div><p class="text-xl font-semibold text-green-700">👍 ${Number(data.fbPos) || 0}</p><p class="text-xs text-gray-500">Giudizi positivi</p></div>
        <div><p class="text-xl font-semibold text-red-600">👎 ${Number(data.fbNeg) || 0}</p><p class="text-xs text-gray-500">Giudizi negativi</p></div>
      </div>`;
    $('profile-name-header').textContent = data.displayName || auth.currentUser?.displayName || 'Utente Rikeka';
    renderOffers();
    updateValuePreview();
  }, (e) => reportError('loadProfileData', e));
}

// Iscrizioni chiuse? Mostra "Rikeka è al completo" e restituisce false
async function iscrizioniPerNuovo() {
  try {
    const c = (await getDoc(doc(db, 'config', 'iscrizioni'))).data();
    if (!c || c.aperte !== false || state.isAdmin) return true;
    if (typeof c.messaggio === 'string' && c.messaggio.trim()) $('closed-msg').textContent = c.messaggio.trim();
    $('closed-modal').style.display = 'flex';
    logEvent('signup_closed_seen', {});
    return false;
  } catch (e) {
    reportError('iscrizioniPerNuovo', e);
    return true;   // nel dubbio si prosegue: decidono comunque le regole del server
  }
}

// ---------- Benvenuto: KP subito + bonus al primo scambio ----------
let benvenutoDopo = null;
function mostraBenvenuto(kp, bonus) {
  $('welcome-kp').textContent = String(kp);
  $('welcome-bonus-row').classList.toggle('hidden', !(bonus > 0));
  $('welcome-bonus').textContent = String(bonus);
  $('welcome-modal').style.display = 'flex';
}
window.chiudiBenvenuto = function () {
  $('welcome-modal').style.display = 'none';
  if (benvenutoDopo) { const f = benvenutoDopo; benvenutoDopo = null; f(); }
};
// Riga nel "?" con i valori del catalogo
function aggiornaInfoBonus() {
  const el = $('info-bonus');
  if (!el) return;
  const c = state.catalog || {}, b = kpPrimoScambio(c);
  const subito = Number.isInteger(c.kpIniziali) ? c.kpIniziali : 50;
  el.textContent = b > 0
    ? `🎁 Chi si iscrive riceve ${subito} KP subito e altri ${b} KP al primo scambio concluso.`
    : `🎁 Chi si iscrive riceve ${subito} KP per iniziare.`;
}
document.addEventListener('catalog-changed', aggiornaInfoBonus);

// ---------- 13b. ACCETTAZIONE TERMINI ----------
let consentMode = null;   // { newProfile: bool } mentre il modal e' aperto

function showConsent(mode) {
  if (consentMode) return;
  consentMode = mode;
  $('consent-age-num').textContent = String(LEGAL.etaMinima);
  $('consent-age').checked = false;
  $('consent-terms').checked = false;
  window.updateConsentButton();
  $('consent-modal').style.display = 'flex';
}

window.updateConsentButton = function () {
  $('consent-btn').disabled = !($('consent-age').checked && $('consent-terms').checked);
};

window.acceptTerms = async function () {
  const u = auth.currentUser;
  if (!u || !consentMode) return;
  const userRef = doc(db, 'users', u.uid);
  $('consent-btn').disabled = true;
  try {
    if (consentMode.newProfile) {
      await catalogReady;
      const kpSubito = state.catalogOnServer ? state.catalog.kpIniziali : 100;
      const bonus = state.catalogOnServer ? kpPrimoScambio(state.catalog) : 0;
      await setDoc(userRef, {
        displayName: (u.displayName || 'Utente Rikeka').slice(0, 80),
        karmaPoints: kpSubito,
        completedSwaps: 0,
        termsVersion: LEGAL.versioneTermini,
        termsAcceptedAt: serverTimestamp(),
        ...(bonus > 0 ? { bonusPrimoScambio: bonus } : {})
      });
      logEvent('user_created', { termsVersion: LEGAL.versioneTermini, kp: kpSubito, bonus });
      mostraBenvenuto(kpSubito, bonus);
    } else {
      await updateDoc(userRef, { termsVersion: LEGAL.versioneTermini, termsAcceptedAt: serverTimestamp() });
      logEvent('terms_accepted', { termsVersion: LEGAL.versioneTermini });
    }
    $('consent-modal').style.display = 'none';
    consentMode = null;
    if (!state.zona && !zonePromptShown) {
      zonePromptShown = true;
      const apriZona = () => setTimeout(() => window.openZoneModal(true), 300);
      if ($('welcome-modal').style.display === 'flex') benvenutoDopo = apriZona; else apriZona();
    }
  } catch (e) {
    reportError('acceptTerms', e);
    alert('Non è stato possibile salvare la tua scelta: ' + friendlyError(e));
    window.updateConsentButton();
  }
};

window.declineTerms = async function () {
  $('consent-modal').style.display = 'none';
  consentMode = null;
  await signOut(auth);
};

// ---------- 13c. ELIMINAZIONE ACCOUNT (diritto alla cancellazione) ----------
let deletingAccount = false;

// Passo 1: finestra dell'app (niente prompt del browser: farebbe scadere il "tocco"
// e Chrome bloccherebbe poi la finestra di Google con auth/popup-blocked)
window.deleteMyAccount = function () {
  if (!auth.currentUser) return;
  const inTrattativa = myOffers.filter((o) => o.data.status === 'in_trattativa').length;
  $('delete-warn').textContent = inTrattativa
    ? `Attenzione: hai ${inTrattativa} ${inTrattativa === 1 ? 'annuncio' : 'annunci'} in trattativa, che verranno annullati.` : '';
  $('delete-confirm-input').value = '';
  $('delete-go').disabled = true;
  $('delete-modal').style.display = 'flex';
};
window.closeDeleteModal = function () { $('delete-modal').style.display = 'none'; };
window.checkDeleteInput = function () {
  $('delete-go').disabled = $('delete-confirm-input').value.trim().toUpperCase() !== 'ELIMINA';
};

// Passo 2: il tocco su "Elimina definitivamente" apre SUBITO la finestra di Google
window.confirmDeleteAccount = async function () {
  const me = auth.currentUser;
  if (!me || $('delete-confirm-input').value.trim().toUpperCase() !== 'ELIMINA') return;
  $('delete-go').disabled = true;
  try {
    // 1. Conferma l'identità con Google (richiesto da Firebase per eliminare un account)
    await reauthenticateWithPopup(me, googleProvider);
    window.closeDeleteModal();
    deletingAccount = true;
    logEvent('account_deleted', { offers: myOffers.length, chats: allChatsData.length }, 'warn');

    // 2. Annunci e foto
    for (const o of myOffers) {
      await deleteOfferWithFotos(o.id);
    }
    // 3. Chat: spariscono per chi esce; l'altra persona conserva i messaggi.
    //    Se anche l'altra l'aveva gia' eliminata, si cancellano davvero.
    for (const c of allChatsData) {
      try {
        await updateDoc(doc(db, 'chats', c.id), { [`nascosta.${me.uid}`]: serverTimestamp() });
        const altro = (c.data.users || []).find((u) => u !== me.uid);
        if (altro && nascostaPerMe(c.data, altro)) await window.deleteChat(null, c.id, { senzaConferma: true });
      } catch (e) { reportError('deleteAccount.chat', e, { chatId: c.id }); }
    }
    // 4. Profilo e token delle notifiche
    stopListeners();
    await removePushTokens(me.uid);
    try { await deleteDoc(doc(db, 'quote', me.uid)); } catch (_) { /* annuncio recente: resta solo un orario */ }
    try {
      const rim = await getDocs(query(collection(db, 'rimozioni'), where('ownerId', '==', me.uid)));
      for (const d of rim.docs) await deleteDoc(d.ref);
    } catch (_) { /* nessun avviso */ }
    const b = writeBatch(db);
    b.delete(doc(db, 'users', me.uid));
    await b.commit();
    // 5. Account di accesso
    await deleteUser(me);
    alert('Il tuo account è stato eliminato. Grazie per aver fatto parte di Rikeka.');
    await svuotaMemoriaLocale();
    location.reload();
  } catch (e) {
    deletingAccount = false;
    window.checkDeleteInput();   // riabilita il pulsante per riprovare
    if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request') return;
    if (e?.code === 'auth/popup-blocked') {
      alert('Il browser ha bloccato la finestra di Google. Premi di nuovo "Elimina definitivamente"; se non basta, consenti i popup per questo sito.');
      return;
    }
    reportError('deleteMyAccount', e);
    alert('Eliminazione non completata: ' + friendlyError(e) + '\nRiprova; se il problema continua scrivi al gestore.');
  }
};

if ($('app-version')) $('app-version').textContent = 'Versione ' + APP_VERSIONE;

// ---------- iPhone: dopo la chiusura della tastiera la pagina puo' restare spostata
// e la barra di navigazione (fissata in basso) finisce fuori schermo. La riallineiamo.
if (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  const riallinea = () => {
    // mentre si sta scrivendo in un campo la tastiera e' aperta: non spostare nulla
    if (document.activeElement?.matches?.('input, textarea, select')) return;
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
  };
  document.addEventListener('focusout', (e) => {
    if (e.target?.matches?.('input, textarea, select')) setTimeout(riallinea, 80);
  });
  window.visualViewport?.addEventListener('resize', () => setTimeout(riallinea, 80));
  window.addEventListener('orientationchange', () => setTimeout(riallinea, 300));
}

// ---------- Chat e tastiera: mentre scrivi, la chat occupa solo lo spazio visibile
// SOPRA la tastiera (e la barra dei suggerimenti), cosi' la striscia di scrittura
// e gli ultimi messaggi restano in vista. Non si "indovina" la tastiera dalle altezze
// (su iPhone cambiano entrambe): conta solo se il campo della chat e' attivo.
function chatAperta() { return $('chat-screen')?.style.display === 'flex'; }
function staiScrivendo() { return document.activeElement?.id === 'message-input'; }
function adattaChatAllaTastiera() {
  const vv = window.visualViewport, cs = $('chat-screen');
  if (!vv || !cs || !chatAperta()) return;
  if (!staiScrivendo()) { liberaChatDallaTastiera(); return; }
  cs.style.top = Math.max(0, vv.offsetTop) + 'px';
  cs.style.height = vv.height + 'px';
  cs.style.bottom = 'auto';
  cs.classList.add('chat-tastiera');
  const box = $('messages-container');
  if (box) box.scrollTop = box.scrollHeight;
}
function liberaChatDallaTastiera() {
  const cs = $('chat-screen');
  if (!cs) return;
  cs.style.top = ''; cs.style.height = ''; cs.style.bottom = '';
  cs.classList.remove('chat-tastiera');
}
window.visualViewport?.addEventListener('resize', adattaChatAllaTastiera);
window.visualViewport?.addEventListener('scroll', adattaChatAllaTastiera);
document.addEventListener('focusin', (e) => {
  if (e.target?.id !== 'message-input') return;
  // la tastiera dell'iPhone si apre con un'animazione: si riadatta piu' volte
  [0, 120, 300, 600, 900].forEach((ms) => setTimeout(adattaChatAllaTastiera, ms));
});
document.addEventListener('focusout', (e) => {
  if (e.target?.id !== 'message-input') return;
  setTimeout(() => { if (!staiScrivendo()) liberaChatDallaTastiera(); }, 150);
});

// ---------- 13c. SEGNALA UN PROBLEMA ----------
window.openBugReport = function () {
  if (!auth.currentUser) return;
  $('bug-text').value = '';
  $('bug-send').disabled = true;
  $('bug-modal').style.display = 'flex';
  setTimeout(() => $('bug-text').focus(), 50);
};
window.closeBugReport = function () { $('bug-modal').style.display = 'none'; };
window.sendBugReport = async function () {
  const me = auth.currentUser;
  const testo = $('bug-text').value.trim().slice(0, 1000);
  if (!me || testo.length < 5) return;
  const btn = $('bug-send'); btn.disabled = true; btn.textContent = 'Invio…';
  try {
    // Al massimo una segnalazione al minuto (controllato anche dalle regole)
    const qRef = doc(db, 'problemiQuota', me.uid);
    const ultimo = tsToDate((await getDoc(qRef)).data()?.ultimo)?.getTime() || 0;
    const attesa = Math.ceil((ultimo + 61000 - Date.now()) / 1000);
    if (attesa > 0) { alert(`Hai appena inviato una segnalazione: aspetta ${attesa} secondi e riprova.`); return; }

    const ref = doc(collection(db, 'problemi'));
    const batch = writeBatch(db);
    batch.set(qRef, { ultimo: serverTimestamp() });
    batch.set(ref, {
      uid: me.uid,
      nome: (me.displayName || 'Utente').slice(0, 80),
      testo,
      pagina: (document.querySelector('.screen.active')?.id || '').slice(0, 40),
      ua: (APP_VERSIONE + ' · ' + navigator.userAgent).slice(0, 200),
      ts: serverTimestamp()
    });
    await batch.commit();
    notify('bug', { problemaId: ref.id });
    window.closeBugReport();
    alert('Grazie! La segnalazione è arrivata agli amministratori.');
  } catch (e) {
    reportError('sendBugReport', e, { versione: APP_VERSIONE });
    alert(e?.code === 'permission-denied'
      ? "Il server non ha accettato la segnalazione. Se hai appena aggiornato l'app, chiudila e riaprila (versione in fondo al Profilo: " + APP_VERSIONE + ') e riprova.'
      : 'Invio non riuscito: ' + friendlyError(e));
  } finally {
    btn.textContent = 'Invia';
    btn.disabled = $('bug-text').value.trim().length < 5;
  }
};

// ---------- 13d. ZONA DELL'UTENTE ----------
let zonePromptShown = false;
let zoneAbort = null;
let zoneTimer = null;
let zoneResults = [];

// Nome usato quando la zona e' stata presa dal GPS: agli altri non dice nulla,
// quindi negli annunci si mostra solo la distanza
const ZONA_GPS = 'Vicino a me';

/** Etichetta "dove si trova" sotto il titolo dell'annuncio. */
function zonaAnnuncioHtml(o, km, isOwner) {
  const z = zonaValida(o.zona) ? o.zona : null;
  if (!z) return '<p class="offer-zone offer-zone-none">📍 Zona non indicata</p>';
  const dist = !isOwner && km !== null && km !== undefined ? etichettaDistanza(km) : '';
  if (z.nome === ZONA_GPS) {
    if (isOwner) return '<p class="offer-zone">📍 La tua posizione</p>';
    return dist
      ? `<p class="offer-zone">📍 a ${esc(dist)} da te</p>`
      : '<p class="offer-zone"><button type="button" class="offer-zone-link" onclick="event.stopPropagation();chiudiAnnuncio();openZoneModal(false)">📍 Imposta la tua zona per vedere la distanza</button></p>';
  }
  return `<p class="offer-zone">📍 ${esc(z.nome)}${dist ? ` <span class="offer-zone-km">· ${esc(dist)}</span>` : ''}</p>`;
}

/** Nel modulo Pubblica: in quale zona uscira' l'annuncio. */
function renderPublishZone() {
  const el = $('publish-zone');
  if (!el) return;
  el.classList.toggle('publish-zone-missing', !state.zona);
  el.innerHTML = state.zona
    ? `<span>📍 Il tuo annuncio sarà visibile in: <b>${esc(state.zona.nome === ZONA_GPS ? 'la tua posizione attuale (circa 1 km)' : state.zona.nome)}</b></span>
       <button type="button" onclick="openZoneModal(false)">Cambia</button>`
    : `<span>📍 <b>Non hai impostato la tua zona</b>: chi vede l'annuncio non saprà dove si trova.</span>
       <button type="button" onclick="openZoneModal(false)">Imposta</button>`;
}

function renderZoneProfile() {
  renderPublishZone();
  const el = $('zone-current');
  if (!el) return;
  el.innerHTML = state.zona
    ? `📍 <b>${esc(state.zona.nome)}</b>`
    : '<span class="text-gray-500">Non ancora impostata</span>';
}

function renderZoneBanner() {
  const b = $('zone-banner');
  if (b) b.classList.toggle('hidden', !!state.zona || !auth.currentUser);
}

window.openZoneModal = function (primoAccesso = false) {
  $('zone-intro').textContent = primoAccesso
    ? 'Indica dove ti trovi: vedrai per primi gli annunci più vicini a te. Vedrai comunque anche tutti gli altri.'
    : 'Cambia la tua zona: gli annunci verranno ordinati dal più vicino.';
  $('zone-search').value = '';
  $('zone-results').innerHTML = '';
  $('zone-msg').textContent = '';
  $('zone-modal').style.display = 'flex';
  setTimeout(() => $('zone-search').focus(), 50);
};

window.closeZoneModal = function () {
  zoneAbort?.abort();
  $('zone-modal').style.display = 'none';
};

window.onZoneSearch = function (value) {
  clearTimeout(zoneTimer);
  zoneTimer = setTimeout(async () => {
    zoneAbort?.abort();
    zoneAbort = new AbortController();
    const box = $('zone-results');
    if (String(value).trim().length < 2) { box.innerHTML = ''; return; }
    $('zone-msg').textContent = 'Cerco…';
    try {
      zoneResults = await cercaComuni(value, zoneAbort.signal);
      $('zone-msg').textContent = zoneResults.length ? '' : 'Nessun Comune trovato con questo nome.';
      box.innerHTML = zoneResults.map((r, i) => `
        <button type="button" class="zone-row" onclick="chooseZone(${i})">
          <span class="zone-name">${esc(r.nome)}</span>
          <span class="zone-detail">${esc(r.dettaglio)}</span>
        </button>`).join('');
    } catch (e) {
      if (e.name === 'AbortError') return;
      $('zone-msg').textContent = 'Ricerca non disponibile in questo momento: riprova o usa la posizione.';
      reportError('zoneSearch', e);
    }
  }, 350);
};

async function saveZone(z) {
  const me = auth.currentUser;
  if (!me || !zonaValida(z)) return;
  try {
    await updateDoc(doc(db, 'users', me.uid), { zona: { nome: z.nome, lat: z.lat, lng: z.lng } });
    logEvent('zone_set', { nome: z.nome });
    window.closeZoneModal();
  } catch (e) {
    reportError('saveZone', e);
    $('zone-msg').textContent = 'Salvataggio non riuscito: ' + friendlyError(e);
  }
}

window.chooseZone = function (i) {
  const r = zoneResults[i];
  if (r) saveZone({ nome: r.nome, lat: r.lat, lng: r.lng });
};

window.useMyPosition = async function () {
  $('zone-msg').textContent = 'Rilevo la posizione…';
  try {
    const p = await posizioneAttuale();
    await saveZone({ nome: ZONA_GPS, lat: p.lat, lng: p.lng });
  } catch (e) {
    $('zone-msg').textContent = e.message + ' Puoi cercare il tuo Comune qui sopra.';
  }
};

// ---------- 14. AVVIO ----------
// App installabile: registra il service worker (solo su http/https)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker non registrato:', e));
}
// Dice al service worker quale chat è aperta: la notifica di quella chat non serve,
// tutte le altre arrivano anche con l'app aperta.
function tellServiceWorkerChat() {
  try { navigator.serviceWorker?.controller?.postMessage({ type: 'open-chat', chatId: currentChatId }); } catch (_) {}
}

// ---------- Notifiche: aprire l'app installata e la chat giusta ----------
// Dice al service worker se questa finestra e' l'app installata o una scheda del browser
const APP_INSTALLATA = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
navigator.serviceWorker?.ready.then((reg) => {
  try { reg.active?.postMessage({ type: 'app-mode', standalone: APP_INSTALLATA }); } catch (_) {}
}).catch(() => {});

// Chat da aprire appena i dati sono pronti (arrivata da una notifica)
let chatDaAprire = new URLSearchParams(location.search).get('chat');
// Indirizzo pulito; nell'app installata resta "?app=1", cosi' il service worker la
// riconosce anche dopo essere stato "addormentato" dal telefono
history.replaceState(null, '', location.pathname + (APP_INSTALLATA ? '?app=1' : ''));
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  try { navigator.serviceWorker.controller?.postMessage({ type: 'app-mode', standalone: APP_INSTALLATA }); } catch (_) {}
});
function apriChatInAttesa() {
  if (!chatDaAprire || !auth.currentUser) return;
  const c = allChatsData.find((x) => x.id === chatDaAprire);
  if (!c) return;
  chatDaAprire = null;
  window.openChat(c.id, c.data?.offerTitle);
}
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type !== 'apri-chat' || typeof e.data.chatId !== 'string') return;
  chatDaAprire = e.data.chatId;
  apriChatInAttesa();
});
populateSelects();

// Quando si scopre (o cambia) il ruolo di amministratore, aggiorna ciò che dipende dai limiti
document.addEventListener('admin-changed', () => {
  renderOffers();
  updateFotoLabels();
  updateValuePreview();
  // Il ruolo si vede solo qui, sotto il nome nel Profilo
  $('profile-role').textContent = state.isAdmin ? '🛡️ Amministratore Rikeka' : 'Membro Rikeka';
  if (state.isAdmin && $('kp-hint')) $('kp-hint').textContent = 'Puoi richiedere e pubblicare senza limiti di KP.';
});

// ---------- FOTOCAMERA INTEGRATA ----------
// Apre la fotocamera dentro l'app: il browser chiede il permesso la prima volta.
// Se non è disponibile (o il permesso è negato) si usa l'app fotocamera del telefono.
// Dopo ogni scatto: anteprima con "Rifai" / "Usa questa foto"; poi
// "Scatta un'altra" / "Fine". Con 3 foto la fotocamera si chiude da sola.
let camStream = null, camFacing = 'environment';
let camScatto = null;       // { file, url } foto appena scattata, in attesa di conferma
let camOccupata = false;    // evita doppi tocchi mentre si elabora

function camLiberi() { return [0, 1, 2].filter((i) => !pendingFotos[i]); }
function camAggiornaContatore() {
  const n = 3 - camLiberi().length;
  $('camera-count').textContent = `${n}/3 foto`;
  $('camera-shot').disabled = camLiberi().length === 0 || !camStream;
  $('camera-done').classList.toggle('hidden', n === 0);
}
// Mostra una sola "fase" della fotocamera: live (mirino), review (anteprima), ask (altra o fine)
function camFase(fase) {
  $('camera-live').classList.toggle('hidden', fase !== 'live');
  $('camera-review').classList.toggle('hidden', fase !== 'review');
  $('camera-ask').classList.toggle('hidden', fase !== 'ask');
  $('camera-preview').classList.toggle('hidden', fase !== 'review');
  $('camera-switch').style.visibility = fase === 'live' ? '' : 'hidden';
}
function camScartaScatto() {
  if (camScatto?.url) URL.revokeObjectURL(camScatto.url);
  camScatto = null;
  $('camera-preview').removeAttribute('src');
}
function camStop() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  $('camera-video').srcObject = null;
}
async function camStart() {
  camStop();
  const msg = $('camera-msg');
  msg.classList.add('hidden');
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: camFacing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false
  });
  $('camera-video').srcObject = camStream;
}

window.openCamera = async function () {
  if (!camLiberi().length) return alert('Hai già 3 foto: toccane una con la ✕ per sostituirla.');
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) { $('camera-fallback').click(); return; }
  camScartaScatto();
  camOccupata = false;
  camFase('live');
  $('camera-modal').classList.remove('hidden');
  camAggiornaContatore();
  try {
    await camStart();
    camAggiornaContatore();
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    $('camera-switch').classList.toggle('hidden', cams.length < 2);
  } catch (e) {
    const negato = e.name === 'NotAllowedError' || e.name === 'SecurityError';
    const msg = $('camera-msg');
    msg.classList.remove('hidden');
    msg.innerHTML = negato
      ? 'Accesso alla fotocamera negato.<br>Per consentirlo: tocca il lucchetto 🔒 accanto all\'indirizzo → Autorizzazioni → Fotocamera → Consenti, poi riprova.<br><br><button class="underline" onclick="closeCamera();document.getElementById(\'camera-fallback\').click()">Usa l\'app fotocamera del telefono</button>'
      : 'Nessuna fotocamera disponibile.<br><br><button class="underline" onclick="closeCamera();document.getElementById(\'camera-fallback\').click()">Scegli una foto dal dispositivo</button>';
    $('camera-shot').disabled = true;
    logEvent('camera_error', { name: e.name }, 'warn');
  }
};

window.switchCamera = async function () {
  camFacing = camFacing === 'environment' ? 'user' : 'environment';
  try { await camStart(); } catch (e) { reportError('switchCamera', e); }
};

// 1) Scatto: blocca l'immagine e chiede conferma
window.takeShot = async function () {
  const video = $('camera-video');
  if (camOccupata || !camStream || !video.videoWidth || !camLiberi().length) return;
  camOccupata = true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    video.classList.remove('camera-flash'); void video.offsetWidth; video.classList.add('camera-flash');
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.9));
    if (!blob) throw new Error('Scatto non riuscito');
    camScartaScatto();
    const file = new File([blob], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' });
    camScatto = { file, url: URL.createObjectURL(blob) };
    $('camera-preview').src = camScatto.url;
    $('camera-use').disabled = false;
    camFase('review');
  } catch (e) {
    reportError('takeShot', e);
    alert('Non sono riuscito a scattare la foto, riprova.');
  } finally {
    camOccupata = false;
  }
};

// 2a) "Rifai": scarta e torna al mirino
window.camRetake = function () {
  camScartaScatto();
  camFase('live');
  camAggiornaContatore();
};

// 2b) "Usa questa foto": la mette nel primo spazio libero, poi chiede se continuare
window.camUse = async function () {
  if (!camScatto || camOccupata) return;
  const liberi = camLiberi();
  if (!liberi.length) { camScartaScatto(); return window.closeCamera(); }
  camOccupata = true;
  $('camera-use').disabled = true;
  const slot = liberi[0];
  const file = camScatto.file;
  pendingFotos[slot] = { loading: true };   // prenota lo spazio
  try {
    await setFoto(slot, file);
  } finally {
    camOccupata = false;
    camScartaScatto();
  }
  camAggiornaContatore();
  if (!pendingFotos[slot]) { camFase('live'); return; }   // elaborazione fallita: setFoto ha già avvisato
  const n = 3 - camLiberi().length;
  if (!camLiberi().length) {
    camMostraDomanda(`✓ Foto ${n} di 3 aggiunta. Hai raggiunto il massimo di 3 foto.`, false);
    setTimeout(() => { if (!$('camera-modal').classList.contains('hidden')) window.closeCamera(); }, 1200);
    return;
  }
  camMostraDomanda(`✓ Foto ${n} di 3 aggiunta. Vuoi scattarne un'altra?`, true);
};

function camMostraDomanda(testo, altra) {
  $('camera-ask-msg').textContent = testo;
  $('camera-another').classList.toggle('hidden', !altra);
  // miniature delle foto già aggiunte (le immagini vengono da setFoto, non da testo dell'utente)
  const box = $('camera-thumbs');
  box.replaceChildren(...[0, 1, 2].map((i) => {
    const f = pendingFotos[i];
    if (f?.thumb) { const img = document.createElement('img'); img.src = f.thumb; img.alt = `Foto ${i + 1}`; return img; }
    return document.createElement('span');
  }));
  camFase('ask');
}

// 3) "Scatta un'altra": torna al mirino
window.camAnother = function () {
  camFase('live');
  camAggiornaContatore();
};

window.closeCamera = function () {
  camStop();
  camScartaScatto();
  camFase('live');
  $('camera-modal').classList.add('hidden');
};


// ---------- REPUTAZIONE: scambi conclusi e % di giudizi positivi ----------

export function testoReputazione(u) {
  const num = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.floor(Number(x))) : 0);
  const scambi = num(u?.completedSwaps), pos = num(u?.fbPos), neg = num(u?.fbNeg), tot = pos + neg;
  if (!scambi && !tot) return '<span class="rep-new">🌱 nuovo</span>';
  const pct = tot ? Math.round((pos / tot) * 100) : null;
  return `${scambi} ${scambi === 1 ? 'scambio' : 'scambi'}${pct === null ? '' : ` · <span class="${pct < 70 ? 'rep-low' : 'rep-ok'}">👍 ${pct}%</span>`}`;
}

async function datiUtente(uid) {
  if (!repCache.has(uid)) {
    repCache.set(uid, getDoc(doc(db, 'users', uid)).then((s) => {
      const d = s.exists() ? s.data() : null;
      repCache.set(uid, d);
      return d;
    }).catch(() => { repCache.delete(uid); return null; }));
  }
  return repCache.get(uid);
}

function fillReputazioni() {
  document.querySelectorAll('[data-rep]').forEach(async (el) => {
    const d = await datiUtente(el.dataset.rep);
    if (d) el.innerHTML = '· ' + testoReputazione(d);
  });
}

// Chi ha regalato giudica chi ha ricevuto (una volta sola)
window.rateReceiver = async function (offerId, giudizio) {
  if (!['positivo', 'negativo'].includes(giudizio)) return;
  if (giudizio === 'negativo' && !confirm('Confermi un giudizio negativo? Conta nella percentuale visibile agli altri e non si può cambiare.')) return;
  const me = auth.currentUser;
  try {
    let altro = null;
    await runTransaction(db, async (tx) => {
      const oRef = doc(db, 'offerte', offerId);
      const oSnap = await tx.get(oRef);
      if (!oSnap.exists()) throw new Error('Annuncio non trovato.');
      const o = oSnap.data();
      if (o.ownerId !== me.uid || o.status !== 'concluso' || !o.reservedBy) throw new Error('Operazione non consentita.');
      if (o.feedbackGiver) throw new Error('Hai già dato il tuo giudizio.');
      altro = o.reservedBy;
      const uRef = doc(db, 'users', o.reservedBy);
      const uSnap = await tx.get(uRef);
      if (!uSnap.exists()) throw new Error('Profilo non trovato.');
      const u = uSnap.data();
      tx.update(oRef, { feedbackGiver: giudizio });
      tx.update(uRef, {
        lastOfferId: offerId,
        ...(giudizio === 'positivo' ? { fbPos: (u.fbPos ?? 0) + 1 } : { fbNeg: (u.fbNeg ?? 0) + 1 })
      });
    });
    repCache.delete(altro);
    logEvent('giver_feedback', { offerId, giudizio, receiverId: altro }, giudizio === 'negativo' ? 'warn' : 'info');
  } catch (e) {
    reportError('rateReceiver', e, { offerId });
    alert('Giudizio non salvato: ' + friendlyError(e));
  }
};

// Scambio fermo da più di 7 giorni: chi ha regalato chiede l'intervento di un amministratore
window.askAdminHelp = async function (offerId) {
  if (!confirm('Chiedere a un amministratore di intervenire?\nPotrà concludere lo scambio (e accreditarti i KP) oppure annullarlo.')) return;
  try {
    await updateDoc(doc(db, 'offerte', offerId), { aiutoRichiesto: true });
    logEvent('help_requested', { offerId }, 'warn');
    notify('help', { offerId });
    postChatEvent(offerId, '🆘 Chi regala ha chiesto aiuto a un amministratore per concludere lo scambio');
  } catch (e) {
    reportError('askAdminHelp', e, { offerId });
    alert('Richiesta non inviata: ' + friendlyError(e));
  }
};

// Account sospeso: si può solo consultare
async function checkSuspended(uid) {
  try { state.sospeso = (await getDoc(doc(db, 'sospesi', uid))).exists(); } catch (_) { state.sospeso = false; }
  $('suspended-banner').classList.toggle('hidden', !state.sospeso);
}

// ---------- "COME FUNZIONA" (nuvoletta in testata) ----------
window.toggleInfo = function (ev, apri) {
  ev?.stopPropagation();
  const pop = $('info-pop'), btn = $('info-btn');
  const mostra = apri ?? pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !mostra);
  btn.setAttribute('aria-expanded', String(mostra));
  if (mostra) {
    // la punta della nuvoletta indica il "?"
    const b = btn.getBoundingClientRect(), q = pop.getBoundingClientRect();
    pop.style.setProperty('--freccia', Math.max(12, b.left + b.width / 2 - q.left - 6) + 'px');
    btn.classList.remove('info-new');
    try { localStorage.setItem('ec_info_vista', '1'); } catch (_) {}
  }
};
document.addEventListener('click', () => {
  if (!$('info-pop').classList.contains('hidden')) window.toggleInfo(null, false);
});
// Finché non l'ha aperta almeno una volta, l'icona pulsa per farsi notare
try { if (!localStorage.getItem('ec_info_vista')) $('info-btn').classList.add('info-new'); } catch (_) {}
