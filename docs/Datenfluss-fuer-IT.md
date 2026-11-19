# PE Element-Etiketten – Datenübersicht und Datenfluss

Stand: 19.11.2026 · Verantwortlich: Abteilungsleiter PE Fabrikation AG, Lachen · Antwort auf die Sicherheitsprüfung der IT

## 1. Zweck

Jedes ausgelieferte Element (rund 18'000 pro Jahr) erhält eine Etikette mit QR-Code. Monteure und Bauleitung rufen damit auf der Baustelle die Montage- und Detailpläne ab, melden «montiert» und legen Montagefotos ab. Das Büro sieht den Stand live und druckt die Etiketten.

## 2. Beteiligte Dienste

| Dienst | Konto / Ort | Zweck | Welche Daten |
|---|---|---|---|
| **GitHub Pages** | `alarmpegza-a11y.github.io/PE-ETIKETTEN` | Ausliefern der Webseite (eine HTML-Datei) | Nur Programmcode, **keine Daten, keine Schlüssel** |
| **Firebase Firestore** | Projekt `etikette-fa8d1`, Speicherort **eur3 (Europa)**, Spark-Tarif | Datenbank | Aufträge/Objekte (Name, Kunde, Adresse, Auftragsnr., Lieferdatum), Elemente (Position, Bezeichnung, Betriebsauftrag, Status, «montiert am/von», Liste der Fotos), Planverzeichnis (Dateiname, Grösse, Verweis), Einstellungen, Rollen, Etiketten-Schlüssel |
| **Firebase Authentication** | Projekt `etikette-fa8d1` | Anmeldung Büro/Produktion | E-Mail-Adressen der Büro-Konten. **Anonyme Anmeldung deaktiviert** |
| **Dropbox** | Firmenkonto, eigene App «PE-Etiketten-Lachen» mit Zugriffstyp **App-Ordner** | Ablage der Dateien | PDF-Pläne (`Apps/PE-Etiketten-Lachen/plaene/…`), Montagefotos (`…/fotos/…`). Die App sieht **nur diesen Ordner**, nicht die übrige Dropbox |
| **Cloudflare Worker** | `pe-etiketten-api.alarm-pe-gza.workers.dev`, Gratis-Tarif | Sichere Brücke Browser ↔ Dropbox/Firestore | Hält alle Schlüssel als Secrets, speichert selbst **keine Daten** (nur kurzfristiger Datei-Cache) |
| **Enventa ERP** (intern) | – | Quelle der Auftragsdaten | Export «Planung Betriebsaufträge» als Excel, im Büro ins Tool importiert |

**Daten, die das Firmennetz verlassen:** Auftrags-/Element-Stammdaten (Firestore, EU), Pläne und Fotos (Dropbox, Firmenkonto), E-Mail-Adressen der Büro-Konten (Firebase Auth). Personenbezogen sind: Namen der Kunden/Bauherren (Firmen), Adressen der Baustellen, Name des Monteurs bei «montiert» (frei eingegeben), Montagefotos, E-Mail-Adressen der Büro-Konten.

## 3. Datenfluss

```
Enventa ──Excel-Export──► Büro-PC (Browser, angemeldet)
                              │  E-Mail/Passwort + Rolle «buero»
                              ├──────────► Firestore (EU)      Aufträge, Elemente, Status
                              └──Upload──► Cloudflare Worker ──► Dropbox (App-Ordner)   Pläne

Baustelle (Handy, OHNE Anmeldung)
   QR-Code: …/#k=<zufälliger Schlüssel, 22 Zeichen>
        └──► Cloudflare Worker ──Service-Konto──► Firestore: nur DIESES Element
                               └──────────────► Dropbox:   nur seine Pläne/Fotos
   «montiert» / Foto: nur mit Monteur-PIN (Sitzung vom Worker signiert)
```

## 4. Zugriffsschutz

| Wer | Wie | Darf |
|---|---|---|
| **Büro / Produktion** | Firebase-Konto (E-Mail/Passwort), Rolle `buero` von Hand in der Konsole gesetzt, **keine Selbstregistrierung** | Alles im Tool |
| **Monteur** | Kein Konto. Einmaliger **Monteur-PIN** pro Gerät, geprüft vom Worker (Secret, nicht im Code), danach signierte Sitzung (365 Tage, PIN-Wechsel macht alle ungültig), 5 Fehlversuche = 15 Min. Sperre | Für das gescannte Element: «montiert» melden, Fotos hochladen/entfernen |
| **Extern** (Kunde, Planer, Bauleitung) | Nur QR-Code | Für das gescannte Element: Angaben, Pläne und Fotos ansehen |
| **Alle anderen** | – | Nichts |

- **Firestore-Regeln** (`firestore.rules` im Repo): Lesen/Schreiben nur mit Rolle `buero` und nicht anonym. Rollen können nur über die Konsole gesetzt werden.
- **QR-Schlüssel:** zufällig (22 Zeichen, ca. 130 Bit), nicht aus Auftrags- oder Barcode-Nummern ableitbar. Der Worker liefert ausschliesslich das zugehörige Element, ohne interne Felder.
- **Aufbewahrung:** Aufträge sind **28 Tage** ab Eröffnung/Import online (einstellbar, «Behalten» verlängert). Danach sperrt der Worker den QR-Code sofort; das Büro löscht Auftrag, Elemente, Pläne, Fotos und die Dropbox-Dateien automatisch.
- **Schlüssel/Secrets** liegen nur als Cloudflare-Secrets: Dropbox-App-Key/-Secret/Refresh-Token, Firebase-Service-Konto, Monteur-PIN. Nicht im Code, nicht im Repo, nicht im Browser.
- **Firebase-Web-API-Key:** öffentlich (bei Firebase üblich), eingeschränkt auf die Websites `alarmpegza-a11y.github.io` und `etikette-fa8d1.firebaseapp.com` sowie die Firebase-Dienste.
- **Dropbox:** Zugriffstyp App-Ordner, Firmenkonto, Token nur serverseitig; Dateien werden nie überschrieben, gelöschte Dateien sind in Dropbox wiederherstellbar.
- **CORS:** Der Worker antwortet Browsern nur für die eigene Webseite.

## 5. Umsetzung der IT-Vorgaben

| # | Vorgabe | Stand |
|---|---|---|
| 1 | Daten sichern | ✅ Vollständige Sicherung 19.11.2026 (lokal, nicht im Repo) |
| 2 | Zugriff schliessen | ✅ Regeln: nur Büro-Konten |
| 3 | Repos privat | ⏸ Bewusst zurückgestellt (GitHub Pages im Gratis-Tarif braucht öffentliche Repos). Im Code stehen keine Geheimnisse. Option: GitHub Pro (USD 4/Mt.) |
| 3 | Anonyme Anmeldung aus | ✅ Deaktiviert (geprüft: «ADMIN_ONLY_OPERATION») |
| 4 | Echte Anmeldung, keine offene Registrierung | ✅ |
| 5 | Rollen serverseitig | ✅ Firestore-Regeln + Worker |
| 6 | Klartext-Codes aus dem Code | ✅ Foto-Code entfernt, PIN nur als Secret |
| 7 | API-Key einschränken | ✅ Websites + Firebase-Dienste |
| 8 | Dropbox einschränken | ✅ Firmenkonto, App-Ordner, Token nur serverseitig |

## 6. Für einen IT-Zugang

- Firebase-Projekt `etikette-fa8d1`: Konsole → Projekteinstellungen → Nutzer und Berechtigungen → IT als «Betrachter» hinzufügen.
- Cloudflare: Account → Mitglieder → IT einladen (Rolle «Workers Read»).
- Dropbox: App «PE-Etiketten-Lachen» in der Entwicklerkonsole, App-Ordner `Apps/PE-Etiketten-Lachen`.
- GitHub: Repo `alarmpegza-a11y/PE-ETIKETTEN` (öffentlich), IT als Mitwirkende einladen falls Schreibzugriff nötig.
