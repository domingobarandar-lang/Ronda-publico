# Cambios — Rondas QR

Las versiones anteriores a la 1.17 están descritas en `app/README.md` (cada función lleva la versión en que entró).

## 1.21.0 — 2026-10-21 · Menos marcas perdidas por la mecánica (QR y GPS), también en Fully Kiosk

No cambia el criterio de presencia: radio, margen, frescura y paridad con el servidor quedan igual. Lo que cambia es que el guardia deja de perder marcas por cómo funcionaba el flujo. Solo toca la app del guardia (`public/app.js`, `index.html`, `estilos.css`); el servidor no cambia. Revisado con foco en los teléfonos que corren la app en **Fully Kiosk Browser** (Android WebView).

- **El QR leído ya no se bota cuando falla la señal.** Si la marca no entra por algo que la señal puede arreglar (sin ubicación, ubicación vieja, señal imprecisa, o distancia dentro del error posible), el QR queda retenido y aparece un panel sobre el botón de escanear con **Reintentar** y **Cancelar**. Reintentar pasa por `procesarCodigo()` igual que un escaneo: mismo control, mismo plazo de espera, mismo registro de rechazo si vuelve a fallar. El rechazo por distancia real y el de un punto bajo techo con la señal de entrada vencida siguen siendo secos.
  - El plazo es de 2 minutos **desde la lectura del QR**: reintentar no lo renueva, y la espera de un Reintentar tardío se corta donde vence el plazo.
  - Si llega el QR de otro punto, el retenido se suelta con aviso («quedó SIN marcar: vuelve a escanear su QR»), no en silencio.
  - El panel dice «todavía NO está marcado» (sin ✓) y avisa al retener, al vencer el plazo y al terminar la ronda con un QR retenido: «QR leído» no es «punto marcado».
  - El motivo del panel se recalcula con la señal de ahora; si ya alcanza, lo dice («La señal ya alcanza: toca Reintentar»), pero la marca no entra sola.
  - En un punto bajo techo (anclaje) el panel habla de la entrada del recinto, no de esperar junto al QR.
- **La espera de señal se ve en ese mismo panel**, no en avisos flotantes que se esfumaban cada segundo y medio: «QR de "X" leído · afinando ubicación… 12 s».
- **Vigía del GPS.** Si el `watchPosition` habló y lleva 10 s callado (la mitad de la frescura), se vuelve a enganchar. Cubre el teléfono que deja de avisar con el guardia parado frente al punto, que terminaba en «tu ubicación es de hace 25 s».
  - Solo actúa con una marca en juego (lector abierto, marca esperando señal o QR retenido). En Fully cada `watchPosition` nuevo vuelve a pedirle el permiso a la app; hacerlo cada 12 s todo el turno era buscarse un diálogo o un rechazo.
  - Un watch que todavía no entregó su primera lectura no se corta antes de 60 s: está adquiriendo, y cortarlo reiniciaba la búsqueda.
  - Con el permiso de ubicación negado ya no se queda muerto: lo vuelven a pedir los toques del guardia (iniciar ronda, abrir el lector, Reintentar), nunca un bucle.
- **Lector más robusto.** La cámara se pide a 1080p. jsQR (iPhone y navegadores sin `BarcodeDetector`) lee el recorte del recuadro a 640 px en vez del cuadro entero achicado a 480: casi el doble de píxeles por módulo para un QR chico o lejano. Alterna con el cuadro completo y cada cuatro pasadas prueba el QR invertido. Enfoque continuo donde la cámara lo permite.
  - No va a resolución nativa a propósito: con poca luz el ruido del sensor llevaba una pasada de 800 px a casi un segundo. Se achica con suavizado, y la pausa entre pasadas crece con lo que costó la anterior: jsQR nunca se lleva más de la mitad del hilo, y los botones siguen respondiendo.
- **El lector deja de fallar callado.**
  - El detector nativo (Chrome y WebView lo implementan sobre Google Play Services) puede fallar de dos maneras: si revienta 5 veces seguidas se pasa a jsQR; si responde vacío para siempre (módulo de códigos no operativo), desde los 3 s sin lectura se intercala una pasada de jsQR cada medio segundo como mínimo (más espaciada si la pasada cuesta).
  - Releer el mismo QR antes de 2,5 s ya no deja la cámara encendida sin leer.
  - Cancelar y reabrir rápido, o activar dos veces el botón de escanear, ya no deja dos ciclos de lectura ni una cámara huérfana.
  - A los 8 s sin lectura el recuadro pasa a alerta, dice qué hacer y ofrece el código a mano. Solo menciona la luz si hay botón de linterna, que aparece cuando la cámara la declara (Chrome/WebView con flash; Safari desde iOS 17). Con dos códigos en cuadro gana el de la app.
  - El video y el recuadro van en un visor que se encoge: «Cancelar» se ve siempre, también a 360×640 con la ayuda y la linterna visibles (antes quedaba fuera de la pantalla, y en un kiosco no hay botón atrás). Con letra grande (Android al 200 %) queda pegado al borde de abajo del pie.
- **Actualización desatendida segura (kiosco).** El service worker es network-first archivo por archivo: con señal intermitente tras un deploy, un teléfono puede cargar la página, el código y los estilos de versiones distintas. Antes, la página vieja con el `app.js` nuevo dejaba la app sin arrancar.
  - `completarHtmlAnterior()` deja la página vieja con la estructura nueva: agrega lo que falta y mete el video y el recuadro en el visor.
  - `index.html` (`<meta name="version-app">`) y `estilos.css` (`--version-app`) declaran su versión. Con estilos de otra versión se inyectan las reglas mínimas del lector. La detección es por la marca, no por cómo se ve la página: con el lector oculto una medida de maquetación no distingue nada.
  - El video solo pasa a absoluto dentro del visor, y el pie del lector queda siempre por encima. Medido en Chrome con las cuatro combinaciones de página y estilos (de v1.20.2 y de esta versión), a 360×640 y 320×568: «Cancelar», «Código a mano» y «Encender luz» se ven y se pueden tocar en todas.
  - `shellMixto()` hace que `revisarVersion()` recargue cuando es seguro. Antes de recargar se exige que la página traiga la marca de la versión nueva; una página sin marca se acepta solo si es un cambio real de versión, para que un rollback a v1.20.x siga llegando a los kioscos.
  - Test nuevo `test/app-arranque.test.js`: arranca el `app.js` real sobre la página de esta versión y sobre la de v1.20.2 tal cual se publicó (`test/fixtures/`), y cruza cada id que usa `app.js` con `index.html`.
- **Documento nuevo `entrega/FULLY-KIOSK.md`**: ajustes obligatorios de Fully (cámara y ubicación PLUS, pantalla, recargas y borrado de datos), lo que hoy no funciona ahí (la alarma de ronda por Web Push) y una prueba de 5 minutos por teléfono antes de dar por buena esta versión.

## 1.20.1 — 2026-10-11 · Sentry enchufado sobre el manejador de errores

Con `SENTRY_DSN` vacío o ausente todo queda apagado y la app funciona igual que la 1.20.0.

- **Servidor**: `lib/sentry.js` se engancha a `errores.reportar()`, así que el manejador de Express, `process.on`, el programador, los recordatorios y las rondas abandonadas reportan sin más cambios. Envía `release` (`rondas-qr@<versión>`) y `environment` (production/development). El SDK solo se carga si hay DSN.
- **Navegador**: bundle propio `public/vendor/sentry.js` (~92 KB, 32 KB gzip; se arma con `npm run build:sentry` y se comitea; `@sentry/browser` y `esbuild` son devDependencies, no van a producción). No se usa el CDN de Sentry: sin señal no cargaría. `errores.js` obtiene el DSN de `GET /api/config-errores` e inicia Sentry; los mismos topes por sesión (10) y la misma deduplicación de la 1.20.0 valen también para Sentry. Sin bundle, sin DSN o sin señal, `errores.js` funciona como antes.
- **Datos personales**: antes de salir, el evento pierde cabeceras (authorization), cookies, cuerpo, query de las URL, PIN, coordenadas GPS y nombres; al guardia solo se lo identifica por su id interno. Sin breadcrumbs de consola/DOM/fetch ni handlers globales de Sentry (solo lo que pasa por `reportar`).
- `sw.js` precachea `vendor/sentry.js` y los tres HTML lo cargan antes de `errores.js`. Un fallo del bundle o de Sentry no impide que arranque la app ni toca la ronda en curso ni la cola.
- `SENTRY_PRUEBA=true` habilita `POST /api/admin/sentry-prueba` (solo administrador con sesión) para provocar un error de prueba tras el deploy.

## 1.20.0 — 2026-10-11 · Los errores de las apps y del servidor dejan rastro

Hasta ahora un error en el teléfono o en el panel desaparecía sin dejar nada, y en el servidor solo había un `console.warn` suelto. Esta versión es la base para enchufar Sentry después: **Sentry queda pendiente** (no se agregó cuenta ni dependencia).

- **Las tres páginas** (guardia, panel y fábrica) cargan `errores.js`: captura errores y promesas rechazadas, muestra un aviso corto arriba (no bloquea nada) y los manda al servidor. Máximo 10 reportes por sesión y un mismo mensaje se manda una sola vez. Ignora el ruido (extensiones del navegador, "Script error.", ResizeObserver, "sin señal"). **No recarga, no navega y no toca la ronda en curso ni la cola sin enviar.**
- **Servidor**: `POST /api/errores-cliente` (sin login, cuerpo máx. 8 KB, tope por IP) deja una línea `[error-cliente]` en los logs con página, mensaje, pila, versión y navegador. **Filtro de datos personales**: se oculta token, PIN, nombres, coordenadas GPS y los parámetros de las URL; todo se limpia de saltos de línea. Solo se registra el id interno del guardia, nunca el nombre.
- `lib/errores.js` centraliza el registro (`reportar(contexto, error)`): lo usan el manejador de Express, las tareas de fondo (informe semanal, alarma de ronda, rondas abandonadas) y los errores sin atrapar del proceso. Ahí se enchufará Sentry.
- Una promesa rechazada sin atrapar se registra y el servidor sigue; una excepción sin atrapar se registra y el proceso se reinicia limpio (Railway lo levanta).
- `errores.js` entra al caché del service worker (sin esto la app del guardia no abre sin señal).

## 1.19.1 — 2026-10-07 · La versión del teléfono se ve de inmediato

Los registros de producción del 7 de octubre mostraron que el teléfono de la garita corrió la app vieja todo el día (la página en modo kiosco no se recargó hasta las 16:51) y que los guardias entran, hacen la ronda y salen: el panel podía seguir en "sin datos" aunque el teléfono ya tuviera la versión nueva.

- La app revisa (y avisa) su versión **al entrar el guardia** y **al encenderse la pantalla**, además de cada minuto. Con la pantalla apagada el reloj de un minuto no corre.
- La pantalla de entrada muestra la versión instalada ("Versión 1.19.1"): se puede confirmar con una foto del guardia, sin sesión.

**Blindaje para el modo kiosco** (el teléfono se actualiza solo y nadie puede ir a destrabarlo):
- La actualización nunca navega a otra dirección: recarga la misma. La app del guardia no tiene enlaces fuera del dominio.
- Antes de recargarse, la app comprueba que la versión nueva está completa en el servidor (la página responde y `app.js` ya es el de esa versión). Si no, sigue con la que funciona.
- Service worker: una respuesta de error del servidor (502 a mitad de deploy) ya no se guarda en el caché ni reemplaza la app; se sirve la copia buena.
- `vigia.js`, independiente de `app.js`: si la app no arranca en 30 s (versión con un error, o `app.js` no bajó por mala señal), muestra "La app se está actualizando…" y recarga cada minuto, solo si el servidor responde, hasta que arranque. Una versión rota se arregla publicando otra, sin ir al condominio.

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
