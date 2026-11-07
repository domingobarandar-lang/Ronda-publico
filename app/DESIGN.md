# DESIGN.md — sistema de diseño de Ronda

Dos apps, un sistema: la del guardia (`/`, tema nocturno) y la del panel (`/panel`, tema claro de oficina), cada una instalable con su propio ícono. Los tokens viven duplicados (a propósito, sin build step) en `public/estilos.css` (guardia) y `public/admin.css` (admin + informe + hoja QR): **mismos nombres, valores mapeados al tema**. Si agregas un color o radio, agrégalo en ambos.

## Principios

1. **El guardia opera de noche, apurado y con una mano**: fondo oscuro, un botón protagonista por pantalla (`btn-gigante`), touch targets ≥ 44 px, feedback inmediato (vibración + aviso). Nada de menús.
2. **El administrador lee veredictos, no dashboards**: el estado de una ronda se entiende por el chip (verde/ámbar/rojo) sin leer nada más. Números con `tabular-nums` para comparar columnas.
3. **Todo imprime bien**: informe y hoja QR son documentos; `@media print` quita interfaz y sombras.
4. **Movimiento discreto**: transiciones de 150 ms, `:active` con scale 0.98, y respeto a `prefers-reduced-motion`.

## Tokens

Estética v1.2 (inspo de José, 2026-07-18): oscuro profundo + **violeta vibrante**, botones pastilla (`--radio-pill` en todos los .btn), insignia circular de marca (`.logo-badge`) y brillos suaves (`--brillo-marca`). El verde dejó de ser marca: quedó como semántico de éxito ("hecho", "en línea", "Completa").

| Token | Guardia (oscuro) | Admin (claro) | Uso |
|---|---|---|---|
| `--marca` | `#a855f7` | `#a855f7` | Acentos, foco, degradado de CTA |
| `--marca-fuerte` | `#7c3aed` | `#7c3aed` (texto: `--marca-texto #6d28d9`) | Extremo del degradado, pestaña activa |
| `--marca-suave` | `rgba(168,85,247,.16)` | `rgba(168,85,247,.14)` | Fondos de énfasis, ring de foco |
| `--brillo-marca` | sombra violeta 24px | versión 25 % | Glow de CTA y `.progreso` |
| `--fondo` | `#0e0e13` | `#f8f8fb` | Fondo de página |
| `--panel` / `--panel-alto` | `#17171f` / `#1d1d28` | `#ffffff` / — | Tarjetas, tablas, diálogos |
| `--borde` | `#272736` | `#e6e4ee` | Bordes y divisores |
| `--texto` / `--texto-suave` | `#f1f0f5` / `#9d9aad` | `#17141f` / `#6b6880` | Jerarquía de texto (AA en ambos temas) |
| `--exito` (+`-suave`) | `#22c55e` | `#166534` / `#dcfce7` | Punto hecho, "en línea", chip "Completa" |
| `--peligro` (+`-suave`) | `#f4435f` | `#dc2626` / `#fee2e2` | Incompleto, eliminar, errores |
| `--alerta` (+`-suave`/`-texto`) | `#f59e0b` | `#b45309` / `#fef3c7` | Observaciones, offline |
| `--info-*` | índigo `#818cf8` | — | Tarjeta de sincronización |
| `--radio-s / -m / -pill` | 14 / 18 / 999 px | 12 / 16 / 999 px | Inputs / tarjetas y diálogos / botones y chips |
| `--esp-1..6` | 4/8/12/16/20/24 px | igual | Escala de espaciado (base 4) |
| `--texto-xs..2xl` | 12→24 px | 12→15 px | El guardia lee más grande que el admin |
| `--sombra-1 / -2` | — (bordes + glow de marca) | suaves | Elevación solo en tema claro |
| `--t` | 150ms ease | igual | Única duración de transición |

## Componentes

- **Botón**: variantes `btn-principal` (una por pantalla), `btn-borde`, `btn-peligro` (siempre borde, nunca relleno rojo — el rojo relleno se reserva para avisos de error), tamaños `btn-chico` / `btn-gigante`. Estados: hover (solo admin/desktop), `:active` scale, `:focus-visible` ring de marca.
- **Chip de estado**: `chip-verde` Completa · `chip-ambar` Con observaciones · `chip-roja` INCOMPLETA · neutro En curso. Es el elemento de mayor jerarquía informativa del panel — nunca usar estos colores de fondo para otra cosa.
- **Fila de punto** (guardia): número en círculo → check con `--marca-suave` al completarse. El avance grande (`.progreso`) es la métrica emocional del guardia: siempre visible.
- **Tarjeta QR** (hoja imprimible): borde punteado = línea de recorte; nombre grande + código corto espaciado para tipear de noche.
- **Aviso flotante**: entra con `aviso-entra` (180 ms), un solo aviso a la vez, 3 s en pantalla.

## Reglas rápidas (do / don't)

- ✅ Colores solo vía tokens. ❌ Ningún hex suelto en reglas nuevas.
- ✅ Un `btn-principal` por vista. ❌ Dos acciones primarias compitiendo.
- ✅ Mensajes de error en texto claro y accionable ("Usuario o PIN incorrectos."). ❌ Códigos o jerga.
- ✅ `tabular-nums` en horas, códigos y conteos. ❌ Números que "bailan" al actualizarse.
- ✅ Nuevos estados de ronda → agregar chip aquí y en `CHIPS` de `admin.js` + `informe.html`. ❌ Estados sin color semántico.
