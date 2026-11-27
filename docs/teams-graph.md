# Trame et Microsoft Graph

> **Obsolète.** Cette voie (Microsoft Graph + enregistrement par la DSI) a été remplacée par
> l'approche « API Teams web » : Trame s'appuie sur la session Teams web déjà authentifiée de
> l'utilisateur, en signant les appels **dans la page** (le jeton ne la quitte jamais). Voir
> [`teams-web-api.md`](teams-web-api.md). La carte « Microsoft Graph » des réglages est remplacée
> par « API Teams web » (`WebApiDriver`). Le code Graph restant (`backend/drivers/graph.py`,
> `backend/msgraph/`, endpoints `/api/graph`) n'est plus utilisé par défaut et sera retiré.

Trame pilote aujourd'hui Teams web dans une fenêtre cachée : il lit et clique dans la page
(« Teams intégré »). Ça marche, mais chaque changement de la page de Teams casse un geste
(« Répondre » introuvable, pièce jointe non confirmée, repères absents).

La voie supportée par Microsoft pour faire la même chose est **Microsoft Graph**, avec une
application enregistrée dans le tenant de l'entreprise et des **permissions déléguées** : Trame agit
au nom de l'utilisateur connecté, avec ses droits, rien de plus. Ce document fait le point action par
action et contient la demande à faire à la DSI.

Ce que Trame ne fait pas et ne fera pas : lire, copier ou réutiliser les jetons de la page Teams web,
ni appeler les routes internes de Teams. Seul Graph, avec la connexion propre à l'application Trame.

## Principe

- **Connexion** : bouton « Se connecter à Microsoft Graph » dans Réglages › Teams. Connexion
  Microsoft standard dans le navigateur (MSAL, client public, PKCE, pas de secret). Le cache de jetons
  est chiffré pour la session Windows (DPAPI) dans le dossier de données de Trame ; « Se déconnecter »
  l'efface.
- **Par action** : si Graph est connecté et autorisé pour l'action, Trame passe par Graph ; sinon,
  ou si Graph répond une erreur, il garde le chemin actuel (page Teams). Réglages › Général et
  `diagnose_teams` (MCP) disent, action par action, quelle voie a servi.
- **Données** : tout reste sur le poste. Les réponses de Graph ne sont jamais journalisées en clair
  (même règle que le texte des messages aujourd'hui).

## Action par action

| Action Trame | Aujourd'hui (page) | Graph (v1.0) | Permission déléguée |
|---|---|---|---|
| Lister les conversations | liste de gauche | `GET /me/chats?$expand=members,lastMessagePreview` | Chat.ReadBasic / Chat.Read |
| Lire un fil, historique | défilement du fil | `GET /chats/{id}/messages?$top=50` (+ `@odata.nextLink`) | Chat.Read |
| Pièces jointes reçues | liens de la page | `attachments[].contentUrl` du message | Chat.Read (+ Files.Read pour ouvrir) |
| Images reçues | vignettes | `GET /chats/{id}/messages/{mid}/hostedContents/{hid}/$value` | Chat.Read |
| Nouveaux messages | aperçus de la liste | interrogation de `lastMessagePreview` des chats (pas de webhook : Trame n'expose rien sur Internet) | Chat.Read |
| Marquer comme lu | ouvrir la conversation | `POST /chats/{id}/markChatReadForUser` | Chat.ReadWrite |
| Présence des autres | pastilles | `POST /communications/getPresencesByUserId` | Presence.Read.All |
| Ma présence | menu profil | `GET /me/presence` | Presence.Read |
| Changer mon statut (durée) | menu statut | `POST /me/presence/setUserPreferredPresence` | Presence.ReadWrite |
| Message de statut | menu statut | `POST /me/presence/setStatusMessage` | Presence.ReadWrite |
| Envoyer un message | saisie + bouton | `POST /chats/{id}/messages` (relu ensuite : preuve d'envoi = id renvoyé) | ChatMessage.Send |
| Mentions @ | saisie assistée | `mentions[]` du message | ChatMessage.Send |
| Répondre en citant | menu « Répondre » | pièce jointe `messageReference` vers le message cité | ChatMessage.Send |
| Réactions | barre de survol | `POST /chats/{id}/messages/{mid}/setReaction` / `unsetReaction` | Chat.ReadWrite |
| Supprimer mon message | menu « … » | `POST /users/{me}/chats/{id}/messages/{mid}/softDelete` | Chat.ReadWrite |
| Envoyer un fichier | menu Joindre | dépôt OneDrive (`PUT /me/drive/root:/Microsoft Teams Chat Files/{nom}:/content`) puis pièce jointe `reference` | Files.ReadWrite + ChatMessage.Send |
| Nouvelle conversation | « Nouveau message » | `POST /chats` (`oneOnOne`) | Chat.Create |
| Chercher une personne | champ « À » | `GET /me/people?$search=` | People.Read, User.ReadBasic.All |
| Chercher dans les messages | recherche Teams | `POST /search/query` (`entityTypes: chatMessage`) | Chat.Read |
| Réunions avec transcription | onglet Récapitulatif | `GET /me/events` (réunions en ligne) → `GET /me/onlineMeetings?$filter=JoinWebUrl eq '…'` → `GET /me/onlineMeetings/{id}/transcripts` | Calendars.Read, OnlineMeetings.Read, OnlineMeetingTranscript.Read.All |
| Transcription .vtt | lecture du récapitulatif | `GET /me/onlineMeetings/{id}/transcripts/{tid}/content?$format=text/vtt` | OnlineMeetingTranscript.Read.All |
| Indicateur de frappe | page | **pas d'équivalent** : reste sur la page | — |
| Partage d'écran en cours (pause auto) | page | **pas d'équivalent** : reste sur la page | — |
| Rejoindre une réunion | bouton | lien `joinWebUrl` ouvert dans Teams | OnlineMeetings.Read |

Avec Graph, 22 actions sur 24 passent par l'API ; seules l'indicateur de frappe et la détection du
partage d'écran restent sur la page.

## Avancement

Quand Graph est connecté, **22 actions sur 24** passent par lui :

- **Lecture** : conversations, fils et historique, fichiers et images reçus, nouveaux messages,
  rattrapage des non-lus, présence des autres, mon statut, recherche de personnes et de messages.
- **Écriture** : marquer comme lu, réactions, suppression de mes messages, statut et message de
  statut, envoi, mentions, réponse citée, fichiers (déposés sur OneDrive, partagés en lecture avec
  les membres de la conversation sans courriel d'invitation), nouvelle conversation.
- **Réunions** : liste, transcriptions .vtt, lien « Rejoindre ».

Restent sur la page : **l'indicateur de frappe** et **la détection du partage d'écran**, qui n'ont
pas d'équivalent dans Graph, et la saisie sans envoi (Graph envoie, il n'écrit pas dans la zone de
saisie de Teams).

La voie réellement suivie s'affiche action par action dans Réglages › Général › Microsoft Graph
et dans `diagnose_teams`.

## Ordre de mise en œuvre

1. **Connexion et lectures** : conversations, messages, pièces jointes, présence, recherche.
   Aucun risque d'écriture ; repli sur la page si Graph n'est pas connecté.
2. **Écritures simples** : marquer comme lu, réactions, statut et message de statut.
3. **Écritures sensibles** : envoi, mentions, réponse citée, suppression, fichiers, nouvelle
   conversation. Mêmes garde-fous qu'aujourd'hui (`backend/safety.py`) ; preuve d'envoi : Graph
   renvoie l'identifiant du message créé, Trame le relit avant de dire « Envoyé ».
4. **Réunions** : liste et transcriptions .vtt par Graph.

Tant que l'application n'est pas consentie dans le tenant, tout continue de passer par la page.

## Demande à la DSI

> **Objet : enregistrement d'une application Microsoft Graph pour Trame (assistant Teams local)**
>
> Bonjour,
>
> Dans le cadre de mon rôle de Champion IA, j'utilise Trame, une application de bureau qui m'aide à
> suivre mes conversations Teams et à préparer mes réponses. Elle fonctionne aujourd'hui en pilotant
> Teams web, ce qui est fragile. Je souhaite la faire passer par Microsoft Graph, la voie supportée.
>
> Je demande l'enregistrement d'une application dans le tenant, ou l'autorisation de l'enregistrer :
>
> - **Type** : application cliente publique (bureau), connexion de l'utilisateur, **permissions
>   déléguées uniquement** (aucune permission d'application, aucun secret). Redirection :
>   `http://localhost` (flux interactif MSAL avec PKCE).
> - **Permissions déléguées** : `User.Read`, `User.ReadBasic.All`, `People.Read`, `Chat.ReadWrite`,
>   `Chat.Create`, `ChatMessage.Send`, `Presence.Read.All`, `Presence.ReadWrite`, `Files.ReadWrite`,
>   `Calendars.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`.
>   Certaines demandent le consentement d'un administrateur.
> - **Périmètre** : uniquement mon compte, pour mes propres conversations et réunions. L'application
>   peut être limitée à mon utilisateur (affectation requise) et soumise à l'accès conditionnel habituel.
> - **Données** : traitées localement sur mon poste ; le cache de jetons est chiffré pour ma session
>   Windows ; aucune donnée n'est envoyée à un service tiers par Trame lui-même. Les réponses
>   proposées passent par l'assistant IA déjà autorisé dans l'entreprise.
> - **Contrôle** : aucune écriture sans action de ma part ou réglage explicite ; journal local des
>   actions ; révocation possible à tout moment depuis Entra ID.
>
> Je reste disponible pour en discuter et adapter la liste des permissions au strict nécessaire.
