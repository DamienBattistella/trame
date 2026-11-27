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

Pour apprendre les **vrais** endpoints, le pont pose un hook **passif** sur `fetch`,
`XMLHttpRequest` **et `WebSocket`**, et n'enregistre que la **structure** des échanges que Teams
émet lui-même :

- requêtes REST (`fetch`/XHR) : méthode, hôte, **gabarit de chemin** (les segments opaques —
  GUID, id de conversation `19:…@thread.v2`, jetons longs — sont **masqués** : `{guid}`,
  `{thread}`, `{id}`, `{n}`), type de réponse (`Content-Type`), statut HTTP, et la **présence**
  (jamais la valeur) d'en-têtes d'auth, par leur **nom** seulement ;
- connexions `WebSocket` : **uniquement l'URL de connexion** (schéma, hôte, chemin masqué) —
  **jamais une frame ni son contenu**. En Teams v2, les messages passent par ce canal (trouter),
  invisible au hook fetch/XHR.

Jamais : valeur d'en-tête, paramètre de requête, corps de requête ou de réponse, frame WebSocket,
contenu de message. Les buffers sont bornés (150 requêtes, 40 sockets).

Le résumé (structure uniquement) sort par l'op existante `diagnose`, donc via l'outil MCP
`diagnose_teams` → `diagnose.page.api_capture` (`endpoints` + `sockets`), ou
`WebBridgeDriver.api_capture()`.

## Découvrir les endpoints en direct

Sur le Trame de l'utilisateur (port 8731, « Teams intégré » connecté), pendant qu'il navigue
dans Teams (ouvrir des conversations, lire un fil, changer de présence…) :

1. appeler l'outil MCP `diagnose_teams` ;
2. lire `diagnose.page.api_capture` :
   - `endpoints` : requêtes REST (fetch/XHR) — `method`, `service`, `host`, `path` (masqué),
     `type`, `status`, `count`, `auth` (noms d'en-têtes) ;
   - `sockets` : connexions WebSocket — `scheme`, `host`, `path` (masqué), `count` (URL de
     connexion seulement, jamais de frame ni de contenu).

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

### ⚠️ Les messages ne sont PAS servis en REST (v2)

Après avoir ouvert et fait défiler des conversations (y compris l'historique profond et une
conversation « froide »), **aucun** endpoint de messages, de fil ou de conversation n'apparaît
dans `endpoints` : rien sur `msg.teams`/chatsvc, ni `/messages`, ni `/conversations`, ni la
présence. Seuls des fetch d'**images**, de **calendrier** et de **réglages** sont émis.

Conclusion : en **Teams v2 web**, la **liste des messages, l'historique et la présence passent
par le canal trouter (WebSocket/long-poll)**, pas par fetch/XHR. Un `webfetch` REST ne peut donc
pas les lire. La capture `sockets` (ajoutée ici) sert à repérer ce canal et, plus tard, le
service de chat ; lire/écrire des messages « par l'API » demanderait de capter ce WebSocket
(bien plus fragile que le DOM) — à arbitrer avant d'implémenter les lectures.

| Action Trame | Voie observée | Faisable en `webfetch` REST ? |
|---|---|---|
| Lister les conversations | trouter (WS) / store client | non (pas de REST observé) |
| Lire un fil + historique | trouter (WS) / store client | non |
| Nouveaux messages | trouter (WS, push) | non |
| Présence (autres / soi) | trouter (WS) probable | non observé en REST |
| Images / pièces jointes | asyncgw (REST) | **oui** |
| Marquer comme lu / réaction / envoi / suppression | trouter (WS) / store client | à confirmer (probablement non REST) |

## Étapes suivantes (PR séparées)

1. **Découverte** : mécanisme `webfetch` + capture `fetch`/XHR (PR initiale), puis capture
   `WebSocket` + endpoints réels documentés (cette PR).
2. **Arbitrage lectures** : la découverte montre que messages/historique/présence passent par le
   WebSocket trouter, pas par REST. Avant d'implémenter des « lectures par l'API », décider :
   - soit capter le canal trouter dans la page (fragile, à évaluer avec la capture `sockets`),
   - soit garder les messages sur le DOM et ne passer par l'API que ce qui est réellement REST
     (images/pièces jointes via asyncgw ; éventuellement réglages/roster via middletier).
3. **Lectures** retenues par l'API de la page, converties vers `backend/models.py`, repli DOM par
   action.
4. **Écritures** (marquer comme lu, réactions, envoi, réponse citée, suppression), uniquement si
   l'envoi peut être **prouvé par une relecture**, en gardant tous les garde-fous de
   `backend/safety.py` (jamais de faux « Envoyé », anti-doublon, titre de conversation).
5. Carte **Réglages › Général › « API Teams web »** (remplace « Microsoft Graph ») : montre, action
   par action, la voie suivie (API page / DOM), via un `routes()` comme le `GraphDriver`.
