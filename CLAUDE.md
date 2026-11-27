# Trame — règles pour les agents

## Réglages : une mise à jour ne perd jamais rien

Une mise à jour de Trame ne supprime ni ne modifie aucune option ou aucun paramètre réglé par l'utilisateur. Seule exception : une restructuration des réglages, et elle migre alors la valeur existante.

- **Où vivent les réglages :** `config.json` dans `%APPDATA%\Trame` (`backend/config.py`). Il n'est copié depuis le paquet qu'au premier lancement, jamais écrasé ensuite ; l'installeur et l'updater n'y touchent pas.
- **Valeurs par défaut :** elles ne s'appliquent qu'à un champ absent. Une valeur enregistrée l'emporte toujours.
- **Enregistrement (`backend/settings.py`, `apply`) :** chaque section est fusionnée, jamais remplacée. Une clé inconnue (écrite à la main ou par une autre version) doit survivre à un enregistrement.
- **Restructuration (champ renommé, déplacé ou découpé) :** une migration explicite reporte l'ancienne valeur au nouvel emplacement ; jamais de retour au défaut.
- **Changer un défaut :** ne doit pas réécrire une valeur déjà enregistrée.
- **Préférences d'interface :** tout choix de l'utilisateur (tri, vue, interrupteur) est persisté dans la section `ui` de `config.json`, pas seulement dans un `useState`. Il passe par `UiSettings` / `UiPatch` côté backend et `Settings.ui` dans `ui/src/api.ts`.
- **Seule remise à zéro admise :** `factory_reset`, déclenchée explicitement par l'utilisateur.
- **Tests :** toute évolution des réglages ajoute un test qui vérifie qu'une valeur ou une clé existante survit (voir `test_settings_save_keeps_keys_it_does_not_know` dans `backend/tests/test_api.py`).

## Tester l'interface

L'interface appelle `127.0.0.1:8731` par défaut (`ENGINE` dans `ui/src/api.ts`, surchargeable par `VITE_TRAME_PORT`) : quand le Trame installé tourne, un aperçu de dev parle au vrai moteur (vraies conversations Teams). Demander avant de le piloter, ou lancer un moteur de dev sur un autre port.
