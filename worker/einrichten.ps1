# PE Etiketten: Cloudflare Worker einrichten (einmalig)
# Alle Schluessel gehen direkt zu Cloudflare. Sie werden nicht angezeigt und nirgends gespeichert.
# Start im Ordner worker:  powershell -ExecutionPolicy Bypass -File .\einrichten.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Lies-Geheim($text) {
  $s = Read-Host $text -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
# wrangler ueber cmd starten, damit Meldungen auf stderr das Skript nicht abbrechen
function Wrangler([string]$argumente) { (cmd /c "npx wrangler $argumente 2>&1" | Out-String) }
function Setze-Secret($name, $wert) {
  if (-not $wert) { throw "$name ist leer" }
  $aus = ($wert | cmd /c "npx wrangler secret put $name 2>&1" | Out-String)
  if ($aus -notmatch 'Success') { Write-Host $aus; throw "Setzen von $name fehlgeschlagen" }
  Write-Host "$name gesetzt." -ForegroundColor Green
}

Write-Host "`n1/5 Cloudflare" -ForegroundColor Cyan
$wer = Wrangler 'whoami'
$versuch = 0
while ($wer -match 'not authenticated|ERROR') {
  $versuch++
  if ($versuch -gt 5) { throw 'Cloudflare-Anmeldung nicht moeglich.' }
  Write-Host 'Im Browser beim Token auf das Kopier-Symbol klicken, dann hier: Rechtsklick (fuegt ein) und Enter.'
  $t = (Lies-Geheim 'Cloudflare API-Token einfuegen').Trim()
  Write-Host "Erhalten: $($t.Length) Zeichen (richtig sind etwa 40 bis 60)."
  if ($t.Length -lt 30) { Write-Host 'Zu kurz: In der Zwischenablage war etwas anderes. Bitte nochmals kopieren und einfuegen.' -ForegroundColor Yellow; continue }
  $env:CLOUDFLARE_API_TOKEN = $t
  $wer = Wrangler 'whoami'
  if ($wer -match 'not authenticated|ERROR') { Write-Host 'Cloudflare lehnt diesen Token ab. Bitte nochmals kopieren und einfuegen.' -ForegroundColor Yellow }
}
Write-Host 'Cloudflare verbunden.' -ForegroundColor Green

Write-Host "`n2/5 Worker hochladen" -ForegroundColor Cyan
$aus = Wrangler 'deploy'
Write-Host $aus
$url = ([regex]::Match($aus, 'https://[a-z0-9.-]+\.workers\.dev')).Value
if (-not $url) { throw 'Hochladen des Workers fehlgeschlagen (siehe Meldung oben).' }

Write-Host "`n3/5 Dropbox" -ForegroundColor Cyan
Write-Host 'Der Browser oeffnet deine Dropbox-Apps: App anklicken, Reiter "Settings": dort stehen App key und App secret ("Show").'
Start-Process 'https://www.dropbox.com/developers/apps'
$key = (Read-Host 'Dropbox App key').Trim()
$secret = (Lies-Geheim 'Dropbox App secret').Trim()
Write-Host 'Der Browser oeffnet Dropbox. Dort "Weiter" und "Zulassen" klicken und den angezeigten Code kopieren.'
Start-Process "https://www.dropbox.com/oauth2/authorize?client_id=$key&response_type=code&token_access_type=offline"
$code = (Lies-Geheim 'Code aus dem Browser einfuegen').Trim()
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${key}:${secret}"))
$r = Invoke-RestMethod -Method Post -Uri 'https://api.dropboxapi.com/oauth2/token' -Headers @{ Authorization = "Basic $basic" } -Body @{ code = $code; grant_type = 'authorization_code' }
if (-not $r.refresh_token) { throw 'Dropbox hat keinen refresh_token geliefert' }
Setze-Secret 'DROPBOX_APP_KEY' $key
Setze-Secret 'DROPBOX_APP_SECRET' $secret
Setze-Secret 'DROPBOX_REFRESH_TOKEN' $r.refresh_token
Write-Host 'Dropbox verbunden.' -ForegroundColor Green

Write-Host "`n4/5 Firebase-Schluesseldatei" -ForegroundColor Cyan
Write-Host 'Der Browser oeffnet Firebase: "Neuen privaten Schluessel generieren" und dann "Schluessel generieren". Die Datei landet in Downloads.'
Start-Process 'https://console.firebase.google.com/project/etikette-fa8d1/settings/serviceaccounts/adminsdk'
Read-Host 'Wenn die Datei heruntergeladen ist: Enter druecken'
$dl = Join-Path $env:USERPROFILE 'Downloads'
$datei = Get-ChildItem -Path $dl -Filter 'etikette-fa8d1-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $datei) { $pfad = (Read-Host 'Datei nicht gefunden. Pfad zur JSON-Datei').Trim('" ') } else { $pfad = $datei.FullName; Write-Host "Gefunden: $pfad" }
$json = Get-Content -Raw -Path $pfad
$o = $json | ConvertFrom-Json
if ($o.project_id -ne 'etikette-fa8d1') { throw "Falsches Projekt: $($o.project_id)" }
Setze-Secret 'FIREBASE_SERVICE_ACCOUNT' (($json -replace "`r?`n", ' ').Trim())
Remove-Item -Path $pfad -Force
Write-Host 'Firebase verbunden. Die Schluesseldatei wurde geloescht.' -ForegroundColor Green

Write-Host "`n5/5 Monteur-PIN" -ForegroundColor Cyan
$pin = (Lies-Geheim 'Monteur-PIN ausdenken (mindestens 6 Ziffern)').Trim()
if ($pin.Length -lt 6) { throw 'PIN zu kurz, bitte mindestens 6 Zeichen' }
Setze-Secret 'MONTEUR_PIN' $pin

Write-Host "`nFERTIG. Worker-Adresse: $url" -ForegroundColor Green
Write-Host 'Claude kann jetzt Dropbox im Tool einschalten.'
