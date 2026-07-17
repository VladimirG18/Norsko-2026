/* Offline režim webu Norsko 2026 — ovládání na straně stránky.
 *
 * - registruje service worker (sw.js), který drží v zařízení zálohu webu
 * - plovoucí tlačítko se stavem připojení + panel s ovládáním
 * - ruční přepínač „Offline režim": vše se čte rovnou ze stažené zálohy
 *   (hodí se i při slabém/vypadávajícím signálu), Firestore se přepne
 *   na lokální data
 * - záloha se obnovuje automaticky ~1× denně, ručně tlačítkem kdykoli
 * - na stránce s mapou umí stáhnout mapové podklady trasy pro offline
 *
 * Skript je vložený v <head> s defer, takže NorskoOffline existuje dřív,
 * než se spustí module skripty stránek (ty se na něj odkazují).
 */
(function () {
  'use strict';

  var KLIC_REZIM = 'norsko2026-offline-rezim';
  var rucni = false;
  try { rucni = localStorage.getItem(KLIC_REZIM) === '1'; } catch (e) {}

  var firestoreRegistr = [];   // {db, enableNetwork, disableNetwork} z jednotlivých stránek
  var instalacniUdalost = null; // odložený beforeinstallprompt
  var stavSW = null;            // poslední známý stav ze service workeru

  /* ---------- veřejné API pro stránky ---------- */
  window.NorskoOffline = {
    // Stránky se sdílenými daty ohlásí svou Firestore instanci,
    // ať ji přepínač offline režimu umí odpojit/připojit.
    registerFirestore: function (z) {
      firestoreRegistr.push(z);
      if (rucni && z.disableNetwork) z.disableNetwork(z.db).catch(function () {});
    },
    // Volá se z onSnapshot — když data přišla z lokální zálohy a jsme offline,
    // stavový řádek stránky to poctivě řekne (a po připojení se zase vrátí).
    onData: function (zeZalohy, statusEl) {
      if (!statusEl) return;
      var offline = rucni || !navigator.onLine;
      if (zeZalohy && offline) {
        if (!statusEl.dataset.puvodniText) {
          statusEl.dataset.puvodniText = statusEl.innerHTML;
          statusEl.dataset.puvodniTrida = statusEl.className;
        }
        statusEl.innerHTML = rucni
          ? '📴 Offline režim — zobrazuji staženou zálohu. Změny se odešlou po připojení.'
          : '📴 Bez připojení — zobrazuji staženou zálohu. Změny se odešlou po připojení.';
        statusEl.className = 'statusbar warn';
      } else if (!zeZalohy && statusEl.dataset.puvodniText) {
        statusEl.innerHTML = statusEl.dataset.puvodniText;
        statusEl.className = statusEl.dataset.puvodniTrida || statusEl.className;
        delete statusEl.dataset.puvodniText;
        delete statusEl.dataset.puvodniTrida;
      }
    },
    jeOfflineRezim: function () { return rucni; }
  };

  /* ---------- vzhled widgetu ---------- */
  var css = ''
    // z-index nad mapou (Leaflet jde do 1000); translateZ vynutí vlastní
    // kompozitní vrstvu — jinak mobilní Safari fixní prvek vedle 3D-transformované
    // mapy „probliká a schová" (známý iOS bug s position:fixed).
    + '#nrsk-off{position:fixed;right:14px;bottom:14px;z-index:1200;'
    + 'font-family:"Manrope",-apple-system,"Segoe UI",Roboto,sans-serif;'
    + 'transform:translateZ(0);-webkit-transform:translateZ(0);'
    + 'backface-visibility:hidden;-webkit-backface-visibility:hidden}'
    + '#nrsk-off.vlevo{right:auto;left:14px}'
    + '@supports(padding:env(safe-area-inset-bottom)){#nrsk-off{bottom:calc(14px + env(safe-area-inset-bottom))}}'
    + '#nrsk-pill{display:flex;align-items:center;gap:7px;border:1px solid #dfe9f2;background:#fff;color:#0c3a5f;'
    + 'border-radius:999px;padding:9px 13px;font-size:.86rem;font-weight:700;cursor:pointer;'
    + 'box-shadow:0 4px 14px rgba(12,58,95,.22);transition:background .2s,color .2s}'
    + '#nrsk-pill:hover{box-shadow:0 6px 18px rgba(12,58,95,.3)}'
    + '#nrsk-pill.offline{background:#c0392b;border-color:#c0392b;color:#fff}'
    + '#nrsk-pill.rucni{background:#0c3a5f;border-color:#0c3a5f;color:#fff}'
    + '#nrsk-panel{position:absolute;bottom:52px;right:0;width:min(330px,calc(100vw - 28px));background:#fff;'
    + 'border:1px solid #dfe9f2;border-radius:16px;box-shadow:0 18px 40px rgba(12,58,95,.28);padding:16px;display:none}'
    + '#nrsk-off.vlevo #nrsk-panel{right:auto;left:0}'
    + '#nrsk-off.otevreno #nrsk-panel{display:block}'
    + '#nrsk-panel h3{margin:0 0 10px;font-size:1rem;color:#0c3a5f}'
    + '.nrsk-radek{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:9px 0;font-size:.85rem;color:#182634}'
    + '.nrsk-pozn{font-size:.76rem;color:#5d6e7d;margin:8px 0 0;line-height:1.45}'
    + '.nrsk-btn{display:block;width:100%;margin:8px 0 0;padding:9px 12px;border:none;border-radius:10px;'
    + 'background:#1a6ea8;color:#fff;font:inherit;font-size:.85rem;font-weight:700;cursor:pointer}'
    + '.nrsk-btn:disabled{opacity:.55;cursor:default}'
    + '.nrsk-btn.vedlejsi{background:#eef4f9;color:#0c3a5f}'
    + '.nrsk-prepinac{position:relative;flex:none;width:44px;height:24px;border-radius:999px;background:#cfd9e2;'
    + 'border:none;cursor:pointer;transition:background .2s}'
    + '.nrsk-prepinac::after{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;'
    + 'background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}'
    + '.nrsk-prepinac.zap{background:#2fbf8f}'
    + '.nrsk-prepinac.zap::after{left:23px}'
    + '#nrsk-prubeh{height:6px;border-radius:3px;background:#eef4f9;overflow:hidden;margin-top:8px;display:none}'
    + '#nrsk-prubeh i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2fbf8f,#1a6ea8);transition:width .3s}'
    + '#nrsk-toast{position:fixed;left:50%;bottom:74px;transform:translateX(-50%);background:#0c3a5f;color:#fff;'
    + 'padding:10px 18px;border-radius:999px;font-size:.84rem;font-weight:600;box-shadow:0 8px 24px rgba(12,58,95,.4);'
    + 'z-index:1201;opacity:0;pointer-events:none;transition:opacity .3s;font-family:"Manrope",sans-serif;max-width:88vw;text-align:center}'
    + '#nrsk-toast.viditelny{opacity:1}';

  function pridejStyl() {
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ---------- pomocníci ---------- */
  function toast(text, ms) {
    var t = document.getElementById('nrsk-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'nrsk-toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('viditelny');
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('viditelny'); }, ms || 3500);
  }

  function posliSW(zprava) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(zprava);
    }
  }

  function zjistiStavSW() {
    return new Promise(function (res) {
      if (!navigator.serviceWorker || !navigator.serviceWorker.controller) { res(null); return; }
      var mc = new MessageChannel();
      var hotovo = false;
      mc.port1.onmessage = function (e) { hotovo = true; res(e.data); };
      try { navigator.serviceWorker.controller.postMessage({ typ: 'stav' }, [mc.port2]); }
      catch (e) { res(null); return; }
      setTimeout(function () { if (!hotovo) res(null); }, 2500);
    });
  }

  function formatujCas(ts) {
    if (!ts) return 'zatím neproběhla';
    var d = new Date(ts), dnes = new Date();
    var cas = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === dnes.toDateString()) return 'dnes ' + cas;
    var vcera = new Date(dnes.getTime() - 864e5);
    if (d.toDateString() === vcera.toDateString()) return 'včera ' + cas;
    return d.toLocaleDateString('cs-CZ') + ' ' + cas;
  }

  /* ---------- ruční offline režim ---------- */
  function nastavRezim(zapnout) {
    rucni = zapnout;
    try { localStorage.setItem(KLIC_REZIM, zapnout ? '1' : '0'); } catch (e) {}
    posliSW({ typ: 'offline-rezim', zapnuto: zapnout });
    firestoreRegistr.forEach(function (z) {
      var fn = zapnout ? z.disableNetwork : z.enableNetwork;
      if (fn) fn(z.db).catch(function () {});
    });
    obnovWidget();
    toast(zapnout
      ? '📴 Offline režim zapnut — vše se čte ze stažené zálohy.'
      : '🟢 Offline režim vypnut — data se zase berou ze sítě.');
  }

  /* ---------- záloha (plná synchronizace) ---------- */
  var zalohaBezi = false;
  function zalohujTed(tise) {
    if (zalohaBezi || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    zalohaBezi = true;
    if (!tise) nastavPrubeh(0.03);
    posliSW({ typ: 'zaloha-ted' });
    var btn = document.getElementById('nrsk-zalohuj');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Stahuji zálohu…'; }
    // pojistka: kdyby se odpověď SW ztratila, ať tlačítko nezůstane mrtvé
    setTimeout(function () {
      if (!zalohaBezi) return;
      zalohaBezi = false;
      nastavPrubeh(null);
      var b = document.getElementById('nrsk-zalohuj');
      if (b) { b.disabled = false; b.textContent = '🔄 Stáhnout zálohu teď'; }
    }, 180000);
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }
  }

  function nastavPrubeh(pomer) {
    var p = document.getElementById('nrsk-prubeh');
    if (!p) return;
    p.style.display = pomer == null ? 'none' : 'block';
    if (pomer != null) p.firstChild.style.width = Math.round(pomer * 100) + '%';
  }

  /* ---------- stahování mapových dlaždic (jen mapa.html) ---------- */
  function dlazdiceBodu(lat, lon, z) {
    var n = Math.pow(2, z);
    var la = lat * Math.PI / 180;
    return {
      x: Math.floor((lon + 180) / 360 * n),
      y: Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n)
    };
  }

  // Sada dlaždic pro offline mapu: přehled celé trasy (z4–7), koridor podél
  // trasy (z8) a okolí všech zastávek (z9–12). Drženo v rozumné velikosti,
  // ať jsme ohleduplní ke serverům OpenStreetMap (~10–15 MB).
  function spocitejDlazdice() {
    var data = window.NORSKO_MAP_DATA;
    if (!data) return [];
    var sada = {};
    function pridej(z, x, y, r) {
      var n = Math.pow(2, z);
      for (var dx = -r; dx <= r; dx++) {
        for (var dy = -r; dy <= r; dy++) {
          var X = ((x + dx) % n + n) % n, Y = y + dy;
          if (Y >= 0 && Y < n) sada[z + '/' + X + '/' + Y] = true;
        }
      }
    }
    var body = [];
    (data.segments || []).forEach(function (s) { (s.coords || []).forEach(function (c) { body.push(c); }); });
    (data.stops || []).forEach(function (s) { body.push(s.c); });

    // 1) hrubý přehled: všechny dlaždice obálky trasy
    [4, 5, 6, 7].forEach(function (z) {
      var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      body.forEach(function (c) {
        var t = dlazdiceBodu(c[0], c[1], z);
        minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x);
        minY = Math.min(minY, t.y); maxY = Math.max(maxY, t.y);
      });
      for (var x = minX; x <= maxX; x++) for (var y = minY; y <= maxY; y++) pridej(z, x, y, 0);
    });

    // 2) koridor podél jízdních úseků
    (data.segments || []).forEach(function (s) {
      var c = s.coords || [];
      for (var i = 0; i + 1 < c.length; i++) {
        var a = c[i], b = c[i + 1];
        var kroku = Math.max(1, Math.ceil(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) / 0.35));
        for (var k = 0; k <= kroku; k++) {
          var lat = a[0] + (b[0] - a[0]) * k / kroku, lon = a[1] + (b[1] - a[1]) * k / kroku;
          var t = dlazdiceBodu(lat, lon, 8);
          pridej(8, t.x, t.y, 1);
        }
      }
    });

    // 3) detail kolem zastávek
    (data.stops || []).forEach(function (s) {
      [9, 10, 11, 12].forEach(function (z) {
        var t = dlazdiceBodu(s.c[0], s.c[1], z);
        pridej(z, t.x, t.y, 1);
      });
    });

    return Object.keys(sada).map(function (k) {
      var c = k.split('/');
      return { z: +c[0], x: +c[1], y: +c[2] };
    });
  }

  function stahniMapu() {
    var dlazdice = spocitejDlazdice();
    if (!dlazdice.length || !navigator.serviceWorker.controller) return;
    var btn = document.getElementById('nrsk-mapa');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Stahuji mapu…'; }
    nastavPrubeh(0.02);
    posliSW({ typ: 'stahni-dlazdice', dlazdice: dlazdice });
  }

  /* ---------- widget ---------- */
  function vytvorWidget() {
    var kont = document.createElement('div');
    kont.id = 'nrsk-off';
    // na mapě je vpravo dole atribuce Leafletu — uhneme doleva
    if (document.getElementById('map')) kont.className = 'vlevo';
    kont.innerHTML =
      '<div id="nrsk-panel" role="dialog" aria-label="Offline režim">'
      + '<h3>🛰️ Offline režim</h3>'
      + '<div class="nrsk-radek"><span>Používat staženou zálohu<br><small style="color:#5d6e7d">i když je signál (offline režim)</small></span>'
      + '<button class="nrsk-prepinac" id="nrsk-prepinac" role="switch" aria-checked="false" aria-label="Offline režim"></button></div>'
      + '<div class="nrsk-radek"><span>Připojení</span><b id="nrsk-stav-site"></b></div>'
      + '<div class="nrsk-radek"><span>Poslední záloha</span><b id="nrsk-cas-zalohy">–</b></div>'
      + '<button class="nrsk-btn" id="nrsk-zalohuj">🔄 Stáhnout zálohu teď</button>'
      + '<button class="nrsk-btn vedlejsi" id="nrsk-mapa" style="display:none">🗺️ Stáhnout mapu pro offline</button>'
      + '<button class="nrsk-btn vedlejsi" id="nrsk-instaluj" style="display:none">📲 Nainstalovat jako aplikaci</button>'
      + '<div id="nrsk-prubeh"><i></i></div>'
      + '<p class="nrsk-pozn" id="nrsk-pozn">Záloha se obnovuje automaticky zhruba 1× denně, když jsi online. '
      + 'Bez signálu web naskočí ze zálohy sám i bez přepínače.</p>'
      + (/iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone
          ? '<p class="nrsk-pozn">📲 Na iPhonu: <b>Sdílet → Přidat na plochu</b> — web pak bude fungovat jako aplikace.</p>'
          : '')
      + '</div>'
      + '<button id="nrsk-pill" aria-haspopup="dialog" title="Offline režim"></button>';
    document.body.appendChild(kont);

    document.getElementById('nrsk-pill').addEventListener('click', function () {
      kont.classList.toggle('otevreno');
      if (kont.classList.contains('otevreno')) obnovPanel();
    });
    document.addEventListener('click', function (e) {
      if (!kont.contains(e.target)) kont.classList.remove('otevreno');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') kont.classList.remove('otevreno');
    });
    document.getElementById('nrsk-prepinac').addEventListener('click', function () {
      nastavRezim(!rucni);
    });
    document.getElementById('nrsk-zalohuj').addEventListener('click', function () { zalohujTed(false); });
    document.getElementById('nrsk-instaluj').addEventListener('click', function () {
      if (!instalacniUdalost) return;
      instalacniUdalost.prompt();
      instalacniUdalost = null;
      obnovWidget();
    });
    var mapBtn = document.getElementById('nrsk-mapa');
    if (window.NORSKO_MAP_DATA) {
      mapBtn.style.display = 'block';
      mapBtn.addEventListener('click', stahniMapu);
    }
    obnovWidget();
  }

  function obnovWidget() {
    var pill = document.getElementById('nrsk-pill');
    if (!pill) return;
    pill.classList.remove('offline', 'rucni');
    if (rucni) {
      pill.classList.add('rucni');
      pill.innerHTML = '📴 <span>Offline režim</span>';
      pill.title = 'Offline režim je zapnutý — vše jede ze stažené zálohy';
    } else if (!navigator.onLine) {
      pill.classList.add('offline');
      pill.innerHTML = '📡 <span>Offline — jedu ze zálohy</span>';
      pill.title = 'Bez připojení — web běží ze stažené zálohy';
    } else {
      pill.innerHTML = '🛰️';
      pill.title = 'Online · offline záloha připravena — klepni pro podrobnosti';
    }
    var prep = document.getElementById('nrsk-prepinac');
    if (prep) {
      prep.classList.toggle('zap', rucni);
      prep.setAttribute('aria-checked', rucni ? 'true' : 'false');
    }
    var sit = document.getElementById('nrsk-stav-site');
    if (sit) sit.textContent = navigator.onLine ? '🟢 online' : '📴 bez signálu';
    var inst = document.getElementById('nrsk-instaluj');
    if (inst) inst.style.display = instalacniUdalost ? 'block' : 'none';
  }

  function obnovPanel() {
    zjistiStavSW().then(function (s) {
      stavSW = s;
      var cas = document.getElementById('nrsk-cas-zalohy');
      if (cas) cas.textContent = s ? formatujCas(s.posledniZaloha) : 'zatím neproběhla';
      var mapBtn = document.getElementById('nrsk-mapa');
      if (mapBtn && s && !mapBtn.disabled) {
        mapBtn.textContent = s.pocetDlazdic > 100
          ? '🗺️ Aktualizovat offline mapu (' + s.pocetDlazdic + ' dílků)'
          : '🗺️ Stáhnout mapu pro offline (~15 MB)';
      }
      var pozn = document.getElementById('nrsk-pozn');
      if (pozn && navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (odhad) {
          if (odhad && odhad.usage) {
            var mb = Math.round(odhad.usage / 1048576);
            pozn.textContent = 'Záloha se obnovuje automaticky zhruba 1× denně, když jsi online. '
              + 'Bez signálu web naskočí ze zálohy sám. Záloha v zařízení: ~' + mb + ' MB.';
          }
        }).catch(function () {});
      }
    });
  }

  /* ---------- zprávy ze service workeru ---------- */
  function napojZpravySW() {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.typ === 'zaloha-prubeh') {
        nastavPrubeh(d.hotovo / d.celkem);
      } else if (d.typ === 'zaloha-hotovo') {
        zalohaBezi = false;
        nastavPrubeh(null);
        var btn = document.getElementById('nrsk-zalohuj');
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Stáhnout zálohu teď'; }
        toast(d.chyb
          ? '⚠️ Záloha stažena s výhradami (' + d.chyb + ' souborů se nepovedlo).'
          : '✅ Záloha je čerstvá — web teď funguje i bez internetu.');
        obnovPanel();
      } else if (d.typ === 'dlazdice-prubeh') {
        nastavPrubeh(d.hotovo / d.celkem);
      } else if (d.typ === 'dlazdice-hotovo') {
        nastavPrubeh(null);
        var mbtn = document.getElementById('nrsk-mapa');
        if (mbtn) { mbtn.disabled = false; mbtn.textContent = '🗺️ Aktualizovat offline mapu'; }
        toast(d.chyb > d.ok
          ? '⚠️ Mapu se nepodařilo stáhnout celou — zkus to znovu na lepším připojení.'
          : '✅ Mapa trasy je stažená pro offline (' + (d.ok + d.preskoceno) + ' dílků).');
        obnovPanel();
      }
    });
  }

  /* ---------- automatická denní záloha ---------- */
  function zkontrolujCerstvostZalohy() {
    if (!navigator.onLine || rucni) return;
    zjistiStavSW().then(function (s) {
      if (!s) return;
      var stara = !s.posledniZaloha || (Date.now() - s.posledniZaloha) > 20 * 3600e3;
      var nedavnoZkouseno = s.posledniPokusOZalohu && (Date.now() - s.posledniPokusOZalohu) < 30 * 60e3;
      if (stara && !nedavnoZkouseno) {
        setTimeout(function () { zalohujTed(true); }, 4000);
      }
    });
  }

  // Denní záloha na pozadí i bez otevření webu (jen Chrome/Android
  // s nainstalovanou aplikací; jinde se tiše přeskočí).
  function zkusPeriodickouSynchronizaci(reg) {
    if (!('periodicSync' in reg)) return;
    try {
      navigator.permissions.query({ name: 'periodic-background-sync' }).then(function (p) {
        if (p.state === 'granted') {
          reg.periodicSync.register('norsko-denni-zaloha', { minInterval: 20 * 3600e3 }).catch(function () {});
        }
      }).catch(function () {});
    } catch (e) {}
  }

  /* ---------- start ---------- */
  function start() {
    pridejStyl();
    vytvorWidget();

    window.addEventListener('online', function () { obnovWidget(); zkontrolujCerstvostZalohy(); });
    window.addEventListener('offline', obnovWidget);
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      instalacniUdalost = e;
      obnovWidget();
    });
    window.addEventListener('appinstalled', function () {
      instalacniUdalost = null;
      obnovWidget();
      toast('📲 Aplikace je nainstalovaná — najdeš ji na ploše.');
    });

    if (!('serviceWorker' in navigator)) return;
    napojZpravySW();

    navigator.serviceWorker.register('sw.js').then(function (reg) {
      zkusPeriodickouSynchronizaci(reg);
    }).catch(function (e) {
      console.warn('Service worker se nepodařilo zaregistrovat:', e);
    });

    if (navigator.serviceWorker.controller) {
      posliSW({ typ: 'offline-rezim', zapnuto: rucni });
      zkontrolujCerstvostZalohy();
    } else {
      // první návštěva: počkat, až se SW ujme stránky, pak rovnou doplnit
      // zálohu (CDN závislosti se stahují až po aktivaci)
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        posliSW({ typ: 'offline-rezim', zapnuto: rucni });
        toast('✅ Web je připraven pro offline použití.');
        obnovPanel();
        zkontrolujCerstvostZalohy();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
