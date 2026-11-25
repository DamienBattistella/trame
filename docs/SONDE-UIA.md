# Sonde UIA — phase 0 (le go/no-go)

Avant d'écrire le driver réel, il faut confirmer sur **ton poste** ce que
l'arbre d'accessibilité de Teams v2 expose. 10 minutes. Rien n'est modifié.

Teams v2 est une app WebView2 (Chromium) : son UIA est le DOM web, construit
**paresseusement** (il s'active quand un client UIA se connecte) et **instable**
d'une mise à jour à l'autre. Les points solides (saisir, lire le texte) sont
quasi acquis ; le point risqué est l'**identité stable des conversations**.

## 1. Sonde automatique (2 min)

Teams ouvert, **une conversation affichée** :

```powershell
powershell -ExecutionPolicy Bypass -File tools/probe-teams.ps1
```

Lecture du résultat :
- **Fenêtre Teams trouvée** → la base est là.
- **Zone de saisie / Liste de messages** → saisir et lire fonctionneront.
- **Identifiants de fil** : c'est le verdict.
  - `AutomationId de fil détectés` + des lignes `19:...@thread.v2` → **watchlist
    par ID stable faisable** (le chemin propre).
  - `Aucun AutomationId de fil` → repli sur le nom d'affichage, et vérifie à la
    main (étape 2) avant de conclure : certains builds exposent l'id plus bas
    dans l'arbre que le plafond de la sonde.

## 2. Vérification visuelle — Accessibility Insights for Windows

Installer : https://accessibilityinsights.io/downloads/ (gratuit, Microsoft).

1. Lance **Accessibility Insights for Windows**, onglet **Live Inspect**.
2. Survole, dans Teams :
   - **un élément de la liste de conversations** (rail de gauche),
   - **la zone de saisie** d'un message,
   - **un message** affiché dans le fil.
3. Pour chacun, note dans le panneau de droite :
   - **ControlType** (Edit/Document pour la saisie, List/Group pour les messages),
   - **AutomationId** — regarde s'il contient `19:...@thread.v2` ou
     `chat-list-item_19:...`,
   - **Name** (le texte / nom affiché, pour le repli).

### Ce qu'on cherche à confirmer
| Élément | Attendu | Sert à |
|---|---|---|
| Item du rail | AutomationId = id de fil stable | clé de watchlist |
| Zone de saisie | ControlType Edit/Document, focusable | écrire la réponse |
| Message | Name = texte, author lisible | lire le contexte + l'expéditeur |
| Bouton « Arrêter le partage » présent en partage d'écran | détectable | auto-pause |

## 3. Remonter le résultat
Renseigne ce que tu as vu (surtout : l'AutomationId des items du rail) — ça
fixe la stratégie de sélecteurs dans `backend/drivers/windows_uia.py` (marqueurs
`A CALER`). Si l'id stable est là, on le câble ; sinon, repli nom + canary de
revalidation après chaque mise à jour Teams.
