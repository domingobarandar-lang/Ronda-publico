# Cambios — Rondas QR

Las versiones anteriores a la 1.17 están descritas en `app/README.md` (cada función lleva la versión en que entró).

## 1.19.1 — 2026-10-07 · La versión del teléfono se ve de inmediato

Los registros de producción del 7 de octubre mostraron que el teléfono de la garita corrió la app vieja todo el día (la página en modo kiosco no se recargó hasta las 16:51) y que los guardias entran, hacen la ronda y salen: el panel podía seguir en "sin datos" aunque el teléfono ya tuviera la versión nueva.

- La app revisa (y avisa) su versión **al entrar el guardia** y **al encenderse la pantalla**, además de cada minuto. Con la pantalla apagada el reloj de un minuto no corre.
- La pantalla de entrada muestra la versión instalada ("Versión 1.19.1"): se puede confirmar con una foto del guardia, sin sesión.

## 1.19.0 — 2026-10-06 · Comentario del guardia en la ronda · La app se actualiza sola

### Comentario del guardia

**Teléfono del guardia**
- Campo "Comentario (opcional)" en la ronda en curso, sobre "Terminar ronda". Hasta 280 caracteres, uno por ronda. Se guarda mientras se escribe (sobrevive a una recarga o a un apagón) y viaja con el cierre: sin señal, espera en la cola.

**Servidor y panel**
- El comentario queda en la ejecución (`comentario`, dentro de la columna `datos` de la tabla `ejecuciones`: sin migración). Sale en el informe de la ronda del panel y en el aviso al administrador.
- Reenviar el cierre no lo cambia, y un cierre automático no borra el que hubiera.

**Informe semanal**
- Nueva sección 6, "Comentarios de los guardias": una fila por ronda con comentario (fecha, guardia, estado de la ronda, texto). La Conclusión pasa a ser la sección 7 y cuenta los comentarios. Ejemplo: `entrega/ejemplos/Informe-semanal-ejemplo-v3.docx`.

### La app del guardia se actualiza sola

El teléfono de la garita corre en modo kiosco y nadie lo recarga: un deploy podía no llegar sin ir al condominio.

- La app pregunta cada minuto qué versión sirve el servidor (`GET /api/version`, o `POST /api/mi/version` con sesión) y, si no es la suya, se recarga sola. Nunca con una ronda en curso, con marcas por enviar o con alguien escribiendo.
- Freno: si la recarga no trae la versión nueva, tres intentos y después uno por hora.
- Panel → Guardias: columna "Versión de la app" con la versión con que se conectó cada guardia, si está al día y cuándo se vio por última vez. Es por guardia, no por teléfono.
- **En cada release** hay que subir la versión en tres lugares: `package.json`, `VERSION` en `sw.js` y `VERSION_APP` en `app.js` (hay un test que lo exige). Ese cambio es el que dispara la recarga en los teléfonos.
- El teléfono recibe este mecanismo la próxima vez que cargue la app; desde ahí, las versiones siguientes llegan solas.

## 1.18.0 — 2026-10-05 · El guardia puede eliminar su cuenta

Requisito de Google Play: si la cuenta se crea dentro de la app, tiene que poder borrarse dentro de la app y desde una página web pública (CU-25 en `SPEC.md`).

**Teléfono del guardia**
- "Eliminar mi cuenta", discreto al final de la pantalla de rondas. Explica qué se borra y qué se conserva y pide el PIN. Al terminar borra todo lo que guarda el teléfono (localStorage, respaldo en IndexedDB, cola), desuscribe la alarma de ronda y vuelve al login con un aviso.
- No deja borrar con una ronda en curso o marcas sin enviar (se perderían).

**Página pública** `/eliminar-cuenta.html`
- Sin login. Explica cómo hacerlo desde la app y trae un formulario usuario + PIN. Muestra el contacto `CONTACTO_PRIVACIDAD` (nueva variable de entorno: teléfono con WhatsApp y llamada, o correo) y enlaza `/privacidad.html`.

**Servidor**
- `DELETE /api/mi/cuenta` (con sesión + PIN) y `POST /api/cuenta/eliminar` (usuario + PIN). Comparten el tope de intentos con el login. Solo cuentas de guardia: admin, fábrica y acceso total reciben 403.
- Se borran el usuario, sus sesiones y sus suscripciones push. Sus rondas se conservan **anonimizadas**: "Guardia eliminado" en informes, panel, avisos e informe semanal, sin nombre ni usuario. Una ronda en curso se cierra con el cierre normal.
- Eliminar un guardia desde el panel hace lo mismo (antes dejaba su nombre en los avisos ya escritos).
- Los respaldos no se reescriben: lo borrado sale de ellos al rotar (14 días). Las copias por correo de `RESPALDO_TO` hay que borrarlas en el buzón con el mismo plazo — ver `entrega/OPERACION.md`.

**Al desplegar**: definir `CONTACTO_PRIVACIDAD=+56911112222` en Railway.

## 1.17.1 — 2026-09-30 · La ronda sobrevive al apagón · Informe semanal sin incoherencias

### La ronda sobrevive al apagón

Con la app instalada como PWA, si el teléfono se apagaba a mitad de ronda, al volver a abrirla la ronda ya no estaba: el guardia empezaba otra y la primera quedaba **"en curso" para siempre**. Pasaba sobre todo con la ronda hecha sin señal: al servidor solo le había llegado el inicio. (En Kiosk Browser no pasaba: la app nunca sale de primer plano.)

**Teléfono del guardia**
- Además de `localStorage`, el estado se respalda en IndexedDB con escritura estricta (queda en el disco antes de darse por guardado). Chrome baja `localStorage` al disco con retraso, y eso era lo que se perdía en el apagón. Al abrir, gana la copia más nueva y, si se recuperó una ronda, se avisa ("Se recuperó tu ronda en curso").
- Se vuelve a guardar al pasar a segundo plano y se pide almacenamiento persistente (que el navegador no borre los datos de la app para hacer espacio).
- La ronda sale del respaldo sola cuando el servidor confirma el cierre.

**Servidor**
- Las rondas abandonadas se cierran solas: sin actividad por `RONDA_ABANDONO_MIN` (120 por defecto) o el doble de la duración máxima de la ronda, si es más. Quedan como incompletas, con la observación "Cerrada automáticamente" y el aviso al administrador. Antes, una sola ronda colgada **callaba la alarma de ronda de todo el condominio**.
- Si el teléfono aparece después con las marcas que traía sin señal, la ronda se reabre, las recibe y el cierre del teléfono reemplaza al automático. Un cierre del administrador no se reabre nunca.
- Las colgadas de hace más de un día (las que ya existían antes de esta versión) se cierran en el primer arranque sin push, solo con el aviso en el panel.

### Informe semanal sin incoherencias

El informe decía "los puntos más cubiertos fueron X e Y; Z quedó al final del ranking" aunque todos los puntos tuvieran las mismas marcas: con empate, mandaba el orden en que se cargaron los puntos. Revisado entero; todas las frases salen de reglas fijas sobre los números (sin API).

- **Puntos → cobertura**: la sección 4 pasa a "Cobertura por punto de control" (marcado / lo que tocaba marcar según las rondas realizadas, y cuántas veces faltó). Aparecen **todos** los puntos, también los que nadie marcó (antes se cortaba en 10 y un punto con 0 marcas no salía). Con empate se dice que es empate; un punto que está en menos rondas no sale "menos cubierto".
- **Porcentajes honestos**: 100% de cumplimiento solo si no hubo incidencias (antes 299 de 300 redondeaba a 100%), 0% solo si es nada, y las partes suman 100. Las barras reparten los bloques igual.
- Faltantes de una ronda incompleta: los que se evaluaron al cerrarla, no los de la ronda editada después.
- Turno de un guardia con tantas rondas de día como de noche: "Día y noche" (antes, "Noche"). Plurales ("1 marcación"), "Semana del…" solo para un rango lunes-domingo.
- **Incidencias en resumen**: la sección 5 ya no lista ronda por ronda; muestra cuántas incompletas y sospechosas hubo, el % sobre el total y de qué guardia. El detalle sigue en el panel (pestaña Informes).
- **Gráfico de rondas por día y guardia** (sección 3): una barra apilada por día, un color por guardia (paleta validada para daltonismo; del 5.º guardia en adelante, "Otros" en gris), y debajo la misma información en una tabla guardia × día.
- **Logo de Rondas QR** arriba a la izquierda del informe, junto al título.
- `revisarCoherencia()` verifica que las secciones cuadren entre sí (y deja aviso en el log si no); `test/informe-semanal.test.js` lo prueba con el caso del empate y con 40 semanas de datos al azar.

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
