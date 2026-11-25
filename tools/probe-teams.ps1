<#
  Trame — sonde UIA (phase 0, go/no-go).
  À lancer sur le poste Windows, Teams v2 OUVERT avec une conversation affichée.
  Ne modifie rien : lit seulement l'arbre d'accessibilité.

  But : confirmer ce que le driver réel pourra exploiter —
   1. la fenêtre Teams est trouvable,
   2. la zone de composition est atteignable (Edit/Document),
   3. la liste des messages est lisible,
   4. (le point risqué) l'identifiant de fil `19:...@thread.v2` remonte-t-il
      en AutomationId sur les éléments du rail / du fil ?

  Usage :  powershell -ExecutionPolicy Bypass -File probe-teams.ps1
#>

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$ErrorActionPreference = "Stop"
$AE = [System.Windows.Automation.AutomationElement]
$Cond = [System.Windows.Automation.Condition]::TrueCondition
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Write-Res($ok, $label) {
  $mark = if ($ok) { "[OK]  " } else { "[!!]  " }
  Write-Host ($mark + $label) -ForegroundColor ($(if ($ok) { "Green" } else { "Yellow" }))
}

# 1. Fenêtre Teams (process ms-teams.exe, classe Chromium)
Write-Host "`n== Recherche de la fenêtre Teams ==" -ForegroundColor Cyan
$root = $AE::RootElement
$teams = $null
$child = $Walker.GetFirstChild($root)
while ($child -ne $null) {
  try {
    $pid = $child.Current.ProcessId
    $proc = (Get-Process -Id $pid -ErrorAction SilentlyContinue)
    if ($proc -and $proc.ProcessName -match "ms-teams|Teams") {
      $teams = $child; break
    }
  } catch {}
  $child = $Walker.GetNextSibling($child)
}
Write-Res ($teams -ne $null) "Fenêtre Teams trouvée"
if ($teams -eq $null) { Write-Host "Teams n'est pas ouvert ? Abandon." -ForegroundColor Red; exit 1 }
Write-Host ("     titre : " + $teams.Current.Name)
Write-Host ("     classe: " + $teams.Current.ClassName)

# Warm-up : WebView2 construit l'arbre à l'arrivée d'un client UIA.
Start-Sleep -Milliseconds 800

# 2/3/4. Parcours borné de l'arbre
Write-Host "`n== Parcours de l'arbre (borné) ==" -ForegroundColor Cyan
$maxNodes = 6000
$seen = 0
$edits = 0
$lists = 0
$threadIds = New-Object System.Collections.Generic.List[string]
$stack = New-Object System.Collections.Stack
$stack.Push($teams)
while ($stack.Count -gt 0 -and $seen -lt $maxNodes) {
  $el = $stack.Pop()
  $seen++
  try {
    $ct = $el.Current.ControlType.ProgrammaticName
    $aid = $el.Current.AutomationId
    if ($ct -match "Edit|Document") { $edits++ }
    if ($ct -match "List") { $lists++ }
    if ($aid -and ($aid -match "19:.*@thread\.v2" -or $aid -match "chat-list-item")) {
      if (-not $threadIds.Contains($aid)) { $threadIds.Add($aid) }
    }
  } catch {}
  try {
    $c = $Walker.GetFirstChild($el)
    while ($c -ne $null) { $stack.Push($c); $c = $Walker.GetNextSibling($c) }
  } catch {}
}
Write-Host ("     noeuds visités : " + $seen + $(if ($seen -ge $maxNodes) { " (plafond atteint)" } else { "" }))
Write-Res ($edits -gt 0) ("Zone(s) de saisie Edit/Document : " + $edits)
Write-Res ($lists -gt 0) ("Liste(s) de messages : " + $lists)

# 4. Le point décisif : identifiants de fil stables ?
Write-Host "`n== Identifiants de fil (le go/no-go) ==" -ForegroundColor Cyan
if ($threadIds.Count -gt 0) {
  Write-Res $true ("AutomationId de fil détectés : " + $threadIds.Count)
  $threadIds | Select-Object -First 8 | ForEach-Object { Write-Host ("     " + $_) }
  Write-Host "`n>>> Watchlist par ID stable : FAISABLE." -ForegroundColor Green
} else {
  Write-Res $false "Aucun AutomationId de fil (19:...@thread.v2) trouvé"
  Write-Host ">>> Repli sur le nom d'affichage. Vérifie avec Accessibility Insights" -ForegroundColor Yellow
  Write-Host "    (le build Teams peut ne pas exposer l'id ; cf. docs/SONDE-UIA.md)." -ForegroundColor Yellow
}

Write-Host "`nFait. Rien n'a été modifié dans Teams.`n" -ForegroundColor Cyan
