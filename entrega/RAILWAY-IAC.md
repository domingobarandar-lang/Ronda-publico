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
- las 19 variables con `preserve()`: «dejar el valor que ya tiene Railway». Los secretos no van al repo;
- una réplica en us-west2 y el comando de arranque.

**Si se agrega una variable en Railway** (por ejemplo `SENTRY_TOKEN_LECTURA` en su momento), hay que sumarla al archivo
como `NOMBRE: preserve()` **antes del próximo `apply`**, o ese `apply` la borra. Ante la duda, `railway config pull --force`
vuelve a importar todo lo que hay; después hay que comparar con `git diff` y devolver el comando de arranque si se perdió.

> Así casi pasó: el archivo que generó `railway config migrate` traía solo el comando de arranque, y su `plan` proponía
> **borrar las 19 variables, desconectar el repo y soltar el volumen**. No se aplicó; se rehízo con `config pull`.

## Equivalencia con el antiguo `railway.json` (verificada el 2026-11-05)

| Campo | Antes | Ahora (guardado en el servicio) |
|---|---|---|
| Start | `node seed.js --si-vacio && node server.js` (venía de `railway.json`) | el mismo, aplicado desde `railway.ts` |
| Reinicio | `ON_FAILURE`, 10 reintentos | igual: es el valor por defecto de Railway (no se declara, ver el comentario en el archivo) |
| Build | Railpack, sin build command, Node 24 por `engines` | igual |
| Healthcheck | ninguno | ninguno |
| Root Directory / repo / rama | `app` / `domingobarandar-lang/rondas-qr` / `main` | igual |
| Variables | 19 | las mismas 19, sin tocar |
| Volumen | `rondas-qr-volume` en `/data` | igual |

El `apply` del 2026-11-05 cambió solo el comando de arranque. Railway desplegó de nuevo (deploy `958b7c33`, SUCCESS) y el sitio
respondió normal. Después, `railway config plan` dice *«Your Railway configuration is already up to date»*.

## Cómo correr el plan (y el apply, si hace falta)

En **Git Bash**, desde la raíz del repo:

```bash
npm install --no-save railway
export _='C:\Users\user\AppData\Roaming\npm\node_modules\@railway\cli\bin\railway.exe'
railway config plan
```

- `npm install --no-save railway` instala el SDK que importa `railway/iac`, en la raíz y no en `app/`, para que no entre en
  el build. `node_modules/` ya está en `.gitignore`.
- El `export _=…` es por un bug del SDK en Windows con Git Bash. El SDK llama al CLI usando la variable `_`, y Git Bash la llena
  con una ruta `/c/…` que Node no puede ejecutar. Sin el `export`, el plan falla con
  *«This version of railway/iac requires Railway CLI 5.42.1 or newer»* aunque el CLI esté al día.
- **Leer el plan antes de aplicar.** Si dice `Delete variable …`, que toca `volumeAttachments` o `source`, o algo
  «destructive», **no aplicar**: falta algo en el archivo.
- `railway config apply` vuelve a mostrar los cambios y pide confirmación. Aplicar dispara un deploy nuevo del último commit.
