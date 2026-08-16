# SPEC — Rondas QR (control de rondas de guardias)

**Fecha**: 2026-07-16 · **Estado**: aprobada por el orquestador (supuestos al final)

## Qué es

Sistema de control de rondas de seguridad para condominios que reemplaza chapitas físicas (iButton) + lectora por QR impresos + el teléfono del guardia.

Tres piezas, una sola app Node:

1. **PWA del guardia** (teléfono): login, ronda descargada, escaneo de QR, funciona sin señal.
2. **Panel del administrador** (navegador): configura puntos/guardias/rondas, imprime la hoja de QR, ve los informes.
3. **API + motor de rondas** (servidor Node): valida escaneos, cierra rondas, genera informes, envía alertas.

## Actores

- **Guardia**: usuario con PIN; ejecuta rondas escaneando QR.
- **Administrador**: usuario con PIN; configura los condominios y recibe informes. Desde la v1.12 el panel lo operan **solo la operación y su equipo**: una cuenta alcanza para todos los condominios (CU-22). Los administradores de los condominios no entran al panel — reciben el informe semanal por correo (CU-20).
- **Fábrica** *(v1.11)*: la operación dando de alta condominios desde `/fabrica`. Es el único rol que **no** pertenece a ningún condominio y, justamente por eso, no puede ver los datos de ninguno.
- Cada **guardia** pertenece a **un** condominio y no sale de ahí. Una instalación sirve a varios condominios: los datos de cada uno están separados, pero el panel los recorre todos.

## Casos de uso (verificables)

- **CU-01 Login**: `usuario + PIN` correctos → sesión iniciada con rol y condominio. PIN incorrecto → error claro y sin sesión.
- **CU-02 Ronda descargada**: el guardia autenticado obtiene las rondas de su condominio con la lista ordenada de puntos; el paquete queda guardado en el teléfono y la ronda puede ejecutarse aunque se caiga la conexión.
- **CU-03 Iniciar ronda**: el guardia inicia una ejecución → queda registrado quién, qué ronda y a qué hora.
- **CU-04 Escaneo válido**: QR de un punto de la ronda en curso → se registra con timestamp, el punto se marca hecho y se ve el avance (n/total).
- **CU-05 Escaneo inválido**: QR de otro condominio, de un punto inexistente o texto arbitrario → rechazado con mensaje claro; no se registra nada.
- **CU-06 Escaneo duplicado**: mismo punto dos veces en la misma ejecución → se conserva el primer registro y se avisa al guardia; no se duplica.
- **CU-07 Offline**: sin conexión, los escaneos quedan en cola local con su timestamp original; al volver la conexión se sincronizan tal cual (marcados `offline` en el informe).
- **CU-08 Cierre y evaluación**: al cerrar la ronda (guardia, o el admin desde el panel si quedó abierta), el servidor evalúa: puntos faltantes, orden violado (si la ronda es estricta) y duración vs máximo permitido.
- **CU-09 Informe**: cada cierre genera un informe con condominio, ronda, guardia, inicio/fin/duración, detalle por punto (hora de marca o **FALTANTE**) y estado global: `Completa`, `Completa con observaciones` o `Incompleta`.
- **CU-10 Alerta de punto saltado**: si faltan puntos, el informe queda `Incompleta` y el administrador recibe una notificación (registro en el panel siempre, y push al teléfono si lo activó) con los puntos faltantes.
- **CU-11 Panel admin**: alta/edición de puntos, guardias y rondas del condominio; listado de informes con estado visible de un vistazo.
- **CU-12 Hoja de QR**: el admin genera una hoja imprimible con el QR de cada punto (+ código corto al pie) para pegar en los sectores.
- **CU-13 Entrada manual de respaldo**: si la cámara falla o el QR está dañado, el guardia tipea el código corto de 6 caracteres impreso bajo el QR — misma validación que el escaneo.
- **CU-14 Aislamiento del guardia** *(hasta v1.11 era aislamiento total; ver CU-22)*: un guardia jamás ve ni valida nada de otro condominio — ni rondas, ni puntos, ni los payloads de los QR, aunque su app pida otro. Ese encierro es el que sostiene el antifraude y no se negocia. **Entre administradores el aislamiento se levantó en la v1.12**: cualquier cuenta `admin` trabaja sobre cualquier condominio.
- **CU-15 GPS en cada marca** *(v1.1)*: al marcar un punto, la app adjunta la ubicación GPS del teléfono (lat/lon/precisión) si está disponible. El fix debe ser reciente (20 s): con un radio de 20 m, una posición vieja ya no describe dónde está el guardia.
- **CU-16 Verificación de presencia** *(v1.1, endurecida en v1.9, corregida en v1.13)*: el administrador puede fijar la ubicación real de cada punto (desde su teléfono parado en el lugar, o quitarla). Si un punto tiene ubicación, el servidor calcula la distancia de cada marca: más allá del tope queda **"lejos del punto"** — observación destacada en el informe y en el aviso al administrador. Marcas sin GPS sobre puntos georreferenciados también quedan observadas. El tope **no es un número fijo** (ver CU-23): es el radio del punto más la imprecisión declarada de las dos medidas que se comparan.
- **CU-18 El GPS bloquea la marca** *(v1.9)*: sobre un punto **con ubicación fijada**, la app **no deja marcar** —ni por QR ni por código a mano— si el teléfono está más lejos del tope o si no hay un fix GPS reciente. El guardia ve la distancia exacta, el tope del momento y la precisión de su señal. El bloqueo se aplica en la app (antes de encolar, funciona sin señal) y se revalida en el servidor con los mismos umbrales, que viajan en el paquete de rondas. Ajustable por entorno (`GPS_RADIO_M`, `GPS_MARGEN_MAX_M`, `GPS_FRESCO_MS`, `GPS_BLOQUEA`) sin tocar código.
- **CU-19 Verificación por entrada (anclaje)** *(v1.10)*: para los puntos **bajo techo** —subterráneos, salas de calderas, interiores de torre— donde el GPS no llega y el radio de 20 m es inalcanzable. El administrador fija la **entrada** del recinto (o el último lugar del recorrido con señal) con "🏠 Fijar entrada" en vez de "📍 Fijar aquí". Ese punto se valida distinto: se acepta el fix que el teléfono tomó **hasta 15 min antes**, siempre que esté dentro de **40 m del ancla**. Prueba que el guardia pasó físicamente por la entrada hace poco, no que esté sobre el punto — es deliberadamente más débil que CU-18, y la alternativa real era no verificar nada. Cada punto puede tener su propio radio y su propia ventana (`radioM`, `ventanaMin`) para calibrar en terreno; los defaults son `GPS_ANCLA_RADIO_M` y `GPS_ANCLA_VENTANA_MIN`.
  - Un punto anclado **exige** que la app informe la antigüedad del fix (`edadMs`, como duración para que el reloj del teléfono no la falsee). Sin ese dato la marca se rechaza: la edad es el control.
  - El informe lo dice explícito (`anclado: true`, "📍 por entrada"): el administrador tiene que saber que ahí la verificación es más laxa.
  - Queda un hueco conocido: el guardia puede quedarse en la entrada y escanear ahí la foto del QR de adentro. Se aprieta bajando la ventana; eliminarlo requiere NFC (v2).
- **CU-20 Destinatarios del informe semanal** *(v1.8, por destinatario en v1.11)*: cada condominio guarda a quién le llega su informe semanal (`correosInforme`, uno o varios). Lo edita el administrador desde el panel, o la operación desde la fábrica. El envío del lunes se agrupa **por destinatario**: quien administra varios condominios recibe **un solo correo** con un `.docx` por condominio, y nunca los de otro administrador. Un condominio sin correo no se envía (salvo el respaldo `INFORME_TO`), y la semana enviada queda registrada por destinatario para no repetir tras un reinicio.
- **CU-21 Alta de condominios (fábrica)** *(v1.11)*: la operación crea desde `/fabrica` un condominio nuevo con su código de registro y sus correos de informe, sin scripts ni despliegues. El id sale del nombre (sin tildes ni eñes, único) y el código de registro de los guardias se genera solo. El condominio queda operable de inmediato desde el selector del panel (CU-22).
  - **No se crea cuenta de panel** *(v1.12)*: como cualquier cuenta `admin` abre todos los condominios, una por condominio no aporta nada y multiplica las llaves. Se crea solo si se piden explícitamente usuario y PIN, para el caso de un cliente que vaya a operar su propio panel.
  - La fábrica también carga los correos del informe de cualquier condominio, cambia el PIN de una cuenta de panel (cerrando sus sesiones abiertas), **quita** cuentas de panel —nunca la última, o nadie podría entrar— y manda un informe de prueba.
  - El rol `fabrica` **no pertenece a ningún condominio**: no puede ver informes, puntos, rondas ni guardias de nadie, y ningún administrador puede crear condominios ni cuentas.
  - El login admite 10 intentos fallidos por usuario e IP y luego bloquea 15 minutos: el PIN es de 4 a 8 dígitos y la app está expuesta en internet.
- **CU-22 Un panel para todos los condominios** *(v1.12)*: el panel trae un selector de condominio y todo lo que muestra y edita es del que esté elegido (el elegido viaja en la cabecera `x-condominio`); pedir uno que no existe cae en el propio del usuario. Permite recorrer condominio por condominio fijando las ubicaciones de los puntos con una sola cuenta, sin cerrar sesión. **Costo explícito**: entre administradores ya no hay aislamiento (ver CU-14). El guardia no participa de esto: su condominio se ignora de la cabecera y queda amarrado al suyo.
- **CU-22 El panel trabaja sobre cualquier condominio** *(v1.12)*: el panel tiene un **selector de condominio** en la barra, y todo lo que muestra —informes, puntos, guardias, rondas, avisos, hoja de QR— es del que esté elegido. Lo pide en la cabecera `x-condominio`; el servidor la acepta solo si el rol es `admin` y el condominio existe (si no, se cae al condominio de la cuenta). Nació de una necesidad de terreno: fijar las ubicaciones GPS de los puntos condominio por condominio, caminando cada uno, sin andar cambiando de cuenta.
  - **Decisión explícita**: con esto **desaparece el aislamiento entre administradores** — cualquier cuenta `admin` ve los informes, guardias y códigos de registro de todos los condominios. Vale mientras los condominios sean de la operación; el día que un cliente tenga panel propio, esta capacidad se restringe a un rol de operación.
  - Lo que **no** cambia: el **guardia** sigue encerrado en su condominio. La cabecera no le sirve — si le sirviera, se bajaría los payloads de los QR del condominio vecino y se caería el antifraude entero.
- **CU-23 Presupuesto de error del GPS** *(v1.13)*: nació de terreno. Con las ubicaciones ya fijadas, el guardia escaneaba **parado sobre el QR** y la app le decía "acércate al punto". Dos causas, las dos reales:
  1. **El punto se fijaba con una sola lectura.** El primer fix de un GPS frío viene de WiFi o de antena, con ±30-100 m, y esa coordenada quedaba guardada como la verdad del punto para siempre. v1.13 hizo que el panel **muestreara 12 s, se quedara con la mejor lectura y guardara su precisión** (`precisionM`) — corregido en CU-24, porque "la mejor de N" seguía siendo un número optimista. Se rechaza guardar peor que ±60 m y se avisa sobre ±25 m. La tabla de puntos muestra la calidad de cada medición, y marca "⚠ fijado sin medir" los anteriores a v1.13.
  2. **El tope era un número fijo.** Acá se comparan **dos** medidas de GPS —la del punto y la del teléfono— y sus errores se suman: exigir 20 m clavados entre dos fixes de ±20 m es matemáticamente imposible de cumplir. El tope pasa a ser `radio + mín(precisión del punto + precisión del fix, GPS_MARGEN_MAX_M)`.
  - **No debilita el control**: el margen lo pone el sensor, no el guardia. Con punto bien medido y buena señal el tope queda en ~30 m; solo con señal mala se estira hasta el techo (60 m por defecto). Escanear la foto del QR desde la caseta sigue rechazado por goleada.
  - Un fix peor que `GPS_PRECISION_MAX_M` (±100 m: WiFi o antena) **no se usa para decidir** — ni para aceptar ni para rechazar. Sirve para las dos cosas mal: rechaza a quien está encima y aceptaría a quien está a dos cuadras. En el informe queda como observación, **no como sospecha**: la señal mala es del edificio, no del guardia.
  - La app del guardia **no se queda con el último fix**: el GPS no mejora en línea recta y un fix de red de ±300 m no puede pisar a uno de satélite de ±6 m. En v1.13 eso se resolvía conservando el mejor; desde CU-24, promediando.

- **CU-24 Precisión honesta en las dos puntas** *(v1.14)*: CU-23 planteó bien el presupuesto de error y lo alimentó mal. Las dos medidas que compara —la del punto y la del fix del guardia— eran "la mejor de N lecturas", que es elegir el error más favorable y llamarlo precisión. Las dos se arreglan igual: muestrear más, promediar, y declarar el ± que corresponde.
  1. **El panel mide 45 s, no 12** (hasta 90 si la señal sigue floja), calienta el receptor desde que se abre la pestaña de puntos, descarta los primeros 5 s y las lecturas peores que ±100 m, y promedia lo que queda con un **centroide ponderado por 1/acc²**. El `precisionM` guardado es `max(dispersión observada, ± declarado / √N, 4 m)` — el **máximo**, no el mínimo: promediar mata el error aleatorio, no el multipath, y prometer ±3 m en un subterráneo porque 40 muestras coincidieron sería el error de v1.10 con más matemática encima. Junto al punto queda la evidencia (`muestras`, `dispersionM`, `precisionDeclaradaM`, `medidoConVersion`). **Ningún punto ya fijado cambia solo**: los medidos con el método anterior se marcan "conviene re-medir".
  2. **El teléfono promedia igual.** Las lecturas entran a un buffer acotado y `consolidarFixes()` entrega **un** fix consolidado; `verificarPresencia()` sigue recibiendo un fix y devolviendo un veredicto, así que el espejo cliente/servidor y `paridad-gps.test.js` no cambian. La propiedad de v1.13 —un fix malo no desplaza a uno bueno— la sostiene ahora el peso `1/acc²`.
  3. **Un rechazo por señal fría deja de ser un rechazo.** La marca queda **esperando** hasta 15 s, se re-evalúa con cada fix nuevo y se registra sola si el criterio se cumple. El criterio **no se afloja**: el plazo se mira antes que el veredicto, así que una señal que entra tarde no rescata nada, y la espera solo puede favorecer a quien camina *hacia* el punto.
  4. **El GPS se enciende con la sesión**, no con la ronda, con **Wake Lock** mientras hay ronda activa y reanudación del watch al volver de segundo plano. Si el Wake Lock falla, el guardia lo ve: degradarse en silencio ahí es caminar media ronda sin ubicación.
  5. **Los rechazos se registran** (`POST /api/ejecuciones/:id/rechazos`). Hasta ahora morían en el teléfono, y por eso los umbrales de v1.13 se ajustaron a ciegas.
  - Como `acc` pasa a ser un número que **calcula la app** y no uno que declara el navegador, el servidor le aplica un piso (`GPS_PRECISION_MIN_M`, 3 m) antes de creerle: un error en la fórmula que devolviera ±1 m aflojaría el margen de cada marca del sistema, y el test de paridad no lo vería —los dos lados coincidirían en el número equivocado—.

## Reglas de negocio

- **QR = punto**: payload `RQR:<condominioId>:<puntoId>:<codigoCorto>`. El código corto (6 caracteres, sin ambiguos 0/O/1/I) va impreso bajo el QR y sirve para la entrada manual.
- **Ronda estricta**: el orden importa; marcar fuera de orden genera *observación* en el informe (el punto igual cuenta como hecho).
- **Duración máxima**: excederla genera *observación*; no invalida la ronda.
- **Duplicados**: gana el primer escaneo. El reenvío de un punto ya marcado **no** se re-verifica por GPS: sale por duplicado antes, para que la cola offline siga siendo idempotente aunque el guardia ya se haya alejado.
- **Presencia GPS**: en un punto con ubicación exacta, pasarse del tope (20 m de radio + la imprecisión de las dos medidas, ver CU-23) o no tener fix reciente **impide** la marca. En un punto anclado, basta haber estado dentro del tope de la entrada (40 m + margen) en los últimos 15 min. Un punto sin ubicación fijada no se verifica.
- **Timestamps offline**: son los del teléfono; el informe los distingue con la marca `offline`.
- **Estados del informe**: `Incompleta` si falta ≥1 punto; `Completa con observaciones` si no falta nada pero hubo orden violado o exceso de duración; `Completa` si todo limpio.

## Datos

- `condominios`: id, nombre, codigoRegistro, correosInforme.
- `usuarios`: id, condominioId, usuario, pinHash, rol (`guardia`|`admin`), nombre.
- `puntos`: id, condominioId, nombre, codigoCorto; `lat`/`lon` si tiene verificación de presencia; `verificacion` (`'anclaje'`, o ausente = ubicación exacta); `radioM`/`ventanaMin` opcionales por punto. El modo se **deduce**: sin lat/lon no se verifica, con lat/lon y sin `verificacion` es exacto. Así los puntos que ya existían siguen funcionando sin migración.
- `rondas` (plantillas): id, condominioId, nombre, puntoIds (ordenados), ordenEstricto, duracionMaxMin.
- `ejecuciones`: id, rondaId, condominioId, guardiaId, inicio, fin, estado, escaneos [{puntoId, ts, offline, gps {lat, lon, acc, edadMs}, distanciaM, anclado, edadGpsMs}], evaluacion {faltantes, fueraDeOrden, gpsLejos, sinGps, rafaga, duracionMin, observaciones, sospechas}.
- Persistencia v1: archivo JSON con escritura atómica (cero dependencias nativas). Migración a SQLite/Postgres documentada para producción de volumen.

## Datos semilla (demo)

- Condominio **Los Aromos**: admin `marta` (PIN 1111); guardias `pedro` (PIN 2222) y `luis` (PIN 3333); 8 puntos (Portería, Estacionamiento A, Quincho, Piscina, Bodega, Sala de bombas, Acceso trasero, Sede social); ronda **Nocturna completa** (los 8 puntos, estricta, 45 min) y ronda **Perimetral express** (4 puntos, no estricta, 20 min).
- Condominio **Mirador del Valle**: admin `carmen` (PIN 4444), guardia `jorge` (PIN 5555), 3 puntos, 1 ronda — existe para verificar CU-14.

## Fuera de alcance v1

App nativa, GPS/NFC anti-fraude (QR fotografiado), fotos de incidencias, WhatsApp, facturación SaaS. Registrado en BRIEF.md.

## Supuestos (no bloquean; se validan con José)

1. Guardias con Android + Chrome (mayoría en Chile); la PWA se instala desde el navegador.
2. El login se hace con conexión (wifi de portería); después la ronda corre offline.
3. El administrador usa navegador de escritorio.
4. Hora local del servidor = hora de Chile.
5. Los datos reales (nombre del condominio, puntos, nómina) los carga José/el cliente en el panel; la demo trae datos semilla.
