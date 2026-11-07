# Incidentes — Ronda

Público: José (soporte y producto). Qué hacer cuando algo falla en producción y el registro de lo que ya falló.

La regla de fondo: **el mismo fallo no pasa dos veces.** Que falle algo nuevo es parte de lanzar rápido; que se repita es que el arreglo no tuvo prevención.

Un fallo de producto **no siempre es un error**. Sentry y `[error-cliente]` (v1.20) ven excepciones; no ven una sesión que vence a mitad de ronda (un 401 es normal) ni una ronda que queda abierta (`en_curso` es un estado válido). Los fallos más caros son de esos: la app hace lo que se diseñó, pero el diseño no calza con cómo se usa en terreno.

## 1. Gravedad

| | Qué es | Ejemplos | Contener | Aviso al administrador |
|---|---|---|---|---|
| **S1** | Se pierde o se falsea un registro de ronda, los guardias no pueden marcar, o se exponen datos personales | La cola borraba marcas ante un 502 (v1.20.2) | El mismo día, dejando todo lo demás | El mismo día |
| **S2** | La ronda se puede hacer, pero algo la corta, la alarma no suena o el informe no cuenta lo que pasó | INC-001 | En 1 o 2 días | Si toca el informe semanal o la alarma |
| **S3** | Molestia sin efecto en el registro ni en la alarma | El panel con la sesión vencida llenaba Sentry (v1.20.3) | En la próxima versión | No |

Ante la duda entre dos niveles, el más alto.

## 2. Cuándo un fallo lleva análisis

Decidido antes, para no discutirlo en caliente. Lleva análisis (sección 6) si se cumple **cualquiera**:

- Es S1 o S2.
- Un informe o un aviso dijo algo que no pasó.
- Hubo que volver a la versión anterior.
- Nos enteramos por el condominio o por un guardia, no por Sentry ni por el panel.
- Es un fallo que ya está en el registro (sección 5): se repitió.

Todo lo demás va solo como una línea en el registro.

## 3. Mientras está pasando

El orden es **parar el daño → restaurar el servicio → guardar evidencia**. Entender por qué pasó viene después.

1. **Parar el daño.** Volver al deploy anterior en Railway si la versión nueva es la causa (si esa versión cambió la base, ver antes [OPERACION.md](OPERACION.md)), o un desvío para el guardia (código a mano, reintentar, cerrar la ronda desde el panel).
2. **Restaurar.** Confirmar con un teléfono real, no solo con el panel, que se puede volver a marcar.
3. **Guardar evidencia el mismo día.** Los logs HTTP de Railway duran **alrededor de un día**: si no se exportan hoy, mañana no están.
   ```bash
   railway logs --http --json --since <ISO> --until <ISO> -n 5000 > evidencia-AAAA-MM-DD.json
   ```
   Desde `app/`, en tramos de unos 45 minutos (más de 5000 líneas da error). `--filter="@httpStatus:401"` o `--filter="@path:/api/login"` acotan. Los logs traen IP y navegador de cada teléfono: se guardan **fuera del repositorio**. La base se lee en **solo lectura** y nunca se corrige una fila antes de tener su copia.
4. **Anotar la cronología mientras pasa**: hora, qué se vio, qué se hizo. Reconstruirla al otro día sale incompleta.
5. **Avisar** según la tabla de la sección 1: qué pasó, qué se afectó, qué se está haciendo. Que el aviso lo dé la operación antes de que el condominio lo descubra genera más confianza que no haber fallado.

## 4. Después: el análisis

- **Cinco porqués**, hasta llegar a algo que se pueda cambiar en el sistema o en el proceso. El último siempre es **«¿por qué no lo vimos antes?»**.
- **Una corrección por nivel**, no solo en el código. Cada corrección es un **mecanismo**: un test que reproduce el fallo, una alerta, un paso en una lista de verificación. «Tener más cuidado» no es una corrección.
- **Proporcional al daño.** Un fallo que costó una tarde no justifica rehacer un módulo.
- **Sin culpables.** Se pregunta qué permitió el error, no quién lo cometió. «Error del guardia» como causa quiere decir que a la app le falta algo: ver la introducción de [FULLY-KIOSK.md](FULLY-KIOSK.md), donde un ajuste mal puesto «parece culpa del guardia».
- **Cerrado** cuando la corrección está en producción, el test que reproduce el fallo pasa, el aviso se dio y las acciones pendientes tienen fecha.

## 5. Revisión mensual (30 minutos)

1. Leer el registro y buscar **patrones**: el mismo componente, el mismo tipo de teléfono, el mismo supuesto. Un patrón es una decisión de producto, no otro parche. Los patrones abiertos están al final del registro.
2. Dos números para saber si se mejora:
   - **Versiones de arreglo / versiones publicadas** en el mes (cuántas salidas necesitaron arreglarse).
   - **Días desde que se supo del fallo hasta que el arreglo estuvo en producción.**
3. Revisar las acciones pendientes de los análisis: una acción sin fecha no se hace.

## Registro

| # | Fecha | Gravedad | Qué pasó | Cómo nos enteramos | Estado |
|---|---|---|---|---|---|
| INC-001 | 2026-10-31 | S2 | Rondas interrumpidas en el teléfono compartido de una garita ([análisis](#inc-001--rondas-interrumpidas-en-el-teléfono-compartido-de-la-garita)) | *Por completar* | Corrección en curso (v1.25) |
| INC-002 | 2026-11-01 | S2 | Marcas dudosas en los puntos bajo techo ([análisis](#inc-002--marcas-dudosas-en-los-puntos-bajo-techo), [ADR-001](ADR-001-GPS-BAJO-TECHO.md)) | *Por completar* | Corrección en curso (v1.27) |
| INC-003 | 2026-11-02 | S3 | `/fabrica` (v1.26.0) contaba los rechazos sin ubicación, por ubicación vieja o por señal imprecisa como «QR, chapita o código equivocado», fallo del guardia, y no como GPS: escondía el problema del GPS bajo techo. `salud.dificultades` los separaba por `topeM`, que el teléfono no manda si no hubo distancia que medir, y el test le inventaba uno. Se calcula al vuelo con los rechazos guardados: al desplegar, la pantalla queda bien sin tocar la base | Revisión del código de la v1.27 (PR #31) | Corrección en curso (sin desplegar) |
| INC-004 | 2026-11-04 | S2 | El cierre automático de la ronda completa (v1.25, 15 min) cortaba al guardia que todavía no tocaba «Terminar», y su «Terminar» tardío se descartaba: el informe decía «no tocó Terminar ronda» ([análisis](#inc-004--el-cierre-automático-cortaba-al-guardia-que-todavía-no-tocaba-terminar)) | José, mirando el panel | Corrección en curso (sin desplegar) |

**Fallos anteriores**, reconstruidos del CHANGELOG y de los commits. No tienen análisis y la gravedad es estimada:

| Versión | Fecha | Gravedad | Qué pasó |
|---|---|---|---|
| 1.17.1 | 2026-09-30 | S2 | Si el teléfono se apagaba a mitad de ronda, la ronda quedaba «en curso» para siempre y **callaba la alarma de ronda del condominio** |
| 1.20.2 | 2026-10-11 | S1 | La cola del teléfono borraba marcas cuando el servidor respondía 502, 500 o 429 |
| 1.20.3 | 2026-10-18 | S3 | El panel con la sesión vencida dejaba errores en Sentry en vez de volver al login |
| 1.21.0 | 2026-10-21 | S2 | Marcas perdidas por la mecánica del QR y del GPS, sobre todo en Fully Kiosk |

### Patrones abiertos

- **Una ronda abierta calla la alarma del condominio.** Van dos: v1.17.1 (ronda colgada tras un apagón) e INC-001 (ronda completa sin «Terminar»). Cada vez se arregló cerrando antes la ronda; no se ha decidido si la alarma debería depender de que haya una ronda en curso. INC-004 es el costo de ese camino: cerrar antes terminó cortando al guardia que todavía no terminaba.
- **La sesión de 1:30 h** (revisión de la auditoría de la v1.14, 2026-08-16) arregló un problema de seguridad y dejó dos fallos después: v1.20.3 en el panel e INC-001 en el teléfono del guardia. Un cambio de seguridad también tiene que probarse contra el turno real.
- **El teléfono compartido de la garita, con Fully Kiosk**, aparece en v1.21.0, v1.22.0 (la alarma no sonaba ahí) e INC-001. Es el ambiente más frágil y el que nadie recarga a mano: cada versión debería probarse ahí antes de darse por buena.

## Análisis

### INC-001 — Rondas interrumpidas en el teléfono compartido de la garita

**Gravedad**: S2. La alarma callada durante dos horas lo acerca a S1: en ese rato el guardia no recibe el aviso de salir a la siguiente ronda.
**Condominio**: Condominio Piloto (*a confirmar*), teléfono de la garita: Android con Fully Kiosk, compartido entre turnos.
**Estado**: corrección en curso en la v1.25 (rama `claude/rondas-interrumpidas-6bd3bf`, sin fusionar). Revisar esta ficha cuando se fusione.

#### Qué pasó

En la misma investigación salieron tres fallos:

- **A. La sesión vencía a mitad de ronda.** Vencía 1:30 h después del login, sin importar la actividad. En el teléfono compartido el guardia entra una vez y no sale, así que la segunda o tercera ronda empezaba con la sesión casi gastada y la app pedía el PIN en pleno recorrido. Las marcas no se perdían (la cola se conserva y se envía al volver a entrar), pero la ronda quedaba cortada.
- **B. Una ronda completa sin «Terminar» quedaba abierta dos horas.** Pasó tres veces seguidas: el guardia marcaba los 9 puntos y no tocaba «Terminar ronda». El cierre automático esperaba las mismas 2 h que a una ronda a medias, la alarma del condominio quedaba callada todo ese tiempo y el informe decía «el teléfono no terminó la ronda», que no era lo que había pasado.
- **C. Los avisos salían con la hora tres horas adelantada.** El servidor de Railway corre en UTC y la hora se formateaba sin zona: una ronda de las 10:02 llegaba como «Inicio 01:02 p. m.».

#### Impacto

*Por completar*: cuántas rondas se cortaron (A), cuántas quedaron abiertas (B, al menos 3), desde cuándo y cuántos avisos salieron con la hora mal (C).

#### Cronología

| Fecha | Qué |
|---|---|
| 2026-08-16 | Revisión de la auditoría de la v1.14: la sesión pasa a vencer 1:30 h después del login. Origen de A. |
| *Por completar* | Primer aviso del problema y quién lo dio. |
| 2026-10-31 | Investigación con los logs HTTP de Railway del teléfono de la garita. |
| *Por completar* | v1.25 en producción. |

#### Cinco porqués

**A. La sesión que vencía**

1. ¿Por qué se cortó la ronda? → La app le pidió el PIN al guardia a mitad del recorrido.
2. ¿Por qué? → La sesión vencía 1:30 h después del login, aunque el guardia estuviera marcando.
3. ¿Por qué se diseñó así? → Para que una sesión robada dejara de servir algún día (antes no vencía nunca). El comentario de `lib/auth.js` aceptaba el costo: «el guardia tiene que teclear». Se supuso que el guardia entra para cada ronda.
4. ¿Por qué no se validó ese supuesto? → El cambio salió de una auditoría de código y se probó con tests; nadie lo contrastó con un turno real en la garita, donde el teléfono es compartido y queda con la sesión abierta.
5. ¿Por qué no lo vimos antes? → Para el sistema no había error: un 401 es la respuesta correcta a una sesión vencida, así que ni el registro de errores ni Sentry podían verlo. No hay ninguna medida de «guardias que tuvieron que volver a entrar a mitad de ronda».

**B. La ronda completa que quedaba abierta**

1. ¿Por qué la alarma no sonó? → Había una ronda en curso, y con una ronda en curso la alarma no suena.
2. ¿Por qué seguía en curso? → El guardia marcó todos los puntos y no tocó «Terminar ronda».
3. ¿Por qué el sistema no la cerró antes? → El cierre automático no distinguía una ronda completa de una a medias: a las dos les daba 2 h, que existen para esperar las marcas de una ronda hecha sin señal.
4. ¿Por qué el guardia no tocó «Terminar»? → *Por confirmar en terreno.* Si con el último punto marcado el guardia cree que ya terminó, el arreglo de fondo está en la app del guardia, no solo en el servidor.
5. ¿Por qué no lo vimos antes? → Una ronda «en curso» y una «cerrada automáticamente» son estados válidos. No hay ninguna medida de cuántas rondas se cierran solas ni de cuántas veces la alarma no se mandó.

**C. La hora de los avisos**

1. ¿Por qué la hora salía mal? → Se formateaba con la zona horaria del servidor.
2. ¿Por qué no se notó en las pruebas? → `npm test` corre con la zona del computador, que está en Chile; Railway corre en UTC. Los tests nunca vieron la zona de producción.

#### Acciones

| # | Acción | Nivel | Estado |
|---|---|---|---|
| 1 | La sesión se renueva con la actividad de la ronda (iniciar, marcar, cerrar) | Código | En curso, v1.25 |
| 2 | Una ronda con todos los puntos marcados se cierra a los 15 min de la última marca (`RONDA_COMPLETA_CIERRE_MIN`), con el motivo real | Código | En producción desde la v1.25. Cortaba al guardia: pasa a 30 min en INC-004 |
| 3 | Los avisos se formatean en hora de Chile | Código | En curso, v1.25 |
| 4 | Correr `npm test` también con `TZ=UTC`, como Railway, para que un error de zona horaria falle en el computador | Detección | Pendiente |
| 5 | Señales de salud del producto en `/fabrica`: rondas cerradas automáticamente, rondas con dificultades técnicas (aplicación o usuario, GPS aparte, sesión cortada) y errores de Sentry por condominio | Detección | En revisión, v1.26.0 |
| 6 | Agregar a la prueba de terreno el turno del teléfono compartido: un guardia entra una vez y hace dos rondas seguidas que pasen la 1:30 h | Proceso | Pendiente |
| 7 | Confirmar con el guardia de la garita por qué no tocaba «Terminar» (acción B4) | Producto | Pendiente |
| 8 | Decidir si la alarma debe callar mientras hay una ronda en curso (patrón repetido) | Producto | Pendiente |
| 9 | Avisar al administrador del condominio qué pasó y qué cambió | Comunicación | *Por completar* |

### INC-002 — Marcas dudosas en los puntos bajo techo

**Gravedad**: S2. El guardia no puede marcar a la primera un punto en el que está, y el informe muestra marcas al borde del tope. La fase 0 no encontró puntos que no se puedan marcar nunca (sería S1): el 86 % de los rechazos termina con el punto marcado en la misma ronda.
**Condominio**: Condominio Piloto (los cuatro interiores de las torres). Los Aromos, sin rechazos del GPS.
**Estado**: corrección en curso (v1.27: cercanía reciente, CU-29). Diagnóstico de producción hecho el 2026-11-02; falta la prueba de terreno. Plan y opciones en [ADR-001](ADR-001-GPS-BAJO-TECHO.md).

#### Qué pasó

En los puntos bajo techo siguen apareciendo marcas dudosas. Al revisar el código salió una causa segura, cuyo peso en terreno falta medir: **en los puntos verificados por entrada (CU-19), la lectura buena de la entrada se pierde a los 20 s** si el teléfono sigue entregando lecturas adentro, y la marca se decide con una lectura de WiFi o de antena. Se rechaza (señal imprecisa o «lejos de la entrada») o se acepta con una lectura que no prueba nada. La otra causa probable son puntos semi-techados con ubicación exacta (rebote de la señal).

#### Impacto

Medido con `scripts/diagnostico-gps.js` en solo lectura, del 2026-10-03 al 2026-11-02 (tabla completa en el [ADR-001, fase 0](ADR-001-GPS-BAJO-TECHO.md#fase-0--diagnóstico-por-punto-1-día-sin-deploy)):

- **Condominio Piloto, 284 rondas.** Las cuatro torres concentran 114 rechazos del GPS en 1.190 intentos (10 %); la peor es la Torre 1, con 17 %. 103 de esos rechazos son por distancia. La Torre 3 tiene además 58 de 271 marcas aceptadas al borde del tope.
- **La causa en producción es la segunda: rebote en puntos semi-techados con ubicación exacta.** Los rechazos declaran ±5–9 m y ubican al guardia a 42–52 m. La de la entrada perdida no tuvo impacto todavía: no hay ningún punto 🏠 en producción.
- Para el guardia: 106 de 123 rechazos por distancia terminaron con el punto marcado en la misma ronda, a los 7–62 s. Para el administrador: marcas al borde del tope que no se distinguen de una marca hecha desde lejos.

#### Cronología

| Fecha | Qué |
|---|---|
| 2026-07-29 | v1.10: verificación por entrada. Cada lectura nueva reemplaza a la anterior: la entrada solo se conserva si el teléfono se calla adentro. |
| Agosto 2026 | v1.13 y v1.14: la lectura pasa a ser la mejor y después el promedio de una ventana de 20 s. La ventana cambia; la entrada se sigue perdiendo. |
| *Por completar* | Primer aviso de marcas dudosas bajo techo y quién lo dio. |
| 2026-11-01 | Revisión del código: se encuentra que la lectura de la entrada no se guarda aparte. |
| 2026-11-01 | v1.27.0 (PR, sin desplegar): rastro de lecturas en la app y cercanía reciente para todos los puntos con ubicación; los 🏠 usan la lectura de la entrada los 15 min completos. Señal por punto en el panel y `scripts/diagnostico-gps.js`. |
| 2026-11-02 | Diagnóstico en producción, en solo lectura y con permiso: las torres de Condominio Piloto son semi-techadas, y el 80 % de sus rechazos por distancia cumple la condición 2 de la cercanía. No hay puntos 🏠. |

#### Cinco porqués

1. ¿Por qué la marca bajo techo sale dudosa? → Se decide con una lectura tomada adentro, de ±40–300 m, en vez de la de la entrada.
2. ¿Por qué no con la de la entrada? → La app guarda un solo fix, el promedio de los últimos 20 s. La ventana de 15 min del anclaje mide la edad de ese fix, no de la mejor lectura en la entrada.
3. ¿Por qué se diseñó así? → Se supuso que bajo techo el teléfono deja de entregar lecturas. Android sigue entregando posiciones de WiFi y antena.
4. ¿Por qué no se validó ese supuesto? → La prueba de terreno bajo techo de la v1.14 (QA.md, pendiente 2) no se hizo, y los tests del anclaje en la app solo cubren los textos y la espera, no un teléfono que sigue leyendo adentro.
5. ¿Por qué no lo vimos antes? → Los rechazos se registran desde la v1.14, pero nadie los ha mirado por punto. No hay ninguna medida de «rechazos y marcas con señal imprecisa en puntos anclados».

#### Acciones

| # | Acción | Nivel | Estado |
|---|---|---|---|
| 1 | Diagnóstico por punto con los datos de producción, en solo lectura (ADR-001, fase 0) | Detección | Hecho el 2026-11-02 (`scripts/diagnostico-gps.js`); repetir dos semanas después del deploy |
| 2 | Cercanía reciente para todos los puntos con ubicación (rastro de lecturas buenas), con tests de un teléfono que sigue leyendo adentro (fase 1) | Código | Hecho en la v1.27 (sin desplegar) |
| 3 | Indicador de señal por punto en el panel y tabla de decisión del modo de cada punto (fase 2) | Detección / Proceso | Hecho en la v1.27 (sin desplegar) |
| 4 | Prueba de terreno bajo techo en el teléfono de la garita antes de dar la v1.27 por buena | Proceso | Pendiente |

### INC-004 — El cierre automático cortaba al guardia que todavía no tocaba «Terminar»

**Gravedad**: S2. El informe y el aviso al administrador dijeron que el guardia no tocó «Terminar ronda» cuando sí lo tocó, y en `/fabrica` cuenta como fallo del guardia.
**Condominio**: Condominio Piloto, teléfono compartido de la garita (Android 16 con Fully Kiosk, alterna entre el wifi de la garita y datos móviles).
**Estado**: corrección en curso (rama `claude/auto-close-rounds-spr-c599ef`, sin desplegar).

#### Qué pasó

José vio en el panel rondas de 12 o 13 minutos que el sistema había cerrado solo y que figuraban como «el guardia marcó todos los puntos pero no tocó «Terminar ronda»», mientras el guardia seguía con la ronda abierta en el teléfono, agregando su observación. Los 12 o 13 minutos son del inicio a la última marca: el cierre automático usa la última marca como hora de término, y por eso parecía que el sistema la había cortado a esa altura.

Desde la v1.25.0, una ronda con todos los puntos marcados se cerraba sola a los 15 min de la última marca (entre 15 y 20, por el barrido de cada 5 min). Si el «Terminar» del guardia llegaba después, el servidor lo descartaba: solo guardaba el comentario, si traía uno. Además, la observación del guardia viaja junto con el «Terminar», así que mientras la escribe el servidor no ve ninguna actividad.

#### Impacto

- Desde la v1.25, **2 rondas completas** cerradas por el sistema, las dos en Condominio Piloto:
  - **3/11 a las 02:31** (`f79e7f9f`): última marca a las 02:48:47 y cierre automático cerca de las 03:06. El «Terminar» del guardia llegó a las **03:08:02**, 19 min después de la última marca, y se descartó. El informe y el aviso dicen algo que no pasó.
  - **4/11 a las 13:20** (`d0eccd0f`): 9 puntos en 12,8 min, casi todo sin señal (las 8 marcas guardadas llegaron juntas a las 13:34:30). Cierre automático cerca de las 13:52. A las 14:06 el teléfono tuvo señal y no traía ningún «Terminar», y hasta las 15:24 no llegó ninguno.
- **Antes de la v1.25**, de 422 rondas completas terminadas por el guardia, 4 tardaron más de 15 min entre la última marca y «Terminar». Con la v1.25 las habría cortado.
- En `/fabrica` las dos cuentan como «fallo del usuario: no tocó «Terminar ronda»».

#### Cronología

| Fecha y hora | Qué |
|---|---|
| 2026-10-31 | v1.25.0 (INC-001 B): la ronda completa se cierra a los 15 min de la última marca y el «Terminar» tardío ya no la reabre. |
| 2026-11-03 03:08 | El «Terminar» del guardia llega un minuto después del cierre automático y se descarta. |
| 2026-11-04 13:52 | El sistema cierra la ronda de las 13:20 mientras el guardia sigue con ella abierta en el teléfono. |
| 2026-11-04 | José lo ve en el panel. Investigación con la base (solo lectura) y los logs HTTP de Railway del teléfono de la garita. |
| *Por completar* | Corrección en producción. |

#### Cinco porqués

1. ¿Por qué el informe dice que el guardia no terminó la ronda? → El sistema la cerró a los 15 min (18 con el barrido) de la última marca, y el «Terminar» que llegó después se descartó.
2. ¿Por qué 15 min no alcanzaban? → Después del último punto, el guardia vuelve a la garita y escribe su observación, que solo viaja con «Terminar»: el servidor no ve nada mientras tanto. El 99 % toca «Terminar» antes de 9 min, pero hay una cola: 4 de 422 pasaron de 15 min.
3. ¿Por qué se descartaba el «Terminar» tardío? → La v1.25 supuso que un «Terminar» tardío era de un guardia que se olvidó y volvió mucho después: reabrir mandaba el informe dos veces y contaba la espera como ronda. No distinguía al guardia que tocó un minuto después del cierre, ni al teléfono sin señal que tocó a tiempo.
4. ¿Por qué se eligieron 15 min? → Se eligieron sin medir cuánto tarda el guardia en tocar «Terminar» en rondas reales, aunque los datos ya estaban en la base.
5. ¿Por qué no lo vimos antes? → Un «Terminar» descartado no dejaba rastro (salvo que trajera comentario): ni el registro de errores ni `/fabrica` lo cuentan. Nos enteramos por José.

#### Acciones

| # | Acción | Nivel | Estado |
|---|---|---|---|
| 1 | El plazo pasa a 30 min (`RONDA_COMPLETA_CIERRE_MIN`), elegido con los 422 cierres reales: cubre el 99,5 % y no atrasa la alarma de un condominio que suena cada hora | Código | Sin desplegar |
| 2 | El «Terminar» del guardia que llega después del cierre automático cuenta (`terminarTarde` en `lib/rondas.js`): si lo tocó dentro del plazo (teléfono sin señal), queda como un cierre normal; si no, el fin sigue siendo la última marca y una observación dice cuánto tardó. Un aviso corto corrige el anterior, sin reabrir la ronda ni mandar push. Si la hora del toque en el teléfono es anterior a la última marca (reloj atrasado), el fin no se mueve | Código | Sin desplegar |
| 3 | Tests que reproducen los dos casos y fallan con el código anterior (`test/abandonadas.test.js`) | Detección | Hecho |
| 4 | Corregir en la base la ronda del 3/11 a las 02:31, cuyo «Terminar» se descartó | Datos | Pendiente: escribir en producción necesita autorización |
| 5 | Contar en `/fabrica` los «Terminar» que llegan después del cierre automático: ahora la ronda queda terminada por el guardia y sale de «cerradas automáticamente». Para eso hay que guardar el «Terminar» tardío como dato (hoy queda solo la observación y el aviso) | Detección | Pendiente |
| 6 | Preguntar al guardia de la garita qué hacía entre la última marca y el «Terminar» (junto con INC-001, acción 7) | Producto | Pendiente |
| 7 | Antes de fijar un plazo que corta al guardia, medir la distribución real en la base, como se hizo aquí | Proceso | Pendiente |
| 8 | El barrido relee cada ronda justo antes de cerrarla (`cerrarAbandonadas`). Cerraba la copia leída al empezar: un «Terminar» o unas marcas que llegaban mientras esperaba el push de otra ronda quedaban pisados, con el mismo «no tocó «Terminar ronda»». Lo encontró la revisión previa al PR, no un caso real | Código | Sin desplegar |
| 9 | El aviso «✅ … sí tocó «Terminar ronda»» no dice si el estado cambió al evaluar con la hora del toque (por ejemplo, una alerta «demasiado rápida» que deja de valer) | Producto | Pendiente |

## Plantilla

Copiar debajo de **Análisis** y agregar la fila en el **Registro**.

```markdown
### INC-00X — <qué pasó, en una línea>

**Gravedad**: S1 / S2 / S3 (y por qué).
**Condominio**: <cuál, qué teléfono>.
**Estado**: <abierto / corrección en curso (versión) / cerrado>.

#### Qué pasó
<Lo que vio el guardia o el administrador, no lo que hizo el código.>

#### Impacto
<Cuántas rondas, qué condominio, desde cuándo hasta cuándo. ¿Algún informe o aviso dijo algo falso?>

#### Cronología
| Fecha y hora | Qué |
|---|---|
| | Empieza el fallo (o el cambio que lo causó) |
| | Nos enteramos (¿por quién?) |
| | Contenido |
| | Corrección en producción |

#### Cinco porqués
1. ¿Por qué…? →
2. ¿Por qué…? →
3. ¿Por qué…? →
4. ¿Por qué…? →
5. ¿Por qué no lo vimos antes? →

#### Acciones
| # | Acción (un mecanismo, no «tener cuidado») | Nivel | Estado |
|---|---|---|---|
| 1 | | Código / Detección / Proceso / Producto / Comunicación | |
```
