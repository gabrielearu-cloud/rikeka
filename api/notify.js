// =====================================================================
// FUNZIONE SERVER SU VERCEL: invia le notifiche push di Rikeka
// URL: https://<tuo-sito>/api/notify   (Vercel la pubblica da sola)
//
// Sicurezza: il client NON sceglie destinatario ne' testo. Manda solo il
// tipo di evento e l'ID; la funzione verifica chi chiama, legge lo stato
// reale in Firestore e decide lei a chi scrivere e cosa.
//
// Configurazione (una volta sola), su Vercel -> Settings -> Environment Variables:
//   FIREBASE_SERVICE_ACCOUNT = contenuto del file JSON della chiave
//   (Firebase -> Impostazioni progetto -> Account di servizio -> Genera nuova chiave privata)
// =====================================================================
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const MIN_INTERVAL_MS = 60 * 1000;   // massimo una notifica al minuto per annuncio/prova
const MSG_INTERVAL_MS = 20 * 1000;   // chat: al massimo una ogni 20 secondi

function admin() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT non configurata');
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return { auth: getAuth(), db: getFirestore(), messaging: getMessaging() };
}

const clip = (s, n) => String(s || '').slice(0, n);
// ID dei documenti: solo lettere, numeri, _ e - (niente "/" che cambierebbe il percorso)
const docId = (s) => (typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s)) ? s : null;

/** Decide destinatario e testo partendo dallo stato reale del database. */
async function buildNotification(db, uid, body) {
  const { type } = body;

  // Prova dal pannello admin: la notifica arriva a chi la chiede
  if (type === 'test') {
    return { to: uid, self: true, key: `test_${uid}`, title: '🔔 Prova riuscita', body: 'Le notifiche di Rikeka funzionano su questo dispositivo.', tag: 'test' };
  }

  if (type === 'message') {
    const chatId = docId(body.chatId);
    if (!chatId) return null;
    const snap = await db.doc(`chats/${chatId}`).get();
    if (!snap.exists) return null;
    const c = snap.data();
    if (!Array.isArray(c.users) || !c.users.includes(uid)) return null;
    if (c.lastMessageSenderId !== uid) return null;                       // deve aver appena scritto lui
    const sentAt = c.lastMessageTimestamp?.toMillis?.() || 0;
    if (Date.now() - sentAt > 2 * 60 * 1000) return null;                 // messaggio recente
    const to = c.users.find((u) => u !== uid);
    const sender = (await db.doc(`users/${uid}`).get()).data()?.displayName || 'Qualcuno';
    return {
      to, key: `msg_${snap.id}_${to}`,
      title: `💬 ${clip(sender, 40)}`,
      body: `Nuovo messaggio per «${clip(c.offerTitle, 60)}»`,
      tag: `chat-${snap.id}`
    };
  }

  // Problema segnalato da un utente: avviso a tutti gli amministratori
  if (type === 'bug') {
    const id = docId(body.problemaId);
    if (!id) return null;
    const p = (await db.doc(`problemi/${id}`).get()).data();
    if (!p || p.uid !== uid) return null;
    const admins = (await db.collection('admins').get()).docs.map((d) => d.id).filter((a) => a !== uid);
    return { toList: admins, key: `bug_${uid}`, tag: 'bug', title: '🐞 Nuovo problema segnalato',
      body: `${clip(p.nome, 40)}: ${clip(p.testo, 100)}` };
  }

  // Contestazione su uno scambio: aperta da chi ha ricevuto -> avviso agli amministratori;
  // decisa da un amministratore -> esito a chi ha ricevuto e a chi ha regalato
  if (type === 'dispute' || type === 'dispute_done') {
    const id = docId(body.offerId);
    if (!id) return null;
    const c = (await db.doc(`contestazioni/${id}`).get()).data();
    if (!c) return null;
    const t = `«${clip(c.titolo, 60)}»`;
    if (type === 'dispute') {
      if (c.buyerId !== uid || c.stato !== 'aperta') return null;
      const admins = (await db.collection('admins').get()).docs.map((d) => d.id).filter((a) => a !== uid);
      return { toList: admins, key: `dispute_${id}`, status: 'aperta', tag: 'dispute',
        title: '⚠️ Contestazione su uno scambio', body: `${clip(c.buyerName, 40)} segnala un problema su ${t}: Pannello Admin → Contestazioni.` };
    }
    if (c.decisoDa !== uid || c.stato === 'aperta' || !(await db.doc(`admins/${uid}`).get()).exists) return null;
    const esito = { rimborso: `accolta: ${c.cpValue} KP restituiti a ${clip(c.buyerName, 30)}`,
      rimborso_storno: `accolta: ${c.cpValue} KP restituiti a ${clip(c.buyerName, 30)} e tolti a ${clip(c.ownerName, 30)}`,
      respinta: 'respinta, i KP restano dove sono' }[c.stato] || 'decisa';
    return { toList: [c.buyerId, c.ownerId], key: `dispute_done_${id}`, status: c.stato, tag: `offer-${id}`,
      title: '⚖️ Contestazione decisa', body: `${t}: ${esito}.` };
  }

  // Annuncio rimosso da un amministratore: l'annuncio non esiste piu', si legge l'avviso
  if (type === 'removed') {
    const id = docId(body.offerId);
    if (!id) return null;
    const r = (await db.doc(`rimozioni/${id}`).get()).data();
    if (!r || r.by !== uid || !(await db.doc(`admins/${uid}`).get()).exists) return null;
    const MOTIVI = { valore: 'valore in KP non corretto', offensivo: 'contenuto volgare o offensivo', vietato: 'oggetto vietato o pericoloso', truffa: 'possibile truffa', altro: 'altro' };
    return { to: r.ownerId, key: `removed_${id}`, status: 'rimosso', tag: `removed-${id}`,
      title: '🛡 Annuncio rimosso', body: `«${clip(r.title, 60)}»: ${MOTIVI[r.motivo] || 'violazione dei Termini'}${r.nota ? ' — ' + clip(r.nota, 80) : ''}` };
  }

  const offerId = docId(body.offerId);
  if (!offerId) return null;
  const snap = await db.doc(`offerte/${offerId}`).get();
  if (!snap.exists) return null;
  const o = snap.data();
  const t = `«${clip(o.title, 60)}»`;
  const base = { key: `${type}_${snap.id}`, status: o.status, tag: `offer-${snap.id}` };

  switch (type) {
    case 'reserved':
      if (o.ownerId !== uid || o.status !== 'in_trattativa' || !o.reservedBy) return null;
      return { ...base, to: o.reservedBy, title: '🎉 Sei stato scelto!', body: `${t} è riservato per te. Accordati in chat per la consegna.` };
    case 'delivered':
      if (o.ownerId !== uid || o.status !== 'consegnato' || !o.reservedBy) return null;
      return { ...base, to: o.reservedBy, title: '📦 Conferma la ricezione', body: `${clip(o.ownerName, 40)} ha segnato ${t} come consegnato. Se l'hai ricevuto, conferma nella chat.` };
    case 'not_received':
      if (o.reservedBy !== uid || o.status !== 'in_trattativa') return null;
      return { ...base, to: o.ownerId, title: '⚠️ Ricezione non confermata', body: `${clip(o.reservedByName, 40)} dice di non aver ricevuto ${t}. Scrivigli in chat.` };
    case 'concluded':
      if (o.reservedBy !== uid || o.status !== 'concluso') return null;
      return { ...base, to: o.ownerId, title: `✅ +${o.cpValue} KP`, body: `Scambio concluso: ${t} è stato ricevuto. Grazie!` };
    case 'help': {
      if (o.ownerId !== uid || o.status !== 'consegnato' || o.aiutoRichiesto !== true) return null;
      const admins = (await db.collection('admins').get()).docs.map((d) => d.id).filter((id) => id !== uid);
      return { ...base, toList: admins, title: '🆘 Scambio da sbloccare', body: `${clip(o.ownerName, 40)} chiede aiuto per ${t}: Pannello Admin → Da controllare.` };
    }
    case 'reviewed': {
      const isAdmin = (await db.doc(`admins/${uid}`).get()).exists;
      if (!isAdmin || !['disponibile', 'rifiutato'].includes(o.status)) return null;
      return o.status === 'disponibile'
        ? { ...base, to: o.ownerId, title: '✅ Annuncio approvato', body: `${t} ora è visibile a tutti.` }
        : { ...base, to: o.ownerId, title: 'Annuncio non approvato', body: `${t}: ${clip(o.motivoRifiuto, 120)}` };
    }
    default:
      return null;
  }
}

export default async function handler(req, res) {
  // Diagnosi: aprendo /api/notify nel browser si vede se il server e' configurato
  if (req.method === 'GET') {
    let configured = false, projectId = null, problem = null;
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
      configured = !!(sa && sa.private_key && sa.client_email);
      projectId = sa?.project_id || null;
      if (!configured) problem = process.env.FIREBASE_SERVICE_ACCOUNT ? 'chiave incompleta' : 'FIREBASE_SERVICE_ACCOUNT mancante';
    } catch (_) { problem = 'FIREBASE_SERVICE_ACCOUNT non e\' un JSON valido (va incollato tutto il file, dalla { alla })'; }
    return res.status(200).json({ ok: configured, projectId, problem });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const { auth, db, messaging } = admin();

    const idToken = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!idToken) return res.status(401).json({ error: 'auth' });
    const { uid } = await auth.verifyIdToken(idToken);

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const n = await buildNotification(db, uid, body);
    const destinatari = n ? (n.toList || [n.to]).filter((d) => d && (d !== uid || n.self)) : [];
    const traccia = (esito, extra = {}) => console.log('[notify]', JSON.stringify({ tipo: String(body.type || '').slice(0, 20), esito, ...extra }));
    if (!destinatari.length) { traccia('non-applicabile'); return res.status(200).json({ sent: 0, reason: 'not-applicable' }); }

    // Anti-spam: una notifica al minuto per chiave; per gli annunci una sola per stato
    const stateRef = db.doc(`notifyState/${n.key}`);
    const prev = (await stateRef.get()).data();
    if (prev) {
      if (n.status && prev.status === n.status) { traccia('gia-inviata'); return res.status(200).json({ sent: 0, reason: 'already-sent' }); }
      const intervallo = n.key.startsWith('msg_') ? MSG_INTERVAL_MS : MIN_INTERVAL_MS;
      if (Date.now() - (prev.at?.toMillis?.() || 0) < intervallo) { traccia('troppo-ravvicinata'); return res.status(200).json({ sent: 0, reason: 'throttled' }); }
    }

    const tokens = [], refDi = new Map();   // token -> documento da cui viene
    for (const d of destinatari.slice(0, 20)) {
      const snap = await db.doc(`pushTokens/${d}`).get();
      (snap.exists ? (snap.data().tokens || []) : []).forEach((t) => { tokens.push(t); refDi.set(t, snap.ref); });
    }
    if (!tokens.length) { traccia('destinatario-senza-dispositivi'); return res.status(200).json({ sent: 0, reason: 'no-tokens' }); }

    const result = await messaging.sendEachForMulticast({
      tokens,
      data: { title: n.title, body: n.body, tag: n.tag || 'rikeka', url: './index.html' },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } }
    });

    // Rimuove i token non piu' validi (app disinstallata, permesso revocato)
    const dead = [];
    result.responses.forEach((r, i) => {
      const code = r.error?.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token') || code.includes('invalid-argument')) dead.push(tokens[i]);
    });
    for (const t of dead) await refDi.get(t).update({ tokens: FieldValue.arrayRemove(t) });

    await stateRef.set({ at: FieldValue.serverTimestamp(), status: n.status || null });
    const errors = result.responses.map((r) => r.error?.code).filter(Boolean);
    traccia('inviata', { dispositivi: tokens.length, consegnate: result.successCount, errori: [...new Set(errors)], tokenRimossi: dead.length });
    return res.status(200).json({ sent: result.successCount, tokens: tokens.length, errors: [...new Set(errors)] });
  } catch (e) {
    console.error('notify error', e);
    const code = String(e?.code || '');
    return res.status(code.startsWith('auth/') ? 401 : 500)
      .json({ error: 'internal', code: code || clip(e?.message, 120) });
  }
}
