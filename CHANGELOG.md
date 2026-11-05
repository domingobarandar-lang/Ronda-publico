# Cambios — Rondas QR

Las versiones anteriores a la 1.17 están descritas en `app/README.md` (cada función lleva la versión en que entró).

## Sin publicar — 2026-11-05 · La configuración de Railway pasa a `.railway/railway.ts`

Railway deja de leer `railway.json` el 1/12. El comando de arranque, lo único que venía de `app/railway.json`, ahora está guardado en el servicio (aplicado con `railway config apply`; la configuración que ya tenía, como el reinicio `ON_FAILURE`, no cambió). Su copia en código es `.railway/railway.ts`, y `app/railway.json` se borra. La app no cambia.

- **`.railway/railway.ts` declara el proyecto completo**: repo y Root Directory `app`, volumen en `/data`, las 19 variables con `preserve()` y el comando de arranque. Lo que el archivo no declara, `railway config apply` lo borra. El archivo del PR #35 (el de `railway config migrate`) traía solo el arranque y su plan proponía borrar las variables y soltar el volumen; no se llegó a aplicar.
- `entrega/RAILWAY-IAC.md`: dónde vive la configuración, la tabla de equivalencia y cómo correr el plan en Windows (hay un bug del SDK con Git Bash).
- **Producción arranca sin seed** (`node server.js`). Con datos en la base, `seed.js --si-vacio` no hacía nada, pero si alguna vez arrancaba con la base vacía (volumen perdido, `DB_PATH` mal escrito, una restauración fallida) creaba la demo, con cuentas cuyos PIN están en git, y la app arrancaba «sana» escondiendo la pérdida. `npm run demo` no cambia.
- **Se borra `INFORME_CONDOMINIOS`** de Railway (valía `piloto-sf`): con esa lista blanca, un condominio nuevo no recibía el informe del lunes. Ahora va a todos los que tengan correo cargado. Quedan 18 variables en `railway.ts`.

## 1.27.0 — 2026-11-04 · Cercanía reciente: menos marcas dudosas bajo techo, y el cierre automático ya no corta al guardia (INC-004)

Decisión y opciones en `entrega/ADR-001-GPS-BAJO-TECHO.md`; incidente INC-002 en `entrega/INCIDENTES.md`. Caso de uso nuevo CU-29 en SPEC.md.

- **Hallazgo (INC-002): en los puntos 🏠 la señal de la entrada se perdía a los 20 s.** Desde la v1.10 la app guardaba un solo fix, el promedio de los últimos 20 s. Si el teléfono seguía entregando lecturas de WiFi o de antena adentro, la de la entrada desaparecía y la marca se decidía con una lectura de ±40-300 m: rechazo («señal imprecisa», «lejos de la entrada») o una marca que no probaba nada. La ventana de 15 min solo funcionaba si el teléfono se callaba adentro.
- **Rastro de lecturas en la app del guardia:** cada lectura consolidada, buena o mala, con su ± (una por tramo de 2 s, las últimas 1.800: una hora). En memoria; se borra al cerrar sesión o al entrar otro guardia.
- **Cercanía reciente (CU-29), para todos los puntos con ubicación.** Si la señal del momento no alcanza (no hay, o el rebote la ubica lejos), antes de rechazar la app mira el rastro. La marca entra **«por cercanía»** si (1) hubo una lectura buena (±20 m o menos) a 30 m o menos del punto en los últimos 5 min (en un 🏠: dentro del tope de la entrada y de su ventana, 40 m + margen y 15 min), y (2) ninguna lectura posterior, la del momento incluida, lo ubica a más de 30 + 20 m descontando su ±. Cubre el alero, el pasillo, el estacionamiento techado y el subterráneo a pocos pasos de la señal sin que el administrador elija 🏠, y arregla la entrada que se perdía. La caseta sigue rechazada: una lectura buena a 150 m no la explica ninguna falla del GPS. Si la verificación de siempre alcanza, nada cambia.
  - La marca viaja con la lectura del momento (`gps`) y la cercana (`cercania`). El servidor revisa las dos con la misma regla (`verificarPresencia(punto, gps, cfg, cercania)`); las intermedias solo las ve el teléfono. La marca retenida («Afinando señal…», `evaluarPendiente()`) usa el mismo selector (`ubicacionParaMarca()`).
  - Una app anterior a la v1.27 no manda `cercania` y se decide como antes.
  - **Informe y aviso:** la marca por cercanía es una marca normal: la ronda queda «Completa», sin observaciones ni sospecha, y la línea del punto no lleva etiqueta. El dato queda guardado en la marca (`porCercania`, la `distanciaM` de la lectura cercana y `distanciaAhoraM` de la del momento). Se ve en Panel → Puntos («N por cercanía» en la señal de cada punto).
  - Configuración nueva (opcional, viaja en el paquete): `GPS_LECTURA_BUENA_M=20`, `GPS_CERCANIA_M=30`, `GPS_CERCANIA_MIN=5`, `GPS_ERROR_EXTRA_M=20`. **`GPS_CERCANIA_MIN=0` la apaga** y vuelve a la v1.25. La app trae los mismos valores por defecto para un paquete viejo en caché.
- **Panel → Puntos: «Señal (30 días)» en cada punto con ubicación:** 🟢 buena / 🟡 regular / 🔴 mala, con el ± típico de las marcas, cuántas entraron por cercanía y cuántos intentos rechazó el GPS, y una 💡 recomendación según la tabla nueva de `entrega/OPERACION.md` («Qué prueba usar en cada punto»): chapita NFC o 🏠 para un punto bajo losa, fijarlo en el último lugar con buena señal, o pasar un 🏠 con buena señal a 📍. Solo sugiere: la ubicación del punto nunca cambia sola. `GET /api/admin/puntos/senal` (nuevo; aparte de `/api/admin/puntos`, así que si falla la tabla carga igual) y `lib/senal-puntos.js`.
- **`scripts/diagnostico-gps.js`** (fase 0 del ADR): la misma cuenta para todos los condominios, en **solo lectura** (abre la base con `readOnly`, sin pasar por `crearStore()`), con rechazos por tipo, marcas al borde del tope, rechazos con la entrada perdida y una clase por punto (bajo losa, semi-techado, mal fijado, ancla perdida). En producción se corre solo con permiso.
- **Compatibilidad con los condominios de QR** (`test/compat-qr.test.js`): mismas respuestas, avisos, rondas guardadas e informe semanal que la v1.22. Los campos nuevos se declaran con su valor neutro: los cuatro umbrales del paquete con sus defaults y `porCercania: false` en el detalle del informe. Ninguna marca de la referencia entra por cercanía.
- **Fully Kiosk:** no usa ninguna API nueva del navegador (el rastro sale del mismo `watchPosition`). Falta la prueba de terreno en el teléfono de la garita: un punto semi-techado y uno bajo techo, escaneando 1-3 min después de perder la señal.
- Tests: `test/app-gps.test.js` (rastro, cercanía en la app: alero, subterráneo, caseta, ida y vuelta, bordes, 🏠 con lecturas malas adentro, marca retenida, envío), `test/cercania.test.js` (servidor e informe), `test/paridad-gps.test.js` (la rama nueva en toda la grilla, app y servidor deciden lo mismo), `test/senal-puntos.test.js` (señal por punto y su API) y `test/scripts.test.js` (el diagnóstico no escribe en la base).

### El cierre automático ya no corta al guardia que todavía no termina (INC-004)

Con la v1.25, una ronda con todos los puntos marcados se cerraba sola a los 15 min de la última marca, y el «Terminar» que llegaba después se descartaba. En Condominio Piloto cortó al guardia que todavía estaba con su observación: el 3/11 su «Terminar» llegó un minuto después del cierre y el informe dijo que no lo había tocado. Solo cambia el servidor; la app del guardia no se actualiza.

- **El plazo pasa de 15 a 30 min** (`RONDA_COMPLETA_CIERRE_MIN`, sin variable vale 30). En 422 rondas reales, el 99 % de los guardias tocó «Terminar» antes de 9 min y solo 2 pasaron de 30. Con más de ~40 min, la ronda abierta empieza a callar la alarma de un condominio que suena cada hora.
- **El «Terminar» del guardia que llega después del cierre automático cuenta** (`terminarTarde` en `lib/rondas.js`). Si lo tocó dentro del plazo y el teléfono estaba sin señal, la ronda queda como si hubiera llegado a tiempo, con su hora de término. Si lo tocó después, el fin sigue siendo la última marca (la espera no cuenta como ronda) y la observación «El guardia tocó «Terminar ronda» N min después de la última marca» reemplaza a «no tocó «Terminar ronda»». En los dos casos deja de contar como cerrada automáticamente en `/fabrica`, no se reabre, el informe no sale de nuevo y no hay push: llega un solo aviso corto, «✅ … sí tocó «Terminar ronda» en su ronda … Queda como terminada por el guardia», con su comentario si trae uno. Reemplaza al aviso «💬 Comentario de …» de la v1.25. El «Terminar» de otra persona (un administrador) no cambia la ronda. Si la hora del teléfono es anterior a la última marca (reloj atrasado), el fin no se mueve: la ronda no se acorta.
- **El barrido ya no pisa un «Terminar» que llega mientras trabaja.** Leía todas las rondas en curso al empezar y cerraba esas copias; si mientras esperaba el push de una llegaba el «Terminar» o las marcas de otra, las pisaba. Ahora relee cada ronda justo antes de cerrarla.
- Tests: `test/abandonadas.test.js` (los 30 min, el «Terminar» tardío, el que tocó a tiempo sin señal, el de un administrador, el reintento de la cola, el borde del plazo, el reloj atrasado y el «Terminar» que llega durante el barrido).

## 1.26.0 — 2026-11-01 · La pantalla de la operación muestra la salud del producto y los errores de Sentry por condominio

Los fallos más caros no son errores de código. El corte de rondas por sesión vencida (INC-001) era un 401, comportamiento esperado: ni el registro de errores (v1.20) ni Sentry (v1.20.1) podían verlo. Ahora la ficha de cada condominio en `/fabrica` muestra, para los últimos 7 días, cómo terminan sus rondas, cuáles tuvieron dificultades técnicas y de quién fue el fallo (`lib/salud.js`), y sus errores de código en Sentry (`lib/sentry-lectura.js`). El panel del administrador y la app del guardia no cambian a la vista: la app sube de número de versión y le dice a Sentry de qué condominio es cada error.

- **Rondas por estado:** completas (con o sin observaciones), incompletas, con sospechas y **cerradas automáticamente**, con su porcentaje sobre las cerradas. Las cerradas automáticamente son las que cerró el proceso de rondas abandonadas (`estaAbandonada` en `lib/rondas.js`) y van aparte aunque hayan quedado completas: el guardia no las terminó. Las que siguen en curso se dicen aparte.
- **Rondas con dificultades técnicas**, separadas en dos lados, cada uno con sus rondas y su porcentaje sobre las rondas de la semana (una ronda puede tener causas de los dos lados; `salud.dificultades`):
  - **Fallo de la aplicación o del teléfono:** **GPS** (en rojo y con el número de rechazos: sin ubicación, ubicación vieja, señal imprecisa, o lejos pero dentro del error posible, que es la misma regla con la que la app retiene el QR para reintentar), **sesión cortada a mitad de ronda**, **el teléfono no terminó la ronda** (la cerró el sistema con puntos sin marcar) y **la chapita no lee** (el reporte del guardia, o el teléfono no entregó la serie).
  - **Fallo del usuario:** **lejos del punto con buena señal de GPS** (más allá del tope del punto más `GPS_PRECISION_MAX_M`), **QR, chapita o código equivocado** y **marcó todos los puntos y no tocó «Terminar ronda»**.
  - Casi todo sale de las rondas (sus rechazos y su cierre). La sesión cortada no dejaba rastro: ahora `POST /api/login` anota al guardia que entra con una ronda propia en curso (`salud.anotarReingreso`); desde la v1.25.1 es el «Entrar de nuevo» del aviso de sesión vencida. Otro guardia que entra en el mismo teléfono con la ronda de un compañero abierta no cuenta, y anotarlo nunca hace fallar el login.
- **Errores técnicos (Sentry)** en cada ficha: los problemas sin resolver de los últimos 7 días de ese condominio, los 3 más frecuentes con cuántas veces pasaron, la última vez y el enlace a Sentry. Los que no tienen condominio (tareas del servidor, pantallas sin sesión, errores de antes de la v1.26) van en su propio bloque, al final. El servidor lee la API de Sentry (`GET /api/fabrica/sentry`, solo el rol fábrica) con un token de **solo lectura**, `SENTRY_TOKEN_LECTURA`, que nunca sale del servidor; la organización, el proyecto y la región salen del `SENTRY_DSN`. Cada consulta se guarda 5 minutos. La lista de condominios no espera a Sentry, y sin token la pantalla dice qué falta y lo demás funciona igual.
- **Etiqueta `condominio` en Sentry:** `errores.reportar` acepta el condominio (`{ condominioId }`) y lo manda como etiqueta. Lo usan el manejador de errores de Express (el condominio de la petición) y la alarma de ronda. En el navegador, `errores.js` se lo pide a la página (`window.__erroresCondominio`, que `app.js` y `admin.js` definen con la sesión que ya tienen): `errores.js` sigue sin leer localStorage. El id del condominio no es un dato personal.
- **Registro nuevo `eventos_salud`** (tabla propia en SQLite, `store.salud`): tipo, condominio, hora, id de la ronda y, del guardia, solo el id interno, como `lib/errores.js` (ni nombre, ni PIN, ni ubicación). Se poda solo a los 30 días. Borrar la cuenta de un guardia le suelta el id, igual que en sus rondas. La base anota desde cuándo mide (`meta.saludDesde`) y la ficha lo dice mientras no se cumpla la semana: antes de esa fecha, un cero en «sesión cortada» no quiere decir nada.
- **Para activarlo en Railway:** `SENTRY_TOKEN_LECTURA` (cómo crearlo, en `app/.env.example`). `SPEC.md` (CU-21) y `entrega/OPERACION.md` describen la pantalla.
- Tests nuevos: `test/salud.test.js` (rondas por estado y porcentajes, un condominio sin rondas, cada causa de cada lado, el margen del GPS, sesión cortada, ventana de 7 días y poda, borrado de cuenta), `test/sentry-lectura.test.js` (configuración desde el DSN, la consulta, los conteos, el caché y los errores de Sentry, con un fetch de mentira) y `test/salud-fabrica.test.js` (el login, `GET /api/fabrica/condominios` y `GET /api/fabrica/sentry` de punta a punta, también con un condominio sin rondas y sin token). `test/errores.test.js` y `test/sentry.test.js` prueban la etiqueta `condominio`.

## 1.25.1 — 2026-11-01 · La chapita ya no saca de la app, y la sesión vencida no corta la ronda

Guía de prueba en el teléfono: `entrega/PRUEBAS-NFC.md` §5 y §6.

- **«Se abrió una pantalla en blanco y me sacó de la app» al acercar una chapita** (Android sin Fully). Dos partes:
  - **Con la app abierta, el lector queda escuchando.** Antes escuchaba solo con la pantalla de la chapita abierta y se apagaba al leer, con la chapita todavía apoyada. Una chapita que ninguna app tiene tomada se la lleva Android: pantalla de etiquetas, otra app de NFC o una ventana casi vacía que tapa la app. Ahora, en un condominio con chapitas, el lector se enciende con el primer toque («Iniciar» una ronda con chapitas, o «Escanear») y no se apaga al leer, rechazar ni cancelar. Con el permiso ya dado, se vuelve a encender solo al abrir la app o al volver a ella. Una chapita acercada en cualquier parte de la ronda (lista, cámara, pregunta «¿Qué hay en este punto?») marca igual que desde su pantalla, con las mismas reglas. Sin ronda en curso dice «Para marcar la chapita, primero inicia la ronda».
  - **Con la app cerrada o en segundo plano, la chapita abre la app.** El panel graba ahora primero un registro con el **enlace a la app** (`<servidor>/#nfc`) y después el texto `RQR:…` de siempre. Android abre la app (la instalada si lo está) en vez de su pantalla de etiquetas, y la app dice «Abriste la app con la chapita: acércala otra vez para marcar». Esa lectura no marca: desde un enlace no llega la serie, que el servidor exige. Si el enlace no cabe en la chapita (NTAG213: 137 bytes), se graba solo el texto, como antes, y el panel lo dice. Las chapitas ya grabadas (solo texto) siguen marcando igual, y la app de antes lee las nuevas. Para que una chapita lleve el enlace hay que regrabarla («📶 Reemplazar chapita»; las bloqueadas no se pueden).
  - **Dos pestañas de la app:** si la app estaba en una pestaña de Chrome, el enlace puede abrir otra. Cada pestaña toma lo que guarda la otra (evento `storage`, gana el `rev` más alto) y ninguna borra lo marcado en la otra.
  - Un condominio de puros QR (Condominio Piloto) no enciende el lector ni pide permiso de NFC.
- **Sesión vencida a mitad de la ronda.** Hasta la v1.25.0, el primer envío rechazado por sesión vencida (401) borraba la sesión, y la marca siguiente mandaba al login. Sin señal, el guardia no podía entrar ni seguir la ronda. Ahora la sesión queda marcada como vencida, la ronda sigue, y arriba aparece «Tu sesión venció. La ronda sigue…» con **«Entrar de nuevo»** (y «← Volver sin entrar» en el login). Se puede marcar y terminar la ronda. Al volver a entrar se envía todo. Funciona junto con el teléfono compartido de la v1.25.0: si entra otro guardia, lo del anterior queda guardado aparte, como ahí.
- **Salir con marcas sin enviar** ya no las borra («¿Salir igual?»): quedan guardadas aparte a nombre del guardia (como en el teléfono compartido) y vuelven cuando entra de nuevo.
- **Chrome borró los datos del sitio** (o cambio de teléfono): al entrar, la app pregunta `GET /api/mi/ronda-en-curso` (nuevo; solo la ronda abierta del propio guardia, sin ubicaciones) y la retoma con las marcas que ya habían llegado.
- Tests: `test/chapita-enlace.test.js` (lo que se graba, el tamaño, chapitas viejas y nuevas, `#nfc`, dos pestañas), `test/sesion-ronda.test.js` (sesión vencida, salir, ronda desde el servidor), `test/app-nfc.test.js` (lector que queda escuchando) y `test/cola-reintentos.test.js` (un 401 ya no borra la sesión). En Chromium: `scripts/probar-sesion-ronda.js` (nuevo: apagado, sesión vencida, otro guardia, datos borrados) y `scripts/probar-nfc-simulado.js` (lector que sigue escuchando, enlace en la chapita, app abierta por la chapita, dos pestañas). `test/compat-qr.test.js` sigue pasando sin cambios.

## 1.25.0 — 2026-10-31 · Rondas que quedaban a medias en el teléfono compartido

Investigación en Condominio Piloto: rondas que aparecieron "paradas a la mitad" y tres seguidas quedaron abiertas con todos los puntos marcados. No fue internet: en el teléfono compartido de la garita, (1) la sesión vencía a la hora y media del **login**, aunque el guardia estuviera en plena ronda, y el teléfono volvía a pedir el PIN; (2) si entraba otro guardia, la app mandaba lo pendiente del anterior con la sesión nueva, el servidor lo rechazaba («Esta ronda no te pertenece») y la cola lo descartaba: así se perdió el cierre de una ronda completa; y (3) con los 9 puntos marcados, «Terminar ronda» quedaba abajo, fuera de la pantalla, y la ronda seguía abierta dos horas, callando la alarma de ronda del condominio.

- **Sesión:** dura 1 h 30 desde la última actividad de ronda (iniciar, marcar, rechazo, terminar), no desde el login (`renovarSesion` en `lib/auth.js`, anotada a lo más cada 5 min). Lo que no es ronda (la consulta de versión de cada minuto, el paquete) no la renueva: una sesión olvidada en un teléfono prendido vence igual. La renovación queda en la base: un deploy a mitad de ronda no la pierde. `test/sesion-en-ronda.test.js`.
- **Pantalla de fin de ronda (app del guardia):** al marcar el último punto aparece **«✅ Marcaste todos los puntos — Ahora toca «Terminar ronda»…»**, el botón de escanear y el de código a mano se esconden, **«Terminar ronda» pasa a ser el botón grande**, la pantalla baja hasta él y el teléfono vibra distinto. El aviso de la marca («✅ Piscina (9/9)») no cambia. La página de una versión anterior servida por el caché recibe el aviso nuevo (`completarHtmlAnterior`).
- **Cierre automático de una ronda completa:** la que tiene todos los puntos marcados y nadie terminó se cierra a los **15 minutos** de la última marca (`RONDA_COMPLETA_CIERRE_MIN`), no a las 2 horas. El informe dice lo que pasó: «Cerrada automáticamente por el sistema: el guardia marcó todos los puntos pero no tocó «Terminar ronda»» (antes decía que el teléfono no terminó la ronda). Si después llega el «Terminar» del teléfono, ya no la reabre (no salía nada nuevo, el informe se mandaba dos veces y la espera contaba como ronda); si trae comentario, se guarda en la ronda y llega como aviso aparte («💬 Comentario de … sobre su ronda …»). Una ronda a medias sigue esperando las 2 h de siempre.
- **Teléfono compartido:** cada ronda anota en el teléfono quién la inició. Si la sesión de un guardia se corta y entra otro, lo pendiente del primero (marcas, cierre, la ronda en pantalla) queda **guardado aparte** con su nombre y no se manda con la sesión del segundo; el que entra ve su pantalla limpia y un aviso. Vuelve a la cola, en orden, cuando el primero entra de nuevo en ese teléfono. Lo apartado se guarda un día. Las rondas iniciadas antes de esta versión no tienen dueño anotado y siguen como antes. `test/telefono-compartido.test.js`.
- **Un cierre que el servidor rechaza** ya no deja la pantalla en «Enviando el informe al administrador…» para siempre: se avisa y se vuelve al inicio.
- **Horas de los avisos en hora de Chile:** el servidor corre en UTC y los avisos al administrador decían «Inicio 01:02 p. m.» de una ronda de las 10:02. Es el único cambio que ve un condominio de QR; `test/compat-qr.test.js` lo declara (pasa las horas de la referencia v1.22 a hora de Chile antes de comparar).
- Configuración nueva en `.env.example`: `RONDA_COMPLETA_CIERRE_MIN=15` (opcional; sin ella vale 15).

## 1.24.1 — 2026-10-30 · En un condominio sin chapitas, el botón vuelve a decir «📷 Escanear QR»

- En la v1.24.0 el botón principal de la app del guardia pasó a decir «Escanear» en todos los condominios, también en los que no tienen chapitas (por ejemplo Condominio Piloto), donde podía confundir a los guardias. Ahora el texto depende de la ronda: **«📷 Escanear QR»** si la ronda no tiene puntos con chapita —igual que hasta la v1.22— y **«Escanear»** solo si tiene alguno. Qué abre el botón no cambia: en una ronda sin chapitas, la cámara, como siempre. No hay que configurar nada por condominio: en cuanto un punto de la ronda tenga chapita grabada, el botón cambia solo.
- `index.html` vuelve a traer «📷 Escanear QR» (el texto de la página antes de que la app pinte la ronda). Tests: `app-nfc` (el texto según la ronda) y `compat-qr` (el botón de la página y el de la ronda son los de la v1.22).

## 1.24.0 — 2026-10-28 · Puntos con chapita NFC, compatibles con los QR

Un punto puede marcarse con una **chapita NFC** (sticker NTAG213 en carcasa impresa) en vez de un QR. Es por punto: un punto es NFC solo cuando tiene una chapita registrada. **Los puntos sin chapita funcionan exactamente igual que antes**: los condominios actuales no migran nada ni cambian de comportamiento. Caso de uso nuevo CU-28 en SPEC.md; guía paso a paso en `entrega/OPERACION.md`.

- **Qué lleva la chapita:** un registro NDEF de texto con el mismo payload del QR (`RQR:<condominio>:<punto>:<código>`). El panel registra además el **número de serie de fábrica** del tag (`nfcSerie`, hex en mayúsculas sin separadores), y el servidor lo **exige**: una foto del QR o una copia del texto en otro tag común no sirve. Una chapita no puede pertenecer a dos puntos (tampoco de dos condominios).
- **Panel → Puntos:** al agregar un punto se elige «con QR» o «con chapita NFC», y el aviso dice qué sigue. Cada punto muestra con qué se marca: «📷 QR», «📶 NFC · falta grabar la chapita» (`nfcPendiente`: no se imprime en la hoja de QR y, mientras, se marca con el código a mano) o «📶 NFC · chapita grabada» con la serie abreviada. En cada punto, **📶 Grabar chapita** / **Reemplazar chapita** / **Volver a QR**. La grabación se hace en terreno con Chrome en un Android con NFC: lee la serie (avisa si la chapita ya tiene otro punto), escribe, vuelve a leer para verificar y recién al final guarda la serie (`PUT /api/admin/puntos/:id/chapita`; `DELETE` para volver a QR). **Graba sin bloquear**: el bloqueo es un paso aparte, **🔒 Bloquear chapita**, para cuando ya se probó y es la definitiva: lee la chapita, comprueba que sea la registrada y que tenga el código del punto, la deja de solo lectura (`makeReadOnly`, para siempre) y lo anota (`PUT /api/admin/puntos/:id/chapita/bloqueo`). En un punto con chapita no aparecen los botones de ubicación (queda «Quitar 📍» si ya tenía una). Si grabar o bloquear falla, el panel dice por qué. Fuera de Android/Chrome el botón explica dónde y cómo hacerlo. Sugiere no fijarle GPS a un punto bajo techo.
- **App del guardia:** el botón principal dice **«Escanear»** (desde la v1.24.1, solo en rondas con chapitas; en las demás sigue «📷 Escanear QR») y abre **un solo medio**, nunca la cámara y el lector a la vez: la pantalla **«Acerca la parte trasera del teléfono a la chapita»** si todos los puntos que faltan son NFC (o el próximo, con orden estricto); la cámara si ninguno lo es; y en una ronda mixta sin orden pregunta **«¿Qué hay en este punto?»** (📷 Un QR / 📶 Una chapita). El lector arranca con el toque (Web NFC lo exige) y se detiene al cerrar (`AbortController`).
  - La lectura entra por `procesarCodigo()` con la serie: GPS, espera de señal, retención, cola offline y avisos son los mismos. El evento de la cola lleva `nfc: { serie }`.
  - Validación offline espejo del servidor: el paquete trae por punto `nfc` y `nfcHuella` (SHA-256 de la serie: la serie no queda guardada en el teléfono), y `manualEnNfc`. Un QR leído para un punto NFC se rechaza («Este punto se marca con la chapita NFC…») y queda en el registro de rechazos.
  - Sin Web NFC (iPhone, Fully Kiosk, otro navegador), permiso negado (`NotAllowedError`), NFC apagado (`NotReadableError`) o sin NFC (`NotSupportedError`): mensaje claro de qué pasa y qué hacer.
  - **«⚠️ La chapita no lee»**: el punto queda sin marcar y el aviso viaja como rechazo con `reporte: 'chapita'`; el informe lo pone en las observaciones para que el administrador revise o reemplace la chapita.
  - La página de una versión anterior servida por el caché se completa con la pantalla nueva (`completarHtmlAnterior`).
- **Servidor (`registrarEscaneo`):** en un punto con chapita la marca entra solo con la serie que coincide (medio `nfc`). QR sin serie, otra serie o código a mano → 422, registrado en `rechazos`. Cada marca guarda `medio: 'qr' | 'nfc' | 'manual'`. Las reglas de GPS no cambian.
- **Código a mano en un punto NFC: no entra** (decisión de José: sin GPS bajo techo, el código tipeado sería la puerta para marcar sin ir). Una sola constante para cambiarlo: `MANUAL_EN_PUNTO_NFC` en `lib/rondas.js` (`'rechazo'` | `'observacion'` | `'sospecha'`); viaja en el paquete, así que la app aplica la misma regla. En el panel, el código de un punto con chapita dice «no sirve a mano».
- **Hoja de QR:** los puntos NFC, también los que tienen la chapita por grabar, salen marcados «Chapita NFC — no lleva QR», sin QR ni código.
- **Informe, aviso al administrador e informe semanal:** en las rondas que tienen puntos con chapita, cada marca muestra 📶 NFC / 📷 QR / ⌨️ a mano; en el informe semanal, la tabla de puntos agrega el desglose cuando hubo marcas con chapita. En un condominio de puros QR no aparece nada nuevo (las marcas anteriores a esta versión tampoco tienen etiqueta).
- **Panel → Rondas: flechas ↑ ↓** para cambiar un punto de lugar en la secuencia (antes solo se podía agregar al final y quitar). Mover un punto no toca su QR ni su chapita. `test/orden-ronda.test.js`.
- **Compatibilidad con los condominios que ya usan QR** (`test/compat-qr.test.js`): una semana de operación de puros QR (marcas buenas y malas, GPS exacto y por entrada, sin señal, duplicados, ráfaga, cierre del administrador, informes, avisos, hoja de QR, informe semanal, y la app del guardia: avisos, cola, pantalla, cámara, marca retenida) se corre con esta versión y se compara campo por campo con lo que hizo la v1.22.0, guardado en `test/fixtures/referencia-qr-v1.22.json`. Solo se permiten los campos nuevos y con su valor neutro (`nfc: false`, `medio: 'qr'`…). La referencia se regenera con `scripts/generar-referencia-compat.js`. Esta revisión encontró y corrigió lo que sí cambiaba para un condominio de QR: textos al guardia («vuelve a escanear su QR», «junto al QR»), las etiquetas 📷 QR en la lista de puntos, el informe y el aviso, el texto del código a mano, y que los botones nuevos pudieran impedir el arranque de la app.
- Otras dos correcciones de la revisión: un QR rechazado en un punto con chapita ya no reabre una ronda que el sistema había cerrado solo, y «La chapita no lee» no queda en el informe si al final el guardia sí marcó el punto.
- **Fully Kiosk:** fuera de alcance. No se pudo verificar su API NFC (su sitio está bloqueado desde la sesión de desarrollo). La app detecta Fully y dice «Este teléfono todavía no lee chapitas NFC». Queda como pendiente en `entrega/FULLY-KIOSK.md`, con las alternativas que sí usan Chrome.
- `entrega/SEGURIDAD.md` corregido: un NTAG213 **sí** se puede copiar; la serie de fábrica lo frena, salvo con tags «mágicos» de serie cambiable. NTAG 424 DNA queda como opción futura.
- Tests nuevos: `test/chapita-nfc.test.js` (servidor) y `test/app-nfc.test.js` (app, con un `NDEFReader` simulado). Plan de prueba en terreno: `entrega/PRUEBAS-NFC.md`.

## 1.22.0 — 2026-10-26 · La alarma de ronda suena en Fully Kiosk

En Fully Kiosk Browser la alarma de ronda no sonaba: el Android WebView no tiene Web Push ni notificaciones, y la app ocultaba el botón. Ahora, en un teléfono con Fully y su interfaz JavaScript activa, la app consulta al servidor y la hace sonar con las funciones propias de Fully. El Web Push de Chrome Android y del iPhone no cambia, y el criterio de presencia del GPS tampoco.

- **Un solo reloj.** Cuándo toca lo sigue decidiendo `lib/recordatorios.js`: el intervalo que fijó el administrador, contado desde la última alarma o desde el inicio de la última ronda. Lo nuevo, `alarmaVigente()`, solo contesta la última alarma que anotó `revisar()` mientras siga en pie: nadie salió a la ronda desde que sonó, no se cumplió el intervalo y no se volvió a guardar la configuración. También contesta la prueba del panel durante 10 minutos. El texto de la alarma (`textoAlarma()`) es el mismo para Web Push y Fully.
- **El teléfono con Fully pregunta cada minuto** (`POST /api/alarma-kiosco`), además de al encender la pantalla y al volver la señal. Lo hace con una credencial del teléfono que el servidor entrega al activar la alarma (`POST /api/mi/alarma-kiosco`, con sesión). No usa la sesión del guardia porque vence a la hora y media y cambia con el turno: la alarma sigue sonando con la app en la pantalla de entrada, igual que una suscripción push. Registro nuevo `db.alarmaKioscos` (`lib/alarma-kiosco.js`): el mismo teléfono (`fully.getDeviceId()`) reemplaza su registro, `visto` se anota cada 2 minutos y no en cada consulta, y un teléfono que no consulta en 7 días se olvida.
- **Suena una vez por alarma y por teléfono.** La identidad de una alarma es su hora en el servidor. El teléfono anota la última que vio (localStorage, fuera de `estado`: sobrevive a «Salir» y a la recarga para actualizarse). No la repite en la consulta del minuto siguiente ni después de recargar. En cada teléfono corre un solo camino (`modoAlarma()`): si existe el objeto `fully` se usa Fully y no se toca el push, así que una misma alarma no puede sonar dos veces en la misma app. Si el guardia está en una ronda en ese teléfono, la alarma se anota sin sonar; la prueba del panel suena igual.
- **Cómo suena:** `turnScreenOn`, `stopScreensaver`, `bringToForeground`, `showNotification` (prioridad alta), `vibrate` y `playSound` de `alarma.wav` (pitidos, 4 s, 32 KB) por el canal de alarma de Android. El sonido se toca sin bucle y la app lo repite durante un minuto: si la página muere a la mitad, se corta solo en segundos. Arriba aparece un aviso con **Entendido**, que corta el sonido; empezar una ronda también lo corta. Mientras suena, la app no se recarga para actualizarse.
- **Sin la interfaz JavaScript de Fully** (o en otro WebView), la app no ofrece el botón y dice que falta activarla. Si se apaga después de activar la alarma, el teléfono lo informa en su consulta y el panel lo muestra.
- **Panel → Avisos:** lista los teléfonos con Fully: nombre, quién activó la alarma, si está conectado y cuándo sonó la última alarma ahí, o desde cuándo no se conecta («ahí la alarma no puede sonar»). «Hacerla sonar ahora» llega a esos teléfonos en menos de un minuto y ya no responde «ningún teléfono» si solo hay teléfonos con Fully.
- Borrar la cuenta de un guardia (él mismo o el panel) borra también los teléfonos con Fully que activó, igual que sus suscripciones push.
- Se descartó mandarle la orden a Fully por su API REST / Remote Admin: escucha en la red local del teléfono (Railway no llega a él) y exige guardar en el servidor la contraseña de administración de cada teléfono. Las razones están en `entrega/FULLY-KIOSK.md`.
- `entrega/FULLY-KIOSK.md`: sección nueva «Alarma de ronda en Fully» con los ajustes que requiere (Enable JavaScript Interface, URL Whitelist al dominio de la app porque Fully no permite limitar la interfaz a un dominio, volumen de alarma, permiso de notificaciones, pantalla encendida o con protector, no tener la alarma también en Chrome) y un paso 8 en la prueba de 5 minutos.
- Tests nuevos en `test/alarma-kiosco.test.js` (15): cuándo está en pie una alarma, el registro de teléfonos, la prueba del panel, el borrado de cuenta y, sobre el `app.js` real, la decisión de sonar, que no se repite ni tras recargar, el minuto de sonido, el comportamiento sin interfaz, con ronda en curso y sin señal, y que Fully y Web Push nunca corren juntos.

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
