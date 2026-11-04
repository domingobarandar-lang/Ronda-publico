# Configuración de Railway: de `railway.json` a `.railway/railway.ts`

Railway deja de leer `app/railway.json` (Config as Code) el **2026-12-01**. La configuración pasa a
**Infrastructure as Code**: [`.railway/railway.ts`](../.railway/railway.ts), en la raíz del repo.

**Diferencia clave**: `railway.json` se leía en cada deploy. `railway.ts` **no**: Railway no lo mira al
desplegar. Se aplica a mano (`railway config apply`) y desde ahí la configuración queda guardada en el servicio.

## Equivalencia (deploy da181aed, leída del servicio en solo lectura el 2026-11-04)

| Campo | Deploy actual | Viene de | En `railway.ts` |
|---|---|---|---|
| Build | Railpack, sin build command, Node 24 por `engines` | panel | igual, sin declarar |
| Start | `node seed.js --si-vacio && node server.js` | `railway.json` | `start:` (el único que dependía del archivo) |
| Healthcheck | ninguno | — | ninguno |
| Reinicio | ON_FAILURE, 10 reintentos | panel (y `railway.json`) | sin declarar: queda el del panel |
| Root Directory | `app` | panel | sin `source`: no se toca |
| Variables | 19 | panel | sin `env`: no se tocan |
| Volumen | `rondas-qr-volume` en `/data` | panel | sin `volumeMounts`: no se toca |
| Réplicas | 1, us-west2 | panel | sin declarar |

## Para aplicarlo (lo decide el usuario; nada de esto se hizo)

1. `npm install railway` donde se vaya a correr el CLI (lo pide `railway/iac`; no va en `app/`).
2. `railway config plan` y revisar: solo debería cambiar el start command. Si propone borrar variables o el volumen, **no aplicar**.
3. `railway config apply`. Después, borrar `app/railway.json` en un PR aparte y desplegar.

Mientras no se aplique, todo sigue igual: `app/railway.json` se sigue leyendo hasta el 2026-12-01.
Si llega esa fecha sin aplicar, el servicio arrancaría con `npm start` (`node server.js`, sin el seed).
