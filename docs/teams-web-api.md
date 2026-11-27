# Trame et les API internes de Teams web

Trame pilote Teams web dans une fenêtre cachée (« Teams intégré ») : aujourd'hui il lit et
clique **dans le DOM** de la page (`ui/src-tauri/teams-bridge.js`). Chaque changement de
l'interface de Teams casse un geste (« Répondre » introuvable, pièce jointe non confirmée,
repère absent).

La voie choisie pour fiabiliser ces actions : faire, **depuis la page**, les mêmes appels
réseau que le client Teams fait déjà — ses **API internes** — en réutilisant la session web
**déjà authentifiée** de l'utilisateur. Pas de Microsoft Graph, pas de demande à la DSI.

> Cette approche **a remplacé** l'ancienne voie Microsoft Graph : le `WebApiDriver` et la carte
> « API Teams web » des réglages ont pris la place du `GraphDriver` et de la carte « Microsoft
> Graph » (code Graph et `msgraph/` retirés).

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

Pour apprendre les **vrais** endpoints, le pont pose un hook **passif** sur `fetch`,
`XMLHttpRequest` **et `WebSocket`**, et n'enregistre que la **structure** des échanges que Teams
émet lui-même :

- requêtes REST (`fetch`/XHR) : méthode, hôte, **gabarit de chemin** (les segments opaques —
  GUID, id de conversation `19:…@thread.v2`, jetons longs — sont **masqués** : `{guid}`,
  `{thread}`, `{id}`, `{n}`), type de réponse (`Content-Type`), statut HTTP, et la **présence**
  (jamais la valeur) d'en-têtes d'auth, par leur **nom** seulement ;
- connexions `WebSocket` : l'URL de connexion (schéma, hôte, chemin masqué) ; **et la STRUCTURE
  des frames** (sens entrant/sortant, taille, et pour une frame JSON les **noms de clés** — chemins,
  clés dynamiques masquées `{guid}`/`{id}`/`{n}`/`{k}`). **Jamais une valeur, jamais le contenu d'un
  message.** Trouter ne fait que prévenir (push) ; les messages eux-mêmes sont relus en REST
  depuis un Web Worker (voir plus bas).

Jamais : valeur d'en-tête, paramètre de requête, corps de requête ou de réponse, **valeur** d'une
frame WebSocket, contenu de message. Les buffers sont bornés (150 requêtes, 40 sockets, 80 formes de
frames).

Le résumé (structure uniquement) sort par l'op existante `diagnose`, donc via l'outil MCP
`diagnose_teams` → `diagnose.page.api_capture` (`endpoints` + `sockets` + `frames`), ou
`WebBridgeDriver.api_capture()`.

## Découvrir les endpoints en direct

Sur le Trame de l'utilisateur (port 8731, « Teams intégré » connecté), pendant qu'il navigue
dans Teams (ouvrir des conversations, lire un fil, changer de présence…) :

1. appeler l'outil MCP `diagnose_teams` ;
2. lire `diagnose.page.api_capture` :
   - `endpoints` : requêtes REST (fetch/XHR) — `method`, `service`, `host`, `path` (masqué),
     `type`, `status`, `count`, `auth` (noms d'en-têtes) ;
   - `sockets` : connexions WebSocket — `scheme`, `host`, `path` (masqué), `count` ;
   - `frames` : structure des frames WebSocket — `host`, `dir` (`in`/`out`), `shape` (noms de
     clés masqués), `count`, `minLen`/`maxLen`. Jamais de valeur ni de contenu de message.

### Endpoints REST observés (Teams v2, `teams.cloud.microsoft`, EMEA)

Capture réelle (lecture seule : liste, lecture de fils, scroll d'historique). Tous en `GET`
sauf mention, la plupart avec `authorization` (bearer), parfois `x-skypetoken`.

| Service | Hôte | Endpoint (gabarit) | Auth | Rôle |
|---|---|---|---|---|
| teams | `teams.microsoft.com` | `/trap/tokens` | authorization | jetons |
| config | `config.teams.microsoft.com` | `/config/v1/Skype/…`, `/config/v1/MicrosoftTeams/…` | — | configuration |
| middletier | `teams.cloud.microsoft` | `/api/mt/part/emea-03/beta/me/settings/{id}` | authorization | réglages |
| middletier | `teams.cloud.microsoft` | `/api/mt/part/emea-03/beta/usersettings/{id}` | authorization | réglages |
| middletier | `teams.cloud.microsoft` | `/api/mt/part/emea-03/beta/users/tenantsv2` | authorization | tenants |
| middletier | `teams.cloud.microsoft` | `/api/mt/part/emea-03/beta/sharepoint/sites/validSites` | authorization + x-skypetoken | SharePoint |
| middletier | `teams.cloud.microsoft` | `POST /api/mt/part/emea-03/beta/users/{guid}/cookiev2` | authorization | cookie |
| asyncgw | `eu-prod.asyncgw.teams.microsoft.com` | `/v1/{guid}/objects/{id}/views/imgo`, `/views/thumbnail_small`, `/urlp/v1/url/content` | authorization | images / aperçus de liens |
| asyncgw | `eu-prod.asyncgw.teams.microsoft.com` | `POST /v1/skypetokenauth`, `POST /v1/{guid}/aadtokenauth` | authorization | échange de jetons |
| graph | `graph.microsoft.com` | `/v1.0/me/events*`, `/v1.0/domains/` | authorization | calendrier, domaines |

### Canal temps réel (WebSocket)

| Hôte | Rôle |
|---|---|
| `go-eu.trouter.teams.microsoft.com` | canal push « trouter » (mise en place vue en REST : `GET /`) |

### Les messages passent par le REST du service de chat, depuis un Web Worker

La première capture n'avait vu **aucun** endpoint de messages, et on en avait conclu à tort que
messages, historique et présence passaient par le WebSocket trouter. En réalité, Teams v2 fait
ces appels depuis un **Web Worker** (scripts `precompiled-web-worker-inner~*.js`, visibles dans
le cache de la WebView) : le hook `fetch`/XHR de la fenêtre ne les voit pas. Ces scripts
contiennent l'API REST classique du service de chat :

| Rôle | Endpoint (gabarit) |
|---|---|
| jeton du chat | `POST https://teams.microsoft.com/api/authsvc/v1.0/authz` (bearer `api.spaces.skype.com`) → `tokens.skypeToken`, `regionGtms.chatService` / `chatServiceAfd` |
| liste des conversations | `GET {chatService}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=…` |
| une conversation | `GET {chatService}/v1/users/ME/conversations/{id}` |
| messages d'un fil | `GET {chatService}/v1/users/ME/conversations/{id}/messages?pageSize=…` |
| lu / non lu | `properties?name=consumptionhorizon` |

Les appels au service de chat portent l'en-tête `Authentication: skypetoken=<jeton>`. Trouter
ne sert qu'au **push** (frames texte, pas JSON) : il prévient, le client relit en REST.

### 3. Session du service de chat dans la page — op `chatsvc`

- La page ouvre **sa propre session**, comme le client : elle reprend le bearer middletier que
  Teams vient de poser (`/api/mt/…`, audience `api.spaces.skype.com`), l'échange via `authz`,
  et garde **en mémoire de la page** le jeton du chat et l'adresse régionale. Renouvelée
  5 minutes avant l'expiration, et une fois sur un 401.
- Côté moteur : `WebBridgeDriver.chat_get(path, query)` ; `chat_conversation_path(thread_id)`
  encode l'id comme le client.
- **Garde-fous** : liste blanche de chemins (liste, conversation, messages, message) et de
  paramètres (`view`, `pageSize`, `startTime`, `targetType`, `syncState`), appliquée par la page
  **et** par le moteur ; lecture seule (GET) à ce stade ; le moteur ne reçoit que le corps
  métier, jamais le jeton ni l'adresse signée.
- **Auto-test** : `diagnose` → `chatsvc_selftest` = `{ ok, status, stage, region }` (étape
  atteinte : `bearer` → `authz` → `chatsvc` → `ok`), au plus toutes les 5 minutes. Visible dans
  la carte « API Teams web » (ligne « Service de chat ») et dans `/api/teams-web`.

### 4. Lecture d'un fil sans ouvrir la conversation — op `chatread`

- La page lit `…/conversations/{id}/messages` page par page (lien `backwardLink`, paramètres
  permis seulement), jusqu'à `last` messages ou au-delà de `since`, puis convertit chaque message
  **dans la page** vers la forme de l'op `read` (DOM) : même extracteur de texte, liens et cartes
  (`message-parts`, rejoué sur le HTML du message), heure affichée comme dans Teams, réactions de
  l'utilisateur (son identifiant est lu dans le jeton du chat, qui reste dans la page), fichiers
  (`properties.files`), aperçus de liens (`properties.links`), images AMS en miniatures. Les
  événements du fil (ajout de membre, appel) sont ignorés.
- Côté moteur : `WebBridgeDriver.read_history_api`, puis `WebApiDriver.read_history_direct`, qui
  note la voie suivie (`routes()["read"]`). Le moteur l'essaie **avant** d'ouvrir la conversation
  (historique d'un fil, contexte des brouillons) ; s'il échoue, ou pour une conversation sans id
  Teams, il lit la page comme avant.
- Effet : lire un fil ne change plus la conversation affichée dans la fenêtre Teams et ne la
  marque plus comme lue.

## Étapes suivantes (PR séparées)

1. ~~Découverte~~ (`webfetch`, capture fetch/XHR/WebSocket, signature en page).
2. ~~Session chatsvc dans la page~~ (#121).
3. **Lectures** : lecture d'un fil (cette PR) ; puis liste et non-lus, surveillance des nouveaux
   messages (sondage `syncState`), repli DOM par action.
4. **Écritures prouvées par relecture** : marquer comme lu (`consumptionhorizon`), réactions
   (`properties?name=emotions`), envoi (relu par `clientmessageid`), réponse citée, suppression,
   avec tous les garde-fous de `backend/safety.py`.
5. Présence et statut, note, recherche (personnes, messages), nouvelle conversation.
6. **Contrôle des repères** : ne vérifier que les repères des actions restées sur la page.
