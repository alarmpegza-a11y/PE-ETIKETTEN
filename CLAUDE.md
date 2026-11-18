# PE Element-Etiketten (QR-Etiketten)

> Diese Datei ist die zentrale Projektbeschreibung für Claude Code (Desktop). Sie liegt im gleichen Ordner wie `index.html` und wird beim Start automatisch gelesen. Sie enthält den **Ist-Zustand**, alle **Entscheidungen** und den **Fahrplan** (Skalierung, Rollen, kurzer QR-Code, Dropbox-Anbindung über Cloudflare Worker, Enventa).
>
> Stand: 18.11.2026. Verantwortlich: Ajdin Slijepčević, Abteilungsleiter, PE Fabrikation AG, Lachen

---

## 0. Stand der Umsetzung (18.11.2026)

**Massgebend ist `index.html` im Repo `alarmpegza-a11y/PE-ETIKETTEN` (main = live).** Diese Version (Excel-Import Enventa, Unterordner, Aufbewahrung, Produktions-Scan, Layout, Galerie, Montage-Export) ist neuer als Teile der Kapitel unten; bei Widerspruch gilt der Code.

Umgesetzt (Branch `dropbox-live`), getestet; Einrichtung siehe `EINRICHTUNG.md`:

- **Dropbox als dritter Speicher** in der Datei-Schicht: `putFile`/`getFile`/`delFile` erkennen IDs `dbx:<pfad>` (Pfade `plaene/{objektId}/{id}.pdf`, `fotos/{elementId}/{id}.jpg`). Aktiv, sobald `WORKER_URL` gesetzt ist; alte Firestore-/Storage-Dateien bleiben lesbar.
- **Worker** (`worker/`): `POST|GET|DELETE /api/datei?pfad=…` (Pfad streng geprüft, nie überschreiben), `POST /api/monteur-pin`, `GET /api/me`, `GET /api/health`. Rollen aus `rollen/{uid}` per Service-Konto. 13 Tests: `cd worker && npm test`.
- **Rollen/Login:** Büro und Produktion mit E-Mail/Passwort (`renderLogin`), Monteur per PIN (ersetzt mit Worker den Foto-Code), sonst extern. Ohne Worker und unter alten Regeln verhält sich alles wie früher (`REGELN_ALT`).
- **Gezielter Scan:** Nicht-Büro lädt nur Element, Objekt und zwei Pläne (`starteScan`). `#b=` sucht `elemente/ba_<nr>`, sonst `barcodes/<nr>`; das Barcode-Verzeichnis pflegt das Büro automatisch (`barcodesPflegen`) für Elemente mit abweichender ID.
- **Migration automatisch:** `autoMigration` startet `migration(true)` im Büro, sobald alle Daten vom Server da sind; mit Rücklesen und Grössenprüfung, wiederaufsetzbar.
- `firestore.rules` im Repo (erst nach dem Worker veröffentlichen).

Tests im Browser: `node test/dev-server.mjs` (Firebase inkl. Regeln und Dropbox nachgebildet, echter Worker-Code). `/` = mit Worker, `/alt.html` = ohne; `ALT_REGELN=1` = alte Regeln. Testkonto `buero@test.ch` / `test1234`, Test-PIN `123456`. `test/workerd-check.mjs` prüft in workerd (braucht auf diesem PC das Visual C++ Redistributable).

Offen: Enventa-Druckformular mit QR (Kapitel 10), Warteschlange für Foto-Uploads ohne Netz.

---

## 1. Worum es geht

Jedes Element, das PE Fabrikation ausliefert (Vorwandelemente, Verrohrungen usw., rund **18'000 pro Jahr**), bekommt eine Etikette 10 × 10 cm mit:

- Logo
- Objekt, Kunde, Adresse und Lieferdatum
- Position, Bezeichnung und Gewerk (z. B. "NZ 41.03 Dusche Attika, Verrohrung Wasser")
- Barcode und **QR-Code**

**Ablauf heute:**

1. Das Büro lädt pro Objekt die Montage- und Detailpläne (PDF) ins Tool und weist sie den Elementen zu.
2. Der Monteur scannt auf der Baustelle den QR-Code und landet in der **Monteur-Maske**. Dort sieht er alle Angaben, **lädt die PDFs direkt herunter**, öffnet sie auf dem Handy, sendet sie weiter (WhatsApp, Mail, Dateien), meldet "montiert" und lädt Fotos hoch.
3. Das Büro sieht alles live.

**Status:** Die Demo kam bei der Geschäftsleitung sehr gut an. Jetzt soll das Tool **produktiv** werden, mit tausenden Elementen und QR-Codes sowie vielen Nutzern: Monteure, Kunden, Planer, Architekten und Bauleiter.

### Harte Anforderungen (nicht verhandelbar)

- **Der Monteur wird nie auf Dropbox oder eine fremde Seite geschickt.** Er bleibt in der Monteur-Maske, das PDF kommt direkt aufs Handy. Öffnen, Senden und Herunterladen funktionieren wie heute.
- **Dropbox ist nur der unsichtbare Speicher im Hintergrund.**
- **Es darf nichts passieren:** keine Zugangsschlüssel im Browser, keine Möglichkeit für Externe, Daten zu ändern oder zu löschen, keine verlorenen Pläne.
- **Muss bei tausenden Elementen und vielen gleichzeitigen Nutzern einwandfrei und schnell laufen**, auch mit 4G auf der Baustelle.

---

## 2. Grundregeln für die Entwicklung

- **Frontend = eine Datei** `index.html` (HTML, CSS und JS). Kein Build-Tool. Bibliotheken nur per CDN.
- **Hosting:** GitHub Pages, Account `alarmpegza-a11y`. Push auf `main` = live. Domain: `alarmpegza-a11y.github.io`
- **Backend (neu):** ein **Cloudflare Worker** im eigenen Unterordner `worker/`. Siehe Kapitel 9.
- **Sprache:** Oberfläche Deutsch (Schweiz). Immer `ss` statt `ß`, Zahlen mit Apostroph (`18'000`), Datum `TT.MM.JJJJ`.
- **Vor jeder Übergabe:** JS-Syntax prüfen (Befehl in Kapitel 12). Ursache von Fehlern beheben, keine Pflaster.
- **Handy zuerst:** Die Monteur-Maske läuft fast nur auf dem iPhone (Safari). Immer auf iOS testen.
- **Keine Inline-Handler:** Alle Klicks laufen über einen zentralen `document`-Listener mit `data-*`-Attributen.
- **Nichts kaputt machen:** Bestehende QR-Codes (langes Format `#e=...`) müssen weiter funktionieren, auch nach allen Umbauten.

### Ordnerstruktur (Ziel)

```
pe-etiketten/
├── index.html                    # Frontend (GitHub Pages)
├── CLAUDE.md                     # diese Datei
├── firestore.rules               # Firestore-Regeln (neu, versioniert)
├── worker/                       # Cloudflare Worker (neu)
│   ├── src/index.js
│   └── wrangler.toml
└── docs/
    └── Kostenvergleich_Digitale_Elementplaene.docx
```

---

## 3. Technik heute

| Teil | Version / Ort | Zweck |
|---|---|---|
| Firebase App, Firestore, Auth (ESM von `www.gstatic.com/firebasejs/`) | 10.12.2 | Datenbank, Live-Sync, Anmeldung |
| QRious (cdnjs) | 4.0.2 | QR-Code als PNG |
| JsBarcode (cdnjs) | 3.11.6 | Barcode CODE128 als SVG |
| Google Font Archivo | 400 bis 800 | Schrift der Oberfläche (die Etikette selbst nutzt Arial) |

- **Firebase-Projekt:** `etikette-fa8d1`. Die Konfiguration steht oben im Modul-Script (`firebaseConfig`). Der Web-API-Key ist öffentlich, das ist bei Firebase normal. Die Sicherheit kommt aus den Regeln.
- **Firestore mit Offline-Cache:** `persistentLocalCache` + `persistentMultipleTabManager`, Fallback `getFirestore`.
- **Auth heute:** nur **anonym** (`signInAnonymously`). In der Konsole sind "Anonym" sowie die Domain `alarmpegza-a11y.github.io` unter "Autorisierte Domains" aktiv.
- **Dateien heute:** PDFs und Fotos liegen **base64 in Firestore**, in Teilen zu 600 KB: `dateien/{id}` + `dateien/{id}/teile/{i}`. Das war nur für die Demo gedacht. **Es wird durch Dropbox ersetzt** (Kapitel 9).
- Das Haupt-Script ist `<script type="module">`. Ein klassisches Script dahinter zeigt nach 10 s eine Fehlermeldung, falls Firebase nicht lädt (`window.__peStart`).

### Aktuelle Firestore-Regeln (Übergang, NICHT produktionsreif)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{coll}/{id} {
      allow read, write: if request.auth != null
        && coll in ['objekte','plaene','elemente','settings','dateien'];
    }
    match /dateien/{id}/teile/{teil} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Problem: Jeder, der einen QR-Code scannt, ist anonym angemeldet und darf damit **alles ändern und löschen**. Die Lösung steht in Kapitel 7.

---

## 4. Datenmodell heute

Alle IDs werden clientseitig mit `uid()` erzeugt und sind zugleich die Dokument-ID.

| Collection | Felder |
|---|---|
| `objekte/{id}` | `name` (erste Etikettenzeile, z. B. "Feldblumenweg 15 17 Zürich"), `kunde`, `strasse`, `plzOrt`, `auftragNr`, `lieferdatum` (ISO), `created` |
| `plaene/{id}` | `objektId`, `art` (`montage` \| `detail`), `name` (Dateiname), `fileId` (→ `dateien`), `url` (optionaler Online-Link), `size`, `fertig` (false während Upload), `created` |
| `elemente/{id}` | `objektId`, `pos` ("NZ 41.03"), `bezeichnung`, `gewerk`, `geschoss`, `lieferdatum` (leer = wie Objekt), `barcode`, `montagePlanId`, `detailPlanId`, `status` (`geplant` \| `produziert` \| `geliefert` \| `montiert`), `montiert` ({`am`,`von`} \| null), `fotos` ([{`id`,`ts`,`von`}]), `created` |
| `settings/app` | `baseUrl` (Adresse für QR-Codes), `logo` (Data-URL, max. 600 KB), `seeded` |
| `dateien/{id}` | `name`, `type`, `size`, `chunks`, `created` (wird abgelöst) |
| `dateien/{id}/teile/{i}` | `d` (base64-Teil, wird abgelöst) |

**Lokal auf dem Gerät:**

- IndexedDB `pe-etiketten-cache`, Store `files`: geladene Dateien als Cache
- localStorage `pe-et-introZu`, `pe-et-monteur`

### QR-Code heute (langes Format, muss weiter funktionieren)

`{baseUrl}#e={base64url(JSON)}`, mit allen Etikettenangaben im Link. Kurzschlüssel:

| Schlüssel | Bedeutung | Schlüssel | Bedeutung |
|---|---|---|---|
| `i` | Element-ID | `n` | Position |
| `oi` | Objekt-ID | `b` | Bezeichnung |
| `o` | Objekt | `g` | Gewerk |
| `k` | Kunde | `e` | Geschoss |
| `s` | Strasse | `bc` | Barcode |
| `p` | PLZ / Ort | `mn` / `m` | Montageplan Name / URL |
| `a` | Auftrag | `dn` / `t` | Detailplan Name / URL |
| `d` | Lieferdatum | | |

Der Link ist rund 450 Zeichen lang. Das ist zu lang für eine robuste Produktion, die Lösung steht in Kapitel 8.

---

## 5. Aufbau von `index.html` (Reihenfolge im Modul-Script)

1. **Firebase-Initialisierung**, `ref(coll,id)`
2. **Helfer:** `$`, `$$`, `uid`, `h` (HTML-Escape), `fmt`, `fmtTs`, `kb`, `debounce`, `toast`, `clean`, `fire` (Promise ohne await, Fehler als Toast), `plain` (JSON-Rundlauf gegen `undefined`), `LS`
3. **Datei-Cache** `DB` (IndexedDB)
4. **Dateien in Firestore:** `putFile` → `{id, done}`, `getFile` (Cache, dann Firestore, mit Fortschritt-Event `datei-fortschritt`, Timeout über `mitTimeout`), `delFile`, `DATEI_FEHLER` (`fehlt` \| `unvollstaendig` \| `netz`), `offeneUploads` + `beforeunload`-Warnung
5. **Zustand** `S` und Speicherfunktionen `saveObj`, `savePlan`, `saveElem`, `patch`, `entferne`, `saveSettings`. Immer zuerst lokal ändern, dann ohne `await` schreiben, damit es offline sofort reagiert.
6. **Live-Sync:** `starteListener` (onSnapshot auf **alle** Collections, siehe Kapitel 6), `syncStatus`, `syncFehler`, `fehlerZurueck`, `pruefeSeed`, `pruefeStart`, `planRender`
7. **QR und Barcode:** `payloadFor`, `linkFor`, `qrData` (mit Cache), `barcodeSvg`
8. **Etikette:** `labelHTML(e)`, 100 × 100 mm, Druck über `@page { size: 100mm 100mm }`
9. **Verwaltung (Büro):** `renderAll` → `renderIntro`, `renderObjektListe`, `renderObjekt`, `renderVorschau` (Etikette 1:1, `fitSkala`), `planTag` (M und D, rot, wenn ein Plan fehlt)
10. **Dialoge:** `dialog()` (mit Guard `if(!d.open)` im close-Event), `objektForm`, `elementForm` (inkl. Direkt-Upload von Plänen)
11. **Pläne zuweisen:** `planHochladen`, `pdfPruefen` (max. 25 MB), `formPlaene`, `autoZuweisen` (Position im Dateinamen), `planZuweisenDialog` (Checkboxen pro Element)
12. **Aktionen** `ACT` (über `data-act`)
13. **Monteur-Maske:** `renderScan` (Fallback nur mit QR-Daten, falls das Element gelöscht wurde), `renderScanElement`, `planKarte`, `weiterePlaene` (getrennt nach Montage- und Detailplänen), `pkZeichnen`, `planLaden`, `planTeilen`, `PLAN_CACHE`. Ablauf: PDF laden (mit Fortschrittsbalken), danach drei Knöpfe:
    - **"PDF öffnen":** Blob-Link im neuen Tab, native iOS-Ansicht
    - **"Senden / Speichern":** `navigator.share` mit Datei
    - **"Herunterladen"**
14. **Fotos:** `komprimieren` (max. 1600 px, JPEG 0.8), `fotosHinzufuegen` (`arrayUnion`), `fotoLoeschen` (`arrayRemove`)
15. **Ereignisse und Routing:** `route()` unterscheidet Verwaltung und `#e=...` (Monteur-Maske über `body.modus-scan`)
16. **Demo-PDFs** (`buildPdf`, `demoPdf`) und **Beispieldaten** (`seed`)

### Bekannte Stolpersteine (gelöst, nicht wieder einbauen)

- **iOS Safari blockiert `window.open` nach einem `await`.** Deshalb: zuerst laden, dann normaler Link. `navigator.share` muss direkt im Klick passieren.
- **Eine eigene PDF-Ansicht mit pdf.js hing auf dem iPhone.** Sie wurde entfernt, der Monteur will das PDF direkt. **Nicht wieder einbauen.**
- **Anmeldung auf 4G:** Nicht mit kurzem Timeout starten. Listener erst nach der Anmeldung starten, bei verspäteter Anmeldung neu verbinden (`onAuthStateChanged`).
- **Uploads:** Wird der Tab vor Ende des Uploads geschlossen, fehlen Teile. Darum gibt es `fertig` und `beforeunload`. Mit dem Worker entfällt das Problem weitgehend.
- **Firestore lehnt `undefined` ab** → `plain()`. `arrayUnion` und `arrayRemove` werden direkt übergeben.
- **Snapshots rendern neu:** Den Fokus in `#monteurName` wiederherstellen, PDF-Zustände in `PLAN_CACHE` behalten.

---

## 6. Schwachstelle 1: Das Tool lädt die ganze Datenbank (MUSS behoben werden)

**Heute:** `starteListener` abonniert `objekte`, `plaene` und `elemente` komplett, auf **jedem** Gerät und bei **jedem** QR-Scan.

**Folgen bei 18'000 Elementen pro Jahr:**

- Jeder Scan lädt zehntausende Dokumente. Das ist langsam auf 4G und hat einen hohen Speicherbedarf auf dem Handy.
- Die Gratis-Grenze von Firestore (50'000 Lesezugriffe pro Tag) ist nach wenigen Scans erreicht. Danach entstehen Kosten oder Fehler.
- Externe könnten sämtliche Kundendaten abrufen.

**Lösung (Schritt 1 im Fahrplan):**

- **Monteur-Maske:**
  - Element per `getDoc` oder `onSnapshot` auf **ein** Dokument laden.
  - Das Objekt per `getDoc` laden.
  - Die Planliste des Objekts aus einer **denormalisierten Liste im Objekt-Dokument** lesen (`objekte/{id}.planListe`: [{`id`,`name`,`art`,`size`}]), damit kein `list` auf `plaene` nötig ist.
- **Büro:**
  - Die Objektliste laden, optional mit Feld `archiviert` und nur aktiven Objekten, sortiert nach `created`, mit Seitenweise-Laden.
  - Elemente und Pläne **nur für das gewählte Objekt** laden: `where('objektId','==',id)`.
- Beim Wechsel des Objekts die alten Listener abmelden.
- Die Beispieldaten (`seed`) im Produktivbetrieb abschalten (Schalter in `settings/app` oder entfernen).

---

## 7. Schwachstelle 2: Jeder darf alles (MUSS behoben werden), Rollen

| Rolle | Wer | Darf |
|---|---|---|
| **Büro** | interne Mitarbeitende | alles: Objekte, Elemente und Pläne anlegen, ändern, löschen; Etiketten drucken |
| **Monteur** | eigene Montagegruppen | Element lesen, Pläne herunterladen, **nur** `status`, `montiert` und `fotos` ändern |
| **Extern** | Kunden, Planer, Architekten, Bauleiter | nur lesen und Pläne herunterladen |

**Umsetzung:**

- **Büro:** Firebase Auth mit **E-Mail und Passwort** (in der Konsole aktivieren). Die Rolle steht in `rollen/{uid}` = `{rolle:'buero'}`. Sie wird nur von Hand in der Konsole gesetzt, nie vom Client.
- **Externe:** anonyme Anmeldung wie heute, nur Lesezugriff.
- **Monteur, offene Entscheidung:**
  - (a) Jeder mit QR-Code darf "montiert" melden und Fotos hochladen. Das ist einfach, aber auch Externe könnten es.
  - (b) **Empfohlen:** Ein einmaliger **Monteur-PIN** pro Gerät. Der Worker prüft den PIN und setzt die Rolle `monteur` in `rollen/{uid}`. Danach bleibt der Monteur auf dem Gerät angemeldet.
- **Kein öffentliches Auflisten:** `get` auf einzelne Dokumente ist erlaubt, `list` nur für das Büro.

### Ziel-Regeln (Entwurf für `firestore.rules`)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function angemeldet() { return request.auth != null; }
    function rolle() {
      return angemeldet() && exists(/databases/$(database)/documents/rollen/$(request.auth.uid))
        ? get(/databases/$(database)/documents/rollen/$(request.auth.uid)).data.rolle : 'extern';
    }
    function buero() { return rolle() == 'buero'; }
    function monteur() { return rolle() == 'monteur' || buero(); }

    match /objekte/{id} {
      allow get: if angemeldet();
      allow list, write: if buero();
    }
    match /plaene/{id} {
      allow get: if angemeldet();
      allow list, write: if buero();
    }
    match /elemente/{id} {
      allow get: if angemeldet();
      allow list, create, delete: if buero();
      allow update: if buero()
        || (monteur() && request.resource.data.diff(resource.data).affectedKeys()
              .hasOnly(['status','montiert','fotos']));
    }
    match /barcodes/{bc} {
      allow get: if angemeldet();
      allow list, write: if buero();
    }
    match /settings/{id} {
      allow get: if angemeldet();
      allow write: if buero();
    }
    match /rollen/{uid} {
      allow get: if angemeldet() && request.auth.uid == uid;
      allow write: if false;   // nur Konsole bzw. Worker (Admin)
    }
    // Übergang bis zur vollständigen Migration nach Dropbox:
    match /dateien/{d=**} {
      allow read: if angemeldet();
      allow write: if buero();
    }
  }
}
```

Die Regeln vor dem Ausrollen mit dem **Firestore Emulator** oder dem **Rules Playground** in der Konsole testen.

---

## 8. Kurzer QR-Code (Schritt 2)

- **Neues Format:** `{baseUrl}#b={barcode}`, z. B. `https://alarmpegza-a11y.github.io/<repo>/#b=2604120103`. Alternativ `#i={elementId}`.
- **Nachschlagen:** Collection `barcodes/{barcode}` = `{elementId}` mit öffentlichem `get`. Das Büro schreibt sie beim Anlegen oder Ändern eines Elements. Barcodes müssen **eindeutig** sein, das beim Speichern prüfen.
- **Vorteile:** ein viel kleinerer QR-Code (bessere Scanbarkeit mit Staub und schlechtem Licht), keine Kundendaten im Link, und es passt zu Enventa (Kapitel 10).
- **Rückwärtskompatibel:** `#e=...` (lang) muss weiter funktionieren. Wenn möglich per `i` laden, sonst den bestehenden Fallback mit QR-Daten nutzen.
- Fehlerkorrektur kann bei kurzem Link auf `M` erhöht werden.

---

## 9. Dropbox als Speicher über Cloudflare Worker (Schritt 3)

### Warum ein Worker nötig ist

Für Dropbox braucht es einen Zugangsschlüssel. **Im Browser oder auf GitHub darf er nie stehen**, sonst kann jeder die Dropbox lesen und löschen. Der Worker hält den Schlüssel geheim und liefert die PDFs aus. **Für den Monteur ändert sich nichts:** Er lädt das PDF in der Monteur-Maske, die Datei kommt vom Worker mit richtigem Dateinamen. Dropbox sieht er nie.

### Architektur

```
Büro (index.html) ──Upload + Firebase-ID-Token──► Worker ──► Dropbox (App-Ordner)
                                                   │
Monteur (index.html) ──GET /api/plan/{planId}────► Worker ──► Cloudflare-Cache ──► Dropbox
                                                   │
                                   prüft Plan in Firestore (REST, get)
```

### Endpunkte des Workers

| Methode und Pfad | Wer | Funktion |
|---|---|---|
| `POST /api/plan` | Büro | Body = PDF, Header `X-Objekt-Id`, `X-Art`, `X-Name`. Prüft PDF und Grösse (max. 50 MB) und lädt hoch nach `/objekte/{objektId}/{art}/{uid}_{name}`. Antwort: `{dropboxPath, size}`. Danach schreibt der Client den Plan in Firestore (`speicher:'dropbox'`, `dropboxPath`, `fertig:true`). |
| `GET /api/plan/{planId}` | alle angemeldeten | Liest `plaene/{planId}` über die Firestore REST API, holt die Datei aus Dropbox (`files/download`) und liefert sie aus mit `Content-Type: application/pdf` und `Content-Disposition: inline; filename*=UTF-8''…`. Antworten werden im **Cloudflare-Cache** zwischengespeichert (Schlüssel: planId + Version). Es werden nur Pfade ausgeliefert, die in Firestore registriert sind, nie freie Pfade. |
| `DELETE /api/plan/{planId}` | Büro | löscht die Datei in Dropbox (`files/delete_v2`) |
| `POST /api/foto/{elementId}` | Monteur | JPEG, max. 5 MB, nach `/objekte/{objektId}/fotos/{elementId}/{uid}.jpg`. Antwort: `{fotoId, dropboxPath}`. Danach schreibt der Client per `arrayUnion` in `fotos`. |
| `GET /api/foto/{elementId}/{fotoId}` | alle angemeldeten | prüft, ob das Foto im Element steht, und liefert es aus (mit Cache) |
| `POST /api/monteur-pin` | anonym | prüft den PIN (Secret) und setzt `rollen/{uid}` auf `monteur` (Firestore REST mit Service-Konto) |

**Für alle Endpunkte gilt:**

- **CORS** nur für `https://alarmpegza-a11y.github.io`.
- **Auth:** Header `Authorization: Bearer <Firebase-ID-Token>`. Der Worker prüft den JWT (RS256) gegen die öffentlichen Google-Schlüssel (`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`), dazu `aud = etikette-fa8d1` und `iss = https://securetoken.google.com/etikette-fa8d1`. Die Rolle kommt aus `rollen/{uid}`.
- **Begrenzung:** Rate-Limit pro uid (z. B. Cloudflare Rate Limiting oder KV-Zähler).
- **Dropbox-Zugang:** Refresh-Token als Secret. Das kurzlebige Access-Token (4 h) wird im Worker-Speicher oder KV zwischengespeichert und bei Ablauf erneuert (`POST https://api.dropboxapi.com/oauth2/token`, `grant_type=refresh_token`).
- **Dropbox-API:**
  - Upload: `https://content.dropboxapi.com/2/files/upload` (bis 150 MB pro Aufruf, für grössere Dateien Upload-Sessions)
  - Download: `https://content.dropboxapi.com/2/files/download`
  - Löschen: `https://api.dropboxapi.com/2/files/delete_v2`

### Anpassungen in `index.html`

- `WORKER_URL` als Konstante oben im Script.
- **Plan hochladen:** `fetch(WORKER_URL+'/api/plan', {method:'POST', headers:{Authorization:'Bearer '+await user.getIdToken(), …}, body:file})` mit Fortschritt über `XMLHttpRequest.upload.onprogress` oder in Teilen.
- **Plan laden (Monteur):** `fetch(WORKER_URL+'/api/plan/'+planId, {headers:{Authorization:…}})` → Blob. Dann wie heute in `PLAN_CACHE`, mit "PDF öffnen", "Senden / Speichern" und "Herunterladen". **Die Oberfläche bleibt gleich.**
- **Fotos** ebenso über den Worker. Die Vorschaubilder holt das Tool vom Worker.
- Den lokalen IndexedDB-Cache für bereits geladene PDFs behalten. Das ist schneller und funktioniert auch offline.
- `plaene` bekommt ein neues Feld `speicher` (`firestore` \| `dropbox`). Beim Lesen werden beide Varianten unterstützt, bis die Migration fertig ist.

### Migration der bestehenden Dateien

- Im Büro gibt es einen einmaligen Knopf "Dateien nach Dropbox übertragen" (nur für die Rolle Büro).
- Für jeden Plan mit `fileId`: `getFile`, dann `POST /api/plan`, dann den Plan auf `speicher:'dropbox'` setzen.
- **Erst nach erfolgreicher Prüfung** (Grösse stimmt, Download klappt) die alten `dateien`-Teile löschen.
- Fotos genauso. Fortschritt anzeigen, nach Abbruch wieder aufsetzbar, nichts doppelt.

### Einrichtung Dropbox (macht Ajdin, einmalig)

1. Firmen-Dropbox verwenden (idealerweise **Dropbox Business**, nicht privat). Die Freigabe der Geschäftsleitung für Kundenpläne einholen.
2. https://www.dropbox.com/developers/apps → **Create app** → "Scoped access" → **"App folder"** → Name z. B. `PE-Etiketten`.
3. Im Reiter **Permissions** die Berechtigungen `files.metadata.read`, `files.content.read` und `files.content.write` aktivieren, dann **Submit**.
4. Im Reiter **Settings** den **App key** und das **App secret** notieren.
5. Einen **Refresh-Token** erzeugen:
   - Im Browser öffnen: `https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&response_type=code&token_access_type=offline`
   - Erlauben und den angezeigten **Code** kopieren.
   - Dann ausführen:
     ```bash
     curl https://api.dropbox.com/oauth2/token \
       -d code=CODE -d grant_type=authorization_code \
       -u APP_KEY:APP_SECRET
     ```
   - Aus der Antwort den `refresh_token` sicher aufbewahren. **Nie in Git, nie in den Chat, nie in `index.html`.**

### Einrichtung Cloudflare Worker (macht Ajdin, einmalig, mit Claude Code)

1. Cloudflare-Konto (kann das bestehende sein).
2. `npm install -g wrangler`, dann `wrangler login`.
3. Im Ordner `worker/` das Projekt anlegen, `wrangler.toml` mit `name = "pe-etiketten-api"`.
4. Die Secrets setzen. Werte nur im Terminal eingeben:
   ```bash
   wrangler secret put DROPBOX_APP_KEY
   wrangler secret put DROPBOX_APP_SECRET
   wrangler secret put DROPBOX_REFRESH_TOKEN
   wrangler secret put MONTEUR_PIN
   wrangler secret put FIREBASE_SERVICE_ACCOUNT   # JSON, nur für rollen/ setzen
   ```
5. Variablen in `wrangler.toml`: `FIREBASE_PROJECT_ID = "etikette-fa8d1"`, `ALLOWED_ORIGIN = "https://alarmpegza-a11y.github.io"`.
6. Optional ein KV-Namespace für Token-Cache und Rate-Limit.
7. `wrangler deploy`. Die Worker-URL notieren (`https://pe-etiketten-api.<konto>.workers.dev`) und in `index.html` als `WORKER_URL` eintragen.

**Kosten:** Der Cloudflare Workers Free-Tarif umfasst 100'000 Anfragen pro Tag, ohne Kosten für Datenverkehr. Für den Start reicht das. Dropbox läuft über das bestehende Firmen-Abo.

---

## 10. Enventa ERP (Etiketten kommen heute aus Enventa)

Die heutigen Element-Etiketten werden aus **Enventa ERP** gedruckt. Die genauen Menüs sind firmenspezifisch und noch zu klären.

**Noch herauszufinden (vor Ort mit der Person, die heute druckt, Fotos vom Druckdialog machen):**

1. Aus welchem Beleg wird gedruckt (Auftrag, Fertigungsauftrag oder Lieferschein), und wie heisst das Druckformular?
2. **Was steckt im Barcode?** Ist die Nummer pro Element eindeutig? Wenn ja, ist sie ideal als QR-Schlüssel (`#b=`).
3. Kann das Formular angepasst werden (eigene IT oder Enventa-Partner), und was kostet es?
4. Gibt es einen **Export** der Auftragspositionen (Excel oder CSV) mit Objekt, Kunde, Adresse, Lieferdatum, Position, Bezeichnung, Gewerk und Barcode?

**Drei Wege, je nach Antwort:**

- **A (Bevorzugt): QR-Code ins Enventa-Formular.** Inhalt: `{baseUrl}#b={Barcode-Nummer}`. Der Druck läuft weiter wie bisher. Das Tool findet das Element über `barcodes/{bc}`. Die Elemente müssen dafür im Tool existieren, also per Import (B) oder von Hand.
- **B: Export aus Enventa → Import ins Tool.** Neue Funktion "Excel/CSV importieren" pro Objekt mit Feldzuordnung und Duplikatprüfung über den Barcode. Danach druckt das Tool die Etiketten im heutigen Layout plus QR-Code.
- **C (Übergang): Zweite kleine QR-Etikette** neben der Enventa-Etikette.

---

## 11. Fahrplan

| # | Schritt | Abhängigkeit | Ergebnis |
|---|---|---|---|
| 1 | **Gezielt laden** (Kapitel 6) + **Rollen und Regeln** (Kapitel 7), Büro-Login per E-Mail, `firestore.rules` im Repo | keine | schnell bei tausenden Elementen, Externe können nichts ändern |
| 2 | **Kurzer QR-Code** `#b=` / `#i=` + `barcodes/`, alter Link bleibt gültig | Schritt 1 | kleinere, robuste QR-Codes |
| 3 | **Cloudflare Worker + Dropbox** (Kapitel 9), Upload, Download, Fotos, Monteur-PIN | Dropbox-App + Cloudflare-Konto | Dateien in Dropbox, Schlüssel sicher, Monteur merkt nichts |
| 4 | **Migration** der bestehenden Dateien nach Dropbox, danach `dateien` aufräumen | Schritt 3 | Firestore wieder schlank |
| 5 | **Enventa-Anbindung** (Kapitel 10): Import oder QR im Formular | Antworten aus Kapitel 10 | kein doppeltes Erfassen |
| 6 | **Pilot:** ein Objekt, eine Montagegruppe, mehrere Handys gleichzeitig, 4 bis 6 Wochen | 1 bis 4 | Freigabe zum Ausrollen |
| 7 | **Ausrollen** + kurze Anleitung für Monteure (1 Seite mit Bildern) | Pilot ok | produktiv |

**Abnahmekriterien vor dem Ausrollen:**

- Scan bis Anzeige der Element-Daten in **unter 2 s** auf 4G.
- Ein PDF mit 5 MB ist auf 4G in **unter 10 s** geladen und lässt sich öffnen, senden und herunterladen.
- Ein externer Nutzer kann **nichts** ändern oder löschen (mit den Regeln getestet).
- Kein Zugangsschlüssel im Browser-Quelltext.
- 20 gleichzeitige Nutzer auf demselben Plan: keine Fehler.
- Alte QR-Codes (`#e=`) funktionieren weiterhin.

### Weitere Ideen (später)

- A4-Etikettenbogen zusätzlich zum 10 × 10 cm Etikettendrucker
- Planversionen: neue Version ersetzt die alte, der Monteur sieht "Plan geändert am …"
- Montageprotokoll mit Fotos als PDF (Abnahme, Rechnung)
- Anbindung an die anderen PE-Apps (PE-Montage, PE-Kalender, Bauleiter-Übersicht): Montagestatus pro Objekt
- Dashboard: geliefert und montiert pro Objekt in Prozent

---

## 12. Testen

**Syntaxprüfung des Frontends:**

```bash
python3 -c "import re;s=open('index.html').read();open('/tmp/m.mjs','w').write(re.findall(r'<script type=\"module\">(.*?)</script>',s,re.S)[0])" && node --check /tmp/m.mjs
```

**Browsertests ohne echte Firebase-Verbindung (bewährt):**

- Playwright, CDN-Adressen abfangen: QRious und JsBarcode lokal aus `node_modules` ausliefern.
- Die drei Firebase-Module durch einen Mock ersetzen (Firestore im localStorage, Sync zwischen Tabs über das `storage`-Event, `arrayUnion` und `arrayRemove` nachgebildet, `onAuthStateChanged` simuliert).
- Beim Ausliefern von `index.html` die Zeile `/* ---------- Start ---------- */` durch `window.__pe={S,getFile,DB};` ersetzen, um im Test auf den Zustand zuzugreifen.
- Szenarien:
  - zwei Tabs mit Live-Sync
  - Upload und Download
  - "montiert" melden
  - Fotos hochladen und löschen
  - Plan zuweisen
  - Fehlerfall "Kein Zugriff"
  - Handy-Viewport 390 × 844

**Worker:**

- `wrangler dev` lokal starten.
- Mit `curl` alle Endpunkte prüfen, auch die Fälle *ohne* Token und *mit falscher Rolle*. Beide müssen abgewiesen werden.

**Regeln:** Firestore Emulator (`firebase emulators:start --only firestore`) mit Testfällen für Büro, Monteur, Extern und nicht angemeldet.

---

## 13. Begleitdokument

`docs/Kostenvergleich_Digitale_Elementplaene.docx`: Wirtschaftlichkeit für die Geschäftsleitung.

- **Grundlage:** 18'000 Elemente pro Jahr, Druck A2
- **Mittleres Szenario:** 2 Blätter pro Element, 10 % Nachdrucke, CHF 0.43 Material pro Blatt, 1 Minute pro Element, CHF 70 pro Stunde

| | Kosten heute | Kosten digital | Einsparung pro Jahr |
|---|---|---|---|
| Mittleres Szenario | CHF 38'028 | CHF 9'803 | **≈ CHF 28'000** |
| Spannweite | | | CHF 12'000 bis 71'000 |

- **Zusätzlich, nicht eingerechnet:** Suchzeit auf der Baustelle (rund CHF 21'000 bei 1 Minute pro Element), weniger Fehlmontagen, rund 790 kg Papier pro Jahr weniger.
- Die Annahmen mit echten Plotterrechnungen und Zeiten überprüfen.
