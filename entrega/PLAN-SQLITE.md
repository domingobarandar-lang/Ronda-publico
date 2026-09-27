# Plan — Migración de db.json a SQLite (v1.16)

**Fecha**: 2026-09-26 · **Motivo**: pasar de ~3 a 30+ condominios y ~100 guardias en ~2 meses.
**Criterio del dueño**: lo más rápido, económico y seguro.

## Problema

`lib/store.js` guarda **toda** la base en `db.json` en cada `store.guardar()` (≈30 llamadas, una por escaneo). Medido: 10 mil rondas = 32 MB = ~100 ms por guardado con el event loop bloqueado; 80 mil = ~1 s. A 30 condominios × ~12 rondas/día (~360/día) se llega a 10 mil en ~1 mes y a 30 mil en ~3 meses. Además todo el historial vive en memoria.

## Decisión

**SQLite con `node:sqlite` (incluido en Node 24, cero dependencias nativas), en el volumen de Railway ya montado en `/data`.** Un solo proceso, WAL, `synchronous=NORMAL`. Medido con 100 mil rondas: upsert de una ronda 0,14 ms; listar 200 de un condominio 0,8 ms.

Descartado: Postgres/Supabase — obligaría a volver asíncrono todo el acceso a datos (~90 puntos del código) por una escala que un solo proceso con SQLite cubre de sobra. Se reconsidera si hacen falta varias réplicas, panel para clientes externos o BI externo.

## Diseño: híbrido por tamaño de colección

| Colección | Tamaño esperado | Dónde vive |
|---|---|---|
| condominios, usuarios, puntos, rondas, pushSuscripciones, vapid, informeEmailEstado, sesiones | chico y acotado (KB) | **en memoria como hoy** (`store.db`), persistido en tabla `estado(clave, valor JSON)`; `guardar()` solo escribe las claves cuyo JSON cambió |
| **ejecuciones** | crece sin techo | **tabla propia**, leída y escrita por fila |
| **notificaciones** | crece sin techo | **tabla propia**, append |

Así las ~70 lecturas de configuración (`db.usuarios.find`, `db.puntos.filter`, …) **no cambian**. Solo cambian los ~12 accesos a `ejecuciones`/`notificaciones`.

### Esquema

```sql
CREATE TABLE estado (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
CREATE TABLE ejecuciones (
  id TEXT PRIMARY KEY, condominio_id TEXT NOT NULL, ronda_id TEXT, guardia_id TEXT,
  inicio TEXT, fin TEXT, estado TEXT, datos TEXT NOT NULL      -- el objeto completo en JSON
);
CREATE INDEX ejec_condo_inicio ON ejecuciones(condominio_id, inicio);
CREATE TABLE notificaciones (id INTEGER PRIMARY KEY, condominio_id TEXT, ts TEXT, datos TEXT NOT NULL);
CREATE INDEX notif_condo ON notificaciones(condominio_id, id);
CREATE TABLE meta (clave TEXT PRIMARY KEY, valor TEXT);          -- versión de esquema
```

Las ejecuciones se guardan como documento JSON + columnas indexadas: el formato del objeto no cambia, así que `lib/rondas.js` (evaluación, GPS, paridad) no se toca en su lógica.

### API nueva del store

```js
store.db                         // igual que hoy, sin ejecuciones ni notificaciones
store.guardar()                  // persiste solo las claves de `estado` que cambiaron
store.ejecuciones.obtener(id)
store.ejecuciones.guardar(e)     // upsert de UNA ejecución
store.ejecuciones.listar({ condominioId, desde, hasta, estadoDistintoDe, limite })
store.ejecuciones.ultimaDe(condominioId)
store.notificaciones.agregar(n)
store.notificaciones.ultimas(condominioId, 50)
store.transaccion(fn)            // para scripts de purga/migración
```

`lib/rondas.js`: `iniciarEjecucion` deja de hacer `db.ejecuciones.push`/`find` y recibe el repositorio (o devuelve la ejecución y el handler la guarda). `registrarEscaneo` y `cerrarEjecucion` siguen mutando el objeto; el handler llama `store.ejecuciones.guardar(e)`.

## Migración de datos (automática y reversible)

1. Al arrancar, si existe `db.json` y la base SQLite no tiene `meta.version`: importar todo en **una transacción**, verificar conteos (ejecuciones, notificaciones, usuarios, puntos), y renombrar `db.json` → `db.json.migrado-<fecha>` (no se borra).
2. Si la importación falla: rollback, el servidor **no arranca** y el log dice por qué (mejor caído y con los datos intactos que arriba a medias).
3. Vuelta atrás: `node scripts/exportar-json.js` regenera un `db.json` desde SQLite, y el deploy anterior lo lee tal cual.
4. `DB_PATH` pasa a apuntar a `/data/rondas.sqlite`; si apunta a un `.json`, se usa el `.sqlite` hermano y se importa el `.json` (así no hay que tocar Railway el día del deploy).

## Respaldos

- **Railway volume backups: NO disponibles en el plan actual** (confirmado 2026-09-27). El respaldo lo hace la app.
- **Snapshot propio diario** con `VACUUM INTO /data/respaldos/rondas-AAAA-MM-DD.sqlite`, se conservan 14. Consistente aunque haya escrituras en curso. Programado con `lib/programador.js`.
- **Copia fuera de Railway por correo**: el snapshot se comprime (gzip) y se envía como adjunto con la integración Gmail API que ya existe (`lib/correo.js`, la del informe semanal) a `RESPALDO_TO` (variable de entorno; si no está, no se envía y se loguea). Frecuencia configurable (diaria por defecto). Si el `.gz` se acerca a 20 MB (tope Gmail 25 MB), avisar en el log y en el correo: toca pasar a almacenamiento de objetos (R2/S3).
- **Restauración**: script `scripts/restaurar-respaldo.js` que toma el `.sqlite.gz` y lo deja en `DB_PATH`; documentado en `OPERACION.md`.
- El respaldo trae hashes de PIN, correos y GPS: debe ir a un buzón de la operación con 2FA.

## Cosas que se arreglan de pasada (necesarias a esta escala)

- `GET /api/admin/ejecuciones` devuelve **todas** las del condominio sin límite → paginar (últimas 200 + filtro por fechas). El panel ya las muestra ordenadas por inicio.
- Tope de 50 notificaciones pasa a ser una consulta con `LIMIT`, no un `slice` en memoria.
- `package.json`: `"engines": { "node": ">=24" }` para que Railway no construya con otra versión.

## Pruebas

- Los tests existentes deben pasar sin cambiar su intención; los que leen `store.db.ejecuciones` / `store.db.notificaciones` (test/rondas.test.js, test/revision-v1.15.test.js) pasan a `store.ejecuciones.obtener` / `store.notificaciones.ultimas`.
- Nuevos: importación desde un `db.json` real (conteos y objetos idénticos), importación fallida no arranca ni pierde el `.json`, idempotencia (segundo arranque no reimporta), `guardar()` no escribe claves sin cambios, snapshot diario, exportación de vuelta a JSON.
- Carga: script que simula 100 guardias escaneando a la vez sobre una base de 100 mil rondas.

## Scripts afectados

`seed.js`, `migracion-rsf.js`, `purga-demo.js` → usar la API nueva (purga con `DELETE ... WHERE condominio_id`).

## Esfuerzo y despliegue

~2-3 días de trabajo. Deploy en horario diurno (fuera de la ventana de rondas nocturnas), con respaldo manual de `/data/db.json` antes. Verificación post-deploy: conteos en el log de arranque = conteos del `.json`, una ronda de prueba de punta a punta, panel lista informes.

## Invariantes que la implementación debe respetar (de la revisión)

1. **Nada de `await` entre `store.ejecuciones.obtener(id)` y `store.ejecuciones.guardar(e)`.** Hoy dos escaneos simultáneos de la misma ronda (la cola offline sincroniza en ráfaga) mutan el mismo objeto en memoria. Con SQLite cada request lee su propia copia: si hubiera un `await` en medio, el segundo pisaría al primero y se perdería un escaneo. Revisado: los handlers de escaneo/cierre guardan antes de su primer `await` (`cerrarYNotificar` guarda y recién después notifica). Test explícito: N escaneos concurrentes a la misma ejecución → N escaneos guardados.
2. **Cerrar ronda + registrar notificación en una transacción** (`store.transaccion`).
3. **Informe semanal filtra por fecha de Chile** (`isoChile(e.inicio)`), no UTC. La consulta SQL trae un día de holgura a cada lado y el filtro fino sigue en JS con la misma función; si no, las rondas de 21:00-23:59 del domingo caen en la semana equivocada.
4. `node:sqlite` en Node 24.21 carga sin advertencia experimental — se usa ese y no `better-sqlite3` (evita compilación nativa en Railway). Fijar `engines.node >=24` y verificar en el log de build de Railway qué versión usa.

## Fuera de este plan

Varias réplicas, Postgres, aislamiento entre administradores para clientes externos (CU-22).

## GSTACK REVIEW REPORT

| Run | Status | Findings |
|---|---|---|
| plan-eng-review (2026-09-26) | DONE | 4 invariantes agregados. Alcance ok: 1 módulo nuevo, ~8 archivos tocados, sin servicios nuevos. |

VERDICT: aprobado para implementar con los invariantes de arriba.

NO UNRESOLVED DECISIONS
