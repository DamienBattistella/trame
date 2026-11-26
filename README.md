<p align="center">
  <img src="docs/logo-animated.svg" width="120" alt="Trame" />
</p>

<h1 align="center">Trame</h1>

<p align="center"><strong>La trame de tes conversations.</strong><br/>
Un assistant Windows qui veille sur tes conversations Microsoft Teams et te prépare des réponses, dans ta voix.</p>

<p align="center">
  <a href="https://github.com/DamienBattistella/trame/actions/workflows/ci.yml"><img src="https://github.com/DamienBattistella/trame/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/DamienBattistella/trame/actions/workflows/build.yml"><img src="https://github.com/DamienBattistella/trame/actions/workflows/build.yml/badge.svg" alt="Build Windows" /></a>
</p>

<p align="center">
  <img src="docs/screenshots/brouillons.png" width="820" alt="Trame — file de brouillons à relire" />
</p>

---

## Ce que fait Trame

Trame tourne en tâche de fond, dans la barre des tâches. Quand quelqu'un que tu as choisi t'écrit sur Teams, Trame lit le message, rédige une réponse dans ton style et te la propose. Tu relis, tu ajustes, tu envoies — ou, pour les personnes de confiance, Trame envoie lui-même après un court délai que tu peux annuler.

- **Il pilote l'application Teams que tu as déjà ouverte.** Aucune API Microsoft Graph, aucun jeton, aucune autorisation d'administrateur : Trame agit dans ta session, comme tu le ferais au clavier.
- **Il écrit dans ta voix.** Ton style, ton rôle et ce qu'il doit refuser sont décrits dans un fichier `SOUL.md` que tu déposes dans l'application.
- **Tu gardes la main.** Brouillon par défaut, envoi automatique seulement pour les conversations que tu désignes, pause en un clic.

## Interfaces

### Un démarrage en huit écrans

| | |
|:-:|:-:|
| <img src="docs/screenshots/wizard-bienvenue.png" alt="Bienvenue" /> | <img src="docs/screenshots/wizard-cerveau.png" alt="Choix du cerveau" /> |
| **Bienvenue** — Trame détecte Teams | **Cerveau** — Claude ou GitHub Copilot |
| <img src="docs/screenshots/wizard-test.png" alt="Test de lecture" /> | <img src="docs/screenshots/wizard-watchlist.png" alt="Quelles conversations" /> |
| **Vérification** — Trame repère la fenêtre, les messages et la zone de saisie | **Quelles conversations** — recherche et filtres, même avec des centaines de conversations |
| <img src="docs/screenshots/wizard-modes.png" alt="Brouillon ou auto" /> | <img src="docs/screenshots/wizard-persona.png" alt="Ta voix" /> |
| **Qui envoie** — toi ou Trame, par conversation | **Ta voix** — dépose ton `SOUL.md`, avec une aide et un modèle à copier |

<p align="center">
  <img src="docs/screenshots/ame-etats.png" width="760" alt="L'âme de Trame : attente, fichier au-dessus, accepté, refusé" /><br/>
  <sub>L'âme de Trame réagit au dépôt du <code>SOUL.md</code> : elle attend, s'approche quand un fichier arrive, l'absorbe avec plaisir — ou secoue la tête si ce n'est pas le bon format.</sub>
</p>

### Au quotidien

| | |
|:-:|:-:|
| <img src="docs/screenshots/brouillons.png" alt="Brouillons" /> | <img src="docs/screenshots/watchlist.png" alt="Conversations" /> |
| **Brouillons** — leur message, ta réponse modifiable, un bouton Envoyer | **Conversations** — lesquelles suivre, et qui envoie |
| <img src="docs/screenshots/journal.png" alt="Journal" /> | <img src="docs/screenshots/reglages.png" alt="Réglages" /> |
| **Journal** — tout ce que Trame a lu, proposé et envoyé | **Réglages** — cerveau, démarrage, GitHub, sécurité |

### Le brief d'une conversation

<p align="center">
  <img src="docs/screenshots/brief.png" width="760" alt="Brief de conversation : résumé, points ouverts, sujets et contexte GitHub" /><br/>
  <sub>Depuis une réponse à relire (menu …) ou une conversation, « Résumé » résume la discussion, liste les points ouverts et retrouve les PR, issues et commits liés sur GitHub.</sub>
</p>

<p align="center">
  <img src="docs/screenshots/logo-animation.png" width="560" alt="Le logo se dessine au démarrage" /><br/>
  <sub>Au démarrage, le fil du logo écrit le T de Trame pendant que le moteur se lance.</sub>
</p>

## Fonctionnalités

- **Veille ciblée** : seulement les conversations que tu coches — messages privés, groupes, canaux. Dans un groupe ou un canal, Trame ne réagit que si l'on te mentionne, ou une personne que tu as nommée.
- **Deux modes par conversation** : *Brouillon* (tu valides) ou *Auto* (envoi après un compte à rebours de 3, 5 ou 10 s, annulable par la pause).
- **Brouillons éditables** : tu modifies le texte avant l'envoi, ou tu l'ouvres directement dans Teams pour le terminer toi-même.
- **Rattrapage** : en un clic, les messages non lus deviennent des brouillons — jamais d'envoi automatique en rafale.
- **Brief de conversation** : en un clic, un résumé de la discussion, les points ouverts, les sujets abordés et les PR, issues et commits GitHub liés, chacun avec la raison du lien. Activable et réglable (20, 30 ou 50 derniers messages) dans les réglages.
- **Connexion GitHub intégrée** : « Se connecter à GitHub » dans le wizard ou les Réglages affiche le code à usage unique ; la connexion passe par `gh`, et Trame signale les organisations qui exigent le SSO.
- **Contexte GitHub** (lecture seule) : quand un message parle d'une PR ou d'une issue, Trame consulte tes dépôts pour répondre juste. Il n'écrit jamais sur GitHub.
- **Application de bureau discrète** : icône dans la barre des tâches, démarrage avec Windows, fermer la fenêtre la réduit, instance unique, taille et position mémorisées.

## Sécurité

- **Jamais dans la mauvaise conversation.** Avant de taper quoi que ce soit, Trame ouvre la conversation visée et vérifie qu'elle est bien active ; s'il a le moindre doute, il refuse et garde le brouillon.
- **Pause automatique pendant un partage d'écran**, pour qu'aucune réponse ne s'affiche devant toute une réunion.
- **Jamais deux fois, jamais pour lui-même.** Un brouillon ne peut partir qu'une fois, même en double-cliquant ; Trame ne répond ni à tes propres messages ni à ses propres réponses. Avant de taper, il vérifie que Teams est au premier plan et que la zone de saisie est vide, pour ne rien mélanger à un texte en cours.
- **Pause et partage d'écran revérifiés au dernier moment**, juste avant la saisie : une pause ou un partage commencés pendant la rédaction annulent l'envoi automatique.
- **Moteur local fermé au web.** Le moteur n'écoute que sur ta machine et ne répond qu'à l'interface de Trame : une page web ouverte dans ton navigateur ne peut ni lire tes messages ni déclencher un envoi. Quand tu quittes Trame, le moteur s'arrête avec lui.
- **Un cerveau sans outils.** Claude et Copilot reçoivent le message à rédiger, sans accès à tes fichiers, à tes commandes ni à tes serveurs MCP : un message piégé ne peut rien lui faire exécuter.
- **Mots bloquants** : si un message ou une réponse contient un terme sensible (RH, salaire, confidentiel…), l'envoi automatique repasse en brouillon.
- **Auto-test au démarrage** : si Trame n'arrive pas à repérer les éléments de Teams, tout l'envoi automatique est suspendu.
- **Ce qui sort de ton poste** : le contenu des messages traités est envoyé au cerveau que tu as choisi (Claude ou GitHub Copilot) pour rédiger la réponse. Rien d'autre ne quitte la machine. La configuration est stockée dans `%APPDATA%\Trame`.
- **GitHub passe par `gh`.** La connexion se fait avec la commande `gh` du poste (code à usage unique dans le navigateur) ; le jeton reste dans le coffre d'identifiants de `gh` et Trame ne le voit jamais. Pour une organisation protégée par SSO (SAML), le jeton doit y être autorisé, sinon Trame la signale comme bloquée.

## Installer

1. Télécharge l'installeur Windows depuis la [dernière version](https://github.com/DamienBattistella/trame/releases/latest) : `Trame_x.y.z_x64-setup.exe` (recommandé) ou `Trame_x.y.z_x64_en-US.msi`.
2. Vérifie que la commande `claude` (Claude Code) est installée et connectée sur le poste — ou `gh` avec Copilot si tu choisis ce cerveau.
3. Ouvre Teams, lance Trame et laisse-toi guider.

## Comment c'est construit

```mermaid
flowchart LR
  UI["Interface<br/>Tauri · React · shadcn/ui"] -- "WebSocket + REST<br/>127.0.0.1:8731" --> Engine["Moteur Python<br/>veille · règles · sécurité"]
  Engine -- "UI Automation" --> Teams["Microsoft Teams<br/>(ta session)"]
  Engine -- "rédaction" --> Brain["Claude Code<br/>ou GitHub Copilot"]
  Engine -. "lecture seule" .-> GitHub["gh"]
```

| Dossier | Rôle |
|---|---|
| `ui/` | Interface React (Vite, Tailwind v4, shadcn/ui, Motion) |
| `ui/src-tauri/` | Application Windows : fenêtre, barre des tâches, démarrage auto, moteur embarqué |
| `backend/` | Moteur : veille, règles de déclenchement, file de brouillons, API locale |
| `backend/drivers/` | Pilotage de Teams : `windows_uia` (réel) et `mock` (développement) |
| `tools/probe-teams.ps1` | Sonde UIA à lancer sur un poste avec Teams |
| `DESIGN.md` | Spécification et registre des décisions |

## Développer

Moteur (driver simulé, utilisable sur n'importe quel OS) :

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest -q tests
TRAME_DRIVER=mock python run.py          # API sur 127.0.0.1:8731
TRAME_DRIVER=mock TRAME_BRAIN=mock python run.py   # démo hors ligne, sans appel à claude ni à Copilot
```

`TRAME_BRAIN=mock` remplace le cerveau choisi (Claude ou Copilot, y compris après un changement dans les réglages) par un cerveau simulé et déterministe : brouillons plausibles et résumés de conversation (`POST /api/threads/{id}/brief`) construits à partir des conversations d'exemple, sans consommer d'abonnement. La recherche GitHub du résumé reste réelle (lecture seule, via `gh`) tant qu'elle est activée dans les réglages.

Interface :

```bash
cd ui
npm install
npm run dev                              # http://localhost:5173
npm run tauri dev                        # application de bureau (Windows, Rust requis)
```

Sans moteur, l'interface fonctionne avec des données d'exemple. Le build de l'installeur Windows tourne dans GitHub Actions (`build.yml`) : chaque tag `v*` publie une Release avec l'installeur ; voir `ui/src-tauri/README.md`.

## État du projet

Le moteur, l'interface et l'application de bureau sont complets, testés (109 tests backend, CI verte) et le build Windows produit un installeur. Le pilotage réel de Teams (`backend/drivers/windows_uia.py`) doit encore être **calibré sur un poste Windows** : la nouvelle version de Teams change ses éléments d'interface d'une mise à jour à l'autre. La procédure est décrite dans [`docs/SONDE-UIA.md`](docs/SONDE-UIA.md). En attendant, toute étape incertaine échoue du côté sûr : Trame refuse d'écrire plutôt que de risquer la mauvaise conversation.
