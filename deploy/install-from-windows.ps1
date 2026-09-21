# Installe Manzi Junior sur un VPS neuf, depuis Windows, en une commande.
#
#   .\install-from-windows.ps1 -ServerIp 82.165.1.2
#
# Ce que le script fait, dans l'ordre :
#   1. vérifie que le .env local contient tout ce qui est OBLIGATOIRE au démarrage
#      (il s'arrête et liste ce qui manque plutôt que de laisser le bot échouer au boot) ;
#   2. copie le .env sur le serveur ;
#   3. lance le bootstrap (Docker, utilisateur non-root, dépôt, service systemd)
#      puis install.sh --eco ;
#   4. interroge /healthz et affiche le verdict.
#
# Deux mots de passe root te seront demandés (une fois pour la copie, une fois pour
# l'installation). Le mot de passe n'est jamais écrit dans un fichier ni dans un log.
#
# Prérequis : Windows 10/11 (ssh et scp sont fournis d'origine), le fichier .env
# dans le même dossier que ce script — ou indiqué par -EnvFile.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ServerIp,
  [string]$EnvFile = (Join-Path $PSScriptRoot '.env'),
  [string]$RepoUrl = 'https://github.com/manzilionellm-dotcom/agent.git',
  [string]$Branch  = 'claude/grok-bot-autonomous-agent-3mjee3',
  [string]$User    = 'manzi'
)

$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host "== $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "ARRET : $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. le .env
if (-not (Test-Path $EnvFile)) { Die "$EnvFile introuvable. Passe -EnvFile <chemin>." }

$env_ = @{}
foreach ($line in Get-Content $EnvFile) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
    $env_[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
  }
}

function Val($k) { if ($env_.ContainsKey($k)) { $env_[$k] } else { '' } }
function Missing($k) {
  $v = Val $k
  # Vide, ou encore sur le gabarit : dans les deux cas, ce n'est pas renseigné.
  return ($v -eq '' -or $v -match 'A-REMPLIR|REMPLACE|^sk-\.\.\.$|^sk-ant-\.\.\.$|^tvly-\.\.\.$|^github_pat_\.\.\.$')
}

# Ce que agent/src/config.ts exige réellement pour démarrer, rien de plus.
$required = [ordered]@{
  'GITHUB_TOKEN'           = 'github.com > Settings > Developer settings > Fine-grained tokens'
  'OPENAI_COMPAT_API_KEY'  = 'platform.deepseek.com > API keys'
  'OPENAI_COMPAT_BASE_URL' = 'https://api.deepseek.com/v1'
}
if ((Val 'LLM_PROVIDER') -eq 'openai_compat' -and (Missing 'TAVILY_API_KEY') -and (Missing 'SERPAPI_API_KEY')) {
  $required['TAVILY_API_KEY'] = 'tavily.com > Sign up (gratuit, 1000 recherches/mois, sans carte)'
}
if ((Val 'LLM_PROVIDER') -eq 'anthropic' -or (Val 'LLM_PROVIDER_CRITICAL') -eq 'anthropic') {
  $required['ANTHROPIC_API_KEY'] = 'console.anthropic.com > API keys — OU mets LLM_PROVIDER_CRITICAL=openai_compat et MODEL_CRITICAL=deepseek-chat pour démarrer sans Claude'
}

$manquants = @()
foreach ($k in $required.Keys) { if (Missing $k) { $manquants += "  $k`n     -> $($required[$k])" } }
if ($manquants.Count -gt 0) {
  Write-Host "Le bot refuserait de démarrer. Il manque :" -ForegroundColor Yellow
  $manquants | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
  Die "complete ces valeurs dans $EnvFile puis relance."
}

# Fins de ligne Windows : un CR invisible se retrouverait dans chaque valeur côté Linux.
$raw = Get-Content $EnvFile -Raw
if ($raw -match "`r`n") {
  Say 'conversion des fins de ligne en LF'
  [IO.File]::WriteAllText($EnvFile, ($raw -replace "`r`n", "`n"))
}
Say ".env validé ($($env_.Count) variables)"

# ------------------------------------------------------- 2. copie sur le serveur
Say "copie du .env vers $ServerIp (mot de passe root demandé)"
& scp -o StrictHostKeyChecking=accept-new $EnvFile "root@${ServerIp}:/root/.env.manzi"
if ($LASTEXITCODE -ne 0) { Die 'la copie a échoué (IP, mot de passe, ou serveur pas encore livré).' }

# ------------------------------------------------------- 3. installation distante
# Le script distant est passé en base64 : un seul argument, aucune interférence de
# quoting entre PowerShell, ssh et bash, et stdin reste libre pour le mot de passe.
# `$X = littéral pour bash ; $Branch = interpolé par PowerShell.
# Le token n'apparaît JAMAIS dans la ligne de commande ssh : il est relu sur le
# serveur depuis le .env qu'on vient d'y copier.
$remote = @"
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BR='$Branch'
REPO='$RepoUrl'
USR='$User'
GH=`$(grep -E '^GITHUB_TOKEN=' /root/.env.manzi | head -1 | cut -d= -f2- | tr -d '"\r')
[ -n "`$GH" ] || { echo 'GITHUB_TOKEN absent du .env'; exit 1; }

echo '== bootstrap'
# raw.githubusercontent.com ne sait pas couper une branche qui contient un '/'
# (elle est indistinguable du chemin du fichier) et répond 404. L'API Contents
# prend la branche en paramètre `ref`, donc sans ambiguïté possible.
curl -fsSL -H "Authorization: token `$GH" -H 'Accept: application/vnd.github.raw' \
  "https://api.github.com/repos/manzilionellm-dotcom/agent/contents/deploy/vps-bootstrap.sh?ref=`$BR" \
  -o /root/vps-bootstrap.sh
bash /root/vps-bootstrap.sh "`$USR" "`$REPO" "`$GH" "`$BR"

echo '== .env en place'
install -o "`$USR" -g "`$USR" -m 600 /root/.env.manzi "/home/`$USR/manzi-junior/.env"
shred -u /root/.env.manzi 2>/dev/null || rm -f /root/.env.manzi

echo '== install.sh --eco'
sudo -u "`$USR" -H bash -lc 'cd ~/manzi-junior && ./install.sh --eco'

echo '== sante'
sleep 20
curl -fsS http://127.0.0.1:8787/healthz || echo 'healthz pas encore pret'
"@

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($remote -replace "`r`n", "`n")))
Say 'installation sur le serveur (10 à 20 min, mot de passe root demandé une dernière fois)'
& ssh -o StrictHostKeyChecking=accept-new "root@$ServerIp" "echo $b64 | base64 -d | bash"
if ($LASTEXITCODE -ne 0) { Die "l'installation distante a échoué — envoie les dernières lignes affichées." }

Write-Host ''
Write-Host 'Manzi Junior est installé.' -ForegroundColor Green
Write-Host "Journal en direct :  ssh root@$ServerIp 'docker compose -f /home/$User/manzi-junior/docker-compose.yml logs -f orchestrator'"
Write-Host "Prochaine étape   :  le webhook WhatsApp (docs/ECO.md, section 4)."
