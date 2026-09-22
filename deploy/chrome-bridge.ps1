# Manzi Junior - pont vers TON Chrome (Windows).
#
#   $env:MANZI_HOST='manzi@50.21.190.19'; $env:MANZI_GW='172.17.0.1'; .\chrome-bridge.ps1
#
# Ouvre un Chrome pilotable et le publie vers le serveur par un tunnel SSH
# inverse. Tant que cette fenetre reste ouverte, Manzi Junior voit ce Chrome
# et agit dans les comptes qui y sont connectes. Quand elle se ferme, il
# retombe sur son propre Chromium, sans tes sessions.
#
# Profil dedie, et non ton profil habituel : depuis Chrome 136, Google refuse
# --remote-debugging-port sur le profil par defaut. Ce n'est pas contournable.
# Au premier lancement, ce script COPIE ton profil Chrome existant dans le
# profil dedie : l'agent herite de toutes tes sessions ouvertes, sans jamais
# toucher au Chrome que tu utilises toi. Les deux vivent ensuite leur vie.
# Ferme Chrome avant le premier lancement, sinon la copie est incoherente.
#
# Fichier volontairement en ASCII pur : PowerShell 5.1 lit un .ps1 sans BOM
# comme de l'ANSI, et un seul accent suffit a casser l'analyse du script.

$ErrorActionPreference = 'Stop'

$Remote  = $env:MANZI_HOST
$Gateway = $env:MANZI_GW
$Port    = 9222
$ProfileDir = Join-Path $HOME 'manzi-chrome'

if (-not $Remote)  { Write-Host "Manque: `$env:MANZI_HOST (ex: manzi@50.21.190.19)" -ForegroundColor Red; exit 1 }
if (-not $Gateway) { Write-Host "Manque: `$env:MANZI_GW (affiche par chrome-bridge-server.sh)" -ForegroundColor Red; exit 1 }

function Test-Cdp {
  try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing; return $true }
  catch { return $false }
}

# 1. Chrome ---------------------------------------------------------------------
if (Test-Cdp) {
  Write-Host "==> Chrome pilotable deja en ecoute sur $Port" -ForegroundColor Cyan
} else {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $chrome) { Write-Host "chrome.exe introuvable. Installe Chrome ou edite ce script." -ForegroundColor Red; exit 1 }

  # Premier lancement : on recopie le profil existant pour heriter des sessions.
  # Les cookies Chrome sont chiffres par DPAPI, lie au compte Windows : la copie
  # reste dechiffrable puisqu'elle sert sous le meme compte. On laisse les
  # caches derriere - plusieurs gigaoctets qui se reconstruisent seuls.
  if (-not (Test-Path $ProfileDir)) {
    $src = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
    if (Test-Path $src) {
      if (Get-Process chrome -ErrorAction SilentlyContinue) {
        Write-Host "Chrome est ouvert. Ferme-le completement, puis relance ce script." -ForegroundColor Red
        Write-Host "Sans cela la copie du profil est incoherente et les sessions sont perdues." -ForegroundColor Red
        exit 1
      }
      Write-Host "==> Copie de ton profil Chrome (une seule fois, peut prendre 1-2 min)" -ForegroundColor Cyan
      $skip = @('Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache',
                'DawnGraphiteCache', 'DawnWebGPUCache', 'CacheStorage', 'Service Worker', 'Crashpad')
      # /XD exclut ces dossiers ou qu'ils soient ; /NFL /NDL /NJH /NJS pour un log lisible.
      $rcArgs = @($src, $ProfileDir, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XJ', '/XD') + $skip
      $null = & robocopy @rcArgs
      # robocopy: 0-7 = succes (8+ = echec reel). $LASTEXITCODE n'est pas une erreur ici.
      if ($LASTEXITCODE -ge 8) {
        Write-Host "La copie du profil a echoue (code $LASTEXITCODE)." -ForegroundColor Red
        Remove-Item -Recurse -Force $ProfileDir -ErrorAction SilentlyContinue
        exit 1
      }
      Write-Host "==> Profil copie : tes sessions sont dans le Chrome de Manzi Junior" -ForegroundColor Cyan
    }
  }

  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  Write-Host "==> Ouverture du Chrome de Manzi Junior (profil $ProfileDir)" -ForegroundColor Cyan
  Start-Process $chrome -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    "--user-data-dir=$ProfileDir",
    "--no-first-run",
    "--no-default-browser-check"
  )

  $ok = $false
  foreach ($i in 1..30) { Start-Sleep -Seconds 1; if (Test-Cdp) { $ok = $true; break } }
  if (-not $ok) { Write-Host "Chrome n'ecoute pas sur $Port apres 30 s." -ForegroundColor Red; exit 1 }
  Write-Host "==> Chrome en ecoute" -ForegroundColor Cyan
  Write-Host "    Verifie dans cette fenetre que tes comptes sont bien connectes." -ForegroundColor Yellow
  Write-Host "    Ce qui manque, connecte-le une fois : ca reste dans ce profil." -ForegroundColor Yellow
}

# 2. Tunnel inverse --------------------------------------------------------------
# On force l'adresse d'ecoute cote serveur sur la passerelle Docker. Jamais
# 0.0.0.0 : ce port pilote un navigateur ou tu es connecte, le publier sur
# Internet revient a donner tes comptes.
$Bind = "${Gateway}:${Port}:127.0.0.1:${Port}"
Write-Host "==> Tunnel vers $Remote (ecoute serveur sur ${Gateway}:${Port})" -ForegroundColor Cyan
Write-Host "    Ctrl+C pour couper le pont. Manzi Junior continue de tourner sans lui." -ForegroundColor Cyan

# Reconnexion automatique : une coupure Wi-Fi ne doit pas rendre le bot aveugle
# jusqu'a ce que quelqu'un s'en apercoive.
#
# Avant CHAQUE tentative on libere le port cote serveur. Quand cette fenetre
# se ferme mal - portable qui s'endort, Wi-Fi coupe - sshd garde le port
# reserve tant qu'il n'a pas constate la mort de la connexion, parfois
# plusieurs minutes. Sans cette etape, la tentative suivante recoit
# "remote port forwarding failed for listen port 9222" et boucle dessus
# indefiniment : le pont ne remonte jamais tout seul.
$Free = "cd manzi-junior && bash deploy/chrome-bridge-free.sh $Port"
while ($true) {
  # ErrorActionPreference=Stop transforme la moindre ligne ecrite sur la sortie
  # d'erreur d'un programme externe en erreur fatale. Le liberateur de port
  # ECRIT sur stderr quand il ne peut pas agir - ce qui est une information,
  # pas une panne - et faisait donc mourir le pont au lieu de le remonter.
  $ancien = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $libre = (ssh $Remote $Free 2>&1 | Out-String).Trim()
  $ErrorActionPreference = $ancien
  if ($libre) { Write-Host "    $libre" -ForegroundColor DarkGray }
  if ($libre -match 'autre utilisateur') {
    Write-Host "    Le port est tenu par un processus qui ne t appartient pas." -ForegroundColor Yellow
    Write-Host "    Une fois, en root : ssh root@<serveur> puis" -ForegroundColor Yellow
    Write-Host "      bash /home/manzi/manzi-junior/deploy/chrome-bridge-free.sh $Port" -ForegroundColor Yellow
  }

  ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R $Bind $Remote

  Write-Host "    tunnel coupe - nouvelle tentative dans 5 s" -ForegroundColor DarkYellow
  Start-Sleep -Seconds 5
}
