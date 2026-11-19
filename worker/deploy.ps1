# PE Etiketten: neue Version des Workers zu Cloudflare hochladen.
# Fragt einen Cloudflare-API-Token ab (wird nicht angezeigt und nicht gespeichert).
# Start im Ordner worker:  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Lies-Geheim($text) {
  $s = Read-Host $text -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Wrangler([string]$argumente) { (cmd /c "npx wrangler $argumente 2>&1" | Out-String) }

$wer = Wrangler 'whoami'
$versuch = 0
while ($wer -match 'not authenticated|ERROR') {
  $versuch++
  if ($versuch -gt 5) { throw 'Cloudflare-Anmeldung nicht moeglich.' }
  Write-Host 'Im Browser beim Token auf das Kopier-Symbol klicken, dann hier: Rechtsklick (fuegt ein) und Enter.'
  $t = (Lies-Geheim 'Cloudflare API-Token einfuegen').Trim()
  Write-Host "Erhalten: $($t.Length) Zeichen (richtig sind etwa 40 bis 60)."
  if ($t.Length -lt 30) { Write-Host 'Zu kurz. Bitte nochmals kopieren und einfuegen.' -ForegroundColor Yellow; continue }
  $env:CLOUDFLARE_API_TOKEN = $t
  $wer = Wrangler 'whoami'
  if ($wer -match 'not authenticated|ERROR') { Write-Host 'Cloudflare lehnt diesen Token ab. Bitte nochmals.' -ForegroundColor Yellow }
}
Write-Host 'Cloudflare verbunden. Lade hoch ...' -ForegroundColor Green
$aus = Wrangler 'deploy'
Write-Host $aus
if ($aus -notmatch 'workers\.dev') { throw 'Hochladen fehlgeschlagen (siehe oben).' }
Write-Host "`nFERTIG. Neue Worker-Version ist online." -ForegroundColor Green
