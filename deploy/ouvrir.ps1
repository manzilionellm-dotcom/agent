# Ouvre une page de Manzi Junior directement dans ton navigateur.
#
#   .\ouvrir.ps1            -> le tableau de bord
#   .\ouvrir.ps1 screen     -> l'ecran du navigateur du serveur
#   .\ouvrir.ps1 vault      -> le coffre d'identifiants
#
# Ce script existe parce que l'etape « copier le lien du terminal vers la
# barre d'adresse » a rate quatre fois de suite : colle dans PowerShell, le
# lien devient une commande inconnue, et pendant ce temps le billet expire.
# Ici la machine fait le copier-coller, et le navigateur s'ouvre tout seul.
#
# ASCII pur : PowerShell 5.1 lit un .ps1 sans BOM comme de l'ANSI, et un seul
# accent casse l'analyse du fichier entier.

$ErrorActionPreference = 'Stop'

$Page   = if ($args.Count -ge 1) { $args[0] } else { 'board' }
$Remote = if ($env:MANZI_HOST) { $env:MANZI_HOST } else { 'manzi@50.21.190.19' }

if ($Page -notin @('board','screen','vault')) {
  Write-Host "Page inconnue: $Page  (board | screen | vault)" -ForegroundColor Red; exit 1
}

Write-Host "==> Demande d'un lien pour /$Page" -ForegroundColor Cyan

# Le liberateur ecrit parfois sur la sortie d'erreur ; avec Stop, la moindre
# ligne la-bas tuerait le script. On relache le temps de l'appel.
$ancien = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$sortie = (ssh $Remote "cd manzi-junior && bash deploy/vault-link.sh $Page" 2>&1 | Out-String)
$ErrorActionPreference = $ancien

$lien = [regex]::Match($sortie, "https://\S+/$Page\?t=\S+").Value
if (-not $lien) {
  Write-Host "Aucun lien dans la reponse du serveur :" -ForegroundColor Red
  Write-Host $sortie
  exit 1
}

Write-Host "==> Ouverture dans ton navigateur" -ForegroundColor Cyan
Write-Host "    $lien" -ForegroundColor DarkGray
Start-Process $lien
Write-Host ""
Write-Host "Ce lien meurt a la premiere ouverture. Pour en avoir un autre, relance ce script." -ForegroundColor Yellow
