# Manzi Junior - autorise l'acces a Gmail et a l'Agenda. A lancer UNE FOIS, sur Windows.
#
#   $env:MANZI_HOST='manzi@50.21.190.19'; .\google-auth.ps1
#
# Google exige un navigateur pour le consentement : impossible sur un serveur
# sans ecran. On fait donc le consentement ici, sur ton poste, et on envoie le
# jeton de rafraichissement directement dans le .env du serveur. Le jeton ne
# s'affiche jamais, ni a l'ecran, ni dans l'historique PowerShell.
#
# Ce jeton ne depend ensuite ni de ton PC, ni de ton adresse IP, ni d'une
# session ouverte. C'est ce qui distingue cette methode d'un transfert de
# cookies : Google invalide des cookies rejoues depuis un autre pays, il
# n'invalide pas un jeton de rafraichissement.
#
# ASCII pur : PowerShell 5.1 lit un .ps1 sans BOM comme de l'ANSI, et un seul
# accent casse l'analyse du fichier entier.

$ErrorActionPreference = 'Stop'

$Remote = $env:MANZI_HOST
if (-not $Remote) { Write-Host "Manque: `$env:MANZI_HOST (ex: manzi@50.21.190.19)" -ForegroundColor Red; exit 1 }

$Port   = 8765
$Redir  = "http://127.0.0.1:$Port/"
$Scopes = @(
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly'
) -join ' '

Write-Host "==> Identifiants du client OAuth (type: Application de bureau)" -ForegroundColor Cyan
Write-Host "    console.cloud.google.com > API et services > Identifiants" -ForegroundColor DarkGray
$ClientId     = (Read-Host 'ID client').Trim()
$ClientSecret = (Read-Host 'Code secret du client').Trim()
if (-not $ClientId -or -not $ClientSecret) { Write-Host "Identifiants vides." -ForegroundColor Red; exit 1 }

# access_type=offline + prompt=consent : sans les deux, Google ne renvoie un
# refresh_token qu'a la toute premiere autorisation et rien du tout ensuite,
# ce qui donne un script qui marche une fois et echoue sans raison visible.
$AuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth' +
  '?client_id=' + [uri]::EscapeDataString($ClientId) +
  '&redirect_uri=' + [uri]::EscapeDataString($Redir) +
  '&response_type=code' +
  '&access_type=offline' +
  '&prompt=consent' +
  '&scope=' + [uri]::EscapeDataString($Scopes)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($Redir)
try { $listener.Start() } catch {
  Write-Host "Impossible d'ecouter sur $Redir - le port $Port est deja pris." -ForegroundColor Red
  exit 1
}

Write-Host "==> Ouverture du consentement Google dans ton navigateur" -ForegroundColor Cyan
Write-Host '    Choisis ton compte, puis Continuer. Si Google affiche' -ForegroundColor DarkGray
Write-Host '    (Cette application n''est pas validee) : Parametres avances > Continuer.' -ForegroundColor DarkGray
Start-Process $AuthUrl

$ctx  = $listener.GetContext()
$code = $ctx.Request.QueryString['code']
$err  = $ctx.Request.QueryString['error']

$html = if ($code) { '<h2>C est bon. Tu peux fermer cet onglet et revenir a PowerShell.</h2>' }
        else { '<h2>Autorisation refusee. Reviens a PowerShell.</h2>' }
$buf = [Text.Encoding]::UTF8.GetBytes("<html><meta charset='utf-8'><body style='font-family:sans-serif'>$html</body></html>")
$ctx.Response.ContentType = 'text/html; charset=utf-8'
$ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
$ctx.Response.Close()
$listener.Stop()

if (-not $code) { Write-Host "Autorisation refusee ($err)." -ForegroundColor Red; exit 1 }
Write-Host "==> Code recu, echange contre un jeton durable" -ForegroundColor Cyan

$tok = Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' -Body @{
  code          = $code
  client_id     = $ClientId
  client_secret = $ClientSecret
  redirect_uri  = $Redir
  grant_type    = 'authorization_code'
}

if (-not $tok.refresh_token) {
  Write-Host "Google n'a pas renvoye de refresh_token." -ForegroundColor Red
  Write-Host "Cause habituelle : ce compte a deja autorise cette application." -ForegroundColor Yellow
  Write-Host "Retire-la sur myaccount.google.com/permissions, puis relance ce script." -ForegroundColor Yellow
  exit 1
}

Write-Host "==> Envoi au serveur (les valeurs ne passent pas par l'ecran)" -ForegroundColor Cyan
$remoteCmd = "cd ~/manzi-junior && bash deploy/set-env.sh " +
             "GOOGLE_CLIENT_ID=$ClientId GOOGLE_CLIENT_SECRET=$ClientSecret GOOGLE_REFRESH_TOKEN=$($tok.refresh_token)" +
             " && docker compose -f docker-compose.yml -f docker-compose.eco.yml up -d --force-recreate orchestrator"
ssh $Remote $remoteCmd
if ($LASTEXITCODE -ne 0) { Write-Host "L'envoi au serveur a echoue (code $LASTEXITCODE)." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host 'Termine. Sur WhatsApp, demande : quoi de neuf dans mes mails ?' -ForegroundColor Green
Write-Host ""
Write-Host "Un point a verifier une seule fois, sinon l'acces tombera dans 7 jours :" -ForegroundColor Yellow
Write-Host "  console.cloud.google.com > Ecran de consentement OAuth" -ForegroundColor Yellow
Write-Host '  Etat de publication doit etre: En production  (et non Test).' -ForegroundColor Yellow
Write-Host "  En mode Test, Google fait expirer le jeton au bout de 7 jours." -ForegroundColor Yellow
