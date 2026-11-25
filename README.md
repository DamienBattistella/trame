# Trame

Assistant Teams personnel. Il lit et rédige tes réponses **en pilotant le client
Microsoft Teams natif** sur ton poste Windows (UI Automation), dans ta session
Entra déjà ouverte — ni Graph, ni jeton emprunté, ni clone du client. Les
réponses sont rédigées par Claude dans ta voix (persona `SOUL.md`), en brouillon
à valider ou en auto selon la personne.

Nom de code du dépôt : `dedalus-teams-agent`. Produit : **Trame**.

## Architecture

```
UI (Tauri + React/shadcn)  ──WebSocket/REST :8731──►  Backend (Python)
  wizard + panneau                                      watcher + UIA Teams
  fenêtre sans cadre                                    ↓
                                                        Cerveau : claude -p / gh copilot
```

- **`backend/`** — watcher Python : détection, déclencheurs, modes, sécurité,
  cerveau commutable, API locale (FastAPI + WebSocket). Driver Teams commutable :
  `mock` (tout OS, dev) / `windows_uia` (réel, Windows — à caler, cf. DESIGN §9).
- **`ui/`** — front React + Vite + Tailwind + shadcn/ui ; `src-tauri/` l'empaquette
  en app desktop (fenêtre sans cadre + backend en sidecar).
- **`DESIGN.md`** — spéc gelée et registre des décisions.
- **`SOUL.md`** — persona (placeholder ; se dépose via l'appli).

## Lancer en dev (ici, driver simulé)

Backend :
```bash
cd backend && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
TRAME_DRIVER=mock python run.py        # API sur 127.0.0.1:8731
```

UI :
```bash
cd ui && npm install && npm run dev     # http://localhost:5173
```

L'UI se connecte au backend en WebSocket ; sans backend, elle retombe sur des
données simulées. En l'état, le panneau affiche de vrais brouillons rédigés par
`claude -p`.

## Empaqueter (poste Windows)

Voir `ui/src-tauri/README.md` : Rust + Tauri CLI, backend en sidecar (PyInstaller),
`npm run tauri build`. Non compilé dans l'environnement de dev (pas de Rust).

## Reste à faire

- Sonde UIA réelle sur le poste (phase 0, le seul go/no-go) — `backend/drivers/windows_uia.py`.
- Build Tauri sur le poste.
