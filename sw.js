// =====================================================================
// SERVICE WORKER di Rikeka
// Rende l'app installabile e veloce all'avvio. Strategia "prima la rete":
// gli utenti ricevono sempre l'ultima versione pubblicata; la copia salvata
// si usa solo se la connessione manca. I dati (Firebase) non passano di qui.
// Quando cambi i file dell'app non serve toccare nulla; aumenta VERSIONE
// solo se aggiungi o rinomini file nell'elenco qui sotto.
// =====================================================================
const VERSIONE = 'rikeka-v32';
const FILE_BASE = [
  './', './index.html', './privacy.html', './termini.html', './manifest.webmanifest',
  './css/style.css',
  './js/app.js', './js/admin.js', './js/catalog.js', './js/config.js', './js/firebase.js',
  './js/logger.js', './js/state.js', './js/utils.js', './js/legal-page.js', './js/push.js', './js/geo.js', './js/install.js', './js/filtro.js',
  './icons/icon-192.png', './icons/icon-512.png', './favicon.svg'
];

self.addEventListener('install', (event) => {
  // Salva i file uno per uno: se qualcuno manca sul sito, lo salta invece di bloccare tutto
  event.waitUntil(
    caches.open(VERSIONE)
      .then((c) => Promise.all(FILE_BASE.map((f) => c.add(f).catch(() => console.warn('[sw] file non trovato:', f)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSIONE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Solo file del nostro sito; Firebase, Google e CDN vanno direttamente in rete
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(VERSIONE).then((c) => c.put(req, copia));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});

// =====================================================================
// NOTIFICHE PUSH (inviate da /api/notify tramite Firebase Cloud Messaging)
// =====================================================================
// Chat aperta in ciascuna finestra (comunicata dall'app)
const chatAperta = new Map();
const appInstallata = new Map();   // finestra -> true se e' l'app installata (non una scheda del browser)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'open-chat' && event.source) chatAperta.set(event.source.id, event.data.chatId || null);
  if (event.data?.type === 'app-mode' && event.source) appInstallata.set(event.source.id, !!event.data.standalone);
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { /* testo non JSON */ }
  const d = payload.data || payload.notification || {};
  const title = d.title || 'Rikeka';
  const options = {
    body: d.body || 'Hai una novità su Rikeka',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: d.tag || 'rikeka',
    renotify: true,
    data: { url: d.url || './index.html' }
  };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Si salta solo se la STESSA chat e' aperta e in primo piano.
      // Su iPhone/iPad va mostrata sempre: Safari revoca le notifiche se un push resta "silenzioso".
      const apple = /iphone|ipad|ipod|macintosh/i.test(self.navigator.userAgent);
      const chatId = (options.tag || '').startsWith('chat-') ? options.tag.slice(5) : null;
      if (!apple && chatId && wins.some((w) => w.visibilityState === 'visible' && w.focused && chatAperta.get(w.id) === chatId)) return;
      // pallino sull'icona dell'app (iPhone con app installata, computer): si toglie aprendo le chat
      if (chatId) { try { self.navigator.setAppBadge?.(); } catch (_) {} }
      return self.registration.showNotification(title, options);
    })
  );
});

// Tocco sulla notifica: apre l'APP INSTALLATA (non una scheda del browser) e, per i
// messaggi, direttamente la chat giusta.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const tag = event.notification.tag || '';
  const chatId = tag.startsWith('chat-') ? tag.slice(5) : null;
  const url = chatId ? './index.html?chat=' + encodeURIComponent(chatId) : (event.notification.data?.url || './index.html');
  const target = new URL(url, self.registration.scope).href;
  const telefono = /android|iphone|ipad|ipod/i.test(self.navigator.userAgent);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const nostre = wins.filter((c) => c.url.startsWith(self.registration.scope));
      // 1) l'app installata e' gia' aperta: la porta in primo piano e apre la chat
      const app = nostre.find((c) => appInstallata.get(c.id) === true || new URL(c.url).searchParams.get('app') === '1');
      if (app) { if (chatId) app.postMessage({ type: 'apri-chat', chatId }); return app.focus(); }
      // 2) sul telefono: avvia l'app installata (il sistema la apre al posto del browser)
      if (telefono || !nostre.length) return self.clients.openWindow(target);
      // 3) sul computer: usa la scheda gia' aperta
      const w = nostre[0];
      if (chatId) w.postMessage({ type: 'apri-chat', chatId });
      return w.focus();
    })
  );
});
