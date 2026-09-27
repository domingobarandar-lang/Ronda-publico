# Checklist — Deploy de la v1.17 (SQLite)

El deploy lo hace la operación, **de día y fuera del horario de rondas**. Tiempo estimado: 30-45 minutos con la verificación. Contexto: `entrega/PLAN-SQLITE.md`; operación del día a día: `entrega/OPERACION.md`, sección **Base de datos**.

Los comandos `railway` van en **Git Bash**, no en PowerShell 5.1 (su redirección `>` guarda en UTF-16 y corrompe las copias). El CLI se instala con `npm i -g @railway/cli`, después `railway login` y `railway link` (proyecto `rondas-qr`). Si `railway ssh -- node scripts/…` no encuentra el script, anteponer la carpeta de la app: `railway ssh -- sh -c 'cd /app && node scripts/…'`.

## Antes (uno o dos días antes)

- [ ] Railway → servicio → Variables: anotar qué dice `DB_PATH` (`/data/db.json` está bien: la v1.17 usa `/data/rondas.sqlite` en la misma carpeta e importa el `.json`). No hace falta cambiarlo.
- [ ] Definir **`RESPALDO_TO`**: un buzón de la operación **con verificación en dos pasos** (el respaldo trae hashes de PIN, correos y GPS). Cargarlo en las variables de Railway.
- [ ] Confirmar que las variables de Gmail (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`) siguen puestas: el respaldo sale por la misma cuenta que el informe semanal.
- [ ] Bajar una copia de producción y probar la importación con datos reales:
  ```bash
  railway ssh -- cat /data/db.json > app/data/db-produccion.json
  cd app && npm test
  ```
  El test **"importación de la copia real de producción"** tiene que salir en verde y **no** como `skipped`. Ese archivo es sensible: no se commitea (la carpeta `app/data/` está en `.gitignore`) y se borra al terminar.
- [ ] Anotar los conteos de esa copia (solo números, sin mostrar contenido):
  ```bash
  node -e "const d=require('./app/data/db-produccion.json');console.log({ejecuciones:new Set((d.ejecuciones||[]).map(e=>e.id)).size,notificaciones:(d.notificaciones||[]).length,usuarios:(d.usuarios||[]).length,puntos:(d.puntos||[]).length})"
  ```

## El día del deploy

- [ ] Revisar en el panel (o en /fabrica, columna "última ronda") que **no haya rondas en curso**.
- [ ] Respaldo manual del `.json` justo antes (y comprobar que el tamaño coincide con el del servidor):
  ```bash
  railway ssh -- ls -l /data/db.json
  railway ssh -- cat /data/db.json > db-antes-v1.17.json
  ls -l db-antes-v1.17.json
  ```
- [ ] Volver a anotar los conteos, ahora sobre `db-antes-v1.17.json` (mismo comando de arriba cambiando el archivo).
- [ ] Desplegar con **"Deploy latest commit"** (o push a la rama que despliega). **No "Redeploy"**: ese vuelve a subir el commit anterior. Root Directory del servicio: `app`.
- [ ] **Log de build**: la versión de Node tiene que ser 24 o superior (`engines` del `package.json`). Si construye con otra, detener y revisar antes de seguir.
- [ ] **Log de arranque**, buscar estas dos líneas:
  - `[store] importado /data/db.json → /data/rondas.sqlite: N ejecuciones, N notificaciones, N usuarios, N puntos; el .json quedó como db.json.migrado-…` → los cuatro números **iguales** a los anotados.
  - `Base de datos: /data/rondas.sqlite (SQLite, Node v24…)` y la línea de conteos debajo.
- [ ] Si en cambio dice `[arranque] el servidor NO arranca: No se pudo importar…`: no se perdió nada, el `.json` sigue intacto. Volver al deploy anterior (Railway → Deployments → el anterior → Redeploy) y revisar el motivo con calma.

## Verificación (con el servicio arriba)

- [ ] **Ronda de prueba de punta a punta**: en un teléfono, entrar como guardia, iniciar una ronda, marcar uno o dos puntos y cerrarla.
- [ ] En el panel: la ronda aparece en **Informes**, el informe abre, y en **Avisos** está el aviso del cierre.
- [ ] Panel → descargar el **informe semanal** (.docx) de la semana pasada: abre y trae las rondas.
- [ ] /fabrica: la columna "última ronda" de cada condominio tiene fecha.
- [ ] Archivos en el volumen: `railway ssh -- ls -l /data` → están `rondas.sqlite` (con `-wal`/`-shm`) y `db.json.migrado-…`.
- [ ] **Respaldo**: `railway ssh -- node scripts/respaldo-ahora.js` → el log dice `[respaldo] enviado a …` y el correo con `rondas-AAAA-MM-DD.sqlite.gz` llega a `RESPALDO_TO`.
- [ ] Validar ese respaldo en seco: `railway ssh -- node scripts/restaurar-respaldo.js /data/respaldos/rondas-AAAA-MM-DD.sqlite` (no toca nada; muestra los conteos).
- [ ] **Reiniciar el servicio una vez** (Restart): el log **no** debe volver a decir `importado`, y el seed debe decir `La base ya tiene datos — se conserva tal cual`.

## Si algo sale mal después de arrancar

Vuelta atrás a la v1.16 (detalle en `entrega/OPERACION.md` → **Vuelta atrás**):

```bash
railway ssh -- node scripts/exportar-json.js
```

y redesplegar el deploy anterior con `DB_PATH=/data/db.json`. Antes de volver a intentar la v1.17, apartar `/data/rondas.sqlite` (y sus `-wal`/`-shm`) para que importe lo que la v1.16 haya escrito.

## Después

- [ ] Al día siguiente, después de las 10:00: en el log aparece `[respaldo] foto del día` y llega el correo del respaldo.
- [ ] Borrar las copias locales sensibles: `app/data/db-produccion.json` y `db-antes-v1.17.json` (o guardarlas cifradas).
- [ ] Recordatorio: después de correr `purga-demo.js --aplicar` o `migracion-rsf.js` en producción, **reiniciar el servicio**.
