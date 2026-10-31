# Rondas QR

Control de rondas de seguridad con QR para condominios: reemplaza las chapitas físicas (iButton) + lectora por QR impresos y el teléfono del guardia. Son **dos apps instalables** sobre el mismo servidor, cada una con su ícono y su acceso:

| | Dirección | Para quién |
|---|---|---|
| 🛡️ **Rondas QR** | `/` | El guardia: hace la ronda escaneando los QR, con o sin señal (PWA offline-first). Ahí mismo crea su usuario. |
| 🗂️ **Panel del administrador** | `/panel` | El administrador: informes, puntos, guardias, rondas y avisos. |

Usuarios de prueba: `guardia`/5678 (app del guardia) y `admin`/1234 (panel).

- **La app y cómo correrla**: [app/README.md](app/README.md) — `cd app && npm install && npm run demo`
- **Qué se pidió y qué hace**: [BRIEF.md](BRIEF.md) · [SPEC.md](SPEC.md) · [QA.md](QA.md)
- **Operación y diseño**: [entrega/](entrega/) — operación, seguridad, diseño del informe semanal y hoja de QR para imprimir
- **Fallos en producción**: [entrega/INCIDENTES.md](entrega/INCIDENTES.md) — qué hacer cuando algo falla y el registro de lo que ya falló
- **Sistema de diseño**: [app/DESIGN.md](app/DESIGN.md)

Construido por la Fábrica de Agentes (2026-07). El `.env` con credenciales no se versiona: copiar `app/.env.example` → `app/.env`.
