# Trame et les API internes de Teams web

Trame pilote Teams web dans une fenêtre cachée (« Teams intégré ») : aujourd'hui il lit et
clique **dans le DOM** de la page (`ui/src-tauri/teams-bridge.js`). Chaque changement de
l'interface de Teams casse un geste (« Répondre » introuvable, pièce jointe non confirmée,
repère absent).

La voie choisie pour fiabiliser ces actions : faire, **depuis la page**, les mêmes appels
réseau que le client Teams fait déjà — ses **API internes** — en réutilisant la session web
**déjà authentifiée** de l'utilisateur. Pas de Microsoft Graph, pas de demande à la DSI.

> Cette approche **remplace** la voie Microsoft Graph décrite dans
> [`teams-graph.md`](teams-graph.md). Le `GraphDriver` et la carte « Microsoft Graph » des
> réglages seront retirés dans une étape ultérieure.

## Règle absolue : le jeton ne quitte jamais la page

C'est la contrainte qui conditionne tout le reste.

- **Les appels se font dans le script injecté**, avec l'authentification propre de la page
  (cookies/jetons de la session Teams de l'utilisateur). Le moteur n'émet aucun appel réseau
  vers Teams.
- **Rien d'authentifiant ne sort de la page** : ni jeton, ni cookie, ni en-tête
  `Authorization`/`Authentication`/`x-skypetoken`. Ces valeurs ne sont jamais lues pour être
  renvoyées, copiées, stockées, journalisées ni envoyées à la télémétrie. Le moteur ne reçoit
  que des **données métier** (conversations, messages, présence…).
- **On ne fait que ce que le client Teams fait déjà**, pour le compte de l'utilisateur. Aucun
  contournement des contrôles de sécurité du tenant. Si un appel échoue (401, 403, endpoint
  changé), on **retombe sur le chemin DOM** actuel et on le signale — aucune régression.

## Mécanisme

L'« appel API » n'est pas émis par le moteur : c'est une **commande envoyée à la page** via la
file de commandes existante du pont (`/api/teams-web/poll` + `/api/teams-web/reply`). La page
l'exécute avec sa session et ne renvoie que le corps parsé.

### 1. Appel authentifié depuis la page — op `webfetch`

- Côté moteur : `WebBridgeDriver.page_fetch(url, method="GET", body=None, headers=None, json=True)`
  (`backend/drivers/web_bridge.py`).
- Côté page : op `webfetch` dans `teams-bridge.js`. Elle fait
  `fetch(url, { credentials: "include", … })` et ne renvoie que `{ status, contentType, json|text }`.
- **Garde-fous** :
  - **Allowlist d'hôtes** (page *et* moteur, défense en profondeur) : uniquement les services
    que Teams interroge déjà (`teams.microsoft.com`, `*.msg.teams.microsoft.com`,
    `presence.teams.microsoft.com`, `*.asyncgw.teams.microsoft.com`, `substrate.office.com`,
    `teams.cloud.microsoft`, `graph.microsoft.com`, `outlook.office365.com`). Tout autre hôte est
    refusé **avant** l'appel.
  - **https obligatoire.**
  - **Aucun en-tête d'auth transmis** : le moteur retire tout en-tête d'auth des en-têtes
    « métier » avant l'envoi, et la page refuse d'en poser. L'auth reste portée par la page.
  - **Aucun en-tête de réponse renvoyé** (hors `Content-Type`) : seul le corps métier, borné à
    2 Mo, remonte au moteur.
- **Portée actuelle (étape de découverte)** : `credentials: "include"` rejoue les **cookies** de
  la page. Les services qui exigent un **bearer token** (jeton applicatif que Teams garde en
  mémoire, pas dans un cookie) répondront 401 tant que la page ne rejoue pas elle-même cette auth
  — ce rejeu, **entièrement dans la page** (le jeton n'en sort pas), est le sujet de l'étape
  « lectures ». D'ici là, ces actions restent sur le DOM.

### 2. Capture réseau en lecture seule (découverte)

Pour apprendre les **vrais** endpoints, le pont pose un hook **passif** sur `fetch` et
`XMLHttpRequest` et n'enregistre que la **structure** des requêtes que Teams émet lui-même :

- méthode, hôte, **gabarit de chemin** (les segments opaques — GUID, id de conversation
  `19:…@thread.v2`, jetons longs — sont **masqués** : `{guid}`, `{thread}`, `{id}`, `{n}`),
- type de réponse (`Content-Type`) et statut HTTP,
- la **présence** (jamais la valeur) d'en-têtes d'auth, par leur **nom** seulement.

Jamais : valeur d'en-tête, paramètre de requête, corps de requête ou de réponse, contenu de
message. Le buffer est borné (150 entrées).

Le résumé (structure uniquement) sort par l'op existante `diagnose`, donc via l'outil MCP
`diagnose_teams` → `diagnose.api_capture`, ou `WebBridgeDriver.api_capture()`.

## Découvrir les endpoints en direct

Sur le Trame de l'utilisateur (port 8731, « Teams intégré » connecté), pendant qu'il navigue
dans Teams (ouvrir des conversations, lire un fil, changer de présence…) :

1. appeler l'outil MCP `diagnose_teams` ;
2. lire `diagnose.api_capture.endpoints` : chaque entrée donne `method`, `service`, `host`,
   `path` (masqué), `type`, `status`, `count`, `auth` (noms d'en-têtes) ;
3. reporter les endpoints utiles dans le tableau ci-dessous.

### Endpoints repérés

> À compléter à partir d'une capture réelle. Tant que la colonne « Endpoint » n'est pas
> renseignée par une capture, l'action reste sur le DOM.

| Action Trame | Service | Endpoint (gabarit) | Méthode | Auth constatée | Statut |
|---|---|---|---|---|---|
| Lister les conversations | chatsvc / middletier | _(à capturer)_ | GET | _(à capturer)_ | — |
| Lire un fil + historique | chatsvc | _(à capturer)_ | GET | _(à capturer)_ | — |
| Nouveaux messages | chatsvc | _(à capturer)_ | GET/long-poll | _(à capturer)_ | — |
| Présence des autres | presence | _(à capturer)_ | POST | _(à capturer)_ | — |
| Ma présence / statut | presence | _(à capturer)_ | GET/PUT | _(à capturer)_ | — |
| Marquer comme lu | chatsvc | _(à capturer)_ | POST/PUT | _(à capturer)_ | — |
| Réaction | chatsvc | _(à capturer)_ | PUT/POST | _(à capturer)_ | — |
| Envoi / réponse citée | chatsvc | _(à capturer)_ | POST | _(à capturer)_ | — |
| Suppression | chatsvc | _(à capturer)_ | DELETE/PUT | _(à capturer)_ | — |

## Étapes suivantes (PR séparées)

1. **(cette PR) Découverte** : mécanisme `webfetch` + capture en lecture seule + ce document.
2. **Lectures** par l'API de la page (conversations, messages + historique, présence, nouveaux
   messages), converties vers les modèles existants (`backend/models.py`). Repli DOM par action.
3. **Écritures** (marquer comme lu, réactions, envoi, réponse citée, suppression), uniquement si
   l'envoi peut être **prouvé par une relecture**, en gardant tous les garde-fous de
   `backend/safety.py` (jamais de faux « Envoyé », anti-doublon, titre de conversation).
4. Carte **Réglages › Général › « API Teams web »** (remplace « Microsoft Graph ») : montre, action
   par action, la voie suivie (API page / DOM), via un `routes()` comme le `GraphDriver`.
