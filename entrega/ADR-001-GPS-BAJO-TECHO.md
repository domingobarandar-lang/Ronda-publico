# ADR-001: Marcas dudosas bajo techo — qué se puede mejorar del GPS y qué no

**Estado:** Propuesto
**Fecha:** 2026-11-01
**Deciden:** José (producto y soporte), operación en terreno
**Relacionado:** CU-16, CU-18, CU-19, CU-23, CU-24, CU-28 en [SPEC.md](../SPEC.md) · [INC-002](INCIDENTES.md#inc-002--marcas-dudosas-en-los-puntos-bajo-techo)

## Contexto

Todavía hay marcas dudosas en los puntos bajo techo. Antes de proponer arreglos conviene separar dos cosas, porque piden soluciones distintas:

- **Bajo una losa** (subterráneo, sala de calderas, interior de torre) no llega señal de satélite. El teléfono sigue entregando posiciones, pero salen de WiFi o de la antena, con ±30–300 m. Ningún software hace que eso sea GPS.
- **Bajo un alero o en un lugar semi-techado** (estacionamiento techado abierto a un lado, pasillo, portería) sí llega señal, pero rebotada en muros y losas (*multipath*). Ese error es un **sesgo**, no ruido: todas las lecturas se corren hacia el mismo lado. `geo.js` ya lo dice: promediar más muestras baja el ruido, no el sesgo.

La app ya tiene casi todo lo que se puede hacer con GPS desde un navegador: promedio ponderado y ± honesto en las dos puntas (v1.14), margen que suma el error del punto y el de la lectura (v1.13), espera de 15 s con la señal fría, vigía del GPS (v1.21), verificación por entrada para los puntos bajo techo (v1.10) y chapitas NFC (v1.24). **Subir la exactitud del GPS tiene un techo físico**, y la app está cerca de él. Donde sí hay margen de mejora es en tres cosas: que la verificación por entrada funcione como se diseñó, que cada punto use la prueba que su lugar permite, y medir antes de ajustar.

### Hallazgo: la lectura de la entrada se pierde a los 20 segundos

La verificación por entrada (CU-19) promete que «el teléfono ya guardó la señal al pasar» ([OPERACION.md](OPERACION.md)): el guardia pasa por la entrada con buena señal, baja, y hasta 15 minutos después puede marcar el punto de abajo. **El código no hace eso.** La app guarda un solo fix, `gpsActual`, que se recalcula con cada lectura nueva sobre una ventana de 20 s (`agregarFix()` y `consolidarFixes()` en `app/public/app.js`). La ventana de 15 minutos solo sirve si el teléfono **deja de entregar lecturas** al entrar.

Un Android que sigue entregando lecturas adentro (lo normal: la ubicación de Android sigue respondiendo con WiFi y antena) produce esto:

| Hora | Qué pasa | Lo que la app tiene como «la ubicación» |
|---|---|---|
| 10:00:00 | El guardia pasa por la entrada, señal ±6 m | La entrada, ±6 m ✅ |
| 10:00:10 | Baja la rampa. Llegan lecturas de ±40–300 m | Todavía la entrada (pesa más por 1/acc²) |
| 10:00:30 | Pasaron 20 s: las lecturas de la entrada salen de la ventana | **Una lectura de adentro**, ±40–300 m |
| 10:02:00 | Escanea el QR del subterráneo | Se decide con la lectura de adentro |

Con la lectura de adentro, según lo que entregue el teléfono, la marca:

- se rechaza por «señal demasiado imprecisa» (más de ±100 m),
- se rechaza por «estás a 70 m de la entrada» (una lectura corrida por el rebote), o
- **se acepta con una lectura mala**, y queda en el informe con una distancia y una precisión que no prueban nada.

Las tres se ven como «marcas dudosas». El comportamiento del código es seguro: viene de la v1.10 (cada lectura reemplazaba a la anterior), siguió en la v1.13 y en la v1.14 (cambió la ventana, no la idea), y un test lo pide a propósito para los puntos exactos (`app-gps.test.js`: «pasada la ventana de frescura, la lectura nueva manda»). **Lo que falta confirmar con datos es cuántas de las marcas dudosas vienen de acá** y cuántas de puntos semi-techados con ubicación exacta.

### Lo que no sabemos

- Qué puntos generan las marcas dudosas, y de qué tipo son: rechazo por señal imprecisa, rechazo por distancia, aceptada con ± grande, observación en el informe.
- Qué modo tiene cada uno de esos puntos (exacto, por entrada, chapita, sin verificación) y con qué calidad se fijó.

Los datos están en la base: cada marca guarda `gps {lat, lon, acc, edadMs}`, `distanciaM`, `anclado` y `edadGpsMs`, y desde la v1.14 cada rechazo guarda `motivo`, `distanciaM`, `topeM`, `acc` y `edadMs`. Nadie los ha mirado por punto.

## Decisión

No aflojar los umbrales generales. Trabajar en cuatro fases, en este orden:

0. **Medir**: un diagnóstico por punto con los datos que ya hay, para saber dónde y de qué tipo son las marcas dudosas.
1. **Cercanía reciente para todos los puntos**: la app guarda un **rastro de lecturas** y, antes de rechazar una marca (sin señal, o con una señal que dice que el guardia está lejos), acepta el punto si hubo una lectura buena cerca de él hace pocos minutos y nada lo ubica más lejos de lo que el GPS se puede equivocar. Es el mecanismo de la entrada generalizado: el administrador ya no tiene que elegir 🏠, salvo en los puntos lejos de toda señal.
2. **Cada punto con la prueba que su lugar permite**: una tabla de decisión para el administrador y un indicador de señal por punto en el panel, calculado con las marcas reales.
3. **Exprimir el GPS donde sí hay señal**: un promedio que siga al guardia cuando camina y ajustes de terreno (teléfono, configuración de Android). Solo si la fase 0 muestra que hace falta.

## Opciones consideradas

### A. Aflojar los umbrales (`GPS_MARGEN_MAX_M`, radios, `GPS_ANCLA_RADIO_M`)

| Dimensión | Evaluación |
|---|---|
| Complejidad | Baja: variables de entorno, sin deploy de la app |
| Costo | Nulo |
| Efecto en el control | Malo: afloja **todos** los puntos para arreglar unos pocos |
| Ataca la causa | No: con una lectura de ±300 m ningún radio razonable decide bien |

**A favor:** inmediato. **En contra:** esconde el síntoma, debilita el control en los puntos que hoy funcionan, y no arregla la verificación por entrada (la lectura de adentro sigue siendo mala). Se descarta como solución; sigue siendo la válvula por punto («Ajustar») que ya existe.

### B. Cercanía reciente, para todos los puntos con ubicación — **recomendada (fase 1)**

| Dimensión | Evaluación |
|---|---|
| Complejidad | Media: app del guardia y servidor (una rama nueva en `verificarPresencia()`, en los dos lados) |
| Costo | Una versión (v1.26) |
| Efecto en el control | Más débil que el exacto: acepta a quien estuvo cerca hace minutos. Sigue rechazando la foto escaneada desde lejos |
| Compatibilidad | Una app vieja en caché sigue igual que hoy; los parámetros viajan en el paquete |

**La regla.** Al escanear un punto con ubicación, primero se decide como hoy: si la señal del momento alcanza, la marca entra. Si no alcanza, porque no hay señal buena o porque dice que el guardia está lejos, **antes de rechazar se mira el rastro**. La marca entra «por cercanía» si se cumplen las dos:

1. **Estuvo cerca hace poco**: en los últimos **5 minutos** (`GPS_CERCANIA_MIN`) hubo una lectura buena (±20 m o mejor, `GPS_LECTURA_BUENA_M`) a **30 m o menos** del punto (`GPS_CERCANIA_M`).
2. **Nada lo ubica más lejos de lo que el GPS se puede equivocar**: ninguna lectura posterior a la última de esas lecturas cercanas, incluida la del momento, buena o mala, está a más de **50 m** del punto descontando su ± (`distancia − ± ≤ GPS_ERROR_POSIBLE_M`). Las lecturas malas no sirven para aprobar, pero sí para desmentir.

La condición 2 es la que separa «el GPS está fallando» de «el guardia se fue». Con una lectura que se ve buena, el rebote corre la posición decenas de metros, no cientos: volver a la caseta, a 150 m, deja lecturas que ninguna falla del GPS explica.

| Caso | Qué ve la app | Resultado |
|---|---|---|
| **Alero**: llega a 12 m del punto con ±8 m; al escanear, el rebote lo ubica a 45 m con ±15 | 45 − 15 = 30 m: dentro de lo que el GPS se puede equivocar | ✅ por cercanía |
| **Subterráneo**: pasa a 12 m con ±8, entra y escanea sin señal 1,5 min después; adentro llegan lecturas de ±150 m | Las lecturas de adentro no lo ubican lejos | ✅ por cercanía |
| **Caseta**: pasa a 25 m del punto, vuelve a la caseta, a 150 m, y escanea la foto | Lectura de 150 m con ±10: 140 m, más que cualquier falla | ❌ lejos |
| **Ida y vuelta**: pasó cerca, se fue a 150 m y volvió a 40 m | La lectura de 150 m lo desmiente; no hay una lectura cercana después | Como hoy: espera 15 s o «acércate» |

La marca viaja con las dos lecturas, marcada `via: 'cercania'`: la cercana (la prueba) y la del momento (la que dijo «lejos»). El servidor revisa las dos con los mismos números: la cercana, a 30 m o menos y con 5 min o menos; la del momento, dentro del error posible. Lo único que solo puede revisar el teléfono son las lecturas intermedias. La marca retenida (`evaluarPendiente()`, que hoy recibe `gpsUltimo()`) pasa por la misma regla, y el cierre (`evaluar()`) no la cuenta como «lejos del punto».

Los puntos 🏠 usan el mismo mecanismo con sus números de hoy (40 m, 15 min) y dejan de ser un algoritmo aparte. 🏠 queda solo para los puntos a más de 30 m del último lugar con señal.

**A favor:** rescata al guardia que está en el punto y al que el GPS ubica lejos por el rebote, cubre los semi-techados y los subterráneos cercanos a la señal sin que el administrador clasifique nada, y arregla la entrada que se pierde (el hallazgo de arriba). Sube la calidad exigida a la prueba: hoy una lectura de ±90 m cerca de la entrada sirve (tope 40 m + margen de hasta 40 m); con esto, no.

**En contra:** prueba que el guardia estuvo a 30 m hace menos de 5 minutos y que ahora no está más lejos que unos 50 m más el error, no que está parado en el punto. En concreto, quien pasó por el punto puede marcarlo hasta 5 minutos después desde 60–80 m. Eso no sirve para escanear la foto desde la caseta si la caseta está más lejos; un punto a menos de ~60 m de la caseta ya hoy queda débil por el margen (tope de hasta 60 m). Queda el hueco de **apagar la ubicación**: sin lecturas no hay nada que desmienta, y por eso la ventana es de 5 minutos. Todo queda a la vista: el informe dice «📍 por cercanía: a 12 m hace 1 min; al marcar, el GPS lo ubicaba a 45 m», y el indicador de señal por punto de la fase 2 muestra si un punto que siempre tuvo buena señal empieza a marcarse por cercanía. El número que más pesa es `GPS_ERROR_POSIBLE_M`, y se calibra con la fase 0: cada rechazo guarda la distancia y el ± del intento, así que muestran de qué tamaño son las fallas del GPS en cada condominio.

### C. Promedio que sigue al guardia cuando camina — **condicionada (fase 3)**

| Dimensión | Evaluación |
|---|---|
| Complejidad | Media: toca `consolidarFixes()` (el panel no, que mide quieto) |
| Costo | Una versión, más pruebas de terreno |
| Efecto en el control | Neutro o mejor: el ± baja porque la dispersión deja de incluir el trayecto |
| Ataca la causa | Solo en puntos con señal; bajo techo no hace nada |

Hoy el fix es el promedio de los últimos 20 s. Si el guardia llega caminando a 1,3 m/s y escanea de inmediato, el promedio queda **atrás**, del lado por donde venía (unos 10–13 m), y la dispersión infla el ±. La espera de 15 s lo compensa (al quedarse quieto el promedio converge), así que el costo es sobre todo «Afinando señal… N s», no rechazos. Arreglo: pesar las lecturas también por antigüedad (vida media de unos 5 s) o promediar solo desde que el guardia se detuvo. Un filtro de Kalman es la versión de libro, pero no se justifica con estos datos. **Solo vale la pena si la fase 0 muestra rechazos o esperas en puntos exactos con la distancia apenas sobre el tope.**

### D. Chapita NFC en todos los puntos bajo losa

| Dimensión | Evaluación |
|---|---|
| Complejidad | Baja: ya existe (v1.24) |
| Costo | Chapitas NTAG213 + grabarlas en terreno |
| Efecto en el control | El mejor disponible: prueba que el guardia estuvo en el punto, sin GPS |
| Bloqueo | **Fully Kiosk no lee chapitas** (Android WebView no tiene Web NFC). Tampoco el iPhone |

**A favor:** es la respuesta de fondo para el subterráneo. **En contra:** el teléfono compartido de la garita, que es justo el que hace rondas, corre en Fully. Mientras eso no cambie (pendiente en [FULLY-KIOSK.md](FULLY-KIOSK.md)), en ese teléfono los puntos bajo losa dependen de la verificación por entrada, y por eso la opción B va primero.

### E. App nativa (Capacitor / TWA) para usar más sensores

| Dimensión | Evaluación |
|---|---|
| Complejidad | Alta: otra base de código, publicación en la tienda, actualización desatendida distinta |
| Costo | Semanas |
| Efecto | Abre la ubicación fusionada de Google, las mediciones GNSS crudas, balizas Bluetooth y WiFi RTT (posición en interiores de 1–2 m, pero solo con routers compatibles, que casi no hay) |

Fuera de alcance según el SPEC. **Las balizas Bluetooth y la posición por WiFi no están disponibles desde una PWA** (Web Bluetooth no escanea balizas en Chrome estable; la web no ve las redes WiFi), así que no hay un camino intermedio. Se revisa si un condominio exige prueba de presencia bajo losa y no se puede usar NFC.

### F. Ajustes de terreno y de equipo

| Dimensión | Evaluación |
|---|---|
| Complejidad | Baja: sin código |
| Costo | Tiempo en terreno; un teléfono mejor al renovar |
| Efecto | Mejora la señal semi-techada; bajo losa no cambia nada |

- **Volver a medir** los puntos fijados con el método anterior a la v1.14 (pendiente de terreno de QA.md, nunca cerrado).
- **Mover el QR** unos metros hacia donde haya cielo cuando el punto lo permite (la puerta por fuera en vez del hall). No cuesta nada, pero cambia lo que verifica la ronda: lo decide el administrador.
- **Android**: ubicación precisa activada y búsqueda de WiFi y Bluetooth encendida (ayuda a la ubicación en lugares semi-techados). En Fully no está comprobado que el WebView use la misma ubicación que Chrome: comparar las dos en el mismo lugar con la prueba de [FULLY-KIOSK.md](FULLY-KIOSK.md).
- **Al renovar el teléfono de la garita**, uno con GNSS de **doble frecuencia (L1 + L5)**: tolera mucho mejor el rebote. Bajo losa da lo mismo.

## Análisis de los trade-offs

- **Control vs. fricción.** A compra menos fricción con menos control en todos los puntos. B y D bajan la fricción **y** mantienen o suben el control, porque atacan la causa. C es neutro en el control. Por eso A se descarta y B va primero.
- **Débil vs. nada.** La cercanía y la entrada son controles más débiles que el exacto, a propósito: bajo techo, en Fully, la alternativa real es no verificar nada. Ninguna de las dos prueba que el guardia entró; para eso está la chapita (D).
- **El espejo cliente-servidor.** B agrega una rama a `verificarPresencia()` en los dos lados (marca `via: 'cercania'`: la lectura cercana hasta 30 m y 5 min, la del momento dentro del error posible), y `paridad-gps.test.js` tiene que recorrerla. El servidor no ve las lecturas intermedias; tampoco puede comprobar hoy que una lectura es real (una app de ubicación falsa es un hueco conocido, ver [SEGURIDAD.md](SEGURIDAD.md)).
- **Medir primero.** Sin la fase 0, cualquier ajuste se hace a ciegas, que es justo lo que la v1.14 quiso dejar de hacer al empezar a registrar los rechazos.

## Consecuencias

- **Más fácil:** marcar los puntos semi-techados y bajo techo sin que el administrador elija un modo, también en un teléfono que sigue entregando lecturas adentro. Explicar cada marca dudosa con datos (fase 0) y elegir el modo de cada punto con un criterio (fase 2).
- **Más difícil:** la app tiene dos memorias de ubicación (el buffer de 20 s y el rastro) y `verificarPresencia()` una rama más, en los dos lados. Los tests nuevos tienen que fijar cuál se usa en cada caso.
- **Riesgo:** el rastro vive en memoria. Si la app se recarga entre la entrada y el punto, se pierde, igual que hoy. En Fully las recargas son raras, pero si la fase 1 en terreno muestra que pasa, guardarlo en `sessionStorage`.
- **Revisar después:** si en Fully se habilita NFC, pasar los puntos bajo losa a chapita. **El acelerómetro** como refuerzo de la cercanía: si desde la lectura cercana el teléfono no caminó, la lectura lejana es una falla del GPS sin duda, y la condición 2 se podría aflojar en ese caso. La API (`devicemotion`) anda en Chrome Android; en el iPhone pide permiso y en Fully hay que comprobarla. Una observación (no sospecha) de «firma de entrada»: si al escanear un punto anclado el teléfono todavía tiene ±5 m en la entrada, el guardia probablemente no bajó. Es interesante pero tiene falsos positivos (puertas, rampas abiertas); se evalúa con datos de la fase 1.

## Plan

### Fase 0 — Diagnóstico por punto (1 día, sin deploy)

1. [ ] Script de **solo lectura** sobre la base de producción (pedir permiso antes, como en INC-001) que dé, por punto y en los últimos 30 días: modo, `precisionM` y versión con que se fijó, marcas, mediana y p90 del `acc` de las marcas, rechazos por tipo (imprecisa, distancia, vencida, sin señal), y cuántas marcas aceptadas quedaron a más del 80 % del tope.
2. [ ] Clasificar cada punto problema: **bajo losa** (lecturas de ±100 m o más), **semi-techado** (±20–60 m, rechazos por distancia), **mal fijado** (`precisionM` vacía o método antiguo), o **por entrada con el ancla perdida** (rechazos con `edadMs` de pocos segundos en un punto anclado: la señal de la entrada debería traer minutos).
3. [ ] Completar la sección de impacto de INC-002 con esos números.

### Fase 1 — Cercanía reciente (v1.26)

1. [ ] Rastro en `app.js`: el fix consolidado cada 5 s, bueno o malo, con su ±. Podado a la ventana más larga en uso (15 min si la ronda tiene puntos 🏠; si no, 5) y con tope de unas 200 lecturas. Vive en memoria, como el buffer, y se borra al cerrar sesión.
2. [ ] `pruebaCercania(punto)` con las dos condiciones, llamada solo cuando la verificación de hoy no alcanza, y un solo selector de lecturas por punto usado por `gpsParaMarca()`, la verificación al escanear y `evaluarPendiente()`.
3. [ ] Rama `via: 'cercania'` en `verificarPresencia()` de `lib/rondas.js` y de `app.js`, que revisa las dos lecturas que viajan. Los puntos 🏠 pasan por el mismo camino con sus números. `evaluar()` no la cuenta como «lejos del punto».
4. [ ] `GPS_LECTURA_BUENA_M` (20), `GPS_CERCANIA_M` (30), `GPS_CERCANIA_MIN` (5) y `GPS_ERROR_POSIBLE_M` (50) en `configGps()` y en el paquete, con defaults en `cfgGps()` para un paquete viejo en caché. Son el punto de partida: se calibran con la fase 0.
5. [ ] Informe y aviso al administrador: «📍 por cercanía: a N m hace M min; al marcar, el GPS lo ubicaba a D m».
6. [ ] Tests: los cuatro casos de la opción B; sin lectura cercana en 5 min → como hoy (espera y rechazo); lectura cercana de hace 6 min → no cuenta; lectura del momento a 70 m con ±15 → rechazo; lectura de ±90 m pegada al punto → no cuenta como cercana; punto 🏠 con 3 min de lecturas malas adentro → se acepta; la marca retenida usa las mismas lecturas que la verificación; el servidor rechaza una marca `via: 'cercania'` con la lectura cercana a 35 m o la del momento fuera del error posible; paridad de la rama nueva.
7. [ ] Prueba de terreno en el teléfono de la garita (Fully): un punto semi-techado y uno bajo techo, escaneando 1–3 min después de perder la señal.
8. [ ] Actualizar CU-16 y CU-19 en SPEC.md, OPERACION.md y CHANGELOG.

**Cómo saber que funcionó:** bajan los rechazos y las observaciones de señal imprecisa bajo techo, se sabe cuántas marcas entran por cercanía en cada punto, y **ninguna marca aceptada fuera de `topeM`** (la métrica de QA.md que no se puede mover).

### Fase 2 — Cada punto con su prueba

1. [ ] Tabla de decisión en OPERACION.md:

   | Lugar del punto | Prueba |
   |---|---|
   | Cielo abierto | 📍 GPS exacto |
   | Semi-techado, o bajo techo a 30 m o menos del último lugar con señal | 📍 fijado en el punto o en el último lugar con señal: la cercanía lo cubre |
   | Bajo losa, teléfono con Chrome en Android | 📶 Chapita NFC, sin ubicación |
   | Bajo losa a más de 30 m de la señal, teléfono con Fully Kiosk | 🏠 Por entrada (hasta que Fully lea chapitas) |

2. [ ] En el panel, por punto: «señal en este punto: buena / regular / mala», calculada con el `acc` de sus marcas y sus rechazos de los últimos 30 días, y una recomendación según la tabla. Solo sugiere: **la ubicación del punto nunca se mueve sola** con las marcas de los guardias (se podría ir corriendo hacia la caseta de a pocos metros).

### Fase 3 — GPS con señal (solo si la fase 0 lo justifica)

1. [ ] Peso por antigüedad en `consolidarFixes()` (vida media de unos 5 s), sin tocar `precisionHonesta()` ni la medición del panel.
2. [ ] Ajustes de Android y comparación Chrome vs. Fully en terreno; GNSS de doble frecuencia en la próxima compra.
