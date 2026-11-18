# PE Etiketten: Schlüssel für den Cloudflare Worker setzen (einmalig).
# Alle Werte gehen direkt zu Cloudflare. Sie werden nicht angezeigt und nicht gespeichert.
# Vorher: im Ordner worker  ->  npm install  und  npx wrangler login
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Lies-Geheim($text) {
  $s = Read-Host $text -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Setze-Secret($name, $wert) {
  if (-not $wert) { throw "$name ist leer" }
  $wert | npx wrangler secret put $name
  if ($LASTEXITCODE -ne 0) { throw "Setzen von $name fehlgeschlagen" }
}

Write-Host "`n1/3 Dropbox" -ForegroundColor Cyan
$key = (Read-Host 'Dropbox App key (Reiter Settings)').Trim()
$secret = (Lies-Geheim 'Dropbox App secret').Trim()
Write-Host 'Der Browser öffnet sich. Dort "Zulassen" klicken und den angezeigten Code kopieren.'
Start-Process "https://www.dropbox.com/oauth2/authorize?client_id=$key&response_type=code&token_access_type=offline"
$code = (Lies-Geheim 'Code aus dem Browser einfügen').Trim()
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${key}:${secret}"))
$r = Invoke-RestMethod -Method Post -Uri 'https://api.dropboxapi.com/oauth2/token' -Headers @{ Authorization = "Basic $basic" } -Body @{ code = $code; grant_type = 'authorization_code' }
if (-not $r.refresh_token) { throw 'Dropbox hat keinen refresh_token geliefert' }
Setze-Secret 'DROPBOX_APP_KEY' $key
Setze-Secret 'DROPBOX_APP_SECRET' $secret
Setze-Secret 'DROPBOX_REFRESH_TOKEN' $r.refresh_token
Write-Host 'Dropbox verbunden.' -ForegroundColor Green

Write-Host "`n2/3 Firebase-Service-Konto" -ForegroundColor Cyan
Write-Host 'Firebase-Konsole -> Projekteinstellungen -> Dienstkonten -> "Neuen privaten Schlüssel generieren".'
$datei = (Read-Host 'Pfad zur heruntergeladenen JSON-Datei (z. B. C:\Users\User\Downloads\etikette-fa8d1-....json)').Trim('" ')
$json = Get-Content -Raw -Path $datei
$o = $json | ConvertFrom-Json
if ($o.project_id -ne 'etikette-fa8d1') { throw "Falsches Projekt: $($o.project_id)" }
Setze-Secret 'FIREBASE_SERVICE_ACCOUNT' (($json -replace "`r?`n", ' ').Trim())
Write-Host 'Service-Konto gesetzt. Die JSON-Datei jetzt löschen (auch aus dem Papierkorb).' -ForegroundColor Yellow

Write-Host "`n3/3 Monteur-PIN" -ForegroundColor Cyan
$pin = (Lies-Geheim 'Monteur-PIN (mindestens 6 Ziffern)').Trim()
if ($pin.Length -lt 6) { throw 'PIN zu kurz, bitte mindestens 6 Zeichen' }
Setze-Secret 'MONTEUR_PIN' $pin

Write-Host "`nFertig. Jetzt: npx wrangler deploy" -ForegroundColor Green
