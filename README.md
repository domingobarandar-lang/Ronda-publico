# Rondas QR

Control de rondas de seguridad con QR para condominios: reemplaza las chapitas físicas (iButton) + lectora por QR impresos y el teléfono del guardia. Una sola app instalable (PWA offline-first) con selector de perfil al entrar — **Soy trabajador** (la app del guardia) o **Soy administrador** (panel con informes y alertas). Usuarios de prueba: `trabajador`/5678 y `admin`/1234.

- **La app y cómo correrla**: [app/README.md](app/README.md) — `cd app && npm install && npm run demo`
- **Qué se pidió y qué hace**: [BRIEF.md](BRIEF.md) · [SPEC.md](SPEC.md) · [QA.md](QA.md)
- **Kit de entrega y operación**: [entrega/](entrega/) — demo de 5 min, one-pager, operación, seguridad, competencia y plan de lanzamiento
- **Sistema de diseño**: [app/DESIGN.md](app/DESIGN.md)

Construido por la Fábrica de Agentes (2026-07). El `.env` con credenciales no se versiona: copiar `app/.env.example` → `app/.env`.
