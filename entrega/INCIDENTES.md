# Incidentes — Rondas QR

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
| INC-003 | 2026-11-02 | S3 | `/fabrica` (v1.26.0) contaba los rechazos sin ubicación, por ubicación vieja o por señal imprecisa como «QR, chapita o código equivocado», fallo del guardia, y no como GPS: escondía el problema del GPS bajo techo. `salud.dificultades` los separaba por `topeM`, que el teléfono no manda si no hubo distancia que medir, y el test le inventaba uno. Se calcula al vuelo con los rechazos guardados: al desplegar, la pantalla queda bien sin tocar la base | Revisión del código de la v1.27 (PR #31) | Corrección en curso (sin desplegar) |

**Fallos anteriores**, reconstruidos del CHANGELOG y de los commits. No tienen análisis y la gravedad es estimada:

| Versión | Fecha | Gravedad | Qué pasó |
|---|---|---|---|
| 1.17.1 | 2026-09-30 | S2 | Si el teléfono se apagaba a mitad de ronda, la ronda quedaba «en curso» para siempre y **callaba la alarma de ronda del condominio** |
| 1.20.2 | 2026-10-11 | S1 | La cola del teléfono borraba marcas cuando el servidor respondía 502, 500 o 429 |
| 1.20.3 | 2026-10-18 | S3 | El panel con la sesión vencida dejaba errores en Sentry en vez de volver al login |
| 1.21.0 | 2026-10-21 | S2 | Marcas perdidas por la mecánica del QR y del GPS, sobre todo en Fully Kiosk |

### Patrones abiertos

- **Una ronda abierta calla la alarma del condominio.** Van dos: v1.17.1 (ronda colgada tras un apagón) e INC-001 (ronda completa sin «Terminar»). Cada vez se arregló cerrando antes la ronda; no se ha decidido si la alarma debería depender de que haya una ronda en curso.
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
| 2 | Una ronda con todos los puntos marcados se cierra a los 15 min de la última marca (`RONDA_COMPLETA_CIERRE_MIN`), con el motivo real | Código | En curso, v1.25 |
| 3 | Los avisos se formatean en hora de Chile | Código | En curso, v1.25 |
| 4 | Correr `npm test` también con `TZ=UTC`, como Railway, para que un error de zona horaria falle en el computador | Detección | Pendiente |
| 5 | Señales de salud del producto en `/fabrica`: rondas cerradas automáticamente, rondas con dificultades técnicas (aplicación o usuario, GPS aparte, sesión cortada) y errores de Sentry por condominio | Detección | En revisión, v1.26.0 |
| 6 | Agregar a la prueba de terreno el turno del teléfono compartido: un guardia entra una vez y hace dos rondas seguidas que pasen la 1:30 h | Proceso | Pendiente |
| 7 | Confirmar con el guardia de la garita por qué no tocaba «Terminar» (acción B4) | Producto | Pendiente |
| 8 | Decidir si la alarma debe callar mientras hay una ronda en curso (patrón repetido) | Producto | Pendiente |
| 9 | Avisar al administrador del condominio qué pasó y qué cambió | Comunicación | *Por completar* |

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
