# dedalus-teams-agent — DESIGN

Assistant Teams personnel qui pilote le client **Microsoft Teams v2 natif** sur
le poste Windows de l'utilisateur, via **UI Automation**, pour lire les messages
et proposer / envoyer des réponses dans la voix de l'utilisateur (persona).

Ce document est la référence de conception. Il fige les décisions prises en
interview (voir §12). Il n'y a pas de commentaires dans le code : les
explications vivent ici, dans les commits et dans les PR.

---

## 1. Principe directeur

On ne touche **jamais** à l'authentification Microsoft. L'utilisateur ouvre
Teams et se connecte normalement via le portail Entra de son entreprise.
L'agent **conduit la fenêtre Teams réelle**, dans la session déjà ouverte,
exactement comme l'utilisateur le ferait à la main.

Conséquences :
- Aucun appel à Microsoft Graph, aucun jeton emprunté, aucun identifiant
  d'application tiers, aucun clone du client natif.
- Le blocage de consentement administrateur sur `Chat.Read` (constaté sur le
  tenant) devient sans objet : on ne demande rien à Graph.
- C'est de l'automatisation d'interface sur sa propre machine, avec son
  consentement — même catégorie que Power Automate Desktop.

## 2. Contraintes et choix assumés

- **Cerveau** : commutable dans les paramètres. **Claude Code par défaut**
  (priorité), **GitHub Copilot** en alternative.
- **Compte Claude** : OAuth Anthropic, **abonnement Ultra personnel** de
  l'utilisateur. Choix explicite et assumé de l'utilisateur, tracé ici et daté :
  le contenu des messages Teams de l'entreprise transite par son compte
  personnel. Ce n'est pas un défaut technique, c'est une décision prise en
  connaissance de cause (interview, 2026-11-25).
- **Surface UIA instable** : le nouveau Teams est une application WebView2
  (Chromium). L'arbre d'accessibilité expose le DOM, pas des contrôles natifs.
  Les sélecteurs cassent au rythme des mises à jour Teams (~mensuel). **Ce
  n'est pas un logiciel « build-once »** : il demande une maintenance continue.
  Voir §9.

## 3. Architecture

```
┌─────────────────────────────┐   localhost (HTTP/WS)   ┌──────────────────────────┐
│  UI de contrôle (Tauri)     │ ◄─────────────────────► │  Watcher (Python)        │
│  React + shadcn/ui        │                         │  « les mains »           │
│  • Wizard de configuration  │                         │  • UIA Teams (lire/écrire)│
│  • Watchlist + modes        │                         │  • détection nouveaux msg │
│  • File de brouillons       │                         │  • pause + partage d'écran│
│  • Pause / Rattraper / logs │                         │  • file brouillons / auto │
│  • Réglages cerveau/GitHub  │                         └────────────┬─────────────┘
│  • Persona SOUL (drop/edit) │                                      │ invoque
└─────────────────────────────┘                         ┌───────────▼──────────────┐
                                                         │  Cerveau (swappable)      │
                                                         │  claude -p (défaut, Ultra)│
                                                         │  / GitHub Copilot         │
                                                         │  SOUL + N msgs + GitHub    │
                                                         └───────────────────────────┘
```

- **Backend** : watcher Python. Détient toute la logique UIA, la boucle
  d'événements, la file de propositions, la pause, le partage d'écran, le
  rattrapage. Expose une **API locale** (HTTP + WebSocket sur `127.0.0.1`).
- **Frontend** : application desktop **Tauri** (petit binaire natif + icône
  barre des tâches) embarquant une UI **React + shadcn/ui**. Parle au backend
  en local. Développable intégralement hors Windows.
- **Cerveau** : invoqué par le backend. `claude -p` en headless par défaut
  (session Claude Code authentifiée via l'Ultra de l'utilisateur), GitHub
  Copilot en alternative, derrière une interface commune.

## 4. Veille

- **Ciblée** : une *watchlist* composée par sélection dans la liste réelle des
  conversations. Clé de stockage = **identifiant de fil stable**
  (`19:…@thread.v2`), avec **repli sur le nom d'affichage**. L'identifiant est à
  vérifier par build (voir §9) ; le wizard le fait de façon guidée.
- **Toutes surfaces** : DM 1:1, chats de groupe, canaux d'équipe — chacun
  activable indépendamment.
- **Détection** : `StructureChanged` sur le fil ouvert comme signal de réveil,
  puis **diff** contre une empreinte (expéditeur + texte + horodatage) pour
  confirmer un vrai nouveau message ; **poll du badge « non lu »** du rail pour
  les conversations non ouvertes.
- **Au démarrage** : **nouveaux messages seulement**. Pas de rattrapage
  automatique. Un bouton **Rattraper** traite les non-lus à la demande.

## 5. Déclencheur de réaction

- **DM 1:1** : réagit à chaque message entrant.
- **Groupe / canal** : réagit **seulement** sur **@mention de l'utilisateur** ou
  mention d'une **personne nommée** dans la configuration.

## 6. Modes de réponse (par entité)

Deux dimensions **indépendantes** par entité de la watchlist :

| Dimension | Valeurs | Rôle |
|---|---|---|
| **Veille** | on / off | est-ce que je surveille cette entité ? |
| **Mode** | `draft` / `auto` | quand je réagis, brouillon ou envoi ? |

- **Brouillon (`draft`, défaut)** : l'agent **notifie** (toast/son), prépare le
  texte, et ne le **saisit dans la zone de composition que lorsque
  l'utilisateur ouvre ce fil** — il ne détourne jamais la vue en basculant de
  conversation tout seul. Validation = l'utilisateur appuie sur Entrée.
- **Auto (`auto`)** : l'agent saisit **et** envoie, précédé d'un **compte à
  rebours annulable (~5 s)**. L'utilisateur regarde faire et garde un arrêt de
  dernière seconde.
- **Garde-fou mécanique** : **auto-test des sélecteurs au démarrage**. S'il
  échoue, toute entité en `auto` retombe en `draft` pour la session.
- **Bouton Rattraper** : génère **uniquement des brouillons**, même pour les
  entités en `auto` (jamais de rafale d'envois sur un backlog).

## 7. Contexte de rédaction

- **N derniers messages** du fil (configurable, défaut 15), avec report de
  l'auteur quand Teams regroupe les messages consécutifs.
- **GitHub** comme source de contexte :
  - **Lecture seule**. L'agent lit code, issues, PR ; il **n'écrit jamais**
    (pas de commentaire, pas d'issue, pas de commit).
  - Liste de repos **configurable**, **tous actifs par défaut**.
  - Consulté **seulement quand le message le justifie** (sujet repo / code /
    issue détecté), jamais sur un message trivial.
  - Accès via `gh` avec les jetons déjà présents sur le poste.

## 8. Sécurité et contrôle

- **Interrupteur global** de pause (suspend toute la veille d'un coup).
- **Auto-pause en partage d'écran** : l'agent ne saisit rien tant qu'un partage
  d'écran Teams est détecté (sinon une réponse serait visible de toute la
  réunion).
- **Filtre de contenu** : liste de termes qui forcent le brouillon même en
  `auto` (RH, confidentiel, salaire…).
- **Journal** : trace de ce qui est lu, proposé, envoyé.

## 9. Réalité UIA et maintenance

Vérifié (recherche technique, 2026-11-25) :
- **Robuste** : saisir/envoyer dans la zone de composition ; lire le texte brut
  et l'expéditeur d'un message.
- **Fragile et à maintenir** : détection événementielle propre (événements UIA
  bruyants → repli par poll) ; **identité stable des conversations**
  (l'`AutomationId` *devrait* porter le thread-id mais ce n'est pas garanti par
  build).
- **Parade** : couche de **sélecteurs multi-stratégie**
  (`AutomationId` → rôle+Name → clavier/presse-papier), un **canary** qui
  revalide chaque ancre après une mise à jour Teams, **OCR** en dernier recours.
- **Activation paresseuse** : WebView2 ne construit l'arbre d'accessibilité que
  lorsqu'un client UIA se connecte → se connecter tôt et **réessayer jusqu'à ce
  que l'arbre se peuple**.

## 10. Wizard de configuration

Objectif : le plus court chemin vers « ça marche ». Défauts intelligents,
réglages fins repliés sous « Avancé ».

1. **Bienvenue** — détecte si Teams tourne.
2. **Connexion cerveau** — « Se connecter à Claude » (OAuth Ultra) / option Copilot.
3. **Test en direct (sonde UIA guidée)** — « Envoie-toi un message, clique
   *Tester* » → l'appli confirme qu'elle lit le fil et repère la zone de
   composition. Vert = go, rouge = diagnostic. (Remplace la sonde manuelle dans
   Accessibility Insights.)
4. **Watchlist** — la liste réelle des conversations s'affiche, l'utilisateur
   coche qui surveiller.
5. **Mode par entité** — `draft` (défaut) / `auto`.
6. **Persona** — zone de **glisser-déposer** du `SOUL.md` (ou « plus tard », un
   défaut est actif), édition et sélection entre plusieurs personas.
7. **GitHub (optionnel)** — connecter `gh`, tous les repos par défaut.
8. **Récapitulatif + Activer.**

## 11. Modèle de configuration

`config.json` (persisté par l'UI). Schéma de référence : voir le fichier
`config.json` du dépôt. Clés principales : `brain`, `model`, `watchlist`
(entrées `{thread_id, display_name, watch, mode}`), `triggers`, `context`,
`github`, `safety`, `ui`. Le persona est un fichier `SOUL.md` déposé via l'UI
(placeholder par défaut).

## 12. Registre des décisions (interview)

| # | Décision |
|---|---|
| Approche | Pilotage UIA du Teams natif ; ni Graph, ni clone, ni vol de jeton |
| Cerveau | Commutable : Claude Code par défaut, Copilot alternative |
| Compte | Claude via OAuth Ultra **perso** — assumé, pas de restriction données |
| Veille | Continue, ciblée par watchlist (ID de fil stable + repli nom) |
| Surfaces | DM, groupe, canal — toutes, configurables |
| Modes | `draft` + `auto` par entité dès le départ ; auto-test sélecteurs |
| Lecture | Hybride UIA + repli capture multimodale |
| Saisie | Directe dans la compo ; draft = Entrée par l'utilisateur, auto = délai annulable |
| Démarrage | Nouveaux messages seulement + bouton Rattraper (brouillons) |
| Déclencheur | 1:1 = tout ; groupe = @mention / personnes nommées |
| Brouillon | Notifie + saisit à l'ouverture, sans détourner la vue |
| Sécurité | Interrupteur global + auto-pause partage d'écran + filtre + journal |
| Contexte | N derniers msgs + GitHub lecture seule, pertinent, repos tous par défaut |
| UI | Tauri + **shadcn/ui** (Radix + Tailwind) ; panneau complet + wizard court style Apple |
| Marque | Nom produit **Trame** (code : dedalus-teams-agent) ; accent **bleu**, logo bulle + méandre |
| Persona | Drop / édition / sélection dans l'UI ; fourni plus tard |

## 13. Plan de construction

| Phase | Contenu | Où | Développable hors Windows |
|---|---|---|---|
| 0 | Sonde UIA (intégrée au wizard, étape 3) | Poste | non |
| 1 | Backend cœur : UIA lire/écrire + API locale + schéma config | Poste | structure oui, UIA non |
| 2 | Watcher : watchlist, détection, modes, délai, pause/partage, Rattraper | Poste | non |
| 3 | Cerveau : `claude -p` + SOUL + contexte N msgs | Poste | partiel |
| 4 | GitHub lecture seule + pertinence | Poste | oui |
| 5 | UI Tauri + shadcn : panneau complet + wizard + drop persona | Poste | **oui, intégralement** |

L'UI shadcn et une large part du backend se développent hors du poste. Seule la
couche UIA se cale sur la machine (phase 0, le vrai go/no-go).

## Design system (revue de conformité, 2026-11-25)

- **Composants** : shadcn/ui partout où il en existe un (Button, Card, Avatar, Label, Switch, Tabs, DropdownMenu, Sheet, Popover, Tooltip, Kbd, Textarea, Input, ScrollArea, Sonner). Le kit (`components/kit.tsx`) n'ajoute que ce que shadcn n'a pas : contrôle segmenté (radiogroup accessible, flèches), liste groupée façon iOS, pastille d'état, compteur animé.
- **Tokens** : aucune couleur en dur hors logo et illustration. `--primary` sert aux fonds (texte blanc ≥ 4,5:1), `--link` au texte d'accent (≥ 4,5:1 sur fond sombre comme clair), `--success|warning|destructive-foreground` au contenu posé sur ces couleurs.
- **Accessibilité** : audit axe-core WCAG 2 AA sur les 12 écrans, sans violation (hors animations d'apparition). Chaque interrupteur et bouton-icône a un nom accessible.
- **Vocabulaire** : on *suit* une conversation (jamais « surveiller », jamais « watchlist » à l'écran) ; « Résumé » pour le brief ; pas de jargon technique (sélecteurs, wizard) ; pas de flèches ni d'emoji dans les textes ; phrases courtes, deux-points plutôt que tirets.
- **Parcours façon Apple** : une idée par écran, titre court + une phrase, bouton principal unique en bas, « Retour » en haut à gauche, étape facultative encore vide → bouton « Plus tard » en retrait, récapitulatif avant activation.

### Passe anti-slop (skill `antislop-ui` + `antislop-copywriting`, miqdadbadjuber/anti-slop)

Check-list UI appliquée écran par écran ; choix assumés, avec leur raison :

- **Palette** : bleu Trame + neutres zinc + vert/orange/rouge d'état uniquement. Aucun dégradé, verre, lueur ni grille de fond. Le bleu est réservé à l'action principale et au texte d'accent.
- **Rayons** : pilule pour les boutons, onglets et contrôles segmentés (convention macOS/iOS demandée : « style Apple ») ; cartes et listes en `rounded-2xl`. Pas de pilule sur les textes ni les blocs de contenu.
- **Icônes** : Lucide, cohérent avec shadcn ; aucune icône « IA » générique (étoile, baguette). Les logos Claude, Copilot et GitHub sont les vrais logos (simple-icons). Le fantôme du dépôt de `SOUL.md` est une illustration liée au produit (l'« âme »), demandée explicitement.
- **Police** : Segoe UI, police système de Windows, cible unique de l'application.
- **Mouvement** : aucune boucle infinie au repos. Le point « En direct » émet une seule onde à la connexion ; le fantôme flotte et cligne quelques fois puis s'immobilise, et ne s'anime en continu que pendant un glisser-déposer. Seuls les indicateurs de chargement tournent tant qu'une action est en cours.
- **États vides** : chacun dit pourquoi et quoi faire (« Aucune conversation suivie » → « Choisir des conversations » ; recherche sans résultat → « Tout afficher »).
- **Connexion** : l'en-tête ne dit rien quand le moteur répond (pas de « En direct ») ; il ne parle que d'un problème : moteur perdu, une pastille rouge « Hors ligne » (icône + mot, reconnexion en infobulle) ; en démo navigateur, « Données d'exemple » en clair (icône fiole), pas seulement dans une infobulle. Sous 1024 px, faute de place, la pastille garde son icône et sa couleur, le mot passe en infobulle et pour les lecteurs d'écran ; « Hors ligne » garde en plus son bandeau dans le panneau. L'état détaillé reste dans Réglages › Santé, Teams déconnecté ou modifié dans son bandeau du panneau.
- **Mise à jour** : l'en-tête ne montre rien tant que Trame est à jour ; une version publiée fait paraître une icône de téléchargement (bouton fantôme comme le thème) avec une pastille LED d'accent en coin, qui pulse doucement (fixe si le mouvement est réduit) et ne pulse plus pendant l'installation. Infobulle et nom accessible : « Mise à jour 0.x.y disponible — installer ». En démo navigateur, `?update` (ou `?update=0.x.y`) l'affiche.
- **Zone de saisie** : une seule carte (texte, pièces jointes, actions), le focus se lit sur la carte entière. À gauche les outils de rédaction en boutons-icônes avec infobulle (Joindre, Corriger, Vérifier) ; à droite la décision : Ignorer et Proposer en retrait, Envoyer seul en plein. Rien de permanent qui ne sert qu'à l'occasion : les limites des pièces jointes vivent dans l'infobulle du trombone, le filtre du sélecteur et le message de refus ; le rappel clavier n'apparaît que pendant la saisie et s'efface s'il manque de place.
- **Listes d'éléments datés (Réunions)** : la plus récente d'abord, regroupée par période (Aujourd'hui, Hier, Cette semaine, La semaine dernière, Plus tôt ce mois-ci, puis le mois) ; dates courtes (« mar. 24 nov. · 11:00–11:45 · 45 min »), la date omise sous Aujourd'hui et Hier. L'état de chaque ligne se lit dans une pastille d'icône à gauche (disponible, en attente, lecture, enregistrée, incomplète, refusée) avec son libellé en infobulle ; l'action de ligne est un bouton discret qui paraît au survol ou au focus, et le seul bouton visible au repos est « Réessayer » d'une erreur. Une action groupée (« Récupérer les N nouvelles ») plutôt qu'un bouton plein par ligne. Une réunion récurrente porte un repère (icône + nombre) qui filtre ses occurrences. Un chemin long s'affiche abrégé (« Documents › Trame › Transcriptions »), le chemin complet dans une bulle qui permet de l'ouvrir, le copier ou le changer.
- **Textes** : pas de tiret cadratin, d'emoji, de flèche, de majuscules d'emphase ni de synonymes en alternance (« résumé » partout, jamais « brief » à l'écran).

## Largeurs et points de rupture (2026-11-26)

Trame tourne aussi bien en panneau étroit à côté de Teams qu'en fenêtre plein écran sur un poste de bureau. Règle : pas de colonne étroite artificielle, mais une largeur de lecture pour le texte long.

- **Points de rupture** : étroit sous 1280 px (une colonne), moyen à partir de 1280 px (`xl`), large à partir de 1600 px (`3xl`, défini dans `index.css`). Sous 1024 px (`lg`), l'en-tête se resserre jusqu'à la largeur minimale de la fenêtre (720 px) : le logo sans le mot « Trame », les pastilles d'état (connexion, statut Teams, pause) sans leur libellé, gardé en infobulle ou pour les lecteurs d'écran. Rien ne déborde ni ne défile en largeur.
- **Coquille** : Réunions, Journal et Réglages prennent toute la largeur jusqu'à 1600 px (`max-w-[100rem]`), centrés au-delà, avec une marge de 16 à 32 px selon la largeur. Discussions occupe toute la fenêtre (liste à gauche, 288 px, 320 px en large).
- **Texte long** : paragraphes plafonnés autour de 70 à 80 caractères (`max-w-xl` pour une introduction, `max-w-3xl` pour le fil d'une conversation et les volets de réglages faits de textes et d'options).
- **Listes et tableaux** : toute la largeur disponible (Journal, Conversations suivies, Entourage, Santé), et toute la hauteur de la fenêtre pour les listes qui défilent, au lieu d'une hauteur fixe.
- **Réunions en fenêtre moyenne ou large** : liste à gauche, détail de la réunion choisie à droite (384 px, 448 px en large), collé en haut pendant le défilement. Le détail montre le titre entier, la date longue, l'horaire, la durée, l'organisation, la série, et pour la transcription le fichier, les prises de parole, les intervenants et les actions à découvert : Compte-rendu en action principale, Ouvrir, puis en retrait Afficher dans le dossier, Copier le chemin, Récupérer à nouveau. Sans choix, la réunion la plus récente de la liste affichée. En fenêtre étroite, pas de détail : la ligne garde ses actions au survol.
- **Journal** : recherche, niveaux et période sur une seule ligne dès 1024 px ; la liste remplit la hauteur restante de la fenêtre (mise en page flex, son propre défilement). À partir de 1280 px, le niveau s'écrit aussi en clair dans une colonne (Info, Alerte, Envoi, Brouillon). Une ligne longue passe à la ligne, alignée en haut sur l'heure. Pas de panneau de détail : une ligne ne porte que l'heure, le niveau et le texte, déjà affichés en entier.
- **Rien de tronqué qui tiendrait** : le compteur de la barre de Réunions passe à la ligne plutôt que d'être coupé par des points de suspension.

## Teams intégré (expérimental, 2026-11-26)

Option dans Réglages › Avancé, désactivée par défaut. Le pilotage de l'appli Teams par l'accessibilité (UIA) reste le mode normal.

- **Pourquoi** : l'arbre d'accessibilité de Teams v2 n'expose ni sélection ni identifiant stable, et lire une conversation oblige à basculer la vue de l'utilisateur. Une copie de Teams web, pilotée par son DOM, lit et écrit sans jamais toucher sa fenêtre.
- **Pas un navigateur sans interface** : l'accès conditionnel classe généralement ces navigateurs comme plateforme non prise en charge, et Microsoft les détecte. On utilise une vraie fenêtre WebView2 de Trame, connectée une fois de façon interactive, puis masquée.
- **Pont** : script injecté (`ui/src-tauri/teams-bridge.js`) → la page ne peut appeler qu'une commande Tauri, `teams_bridge_reply` (capacité `teams-web` limitée à teams.microsoft.com). Le moteur envoie ses ordres par `/api/teams-web/poll`, relayés par l'interface (`teams_web_eval`), réponses par `/api/teams-web/reply`. Confirmation de la conversation par `document.title`, saisie refusée si la zone n'est pas vide ou si une autre conversation est ouverte.
- **Contreparties assumées et affichées** : deuxième session (nouvel appareil dans les connexions), accusés de lecture possibles, refus possible par l'accès conditionnel. Jamais d'envoi sans clic ou mode Auto.
- **Nouveaux messages** : détectés dans les deux pilotes par le changement d'aperçu dans la liste des conversations (`drivers/preview_watch.py`).

## Vue conversation (2026-11-26)

Inspirée de l'écran de conversation de T3 Code, transposée à une conversation Teams entre personnes.

- **Qui parle** : tes messages à droite, en bulle neutre compacte (`bg-muted`, pas de bleu : le bleu reste à l'action principale et au texte d'accent), heure sous le dernier message d'une série. Les autres à gauche, sans bulle, en pleine largeur de lecture : avatar à initiales, nom et heure sur le premier message d'une série seulement. Une série : même auteur, même jour, moins de 5 minutes entre deux messages ; l'heure des suivants apparaît dans la marge au survol. Corps à 15 px, interligne aéré, largeur de lecture `max-w-3xl`.
- **Jours** : un séparateur fin (« 24/11 », « Hier », « Aujourd'hui ») quand le jour change, déduit de l'heure telle que Teams l'affiche. Un fil qui ne nomme aucun jour n'en a pas.
- **Liens par application** : une adresse reconnue devient une pastille discrète (icône de l'application, libellé court, adresse complète au survol) : GitHub `dépôt#123`, `dépôt@abc1234`, `org/dépôt` ; GitLab `projet!12`, `projet#7` ; Jira `ALL-103` (avec le résumé à côté pour un lien nommé) ; Confluence (titre de la page) ; Teams (réunion, message, conversation, canal) ; SharePoint et OneDrive (nom du fichier) ; Figma. Une clé Jira seule (« ALL-94 ») n'est reconnue que si son projet a déjà été lié dans le fil : jamais « UTF-8 » ni « ISO-8601 ». Une adresse quelconque reste un lien souligné. Pastille en teinte du texte (`foreground/6 %`), jamais en couleur pleine ; seuls les logos gardent leur couleur.
- **Tableaux** : un tableau reçu dans Teams est transcrit en Markdown par le pont (`| a | b |`, ligne de séparation), le Markdown tapé aussi ; l'interface le rend en vrai tableau (en-tête discret, lignes fines, défilement horizontal s'il est large), cellules avec pastilles et `code`. Jamais de HTML injecté : tout est rendu par éléments React.
- **Chronologie** : sur le bord gauche du fil, un trait par message (plus long en tête de série, plus court pour les tiens), le message au milieu de la vue mis en avant. Survol : aperçu (auteur, heure, début du texte) ; clic ou Entrée : saut immédiat, avec un bref halo sur le message (sans halo si les animations sont réduites). Un seul arrêt de tabulation, flèches, Début et Fin. Fil très long : un trait par tranche de messages. Composant maison (`ScrollTimeline`) : shadcn/ui n'en a pas (son `MessageScroller` ne sait que sauter à un message et remplacerait `use-stick-to-bottom`).
