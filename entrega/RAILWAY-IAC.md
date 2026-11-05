# Configuración de Railway: `.railway/railway.ts`

Railway dejó de aceptar `railway.json` / `railway.toml` (Config as Code, se dejan de leer el **2026-12-01**).
Desde el **2026-11-05** la configuración del servicio `rondas-QR` vive **guardada en el propio servicio**,
y su copia en código es [`.railway/railway.ts`](../.railway/railway.ts) (Infrastructure as Code). `app/railway.json` se borró.

**Railway no lee `.railway/` al desplegar.** Un push a `main` despliega el código con la configuración que ya tiene
el servicio. Para cambiar esa configuración desde el archivo hay que correr `railway config plan` y `railway config apply`.

## Regla de oro: lo que el archivo no dice, `apply` lo borra

`railway.ts` describe el proyecto **completo**. Si una variable, el volumen o el repo no están en el archivo,
`railway config apply` los **elimina** del servicio. Por eso el archivo declara todo, tal como lo importó `railway config pull`:

- el repo `domingobarandar-lang/rondas-qr` con Root Directory `app`;
- el volumen `rondas-qr-volume` montado en `/data` (5 GB, us-west2);
- las 18 variables con `preserve()`: «dejar el valor que ya tiene Railway». Los secretos no van al repo;
- una réplica en us-west2 y el comando de arranque.

**Si se agrega una variable en Railway** (por ejemplo `SENTRY_TOKEN_LECTURA` en su momento), hay que sumarla al archivo
como `NOMBRE: preserve()` **antes del próximo `apply`**, o ese `apply` la borra. Ante la duda, `railway config pull --force`
vuelve a importar todo lo que hay; después hay que comparar con `git diff` y devolver el comando de arranque si se perdió.

> Así casi pasó: el archivo que generó `railway config migrate` traía solo el comando de arranque, y su `plan` proponía
> **borrar las 19 variables, desconectar el repo y soltar el volumen**. No se aplicó; se rehízo con `config pull`.

## Equivalencia con el antiguo `railway.json` (verificada el 2026-11-05)

| Campo | Antes | Ahora (guardado en el servicio) |
|---|---|---|
| Start | `node seed.js --si-vacio && node server.js` (venía de `railway.json`) | `node server.js`, sin seed (cambio a propósito, ver abajo) |
| Reinicio | `ON_FAILURE`, 10 reintentos | igual: es el valor por defecto de Railway (no se declara, ver el comentario en el archivo) |
| Build | Railpack, sin build command, Node 24 por `engines` | igual |
| Healthcheck | ninguno | ninguno |
| Root Directory / repo / rama | `app` / `domingobarandar-lang/rondas-qr` / `main` | igual |
| Variables | 19 | 18: se borró `INFORME_CONDOMINIOS` (a propósito, ver abajo) |
| Volumen | `rondas-qr-volume` en `/data` | igual |

## Cambios aplicados

| Fecha | Qué cambió en Railway | Deploy |
|---|---|---|
| 2026-11-05 | Comando de arranque guardado en el servicio (`node seed.js --si-vacio && node server.js`), el mismo que traía `railway.json` | `958b7c33`, SUCCESS |
| 2026-11-05 | **Arranque sin seed** (`node server.js`) y **se borra `INFORME_CONDOMINIOS`** | `cdd4dfbe`, SUCCESS |

- **Arranque sin seed.** Con la base de producción con datos, `seed.js --si-vacio` no hacía nada. Pero si el servidor arranca alguna vez
  con la base vacía (se pierde o cambia el volumen, `DB_PATH` mal escrito, una restauración que sale mal), el seed crea la demo:
  los condominios Los Aromos y Mirador y las cuentas `admin`, `marta`, `guardia`…, con PIN publicados en `app/seed.js`. Además la app
  arrancaría «sana» y escondería que se perdió la base. Sin seed, el servidor arranca con la base vacía y se nota. La demo local
  sigue siendo `npm run demo`.
- **Sin `INFORME_CONDOMINIOS`.** Era la lista blanca del informe semanal (`piloto-sf`). Mientras existía, un condominio nuevo no recibía
  el correo del lunes. Sin ella, el informe va a todos los condominios que tengan correo cargado (`lib/programador.js`).
  `ADMIN_TOTAL_CONDOMINIO` se queda: solo decide en qué condominio se abre el panel de acceso total.

Después de cada `apply`, `railway config plan` dice *«Your Railway configuration is already up to date»*.

## Cómo correr el plan (y el apply, si hace falta)

En **Git Bash**, desde la raíz del repo:

```bash
npm install --no-save railway
RW="/c/Users/user/AppData/Roaming/npm/node_modules/@railway/cli/bin/railway.exe"
"$RW" config plan
```

- `npm install --no-save railway` instala el SDK que importa `railway/iac`, en la raíz y no en `app/`, para que no entre en
  el build. `node_modules/` ya está en `.gitignore`.
- **`plan` y `apply` se corren con `"$RW"`, no con `railway`.** Es por un bug del SDK en Windows con Git Bash: para comprobar
  la versión del CLI, el SDK ejecuta el programa que dice la variable `_`. Con `railway` a secas, esa variable apunta al
  lanzador de npm, que no es un ejecutable, y el plan falla con *«This version of railway/iac requires Railway CLI 5.42.1 or
  newer»* aunque el CLI esté al día. Llamando al `railway.exe` por su ruta, la variable apunta a él y funciona.
  Tampoco sirve un `export _=…`: Git Bash la reescribe en cada comando. Y no tener `MSYS_NO_PATHCONV=1` activo en esa ventana,
  porque hace fallar lo mismo. Si la ventana viene de usar `railway ssh`, abrir otra. Los demás comandos (`railway ssh`,
  `railway logs`…) siguen igual.
- **Leer el plan antes de aplicar.** Si dice `Delete variable …`, que toca `volumeAttachments` o `source`, o algo
  «destructive», **no aplicar**: falta algo en el archivo. La excepción es **borrar una variable a propósito**: se quita su línea del
  archivo y el plan tiene que mostrar ese único `Delete variable` y nada más. Como es destructivo, el apply sin preguntas pide
  `"$RW" config apply --yes --confirm-destructive`.
- `"$RW" config apply` vuelve a mostrar los cambios y pide confirmación. Aplicar dispara un deploy nuevo del último commit:
  hacerlo de día y fuera de una ronda.
