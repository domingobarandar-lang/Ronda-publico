# Rondas QR

Control de rondas de seguridad con QR para condominios. Dos apps PWA sobre un
mismo servidor Express: la del guardia (`/`) y el panel del administrador
(`/panel`), más la pantalla de la operación (`/fabrica`).

- Código de la app: [app/](app/) — `cd app && npm install && npm run demo`
- Contexto: [BRIEF.md](BRIEF.md) · [SPEC.md](SPEC.md) · [QA.md](QA.md)
- Operación y seguridad: [entrega/](entrega/) — deploy de la v1.17: [entrega/CHECKLIST-DEPLOY-v1.17.md](entrega/CHECKLIST-DEPLOY-v1.17.md)
- Fallos en producción: [entrega/INCIDENTES.md](entrega/INCIDENTES.md). Al investigar o arreglar uno, agregarlo al registro (y su análisis si la sección 2 lo pide).

El estado vive en `app/data/rondas.sqlite` (SQLite, fuera de git; desde la v1.17 — antes `db.json`, que se importa solo). El `.env` no se versiona:
copiar `app/.env.example` → `app/.env`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
