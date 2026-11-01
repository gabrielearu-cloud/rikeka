// =====================================================================
// PANNELLO ADMIN: verifica annunci, segnalazioni, catalogo, statistiche, log
// Visibile solo a chi ha un documento in /admins/{uid}: il primo creato a mano
// dalla console (fondatore), gli altri nominati da qui
// =====================================================================
import {
  collection, query, where, orderBy, limit, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, writeBatch,
  serverTimestamp, getCountFromServer, getAggregateFromServer, sum, Timestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from './firebase.js';
import { LOG_RETENTION_DAYS } from './config.js';
import { DEFAULT_CATALOG, validaCatalogo, unisciNovita, paroleChiaveAnnuncio } from './catalog.js';
import { state } from './state.js';
import { logEvent, reportError, friendlyError } from './logger.js';
import { $, val, esc, sid, tsToDate } from './utils.js';
import { switchScreen, deleteOfferWithFotos, valuationLine, thumbHtml } from './app.js';
import { notify, testPushDiagnostics } from './push.js';

let adminLogs = [];

export async function checkAdmin(uid) {
  state.isAdmin = false;
  try {
    state.isAdmin = (await getDoc(doc(db, 'admins', uid))).exists();
  } catch (_) { state.isAdmin = false; }
  $('admin-btn').classList.toggle('hidden', !state.isAdmin);
  document.dispatchEvent(new Event('admin-changed'));
}

window.openAdmin = async function () {
  if (!state.isAdmin) return;
  switchScreen('admin-screen');
  document.querySelectorAll('.tab-item').forEach((i) => i.classList.remove('active'));
  await window.refreshAdmin();
};

window.refreshAdmin = async function () {
  if (!state.isAdmin) return;
  await Promise.all([loadStats(), loadContestazioniAdmin(), loadBugs(), loadIscrizioni(), loadAdmins(), loadControl(), loadReviewQueue(), loadReported(), loadLogs()]);
  fillCatalogEditor();
};

// ---------- Contestazioni: problemi su scambi conclusi (entro 48 ore) ----------
const TIPI = { rotto: 'Rotto o danneggiato', non_funziona: 'Non funziona', pericoloso: 'Pericoloso (surriscaldato, ha preso fuoco…)',
  diverso: 'Diverso dalla descrizione', non_ricevuto: 'Mai ricevuto', servizio: 'Servizio non svolto o svolto male', altro: 'Altro' };
async function loadContestazioniAdmin() {
  const box = $('admin-contest');
  box.innerHTML = '<p class="text-xs text-gray-500">Caricamento...</p>';
  try {
    const snap = await getDocs(query(collection(db, 'contestazioni'), where('stato', '==', 'aperta'), limit(50)));
    if (snap.empty) { box.innerHTML = '<p class="text-xs text-gray-400">Nessuna contestazione aperta. 🎉</p>'; return; }
    box.innerHTML = snap.docs.map((d) => {
      const c = d.data(), t = tsToDate(c.createdAt), kp = Number(c.cpValue) || 0;
      const b = esc(c.buyerName || 'chi ha ricevuto'), g = esc(c.ownerName || 'chi ha regalato');
      return `<div class="adm-card contest-card">
        <div class="flex justify-between gap-2"><b>${esc(c.titolo)}</b><span class="text-xs font-bold text-amber-700">${kp} KP</span></div>
        <p class="text-xs text-gray-500">Regalato da <b>${g}</b> a <b>${b}</b>${t ? ` · segnalato il ${esc(t.toLocaleString('it-IT'))}` : ''}</p>
        <p class="text-xs mt-1"><b>${esc(TIPI[c.tipo] || 'Altro')}</b></p>
        <p class="text-sm text-gray-800 mt-1" style="white-space:pre-wrap">${esc(c.testo)}</p>
        <p class="text-xs text-gray-500 mt-1">Leggi anche la chat tra i due prima di decidere (chiedi gli screenshot se serve).</p>
        <div class="adm-actions">
          <button class="adm-btn ok" onclick="decidiContestazione('${sid(d.id)}', 'rimborso_storno')">Restituisci ${kp} KP a ${b} e toglili a ${g}</button>
          <button class="adm-btn" onclick="decidiContestazione('${sid(d.id)}', 'rimborso')">Restituisci ${kp} KP a ${b} (senza toglierli a ${g})</button>
          <button class="adm-btn warn" onclick="decidiContestazione('${sid(d.id)}', 'respinta')">Respingi</button>
        </div></div>`;
    }).join('');
  } catch (e) {
    reportError('admin.loadContestazioni', e);
    box.innerHTML = `<p class="text-xs text-red-600">${regoleVecchie(e)}</p>`;
  }
}

window.decidiContestazione = async function (offerId, esito) {
  if (!['rimborso', 'rimborso_storno', 'respinta'].includes(esito)) return;
  const domanda = { rimborso_storno: 'Restituire i KP a chi ha ricevuto e toglierli a chi ha regalato (senza scendere sotto zero)?',
    rimborso: 'Restituire i KP a chi ha ricevuto, lasciandoli anche a chi ha regalato?', respinta: 'Respingere la segnalazione? Nessun KP si sposta.' }[esito];
  if (!confirm(domanda)) return;
  const nota = (prompt('Nota per i due utenti (facoltativa, max 300 caratteri):', '') || '').trim().slice(0, 300);
  const me = auth.currentUser;
  try {
    await runTransaction(db, async (tx) => {
      const cRef = doc(db, 'contestazioni', offerId);
      const c = (await tx.get(cRef)).data();
      if (!c || c.stato !== 'aperta') throw new Error('La contestazione è già stata decisa.');
      const cp = Number(c.cpValue);
      const bRef = doc(db, 'users', c.buyerId), gRef = doc(db, 'users', c.ownerId);
      const bSnap = await tx.get(bRef), gSnap = await tx.get(gRef);
      tx.update(cRef, { stato: esito, decisoDa: me.uid, decisoAt: serverTimestamp(), ...(nota ? { nota } : {}) });
      if (esito !== 'respinta' && bSnap.exists()) {
        tx.update(bRef, { karmaPoints: (bSnap.data().karmaPoints ?? 0) + cp, lastOfferId: offerId });
      }
      if (esito === 'rimborso_storno' && gSnap.exists()) {
        tx.update(gRef, { karmaPoints: Math.max(0, (gSnap.data().karmaPoints ?? 0) - cp), lastOfferId: offerId });
      }
    });
    logEvent('dispute_decided', { offerId, esito }, 'warn');
    notify('dispute_done', { offerId });
    loadContestazioniAdmin();
  } catch (e) {
    reportError('decidiContestazione', e, { offerId });
    alert('Operazione non riuscita: ' + (e?.code ? regoleVecchie(e).replace(/<[^>]+>/g, '') : e.message));
  }
};

// ---------- Problemi segnalati dagli utenti ----------
async function loadBugs() {
  const box = $('admin-bugs');
  box.innerHTML = '<p class="text-xs text-gray-500">Caricamento...</p>';
  try {
    const snap = await getDocs(query(collection(db, 'problemi'), orderBy('ts', 'desc'), limit(30)));
    if (snap.empty) { box.innerHTML = '<p class="text-xs text-gray-400">Nessun problema segnalato. 🎉</p>'; return; }
    box.innerHTML = snap.docs.map((d) => {
      const p = d.data(), t = tsToDate(p.ts);
      return `<div class="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs">
        <div class="flex justify-between gap-2"><b>${esc(p.nome)}</b><span class="text-gray-500">${t ? esc(t.toLocaleString('it-IT')) : ''}</span></div>
        <p class="mt-1 text-sm text-gray-800" style="white-space:pre-wrap">${esc(p.testo)}</p>
        <p class="mt-1 text-gray-500" style="word-break:break-all">Schermata: ${esc(p.pagina || '-')} · ${esc(p.ua)}</p>
        <button onclick="deleteBug('${sid(d.id)}')" class="mt-2 px-3 py-1 rounded bg-white border border-gray-300">✓ Risolto, elimina</button>
      </div>`;
    }).join('');
  } catch (e) {
    reportError('admin.loadBugs', e);
    box.innerHTML = `<p class="text-xs text-red-600">${regoleVecchie(e)}</p>`;
  }
}
window.deleteBug = async function (id) {
  if (!id) return;
  try { await deleteDoc(doc(db, 'problemi', id)); await loadBugs(); }
  catch (e) { reportError('admin.deleteBug', e); alert('Non eliminato: ' + regoleVecchie(e)); }
};

// ---------- Iscrizioni aperte / chiuse ----------
let iscrizioniAperte = true;
function paintIscrizioni() {
  $('iscr-stato').textContent = iscrizioniAperte ? '🟢 Iscrizioni aperte' : '🔴 Iscrizioni chiuse';
  $('iscr-btn').textContent = iscrizioniAperte ? 'Chiudi iscrizioni' : 'Riapri iscrizioni';
}
async function loadIscrizioni() {
  try {
    const c = (await getDoc(doc(db, 'config', 'iscrizioni'))).data();
    iscrizioniAperte = c?.aperte !== false;
    $('iscr-msg').value = typeof c?.messaggio === 'string' ? c.messaggio : '';
  } catch (e) {
    reportError('admin.loadIscrizioni', e);
  }
  paintIscrizioni();
}
window.toggleIscrizioni = async function () {
  const nuovo = !iscrizioniAperte;
  if (!confirm(nuovo ? 'Riaprire le iscrizioni ai nuovi utenti?' : 'Chiudere le iscrizioni? Chi è già iscritto continuerà a usare Rikeka.')) return;
  const btn = $('iscr-btn'); btn.disabled = true;
  try {
    await setDoc(doc(db, 'config', 'iscrizioni'), {
      aperte: nuovo,
      messaggio: String($('iscr-msg').value || '').trim().slice(0, 300),
      by: auth.currentUser.uid,
      at: serverTimestamp()
    });
    iscrizioniAperte = nuovo;
    paintIscrizioni();
    logEvent(nuovo ? 'signup_opened' : 'signup_closed', {}, 'warn');
  } catch (e) {
    reportError('admin.toggleIscrizioni', e);
    alert('Non salvato: ' + regoleVecchie(e));
  } finally {
    btn.disabled = false;
  }
};

// ---------- Statistiche (aggregazioni: costano pochissime letture) ----------
async function loadStats() {
  const box = $('admin-stats');
  box.innerHTML = '<p class="text-gray-500 col-span-2">Caricamento...</p>';
  try {
    const off = collection(db, 'offerte');
    const cnt = async (q) => (await getCountFromServer(q)).data().count;
    const [users, disp, tratt, verif, concl, kpUsers, kpMoved] = await Promise.all([
      cnt(collection(db, 'users')),
      cnt(query(off, where('status', '==', 'disponibile'))),
      cnt(query(off, where('status', '==', 'in_trattativa'))),
      cnt(query(off, where('status', '==', 'in_verifica'))),
      cnt(query(off, where('status', '==', 'concluso'))),
      getAggregateFromServer(collection(db, 'users'), { t: sum('karmaPoints') }).then((s) => s.data().t || 0),
      getAggregateFromServer(query(off, where('status', '==', 'concluso')), { t: sum('cpValue') }).then((s) => s.data().t || 0)
    ]);
    const cards = [
      ['Utenti', users], ['KP in circolazione', kpUsers],
      ['Annunci disponibili', disp], ['In trattativa', tratt],
      ['Da verificare', verif], ['Scambi conclusi', concl],
      ['KP scambiati', kpMoved], ['Catalogo', state.catalogOnServer ? 'attivo' : 'DA ATTIVARE']
    ];
    box.innerHTML = cards.map(([k, v]) =>
      `<div class="p-3 bg-gray-50 border border-gray-200 rounded-lg"><p class="text-xs text-gray-500">${esc(k)}</p><p class="text-lg font-bold text-gray-800">${esc(v)}</p></div>`).join('');
  } catch (e) {
    reportError('admin.loadStats', e);
    box.innerHTML = `<p class="text-red-600 col-span-2">Statistiche non disponibili: ${esc(friendlyError(e))}</p>`;
  }
}

// ---------- Verifica annunci sopra soglia ----------
function adminOfferCard(id, o, actions) {
  return `
    <div class="p-3 border border-gray-200 rounded-lg bg-white">
      <div class="flex justify-between gap-2">
        <b class="text-sm" style="word-break:break-word">${esc(o.title)}</b>
        <span class="text-sm font-bold text-amber-700 whitespace-nowrap">${o.cpValue} KP</span>
      </div>
      <p class="text-xs text-gray-500">di ${esc(o.ownerName)} · ${esc(o.status)}</p>
      <div class="mt-2">${thumbHtml(id, o)}</div>
      <p class="text-xs text-gray-600" style="word-break:break-word">${esc(o.description)}</p>
      <p class="text-xs text-gray-500 mt-1">${valuationLine(o)}</p>
      <div class="flex gap-2 mt-2 flex-wrap">${actions}</div>
    </div>`;
}

async function loadReviewQueue() {
  const box = $('admin-review');
  try {
    const snap = await getDocs(query(collection(db, 'offerte'), where('status', '==', 'in_verifica'), limit(50)));
    snap.docs.forEach((d) => state.offers.set(d.id, d.data()));
    box.innerHTML = snap.empty
      ? '<p class="text-gray-400 text-xs">Nessun annuncio da verificare.</p>'
      : snap.docs.map((d) => adminOfferCard(d.id, d.data(), `
          <button onclick="approveOffer('${sid(d.id)}')" class="px-3 py-1 text-xs rounded bg-green-600 text-white">✓ Approva</button>
          <button onclick="rejectOffer('${sid(d.id)}')" class="px-3 py-1 text-xs rounded bg-red-600 text-white">✕ Rifiuta</button>`)).join('');
  } catch (e) {
    reportError('admin.loadReviewQueue', e);
    box.innerHTML = `<p class="text-red-600 text-xs">${esc(friendlyError(e))}</p>`;
  }
}

window.approveOffer = async function (id) {
  try {
    await updateDoc(doc(db, 'offerte', id), { status: 'disponibile', verifiedBy: auth.currentUser.uid, verifiedAt: serverTimestamp() });
    logEvent('offer_approved', { offerId: id, kp: state.offers.get(id)?.cpValue });
    notify('reviewed', { offerId: id });
    await loadReviewQueue();
  } catch (e) {
    reportError('admin.approveOffer', e, { offerId: id });
    alert('Impossibile approvare: ' + friendlyError(e));
  }
};

window.rejectOffer = async function (id) {
  const motivo = (prompt('Motivo del rifiuto (verrà mostrato all\'utente):', 'Valore non coerente con il bene nelle foto') || '').trim();
  if (!motivo) return;
  try {
    await updateDoc(doc(db, 'offerte', id), {
      status: 'rifiutato', motivoRifiuto: motivo.slice(0, 300), verifiedBy: auth.currentUser.uid, verifiedAt: serverTimestamp()
    });
    logEvent('offer_rejected', { offerId: id, kp: state.offers.get(id)?.cpValue, motivo: motivo.slice(0, 300) }, 'warn');
    notify('reviewed', { offerId: id });
    await loadReviewQueue();
  } catch (e) {
    reportError('admin.rejectOffer', e, { offerId: id });
    alert('Impossibile rifiutare: ' + friendlyError(e));
  }
};

// ---------- Annunci segnalati ----------
async function loadReported() {
  const box = $('admin-reported');
  try {
    const snap = await getDocs(query(collection(db, 'offerte'), where('reportCount', '>=', 1), limit(50)));
    const docs = snap.docs.filter((d) => d.data().status !== 'concluso');
    if (!docs.length) { box.innerHTML = '<p class="text-gray-400 text-xs">Nessuna segnalazione.</p>'; return; }
    const cards = await Promise.all(docs.map(async (d) => {
      const o = d.data();
      state.offers.set(d.id, o);
      let reasons = '';
      try {
        const r = await getDocs(collection(db, 'offerte', d.id, 'segnalazioni'));
        const TIPI = { valore: '💰 Valore', offensivo: '🤬 Volgare/offensivo', vietato: '🚫 Vietato', truffa: '⚠️ Truffa', altro: '✏️ Altro' };
        reasons = r.docs.map((x) => { const v = x.data(); return `<li><b>${TIPI[v.tipo] || '💰 Valore'}</b>${v.motivo ? ': ' + esc(v.motivo) : ''}</li>`; }).join('');
      } catch (_) {}
      return adminOfferCard(d.id, o, `
        <p class="w-full text-xs text-red-700"><b>${o.reportCount} ${o.reportCount === 1 ? 'segnalazione' : 'segnalazioni'}</b>${o.nascosto || o.reportCount >= state.catalog.sogliaSegnalazioni ? ' (nascosto)' : ''}</p>
        <ul class="w-full text-xs text-gray-600 list-disc ml-4">${reasons}</ul>
        <button onclick="clearReports('${sid(d.id)}')" class="px-3 py-1 text-xs rounded bg-gray-200">Va bene così: azzera e rendi visibile</button>
        <button onclick="adminRemoveOffer('${sid(d.id)}')" class="px-3 py-1 text-xs rounded bg-red-600 text-white">🛡 Rimuovi annuncio</button>`);
    }));
    box.innerHTML = cards.join('');
  } catch (e) {
    reportError('admin.loadReported', e);
    box.innerHTML = `<p class="text-red-600 text-xs">${esc(friendlyError(e))}</p>`;
  }
}

window.clearReports = async function (id) {
  try {
    await updateDoc(doc(db, 'offerte', id), { reportCount: 0, nascosto: false });
    logEvent('reports_cleared', { offerId: id });
    await loadReported();
  } catch (e) {
    reportError('admin.clearReports', e, { offerId: id });
    alert('Operazione non riuscita: ' + friendlyError(e));
  }
};

window.adminDeleteOffer = async function (id) {
  if (!confirm('Eliminare definitivamente questo annuncio?')) return;
  try {
    const o = await deleteOfferWithFotos(id);
    logEvent('offer_deleted_by_admin', { offerId: id, title: o?.title, ownerId: o?.ownerId }, 'warn');
    await Promise.all([loadReported(), loadReviewQueue()]);
  } catch (e) {
    reportError('admin.deleteOffer', e, { offerId: id });
    alert('Eliminazione non riuscita: ' + friendlyError(e));
  }
};

// ---------- Catalogo (fasce di prezzo e parametri) ----------
function fillCatalogEditor() {
  $('catalog-status').textContent = state.catalogOnServer
    ? 'Catalogo attivo su Firestore. Modifica il JSON e salva: le regole di sicurezza useranno subito i nuovi valori.'
    : 'Catalogo NON ancora attivo: nessuno può pubblicare finché non lo salvi la prima volta.';
  $('catalog-editor').value = JSON.stringify(state.catalog, null, 2);
}
document.addEventListener('catalog-changed', () => { if (state.isAdmin && $('admin-screen').classList.contains('active')) fillCatalogEditor(); });

// Aggiunge le nuove categorie dell'app al catalogo salvato, senza toccare quello che hai gia' modificato
window.addCatalogNews = async function () {
  const { catalogo, aggiunte } = unisciNovita(state.catalog);
  if (!aggiunte.length) return alert('Il catalogo è già aggiornato: non ci sono novità da aggiungere.');
  const elenco = aggiunte.slice(0, 15).join('\n- ') + (aggiunte.length > 15 ? `\n… e altre ${aggiunte.length - 15}` : '');
  if (!confirm(`Aggiungere ${aggiunte.length} novità al catalogo?\n\n- ${elenco}\n\nPrezzi e valori già modificati non cambiano.`)) return;
  const errs = validaCatalogo(catalogo);
  if (errs.length) return alert('Errore nel catalogo:\n- ' + errs.join('\n- '));
  try {
    catalogo.versione = (Number(state.catalog.versione) || 0) + 1;
    await setDoc(doc(db, 'config', 'catalogo'), catalogo);
    logEvent('catalog_news_added', { aggiunte: aggiunte.length, versione: catalogo.versione }, 'warn');
    alert(`Fatto: ${aggiunte.length} novità aggiunte.`);
  } catch (e) {
    reportError('admin.addCatalogNews', e);
    alert('Aggiornamento non riuscito: ' + friendlyError(e));
  }
};

window.resetCatalogEditor = function () {
  if (!confirm('Caricare nell\'editor i valori predefiniti? (non salva finché non premi Salva)')) return;
  $('catalog-editor').value = JSON.stringify(DEFAULT_CATALOG, null, 2);
};

window.saveCatalog = async function () {
  let c;
  try { c = JSON.parse(val('catalog-editor')); } catch (e) { return alert('JSON non valido: ' + e.message); }
  const errs = validaCatalogo(c);
  if (errs.length) return alert('Correggi prima questi errori:\n- ' + errs.join('\n- '));
  if (!confirm('Salvare il catalogo? Vale subito per tutti i nuovi annunci.')) return;
  try {
    c.versione = (Number(state.catalog.versione) || 0) + 1;
    await setDoc(doc(db, 'config', 'catalogo'), c);
    logEvent('catalog_saved', { versione: c.versione, sottocategorie: Object.keys(c.sottocategorie).length }, 'warn');
    alert('Catalogo salvato.');
  } catch (e) {
    reportError('admin.saveCatalog', e);
    alert('Salvataggio non riuscito: ' + friendlyError(e));
  }
};

// ---------- Ricerca: prepara gli annunci pubblicati prima della funzione ----------
window.prepareSearch = async function () {
  if (!confirm('Calcolare le parole chiave per gli annunci che non le hanno ancora? Serve una sola volta.')) return;
  const btn = $('prepare-search-btn');
  btn.disabled = true;
  let fatti = 0;
  try {
    const snap = await getDocs(collection(db, 'offerte'));
    const daFare = snap.docs.filter((d) => !Array.isArray(d.data().keywords) && d.data().status !== 'concluso');
    for (let i = 0; i < daFare.length; i += 400) {
      const b = writeBatch(db);
      daFare.slice(i, i + 400).forEach((d) => b.update(d.ref, { keywords: paroleChiaveAnnuncio(state.catalog, d.data()) }));
      await b.commit();
      fatti += Math.min(400, daFare.length - i);
      btn.textContent = `Preparati ${fatti} di ${daFare.length}…`;
    }
    logEvent('search_prepared', { annunci: fatti });
    alert(fatti ? `Fatto: ${fatti} annunci ora si trovano con la ricerca.` : 'Tutti gli annunci erano già pronti per la ricerca.');
  } catch (e) {
    reportError('admin.prepareSearch', e);
    alert('Operazione non riuscita: ' + friendlyError(e));
  } finally {
    btn.disabled = false;
    btn.textContent = '🔎 Prepara la ricerca per gli annunci vecchi';
  }
};

// ---------- Log ----------
async function loadLogs() {
  const box = $('admin-logs');
  box.innerHTML = '<p class="text-gray-500">Caricamento...</p>';
  try {
    const snap = await getDocs(query(collection(db, 'logs'), orderBy('ts', 'desc'), limit(500)));
    adminLogs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    window.renderAdminLogs();
  } catch (e) {
    reportError('admin.loadLogs', e);
    box.innerHTML = `<p class="text-red-600">Log non leggibili: ${esc(friendlyError(e))}</p>`;
  }
}

function filteredLogs() {
  const f = val('admin-filter');
  if (!f) return adminLogs;
  if (f === 'problems') return adminLogs.filter((l) => l.level !== 'info');
  return adminLogs.filter((l) => l.type === f);
}

window.renderAdminLogs = function () {
  const rows = filteredLogs();
  $('admin-logs').innerHTML = rows.length ? rows.map((l) => {
    const d = tsToDate(l.ts);
    const color = l.level === 'error' ? 'bg-red-50 border-red-200' : l.level === 'warn' ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200';
    return `<div class="p-2 border rounded ${color}">
      <div class="flex justify-between"><b>${esc(l.type)}</b><span class="text-gray-400">${d ? d.toLocaleString('it-IT') : ''}</span></div>
      <div class="text-gray-600">${esc(l.userName)} · <span class="text-gray-400">${esc(l.uid)}</span></div>
      <div class="text-gray-500" style="word-break:break-all">${esc(l.details)}</div>
    </div>`;
  }).join('') : '<p class="text-gray-400">Nessun evento.</p>';
};

window.downloadLogs = function (format) {
  const rows = filteredLogs();
  if (!rows.length) return alert('Nessun log da scaricare.');
  const iso = (l) => tsToDate(l.ts)?.toISOString() || '';
  let content, mime;
  if (format === 'csv') {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    content = ['timestamp,level,type,uid,user,details,app']
      .concat(rows.map((l) => [iso(l), l.level, l.type, l.uid, l.userName, l.details, l.app].map(q).join(','))).join('\n');
    mime = 'text/csv';
  } else {
    content = `RIKEKA LOG — esportato il ${new Date().toISOString()} — ${rows.length} eventi\n` +
      rows.map((l) => `${iso(l)} | ${String(l.level).toUpperCase()} | ${l.type} | ${l.uid} | ${l.userName} | ${l.details}`).join('\n');
    mime = 'text/plain';
  }
  const url = URL.createObjectURL(new Blob(['﻿' + content], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `rikeka-log-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : 'txt'}`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
};

window.purgeOldLogs = async function () {
  if (!confirm(`Eliminare i log più vecchi di ${LOG_RETENTION_DAYS} giorni? Scaricali prima se ti servono.`)) return;
  const cutoff = Timestamp.fromMillis(Date.now() - LOG_RETENTION_DAYS * 86400000);
  let total = 0;
  try {
    for (;;) {
      const snap = await getDocs(query(collection(db, 'logs'), where('ts', '<', cutoff), limit(400)));
      if (snap.empty) break;
      const b = writeBatch(db);
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();
      total += snap.size;
    }
    logEvent('logs_purged', { deleted: total, olderThanDays: LOG_RETENTION_DAYS });
    alert(`Eliminati ${total} log.`);
    await loadLogs();
  } catch (e) {
    reportError('admin.purgeOldLogs', e);
    alert('Pulizia non riuscita: ' + friendlyError(e));
  }
};

// ---------- Amministratori ----------
async function loadAdmins() {
  const box = $('admin-list');
  box.innerHTML = '<p class="text-xs text-gray-500">Caricamento...</p>';
  try {
    const snap = await getDocs(collection(db, 'admins'));
    const righe = await Promise.all(snap.docs.map(async (d) => {
      const a = d.data();
      let nome = a.nome;
      if (!nome) {
        try { const u = await getDoc(doc(db, 'users', d.id)); nome = u.exists() ? u.data().displayName : ''; } catch (_) {}
      }
      return { uid: d.id, nome: nome || 'Utente', fondatore: !('addedBy' in a), io: d.id === auth.currentUser?.uid };
    }));
    righe.sort((x, y) => (y.fondatore - x.fondatore) || x.nome.localeCompare(y.nome));
    box.innerHTML = righe.map((r) => `
      <div class="flex items-center justify-between gap-2 p-2 rounded-lg border border-gray-200 bg-white">
        <span class="text-sm"><b>${esc(r.nome)}</b>
          <span class="text-xs text-gray-500">${r.fondatore ? '· fondatore' : ''}${r.io ? ' · tu' : ''}</span></span>
        ${r.fondatore || r.io ? '' : `<button onclick="revokeAdmin('${sid(r.uid)}', this.dataset.nome)" data-nome="${esc(r.nome)}"
            class="px-2 py-1 text-xs rounded bg-red-50 text-red-700 border border-red-200 hover:bg-red-100">Rimuovi</button>`}
      </div>`).join('') || '<p class="text-xs text-gray-500">Nessuno.</p>';
  } catch (e) {
    reportError('loadAdmins', e);
    box.innerHTML = `<p class="text-xs text-red-600">${regoleVecchie(e)}</p>`;
  }
}

window.searchUsersForAdmin = async function () {
  const q = val('admin-search').trim();
  const box = $('admin-search-results');
  if (q.length < 2) { box.innerHTML = '<p class="text-xs text-gray-500">Scrivi almeno 2 lettere del nome.</p>'; return; }
  box.innerHTML = '<p class="text-xs text-gray-500">Ricerca...</p>';
  try {
    const trovati = new Map();
    // UID incollato direttamente
    if (/^[A-Za-z0-9]{20,40}$/.test(q)) {
      const u = await getDoc(doc(db, 'users', q));
      if (u.exists()) trovati.set(u.id, u.data().displayName || 'Utente');
    }
    // Nome che inizia con il testo (come scritto e con l'iniziale maiuscola)
    const varianti = [...new Set([q, q.charAt(0).toUpperCase() + q.slice(1), q.toLowerCase()])];
    for (const v of varianti) {
      const snap = await getDocs(query(collection(db, 'users'),
        where('displayName', '>=', v), where('displayName', '<=', v + '\uf8ff'), orderBy('displayName'), limit(10)));
      snap.docs.forEach((d) => trovati.set(d.id, d.data().displayName || 'Utente'));
    }
    let admins = new Set();
    try { admins = new Set((await getDocs(collection(db, 'admins'))).docs.map((d) => d.id)); } catch (_) { /* elenco non leggibile: si mostra comunque il risultato */ }
    if (!trovati.size) { box.innerHTML = '<p class="text-xs text-gray-500">Nessun utente con questo nome. Il nome va scritto dall\'inizio, come appare nell\'app.</p>'; return; }
    box.innerHTML = [...trovati].map(([uid, nome]) => `
      <div class="flex items-center justify-between gap-2 p-2 rounded-lg border border-gray-200 bg-gray-50">
        <span class="text-sm">${esc(nome)} <span class="text-[10px] text-gray-400">${esc(uid.slice(0, 6))}…</span></span>
        ${admins.has(uid) ? '<span class="text-xs text-green-700">già amministratore</span>'
          : `<span class="flex gap-1">
               <button data-nome="${esc(nome)}" onclick="grantAdmin('${sid(uid)}', this.dataset.nome)"
                 class="px-2 py-1 text-xs rounded bg-green-600 text-white hover:bg-green-700">Rendi admin</button>
               <button data-nome="${esc(nome)}" onclick="suspendUser('${sid(uid)}', this.dataset.nome)"
                 class="px-2 py-1 text-xs rounded bg-red-50 text-red-700 border border-red-200">Sospendi</button>
             </span>`}
      </div>`).join('');
  } catch (e) {
    reportError('searchUsersForAdmin', e);
    box.innerHTML = `<p class="text-xs text-red-600">${regoleVecchie(e)}</p>`;
  }
};

window.grantAdmin = async function (uid, nome) {
  if (!confirm(`Dare a «${nome}» gli stessi poteri che hai tu?\nPotrà pubblicare e ricevere senza limiti di KP, approvare annunci, modificare il catalogo e nominare altri amministratori.`)) return;
  try {
    await setDoc(doc(db, 'admins', uid), { nome: String(nome).slice(0, 80), addedBy: auth.currentUser.uid, addedAt: serverTimestamp() });
    logEvent('admin_granted', { uid, nome });
    $('admin-search-results').innerHTML = `<p class="text-xs text-green-700">✓ ${esc(nome)} ora è amministratore. Lo vedrà al prossimo accesso o ricaricando la pagina.</p>`;
    loadAdmins();
  } catch (e) {
    reportError('grantAdmin', e, { uid });
    alert('Impossibile nominarlo: ' + (e?.code === 'permission-denied' ? 'Firebase sta usando regole vecchie (manca la parte Amministratori).' : friendlyError(e)));
  }
};

window.revokeAdmin = async function (uid, nome) {
  if (!confirm(`Togliere i poteri di amministratore a «${nome}»?`)) return;
  try {
    await deleteDoc(doc(db, 'admins', uid));
    logEvent('admin_revoked', { uid, nome }, 'warn');
    loadAdmins();
  } catch (e) {
    reportError('revokeAdmin', e, { uid });
    alert('Impossibile rimuoverlo: ' + friendlyError(e));
  }
};

// ---------- Verifica notifiche ----------
window.testPush = async function () {
  const btn = $('push-test-btn'), box = $('push-test-result');
  btn.disabled = true; box.innerHTML = '<p class="text-gray-500">Verifica in corso...</p>';
  try {
    const righe = await testPushDiagnostics();
    box.innerHTML = righe.map(([ok, testo]) =>
      `<p class="${ok === true ? 'text-green-700' : ok === false ? 'text-red-600' : 'text-gray-600'}">${ok === true ? '✓' : ok === false ? '✗' : '•'} ${testo}</p>`).join('');
  } catch (e) {
    box.innerHTML = `<p class="text-red-600">✗ ${esc(e.message)}</p>`;
  } finally { btn.disabled = false; }
};

// Messaggio chiaro quando Firebase rifiuta per le regole
function regoleVecchie(e) {
  if (e?.code === 'permission-denied') {
    return 'Firebase rifiuta l\'operazione: le regole attive sono ancora quelle vecchie, senza la parte "Amministratori". '
      + 'In Firebase → Firestore → Regole cerca la parola <b>addedBy</b>: se non c\'è, incolla le regole nuove e premi Pubblica.';
  }
  return esc(friendlyError(e)) + (e?.code ? ` (${esc(e.code)})` : '');
}

// ---------- Da controllare: scambi fermi, giudizi negativi, sospesi ----------
const giorni = (ts) => { const d = tsToDate(ts); return d ? Math.floor((Date.now() - d.getTime()) / 864e5) : '?'; };

async function loadControl() {
  const box = $('admin-control');
  box.innerHTML = '<p class="text-xs text-gray-500">Caricamento...</p>';
  try {
    const [aiuti, negativi, sospesi] = await Promise.all([
      getDocs(query(collection(db, 'offerte'), where('aiutoRichiesto', '==', true), limit(50))),
      getDocs(query(collection(db, 'users'), where('fbNeg', '>=', 2), orderBy('fbNeg', 'desc'), limit(50))),
      getDocs(collection(db, 'sospesi'))
    ]);
    const idSospesi = new Set(sospesi.docs.map((d) => d.id));
    let html = '';

    const fermi = aiuti.docs.filter((d) => d.data().status === 'consegnato');
    html += `<p class="text-xs font-semibold text-gray-600">🆘 Scambi fermi (${fermi.length})</p>`;
    html += fermi.map((d) => {
      const o = d.data();
      return `<div class="adm-card"><b>${esc(o.title)}</b> · ${o.cpValue} KP<br>
        <span class="text-xs text-gray-500">${esc(o.ownerName || '?')} dice di averlo consegnato a ${esc(o.reservedByName || '?')} ${giorni(o.deliveredAt)} giorni fa; nessuna conferma.</span>
        <div class="adm-actions">
          <button class="adm-btn ok" onclick="adminCloseDeal('${sid(d.id)}')">Concludi: KP a chi ha regalato</button>
          <button class="adm-btn" onclick="adminCancelDeal('${sid(d.id)}')">Annulla lo scambio</button>
        </div></div>`;
    }).join('') || '<p class="text-xs text-gray-400">Nessuno.</p>';

    html += `<p class="text-xs font-semibold text-gray-600 pt-2">👎 Giudizi negativi (${negativi.size})</p>`;
    html += negativi.docs.map((d) => {
      const u = d.data(), pos = u.fbPos ?? 0, neg = u.fbNeg ?? 0;
      return `<div class="adm-card"><b>${esc(u.displayName || 'Utente')}</b>
        <span class="text-xs text-gray-500">· ${u.completedSwaps ?? 0} scambi · 👍 ${pos} · 👎 ${neg}${idSospesi.has(d.id) ? ' · <b class="text-red-700">sospeso</b>' : ''}</span>
        <div class="adm-actions">${idSospesi.has(d.id)
          ? `<button class="adm-btn" onclick="unsuspendUser('${sid(d.id)}')">Riattiva</button>`
          : `<button class="adm-btn warn" data-nome="${esc(u.displayName || 'Utente')}" onclick="suspendUser('${sid(d.id)}', this.dataset.nome)">Sospendi</button>`}</div></div>`;
    }).join('') || '<p class="text-xs text-gray-400">Nessuno.</p>';

    html += `<p class="text-xs font-semibold text-gray-600 pt-2">⛔ Account sospesi (${sospesi.size})</p>`;
    html += sospesi.docs.map((d) => {
      const x = d.data();
      return `<div class="adm-card"><b>${esc(x.nome || 'Utente')}</b>
        <span class="text-xs text-gray-500">${x.motivo ? '· ' + esc(x.motivo) : ''}</span>
        <div class="adm-actions"><button class="adm-btn" onclick="unsuspendUser('${sid(d.id)}')">Riattiva</button></div></div>`;
    }).join('') || '<p class="text-xs text-gray-400">Nessuno.</p>';

    box.innerHTML = html;
  } catch (e) {
    reportError('loadControl', e);
    box.innerHTML = `<p class="text-xs text-red-600">${regoleVecchie(e)}</p>`;
  }
}

window.adminCloseDeal = async function (offerId) {
  if (!confirm('Concludere lo scambio?\nChi ha regalato riceve i KP; a chi ha ricevuto vengono tolti (senza scendere sotto zero).')) return;
  try {
    await runTransaction(db, async (tx) => {
      const oRef = doc(db, 'offerte', offerId);
      const o = (await tx.get(oRef)).data();
      if (!o || o.status !== 'consegnato' || !o.reservedBy) throw new Error('Lo scambio non è più in attesa di conferma.');
      const cp = Number(o.cpValue);
      const gRef = doc(db, 'users', o.ownerId), rRef = doc(db, 'users', o.reservedBy);
      const g = (await tx.get(gRef)).data(), r = (await tx.get(rRef)).data();
      const rAdmin = (await tx.get(doc(db, 'admins', o.reservedBy))).exists();
      if (!g || !r) throw new Error('Profilo utente non trovato.');
      // bonus di benvenuto: incassato al primo scambio concluso (anche se chiuso da un admin)
      const bonusG = Number.isInteger(g.bonusPrimoScambio) ? g.bonusPrimoScambio : 0;
      const bonusR = Number.isInteger(r.bonusPrimoScambio) ? r.bonusPrimoScambio : 0;
      const rk = (r.karmaPoints ?? 0) + bonusR;
      tx.update(oRef, { status: 'concluso', chiusoDaAdmin: true, completionDate: serverTimestamp() });
      tx.update(gRef, { karmaPoints: (g.karmaPoints ?? 0) + bonusG + cp, completedSwaps: (g.completedSwaps ?? 0) + 1, lastOfferId: offerId,
        ...('bonusPrimoScambio' in g ? { bonusPrimoScambio: 0 } : {}) });
      tx.update(rRef, { karmaPoints: rAdmin ? rk : Math.max(0, rk - cp), completedSwaps: (r.completedSwaps ?? 0) + 1, lastOfferId: offerId,
        ...('bonusPrimoScambio' in r ? { bonusPrimoScambio: 0 } : {}) });
    });
    logEvent('admin_closed_deal', { offerId }, 'warn');
    loadControl();
  } catch (e) {
    reportError('adminCloseDeal', e, { offerId });
    alert('Operazione non riuscita: ' + (e?.code ? regoleVecchie(e).replace(/<[^>]+>/g, '') : e.message));
  }
};

window.adminCancelDeal = async function (offerId) {
  if (!confirm("Annullare lo scambio?\nL'annuncio torna disponibile e nessun KP si sposta.")) return;
  try {
    await updateDoc(doc(db, 'offerte', offerId), { status: 'disponibile', reservedBy: null, reservedByName: null, deliveredAt: null, aiutoRichiesto: false });
    logEvent('admin_cancelled_deal', { offerId }, 'warn');
    loadControl();
  } catch (e) {
    reportError('adminCancelDeal', e, { offerId });
    alert('Operazione non riuscita: ' + friendlyError(e));
  }
};

window.suspendUser = async function (uid, nome) {
  const motivo = prompt(`Sospendere «${nome}»?\nPotrà vedere gli annunci ma non pubblicare né scrivere in chat.\n\nMotivo (facoltativo, lo vedi solo tu):`, '');
  if (motivo === null) return;
  try {
    await setDoc(doc(db, 'sospesi', uid), { nome: String(nome).slice(0, 80), motivo: motivo.trim().slice(0, 300), by: auth.currentUser.uid, at: serverTimestamp() });
    logEvent('user_suspended', { uid, nome }, 'warn');
    loadControl();
    $('admin-search-results').innerHTML = `<p class="text-xs text-red-700">⛔ ${esc(nome)} è sospeso.</p>`;
  } catch (e) {
    reportError('suspendUser', e, { uid });
    alert('Impossibile sospenderlo: ' + (e?.code === 'permission-denied' ? 'gli amministratori non si possono sospendere (o le regole non sono aggiornate).' : friendlyError(e)));
  }
};

window.unsuspendUser = async function (uid) {
  if (!confirm('Riattivare questo account?')) return;
  try {
    await deleteDoc(doc(db, 'sospesi', uid));
    logEvent('user_unsuspended', { uid });
    loadControl();
  } catch (e) {
    reportError('unsuspendUser', e, { uid });
    alert('Operazione non riuscita: ' + friendlyError(e));
  }
};

// Dopo una rimozione fatta da qualsiasi punto dell'app, aggiorna le liste del pannello
document.addEventListener('offer-removed', () => {
  if (state.isAdmin && $('admin-screen').classList.contains('active')) { loadReported(); loadReviewQueue(); }
});
