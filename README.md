# Norsko-2026

Průvodce cestou obytným vozem po Norsku — itinerář, interaktivní mapa,
sdílené checklisty, kalkulačka nosnosti, výdaje a poznámky.

## 📴 Offline režim

Web funguje i bez internetu — v horách a fjordech se signálem počítat nejde.

### Jak to použít na telefonu

1. **Otevři web na telefonu, když jsi online** (ideálně na Wi-Fi). Při první
   návštěvě se do telefonu automaticky stáhne kompletní záloha všech stránek.
2. Doporučeně: **nainstaluj si web jako aplikaci** — v panelu offline režimu
   (plovoucí tlačítko 🛰️ vpravo dole) je tlačítko „Nainstalovat jako aplikaci";
   na iPhonu v Safari: Sdílet → *Přidat na plochu*.
3. Na stránce **mapy** stáhni tlačítkem „🗺️ Stáhnout mapu pro offline"
   mapové podklady celé trasy (~15 MB, přehled trasy + okolí všech zastávek).
4. **Bez signálu se nic přepínat nemusí** — web sám naskočí ze stažené zálohy.
   Při slabém/vypadávajícím signálu se hodí zapnout **ruční offline režim**
   (přepínač v panelu 🛰️): všechno se pak čte okamžitě ze zálohy a nečeká se
   na síť.

### Co funguje offline

- všechny stránky včetně fotek posádky a vozu,
- mapa se staženými podklady trasy a popisky zastávek,
- sdílené checklisty, balení, výdaje, kalkulačka a poznámky — zobrazí se
  poslední stažená data a **změny (odškrtnutí, nové položky…) se uloží
  lokálně a samy se odešlou ostatním, jakmile je zase signál** (offline
  persistence Firestore),
- vzdálenosti úseků na mapě z poslední online návštěvy.

### Jak se záloha obnovuje

- automaticky **zhruba 1× denně**, když web otevřeš online (stáhne se čerstvá
  kopie všech stránek),
- ručně kdykoli tlačítkem „🔄 Stáhnout zálohu teď" v panelu 🛰️,
- na Androidu s nainstalovanou aplikací se záloha obnovuje i na pozadí
  (periodic background sync); na iPhonu stačí aplikaci jednou za čas otevřít
  s připojením.

### Technicky

- `sw.js` — service worker: předstažení všech stránek a lokálních souborů,
  cache CDN závislostí (Leaflet, Firebase SDK, fonty), mapových dlaždic OSM
  (šetrně, s limity), fotek a API odpovědí (Wikipedia, OSRM). Stránky jedou
  network-first s krátkým timeoutem, v ručním offline režimu cache-first.
- `offline.js` — plovoucí widget 🛰️, ruční přepínač offline režimu, denní
  synchronizace, stahování mapy, instalace na plochu.
- `manifest.webmanifest` + ikony — instalace jako aplikace (PWA).
- Stránky se sdílenými daty používají Firestore `persistentLocalCache`,
  takže data i zápisy fungují offline a synchronizují se po připojení.
