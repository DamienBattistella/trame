# Trame — empaquetage Tauri

Enveloppe desktop de Trame : fenêtre **sans cadre** (`decorations: false`, barre
de titre custom côté React) + backend Python lancé en **sidecar** au démarrage.

> À builder sur le poste (Windows) : nécessite Rust, qui n'était pas dispo dans
> l'environnement où ces fichiers ont été générés. Rien ici n'a été compilé.

## Prérequis (poste Windows)
- **Rust** : https://rustup.rs
- **Tauri CLI** : `npm i -D @tauri-apps/cli` (déjà dans `package.json`)
- **PyInstaller** : `pip install pyinstaller` (dans le venv du backend)
- Prérequis système Tauri v2 pour Windows (WebView2 est déjà présent sur Win 10/11).

## 1. Construire le sidecar backend (PyInstaller)
Le backend devient un exécutable unique, nommé avec le **target triple**, placé
dans `src-tauri/binaries/`.

```powershell
cd backend
.\.venv\Scripts\activate
pip install pyinstaller
pyinstaller --onefile --name trame-backend run.py
# Tauri attend le suffixe du triple cible :
copy dist\trame-backend.exe ..\ui\src-tauri\binaries\trame-backend-x86_64-pc-windows-msvc.exe
```
(Récupérer le triple avec `rustc -Vv | findstr host`.)

Le backend sert son API sur `127.0.0.1:8731` ; l'UI s'y connecte déjà (voir
`ui/src/api.ts`). `config.json`, `SOUL.md` et les personas doivent être
accessibles à côté de l'exécutable — les embarquer via `--add-data` ou pointer
`TRAME_CONFIG` (à ajouter) si besoin.

## 2. Icônes
Génère tout le jeu d'icônes depuis l'image source fournie :
```powershell
cd ui
npm run tauri icon src-tauri/icons/source.png
```

## 3. Lancer / builder
```powershell
cd ui
npm run tauri dev     # dev : Vite + fenêtre native sans cadre + sidecar
npm run tauri build   # installeur (.msi / .exe)
```

## Notes
- `app.withGlobalTauri: true` expose `window.__TAURI__` : les boutons
  réduire/agrandir/fermer de la barre de titre (`src/App.tsx → WindowControls`)
  pilotent la vraie fenêtre.
- `decorations: false` : pas de cadre OS, la barre de titre custom est draggable
  via `data-tauri-drag-region`.
- Permissions dans `capabilities/default.json` (contrôles fenêtre + sidecar).
- Le cerveau `claude -p` suppose `claude` connecté (OAuth Ultra) sur le poste.
