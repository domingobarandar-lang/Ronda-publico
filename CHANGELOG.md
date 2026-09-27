# Cambios — Rondas QR

Las versiones anteriores a la 1.17 están descritas en `app/README.md` (cada función lleva la versión en que entró).

## 1.17.0 — 2026-09-27 · Base de datos SQLite

Pasar de ~3 a 30+ condominios y ~100 guardias: `db.json` se reescribía **entero** en cada marca (con 10 mil rondas, ~100 ms con el servidor bloqueado; con 80 mil, ~1 s). Plan completo en `entrega/PLAN-SQLITE.md` (escrito como "v1.16"; sale como 1.17.0 porque la 1.16.0 ya la usó la alarma de ronda).

**Datos**
- Persistencia en SQLite con `node:sqlite` (viene con Node 24: sin dependencias nativas), modo WAL, en el volumen de Railway. La configuración sigue en memoria y se guarda solo lo que cambió; ejecuciones y avisos tienen tabla propia.
- **Migración automática**: en el primer arranque se importa el `db.json` en una sola transacción, se verifican los conteos y el `.json` queda como `db.json.migrado-<fecha>`. Si algo no cuadra, el servidor no arranca y el `.json` queda intacto. `DB_PATH` puede seguir apuntando al `.json`: no hay que tocar Railway.
- Dos marcas simultáneas de la misma ronda (la cola offline sincroniza en ráfaga) no se pisan, el cierre de una ronda y su aviso se guardan juntos, y el informe semanal sigue cortando por fecha de Chile (las rondas del domingo 21:00-23:59 no se van a la semana siguiente).

**Respaldo** (el plan de Railway no respalda el volumen)
- Foto diaria de la base en `/data/respaldos/` (se guardan 14) y copia comprimida por correo a `RESPALDO_TO` con la cuenta de Gmail del informe semanal. Avisa cuando el respaldo se acerca al tope de Gmail.
- `scripts/restaurar-respaldo.js` (valida y deja el respaldo listo para el próximo arranque; la base anterior no se borra), `scripts/respaldo-ahora.js` (probar el envío) y `scripts/exportar-json.js` (vuelta atrás a la 1.16).

**Panel**
- El listado de informes trae las últimas 200 rondas (antes, todas las del condominio en cada carga) y acepta rango de fechas por la API. La pestaña Avisos pide las últimas 50 a la base.

**Operación**
- `seed.js --si-vacio` decide por el contenido de la base y no por la existencia de `db.json` (si no, el deploy siguiente a la migración sembraba la demo encima de producción).
- `purga-demo.js` y `migracion-rsf.js` borran las rondas y avisos del condominio eliminado en la misma transacción.
- `engines.node >=24`; el log de arranque muestra la ruta de la base, la versión de Node y los conteos.
- Prueba de carga (`scripts/prueba-carga.js`): 100 guardias haciendo su ronda a la vez sobre 100 mil rondas, ninguna marca perdida, ~0,1 ms de base por marca.
