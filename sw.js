/* Service worker pro offline režim webu Norsko 2026.
 *
 * Princip: při instalaci se stáhnou všechny stránky a lokální soubory do
 * cache (záloha v zařízení), CDN závislosti (Leaflet, Firebase SDK, fonty)
 * se přidávají best-effort a doplňují se při běžném prohlížení. Stránky se
 * servírují network-first s krátkým timeoutem — online jsou vždy čerstvé,
 * bez signálu naskočí záloha. Ručně zapnutý offline režim obrací pořadí:
 * všechno jede rovnou ze zálohy, síť se nezkouší.
 */
'use strict';

const VERZE = 'norsko-2026-v1';
const CACHE_STATICKA = `${VERZE}-staticka`;     // stránky + lokální soubory + CDN
const CACHE_DATA     = `${VERZE}-data`;         // Wikipedia souhrny, OSRM trasy
const CACHE_OBRAZKY  = `${VERZE}-obrazky`;      // fotky z CORS zdrojů (Unsplash, Wikimedia)
const CACHE_OBRAZKY_EXT = `${VERZE}-obrazky-ext`; // fotky z ostatních webů (opaque)
const CACHE_DLAZDICE = `${VERZE}-dlazdice`;     // mapové dlaždice OSM

const MAX_DATA = 300;          // max záznamů v datové cache
const MAX_OBRAZKY = 400;       // max fotek (CORS)
const MAX_OBRAZKY_EXT = 40;    // opaque odpovědi mají v quotě velkou režii — držet nízko
const MAX_DLAZDICE = 3000;     // ~35 MB map. dlaždic

// Všechny stránky a lokální soubory — tvoří offline zálohu. Instalace selže,
// pokud něco chybí (ochrana proti neúplné záloze po rozbitém nasazení).
const LOKALNI = [
  './',
  './index.html',
  './mapa.html',
  './pruvodce.html',
  './co_zaridit.html',
  './balime.html',
  './checklist.html',
  './vuz.html',
  './dotazy_vuz.html',
  './kalkulacka.html',
  './vydaje.html',
  './posadka.html',
  './poznamky.html',
  './offline.js',
  './manifest.webmanifest',
  './favicon.ico',
  './favicon.svg',
  './apple-touch-icon.png',
  './ikona-192.png',
  './ikona-512.png',
  './ikona-maskable-512.png',
  './foto/adam.jpg',
  './foto/jaroslava.jpg',
  './foto/jiri.jpg',
  './foto/lucie.jpg',
  './foto/monty.jpg',
  './foto/vladimir.jpg',
  './foto/posadka-kolaz.jpg',
  './foto/vuz/alkovna.jpg',
  './foto/vuz/kuchyn-zasuvka.jpg',
  './foto/vuz/luzko-detail.jpg',
  './foto/vuz/sprcha.jpg',
  './foto/vuz/zadni-luzka.jpg',
];

// Externí závislosti nutné pro plnou funkčnost offline (mapa, sdílené seznamy).
const CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js',
  'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap',
];

// Zdroje fotek, které posílají CORS hlavičky — lze je cachovat „průhledně"
// (bez quota režie opaque odpovědí).
const CORS_OBRAZKY = [
  'images.unsplash.com',
  'upload.wikimedia.org',
  'commons.wikimedia.org',
];

/* ---------- drobné IndexedDB úložiště pro stav SW ---------- */
function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('norsko-sw', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('meta');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function metaGet(klic) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const t = db.transaction('meta', 'readonly').objectStore('meta').get(klic);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
  } catch (e) { return undefined; }
}
async function metaSet(klic, hodnota) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const t = db.transaction('meta', 'readwrite').objectStore('meta').put(hodnota, klic);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    });
  } catch (e) { /* stav si příště načteme znovu */ }
}

/* Ručně zapnutý offline režim — drží se v paměti i v IDB (SW se restartuje). */
let rucniOffline = null;
async function jeRucniOffline() {
  if (rucniOffline === null) rucniOffline = !!(await metaGet('rucniOffline'));
  return rucniOffline;
}

/* ---------- pomocné funkce ---------- */
function fetchSTimeoutem(pozadavek, ms) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), ms);
  return fetch(pozadavek, { signal: ac.signal }).finally(() => clearTimeout(tm));
}

// Stažení do cache: zkusí CORS (levné v quotě), pak no-cors (opaque).
// Timeout brání tomu, aby viselé spojení (slabý signál) zablokovalo synchronizaci.
async function stahniDoCache(cache, url, obnovit, timeout) {
  timeout = timeout || 15000;
  const vlastnosti = obnovit ? { cache: 'reload' } : {};
  try {
    const r = await fetchSTimeoutem(new Request(url, { mode: 'cors', ...vlastnosti }), timeout);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await cache.put(url, r);
    return true;
  } catch (e) {
    try {
      const r = await fetchSTimeoutem(new Request(url, { mode: 'no-cors', ...vlastnosti }), timeout);
      if (r.type !== 'opaque' && !r.ok) throw new Error('HTTP ' + r.status);
      await cache.put(url, r);
      return true;
    } catch (e2) { return false; }
  }
}

// Ořez cache na max. počet záznamů (maže od nejstarších vložení).
async function orizniCache(nazev, max) {
  try {
    const cache = await caches.open(nazev);
    const klice = await cache.keys();
    for (let i = 0; i < klice.length - max; i++) await cache.delete(klice[i]);
  } catch (e) { /* ořez není kritický */ }
}

function bezParametru(url) {
  const u = new URL(url);
  u.search = ''; u.hash = '';
  return u.href;
}

/* ---------- instalace a aktivace ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_STATICKA);
    // Jen lokální soubory, přísně — bez nich záloha nedává smysl. CDN závislosti
    // se doplní hned po aktivaci první plnou synchronizací (viz offline.js),
    // aby pomalé či nedostupné CDN nezdrželo zprovoznění offline režimu.
    await cache.addAll(LOKALNI);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // úklid starých verzí cache
    for (const n of await caches.keys()) {
      if (n.startsWith('norsko-2026-') && !n.startsWith(VERZE)) await caches.delete(n);
    }
    await self.clients.claim();
  })());
});

/* ---------- strategie ---------- */

// Stránky: network-first s timeoutem, záložně cache. V ručním offline režimu
// rovnou cache. Úspěšná odpověď vždy obnoví zálohu stránky.
async function obslouzStranku(req) {
  const cache = await caches.open(CACHE_STATICKA);
  if (await jeRucniOffline()) {
    const c = await cache.match(req, { ignoreSearch: true });
    if (c) return c;
  }
  try {
    const net = await fetchSTimeoutem(req, 4500);
    if (net && net.ok) {
      cache.put(bezParametru(req.url), net.clone());
      return net;
    }
    throw new Error('HTTP ' + (net && net.status));
  } catch (err) {
    const c = await cache.match(req, { ignoreSearch: true });
    if (c) return c;
    const uvod = await cache.match('./index.html');
    if (uvod) return uvod;
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><title>Offline</title>' +
      '<body style="font-family:sans-serif;padding:2em;text-align:center">' +
      '<h1>📴 Jsi offline</h1><p>Tahle stránka ještě není ve stažené záloze. ' +
      'Připoj se k internetu a otevři ji znovu.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

// Cache-first: neměnné soubory (verzované CDN, fonty woff2, lokální fotky).
async function cacheFirst(req, nazevCache) {
  const cache = await caches.open(nazevCache);
  const c = await cache.match(req, { ignoreSearch: false });
  if (c) return c;
  const net = await fetch(req);
  if (net.ok || net.type === 'opaque') cache.put(req.url, net.clone());
  return net;
}

// Stale-while-revalidate: rychlé z cache, na pozadí obnovit (font CSS,
// lokální skripty). V ručním offline režimu se na síť nesahá vůbec.
async function staleWhileRevalidate(req, nazevCache) {
  const cache = await caches.open(nazevCache);
  const c = await cache.match(req);
  if (c && await jeRucniOffline()) return c;
  const obnova = fetch(req).then((net) => {
    if (net.ok) cache.put(req.url, net.clone());
    return net;
  }).catch(() => null);
  return c || obnova.then((net) => net || Response.error());
}

// Network-first pro API data (Wikipedia, OSRM) — offline se vrátí poslední
// známá odpověď, v ručním offline režimu se síť vůbec nezkouší.
async function dataNetworkFirst(req, timeout) {
  const cache = await caches.open(CACHE_DATA);
  if (await jeRucniOffline()) {
    const c = await cache.match(req);
    if (c) return c;
  }
  try {
    const net = await fetchSTimeoutem(req, timeout);
    if (net && net.ok) {
      cache.put(req.url, net.clone());
      if (Math.random() < 0.05) orizniCache(CACHE_DATA, MAX_DATA);
      return net;
    }
    throw new Error('HTTP ' + (net && net.status));
  } catch (err) {
    const c = await cache.match(req);
    if (c) return c;
    throw err;
  }
}

// Mapové dlaždice: klíč se normalizuje (a/b/c subdomény → jeden záznam),
// stahuje se v CORS režimu kvůli úspoře quoty.
async function obslouzDlazdici(req) {
  const u = new URL(req.url);
  u.hostname = 'tile.openstreetmap.org';
  const klic = u.href;
  const cache = await caches.open(CACHE_DLAZDICE);
  const c = await cache.match(klic);
  if (c) return c;
  const net = await fetch(new Request(klic, { mode: 'cors' })).catch(() => fetch(req));
  if (net && (net.ok || net.type === 'opaque')) {
    cache.put(klic, net.clone());
    if (Math.random() < 0.02) orizniCache(CACHE_DLAZDICE, MAX_DLAZDICE);
  }
  return net;
}

// Externí fotky: cache-first; známé CORS zdroje průhledně, ostatní opaque
// v malé oddělené cache.
async function obslouzObrazek(req, url) {
  const cors = CORS_OBRAZKY.includes(url.hostname);
  const nazev = cors ? CACHE_OBRAZKY : CACHE_OBRAZKY_EXT;
  const cache = await caches.open(nazev);
  const c = await cache.match(req.url);
  if (c) return c;
  let net;
  if (cors) {
    net = await fetch(new Request(req.url, { mode: 'cors' })).catch(() => fetch(req));
  } else {
    net = await fetch(req);
  }
  if (net && (net.ok || net.type === 'opaque')) {
    cache.put(req.url, net.clone());
    if (Math.random() < 0.05) {
      orizniCache(CACHE_OBRAZKY, MAX_OBRAZKY);
      orizniCache(CACHE_OBRAZKY_EXT, MAX_OBRAZKY_EXT);
    }
  }
  return net;
}

/* ---------- směrování požadavků ---------- */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  // Firestore a ostatní Google API nechat plně na SDK (má vlastní offline frontu).
  if (url.hostname.endsWith('.googleapis.com') && url.hostname !== 'fonts.googleapis.com') return;

  if (req.mode === 'navigate') { e.respondWith(obslouzStranku(req)); return; }

  if (url.origin === self.location.origin) {
    // fotky stačí z cache (šetří data), skripty se na pozadí obnovují
    if (req.destination === 'image') e.respondWith(cacheFirst(req, CACHE_STATICKA));
    else e.respondWith(staleWhileRevalidate(req, CACHE_STATICKA));
    return;
  }
  if (url.hostname === 'unpkg.com' || url.hostname === 'www.gstatic.com'
      || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, CACHE_STATICKA)); return;
  }
  if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(staleWhileRevalidate(req, CACHE_STATICKA)); return;
  }
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(obslouzDlazdici(req)); return;
  }
  if (url.hostname.endsWith('wikipedia.org')) {
    e.respondWith(dataNetworkFirst(req, 4000)); return;
  }
  if (url.hostname === 'router.project-osrm.org') {
    e.respondWith(dataNetworkFirst(req, 7000)); return;
  }
  if (req.destination === 'image') {
    e.respondWith(obslouzObrazek(req, url)); return;
  }
  // vše ostatní jde normálně na síť
});

/* ---------- plná synchronizace (denní záloha) ---------- */
// Běží nejvýš jedna; další požadavek se k běžící připojí a dostane její výsledek.
let synchronizacePromise = null;
function plnaSynchronizace(oznam) {
  if (synchronizacePromise) return synchronizacePromise;
  synchronizacePromise = (async () => {
    try {
      await metaSet('posledniPokusOZalohu', Date.now());
      const cache = await caches.open(CACHE_STATICKA);
      const vse = [...LOKALNI, ...CDN];
      const jeCdn = new Set(CDN);
      const fronta = vse.slice();
      let ok = 0, chybLokalni = 0, chybCdn = 0, zpracovano = 0;
      async function pracovnik() {
        while (fronta.length) {
          const url = fronta.shift();
          if (await stahniDoCache(cache, url, true)) ok++;
          else if (jeCdn.has(url)) chybCdn++;
          else chybLokalni++;
          zpracovano++;
          if (oznam && (zpracovano % 4 === 0 || zpracovano === vse.length)) {
            oznam({ typ: 'zaloha-prubeh', hotovo: zpracovano, celkem: vse.length });
          }
        }
      }
      await Promise.all([pracovnik(), pracovnik(), pracovnik(), pracovnik()]);
      // Zálohu tvoří stránky webu — CDN selhání ji neshazuje (závislosti se
      // docachují při běžném online prohlížení).
      if (chybLokalni === 0) await metaSet('posledniZaloha', Date.now());
      return { ok, chyb: chybLokalni + chybCdn, chybLokalni, chybCdn, celkem: vse.length, kdy: Date.now() };
    } finally {
      synchronizacePromise = null;
    }
  })();
  return synchronizacePromise;
}

/* ---------- stahování mapových dlaždic pro offline ---------- */
async function stahniDlazdice(seznam, oznam) {
  const cache = await caches.open(CACHE_DLAZDICE);
  seznam = (seznam || []).slice(0, 1500);   // pojistka rozsahu (ohleduplnost k OSM)
  let ok = 0, chyb = 0, preskoceno = 0, zpracovano = 0;
  const SOUBEZNE = 2;                        // max 2 souběžná stahování dle zásad OSM
  const fronta = seznam.slice();
  async function pracovnik() {
    while (fronta.length) {
      const d = fronta.shift();
      const url = `https://tile.openstreetmap.org/${d.z}/${d.x}/${d.y}.png`;
      if (await cache.match(url)) { preskoceno++; }
      else {
        const uspech = await stahniDoCache(cache, url, false);
        if (uspech) ok++; else chyb++;
        await new Promise((r) => setTimeout(r, 120));  // šetrné tempo
      }
      zpracovano++;
      if (oznam && (zpracovano % 20 === 0 || !fronta.length)) {
        oznam({ typ: 'dlazdice-prubeh', hotovo: zpracovano, celkem: seznam.length });
      }
    }
  }
  await Promise.all(Array.from({ length: SOUBEZNE }, pracovnik));
  await orizniCache(CACHE_DLAZDICE, MAX_DLAZDICE);
  if (ok > 0 || preskoceno > 0) await metaSet('mapaStazena', Date.now());
  return { ok, chyb, preskoceno, celkem: seznam.length };
}

/* ---------- zprávy ze stránek ---------- */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  const odpovez = (zprava) => { if (e.ports && e.ports[0]) e.ports[0].postMessage(zprava); };
  const oznamKlientovi = (zprava) => { if (e.source) e.source.postMessage(zprava); };

  if (d.typ === 'offline-rezim') {
    rucniOffline = !!d.zapnuto;
    e.waitUntil(metaSet('rucniOffline', rucniOffline));
  } else if (d.typ === 'zaloha-ted') {
    e.waitUntil(plnaSynchronizace(oznamKlientovi).then((v) => {
      oznamKlientovi({ typ: 'zaloha-hotovo', ...v });
    }));
  } else if (d.typ === 'stahni-dlazdice') {
    e.waitUntil(stahniDlazdice(d.dlazdice, oznamKlientovi).then((v) => {
      oznamKlientovi({ typ: 'dlazdice-hotovo', ...v });
    }));
  } else if (d.typ === 'stav') {
    e.waitUntil((async () => {
      const dlazdice = await caches.open(CACHE_DLAZDICE).then((c) => c.keys()).catch(() => []);
      odpovez({
        typ: 'stav',
        verze: VERZE,
        posledniZaloha: await metaGet('posledniZaloha') || 0,
        posledniPokusOZalohu: await metaGet('posledniPokusOZalohu') || 0,
        mapaStazena: await metaGet('mapaStazena') || 0,
        rucniOffline: await jeRucniOffline(),
        pocetDlazdic: dlazdice.length,
      });
    })());
  }
});

/* Denní záloha na pozadí (Chrome/Android s nainstalovanou aplikací). */
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'norsko-denni-zaloha') e.waitUntil(plnaSynchronizace(null));
});
