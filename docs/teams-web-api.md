# Trame et les API internes de Teams web

Trame pilote Teams web dans une fenêtre cachée (« Teams intégré »). À l'origine il lisait et
cliquait **dans le DOM** de la page (`ui/src-tauri/teams-bridge.js`) : chaque changement de
l'interface de Teams cassait un geste (« Répondre » introuvable, pièce jointe non confirmée,
repère absent). Le DOM reste aujourd'hui le repli de chaque action câblée sur l'API.

La voie choisie pour fiabiliser ces actions : faire, **depuis la page**, les mêmes appels
réseau que le client Teams fait déjà — ses **API internes** — en réutilisant la session web
**déjà authentifiée** de l'utilisateur. Pas d'application Microsoft Graph à enregistrer, pas
de demande à la DSI (Graph n'est appelé que dans la page, avec le jeton que Teams y a posé, pour
résoudre un lien de fichier comme Teams le fait).

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
- **Jetons** : `credentials: "include"` rejoue les **cookies** de la page ; avec `sign`, la page
  resigne l'appel avec le bearer que Teams vient de poser sur le même endpoint (même audience),
  gardé **en mémoire de la page** seulement. Le service de chat (§ 3), la présence (§ 7) et le
  middletier utilisent ce même rejeu, entièrement dans la page.

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

### 5. Liste, non-lus et nouveaux messages — op `chatlist`

- La page lit `…/conversations` : liste complète au premier passage (3 pages de 100), ensuite
  **seulement ce qui a changé** (`syncState` rendu au tour précédent), à chaque coup d'œil (5 s).
  Une ligne compacte par conversation : id Teams, sorte (`dm`, `group`, `meeting`, `self`), sujet,
  horizon de lecture (`consumptionhorizon`), dernier message converti comme un message du fil.
- Le nom de l'autre personne d'un tête-à-tête est demandé au middletier du locataire
  (`beta/users/fetchShortProfile`, bearer de Teams, gardé en mémoire de la page).
- **La liste visible reste celle de la page** (noms, ordre, présence, favoris) et **aucun
  identifiant de Trame ne change** (`title-19:…` pour les groupes, `name:…` pour les tête-à-tête :
  rien à migrer). `WebApiDriver` relie chaque conversation de la page à son id Teams : directement
  pour les groupes, par le nom pour les tête-à-tête (jamais deux homonymes). Il en tire :
  - l'id Teams des tête-à-tête (`chat_aliases`) : leur fil se lit aussi sans les ouvrir ;
  - les **non-lus** : dernier message d'un autre plus récent que l'horizon de lecture ;
  - les **nouveaux messages** : changement du dernier message, avec texte complet, id et auteur
    exact ; jamais les miens ni les événements, jamais de rafale au démarrage.
- **Liste complétée** : la page ne dessine que les lignes qu'elle a chargées. Trame y ajoute, depuis
  le service, les groupes nommés et les tête-à-tête (nom porté par une seule conversation) actifs
  depuis 30 jours que la page n'a pas montrés, 150 au plus, sous les ids que la page leur
  donnerait (`title-19:…`, `name:…`) : rien à migrer quand la page les montre ensuite. Ils sont
  reliés par construction (lecture, nouveaux messages, gestes par le service). Groupes sans sujet
  (la page les nomme par leurs membres), conversations masquées, vides ou plus anciennes : non.
- Les conversations non reliées gardent la détection par aperçu de la page. Si le service refuse,
  tout repasse par la page (aperçus suivis en continu : pas de rafale), puis la synchro repart
  d'une liste complète.
- Diagnostic (`teams_web.chat_map`) : comptes par sorte, conversations reliées, non-lus (ids et
  horizon seulement).

### 6. Gestes — op `chatgesture`

Requêtes relevées dans le code de Teams, faites dans la page avec la session du chat :

| Geste | Requête |
|---|---|
| marquer comme lu | `PUT …/conversations/{id}/properties?name=consumptionhorizon` `{"consumptionhorizon": "<arrivée du dernier>;<maintenant>;<clientmessageid ou id>"}` |
| réaction | `PUT …/messages/{mid}/properties?name=emotions` `{"emotions": {"key": "like", "value": <maintenant>}}` |
| suppression | `DELETE …/messages/{mid}?behavior=softDelete` |
| masquer / réafficher | `PUT …/conversations/{id}/properties?name=hidden` `{"hidden": "true" \| "false"}` (archivage de Trame, option « Masquer aussi dans Teams ») |
| envoi | `POST …/conversations/{id}/messages` (`RichText/Html`, `clientmessageid` de 19 chiffres) |
| réponse citée | même envoi, précédé de `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="{mid}"><strong itemprop="mri" itemid="{mri}">{nom}</strong><span itemprop="time" itemid="{ms}"></span><p itemprop="preview">{extrait}</p></blockquote>` (format du composeur de Teams) |
| mentions | même envoi : un `<span itemscope itemtype="http://schema.skype.com/Mention" itemid="{n}">{mot}</span>` par mot du nom (comme Teams v2), et `properties.mentions` = JSON `[{"@type": "http://schema.skype.com/Mention", "itemid": n, "mri": …, "mentionType": "person", "displayName": "{mot}"}]` |

- **Avant d'écrire**, la page vérifie la cible : message retrouvé par son id, même auteur et
  même début de texte que ce que l'utilisateur a vu ; pour supprimer, un de SES messages.
- **Après**, elle prouve le geste en relisant le service (horizon, réaction, `deletetime`, message
  retrouvé par son `clientmessageid`). Une seule tentative, sur une seule adresse du service :
  jamais rejouée.
- Réponses : `ok` prouvé ; `attempted: false` rien n'est parti, la page fait le geste comme avant ;
  `uncertain` parti sans preuve, remonté comme `SendUncertain` / `ReactUncertain` /
  `DeleteUncertain` et jamais refait (les garde-fous du moteur s'appliquent : anti-doublon,
  « vérifie dans Teams avant de renvoyer »).
- Passent par le service : l'envoi d'un texte simple, en réponse citée (message cité vérifié
  comme pour une réaction, citation relue pour prouver l'envoi) ou avec des mentions, la
  réaction, la suppression, le marquage comme lu, la modification. Restent sur la page : la
  saisie sans envoi (brouillon), les pièces jointes, et la réponse à un message sans id Teams.
- **Mentions** : chaque nom doit désigner UNE personne présente dans la conversation (l'autre
  personne d'un tête-à-tête, ou un auteur des 200 derniers messages du fil) ; jamais une
  recherche dans l'annuaire. Absent ou homonymes : rien ne part, la page mentionne comme avant.
  Prouvées quand chaque nom se relit mentionné.
- **Écrire exige une correspondance forte** : id Teams contenu dans l'id de la page (groupes),
  conversation avec soi-même, ou tête-à-tête relié par son nom ET par le même début de texte ou
  la même heure à la minute. Relié au jour près seulement : lecture par le service, gestes par la
  page.

### 7. Présence, note de statut, recherche de personnes — op `teamspeople`

Le **bearer middletier** que Teams pose lui-même (audience `api.spaces.skype.com`) ouvre aussi le
service de présence et la recherche de personnes (vérifié en direct : 200 ; le jeton du chat, lui,
y est refusé).

| Fonction | Requête |
|---|---|
| mon statut et ma note | `GET https://presence.teams.microsoft.com/v1/me/presence` |
| présence d'autres personnes | `POST …/v1/presence/getpresence/` `[{"mri": …}]` (100 au plus) |
| note de statut | `PUT …/v1/me/publishnote` `{"message": "<p>…</p>", "expiry": "…Z"}` |
| changer mon statut | `PUT …/v1/me/forceavailability/` `{"availability": "DoNotDisturb", "desiredExpirationTime": "…Z"}` (Hors ligne : `"activity": "OffWork"` en plus) |
| réinitialiser mon statut | `PUT …/v1/me/forceavailability/` sans corps |
| recherche de personnes | `POST {middletier}/beta/users/searchV2?…&source=newChat` corps : la requête en chaîne JSON |

- La note est stockée en **HTML** : lue en texte avec l'extracteur des messages, écrite en un
  paragraphe comme Teams. Son **échéance est conservée** (« jamais » vaut `9999-12-30T23:00:00Z`
  à Paris) ; écrite puis relue.
- Présence des tête-à-tête : pour **toute** la liste (la page ne voit que les lignes dessinées),
  par l'interlocuteur connu grâce à `chatlist`, au plus une fois par minute.
- **Changement de statut** (Disponible, Occupé, Ne pas déranger, De retour bientôt, Absent, Hors
  ligne, Réinitialiser), requête relevée dans le code de Teams (`setPresence` / `resetPresence`).
  Prouvé en relisant `me/presence` : `forcedAvailability` doit porter le statut choisi et la même
  échéance (l'activité du moment, une réunion, peut s'afficher par-dessus : ce n'est pas un échec).
  Durées en heure locale : 30 min, 1 h, 2 h ; « aujourd'hui » jusqu'à 23:59:59 ; « cette semaine »
  jusqu'à dimanche 23:59:59 ; « Personnalisé » à l'heure donnée. Rien n'est parti ou refus net : le
  menu de la page, comme avant ; parti sans preuve : jamais refait (« vérifie dans Teams »).
- **Nouvelle conversation** : la personne est trouvée par la recherche de Teams (un seul nom
  identique, sinon la page), puis SON tête-à-tête : dans la liste du service de chat, sinon par
  son id calculé comme Teams (`19:{guid A}_{guid B}@unq.gbl.spaces`, guids triés), sinon créé
  comme Teams le fait (`POST {chatService}/v1/threads` `{"members": [{"id": …, "role": "Admin"}…],
  "properties": {"threadType": "chat", "chatFilesIndexId": "2", "fixedRoster": true,
  "uniquerosterthread": true}}` : un seul fil par paire, jamais de doublon), puis relu. Aucun
  message n'est envoyé ; rien n'est ouvert dans la page. La conversation reste reliée au service
  (lecture et écriture) même si la page ne la montre pas. Tout échec : la page, comme avant.
- **Recherche de messages** : la recherche de Teams passe par `substrate.office.com`, depuis un Web
  Worker, avec un jeton que la page n'expose pas. « Chercher aussi dans Teams » se fait donc en
  deux étapes : d'abord Trame cherche lui-même sur le service de chat (op `chatsearch`) dans les
  200 derniers messages des 40 conversations les plus récentes, chaque mot de la requête présent
  (casse et accents ignorés), au plus 8 lectures par seconde, rien d'ouvert dans la page (donc
  aussi pendant un partage d'écran) ; chaque résultat porte l'id de sa conversation. Puis, à la
  demande, « Chercher dans tout l'historique de Teams » lance la recherche de Teams par la page.
  Service indisponible : la recherche de Teams directement.

### 8. Sonde des conversations de réunion — op `meetingshapes`

Pour câbler les réunions sur le service de chat, il faut savoir quel message porte la carte
« La réunion est terminée » de la page (son `data-mid`). Le code de Teams ne suffit pas à le dire :
l'outil MCP `diagnose_teams` avec `meetings=true` rend la **structure** des 3 conversations de réunion
les plus récentes (id et type de chaque message, balise racine et balises du contenu, noms des
propriétés, clés de `threadProperties.meeting`) et les ids des cartes de récapitulatif affichées.
Jamais un texte, un nom ou une valeur.

### 9. Réunions terminées — op `chatmeetings`

Relevé en direct avec la sonde (§ 8) le 27/11/2026 : dans une conversation de réunion, chaque
occurrence laisse un `Event/Call` de début (`<partlist …>` avec `meetingdetails`, `starttime`,
`endtime`, `icaluid`, `hasephemeraltranscript`), un `Event/Call` de fin (`<ended/>…`), un
`RichText/Media_CallTranscript` quand elle est transcrite, et des `RichText/Media_CallRecording`.
La carte « La réunion est terminée » de la page porte l'**id du message de fin** (même `mid`,
vérifié sur deux réunions) : la liste se lit sur le service, sans ouvrir les conversations, et la
lecture des transcriptions par la page reste valable. Créneau : les heures prévues (`starttime`,
`endtime`), sinon les heures réelles ; transcrite si un message de transcription tombe entre le
début et 10 min après la fin. Service indisponible : la page, comme avant.

Toutes les sortes de réunion : en plus des conversations de réunion planifiée (`19:meeting_…`, les 12
plus récentes), les groupes nommés et tête-à-tête actifs depuis 30 jours (les 12 plus récents) sont
relus pour leurs appels (« Réunion maintenant », réunion planifiée dans un groupe existant, appel
transcrit) : mêmes `Event/Call`. Hors des conversations de réunion, seuls les appels **transcrits**
sont gardés. Jusqu'à 3 pages de 200 messages par conversation (`backwardLink`). Le nom de la
conversation est retenu pour que la page l'ouvre ensuite (aussi après un redémarrage du moteur,
depuis la liste gardée sur le poste). Les réunions de canal (`@thread.tacv2`) ne sont pas couvertes :
la page ne sait ouvrir que les conversations de la liste de Chat.

## Étapes suivantes (PR séparées)

1. ~~Découverte~~ (`webfetch`, capture fetch/XHR/WebSocket, signature en page).
2. ~~Session chatsvc dans la page~~ (#121).
3. ~~Lectures~~ : lecture d'un fil (#122), liste, non-lus et nouveaux messages (#127).
4. ~~Écritures simples~~ (#128), ~~réponse citée~~ (#138), ~~mentions~~.
5. ~~Présence, mon statut, note, recherche de personnes~~ (#135), ~~changement de statut~~ ;
   ~~nouvelle conversation~~ (#142, #144), ~~recherche dans les fils récents~~ (#146), ~~liste
   complétée par le service~~, ~~masquer dans Teams~~ ; restent les réunions et les transcriptions.
6. ~~Contrôle des repères limité aux actions restées sur la page~~ (#130).
