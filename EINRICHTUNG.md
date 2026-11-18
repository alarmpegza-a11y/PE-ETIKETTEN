# Einrichtung Dropbox + Firebase (einmalig)

Reihenfolge einhalten. Jeder Schritt ist für sich sicher, das Tool läuft dazwischen weiter.

## 1. Neue index.html online stellen (ändert noch nichts)

Solange in `index.html` `const WORKER_URL=''` leer ist und die alten Firestore-Regeln gelten, verhält sich das Tool **genau wie bisher**: kein Login, Dateien in Firestore bzw. Firebase Storage, Foto-Code wie gehabt.
Neu ist nur intern vorbereitet: Dropbox, Büro-Login, Monteur-PIN, Barcode-Verzeichnis, Übertragung alter Dateien.

## 2. Firebase: Büro-Konten (vor Schritt 4)

Ab Schritt 4 brauchen Büro **und Produktions-PC** eine Anmeldung.

1. Firebase-Konsole → Projekt `etikette-fa8d1` → **Authentication → Anmeldemethode** → **E-Mail/Passwort** aktivieren. "Anonym" bleibt an (für die Monteure).
2. **Authentication → Nutzer → Nutzer hinzufügen**: pro Person (und für den Produktions-PC) E-Mail und Passwort. Die **Nutzer-UID** kopieren.
3. **Firestore → Daten** → Sammlung `rollen`, Dokument-ID = **die UID**, Feld `rolle` (string) = `buero`. Für jedes Konto wiederholen.

## 3. Dropbox-App prüfen

Auf https://www.dropbox.com/developers/apps die App öffnen:
- Typ **Scoped access**, Zugriff **App folder** (die App sieht nur ihren eigenen Ordner `Apps/<App-Name>`).
- Reiter **Permissions**: `files.metadata.read`, `files.content.read`, `files.content.write` angehakt → **Submit**.
- Reiter **Settings**: App key und App secret bereithalten (nicht in den Chat kopieren).

## 4. Cloudflare Worker (die sichere Brücke zu Dropbox)

In PowerShell:

```powershell
cd C:\Users\User\Desktop\Apps\etiketten\worker
```
```powershell
npm install
```
```powershell
npx wrangler login
```
```powershell
powershell -ExecutionPolicy Bypass -File .\einrichten.ps1
```
Das Skript fragt App key, App secret, den Dropbox-Code, die Firebase-Service-Konto-Datei und den **Monteur-PIN** (ersetzt den bisherigen Foto-Code) ab und legt alles direkt bei Cloudflare ab.

Optional, aber empfohlen (PIN-Sperre über alle Server):
```powershell
npx wrangler kv namespace create PE_KV
```
Die ausgegebene `id` in `wrangler.toml` beim Block `[[kv_namespaces]]` eintragen und die `#` davor entfernen.

```powershell
npx wrangler deploy
```
Kontrolle im Browser: `https://pe-etiketten-api.<konto>.workers.dev/api/health` zeigt `"dropbox":true,"firebase":true,"pin":true`.

Dann die Adresse in `index.html` bei `const WORKER_URL=''` eintragen und online stellen. Ab jetzt:
- Neue Pläne und Fotos gehen nach Dropbox (Ordner `plaene/…` und `fotos/…` im App-Ordner).
- Büro und Produktion melden sich an. Monteure geben einmal pro Handy den PIN ein (bei Foto oder «Als montiert melden»).

**Testen:** Im Büro einen Plan auf M, D oder P ziehen, dann auf dem iPhone den QR-Code scannen: PDF öffnen, senden, herunterladen, montiert melden, Foto aufnehmen.

Danach: **Einstellungen → Dateien nach Dropbox übertragen**. Überträgt alle alten Pläne und Fotos, liest jede Datei zur Kontrolle zurück und löscht erst dann die alte. Kann beliebig oft gestartet werden.

## 5. Firestore-Regeln scharf schalten (zuletzt)

Firebase-Konsole → **Firestore → Regeln** → Inhalt von `firestore.rules` einfügen → **Veröffentlichen**.
Ab dann:
- Externe (Kunden, Planer …) sehen per QR-Code nur ihr Element und dessen Pläne, ändern nichts.
- Monteure (nach PIN) dürfen nur Status, Montagemeldung und Fotos ändern.
- Nur Büro/Produktion sehen alles und dürfen anlegen, ändern, löschen.
- Handys laden nur noch das gescannte Element statt der ganzen Datenbank (schnell auf 4G).

## Sicherheit

- App secret, Refresh-Token, Service-Konto-JSON und PIN **nie** in Git, Chat oder `index.html`.
- Die Service-Konto-JSON nach Schritt 4 löschen.
- Gelöschte Dateien lassen sich in Dropbox unter "Gelöschte Dateien" wiederherstellen.
