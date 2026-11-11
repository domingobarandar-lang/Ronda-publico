# Ronda

Control de rondas de seguridad para condominios: QR impresos en cada sector + el teléfono del guardia, en reemplazo de las chapitas físicas (iButton) y su lectora.

## Probar en 2 comandos

```bash
npm install
npm run demo
```

Son dos direcciones, una por perfil — cada una es una app aparte:

- **👷 App del guardia** → http://localhost:3737 con `guardia` / `5678`. Un guardia nuevo también puede **crear su propio usuario** desde ahí ("🆕 Crear mi usuario"): elige su condominio, escribe el **código del condominio** (el administrador se lo entrega — en la demo, `AROMOS` para Los Aromos y `MIRADOR` para Mirador del Valle), define usuario y PIN, y queda guardado.
- **🗂️ Panel del administrador** → http://localhost:3737/panel con `admin` / `1234` (ve las rondas de ese mismo guardia). En la pestaña **Guardias** ve y cambia el código de registro que entrega a sus guardias.

Cada app solo deja entrar a su perfil: si el administrador escribe su usuario en la app del guardia, esta le muestra el atajo al panel en vez de entrar.

Hay una tercera dirección, la de la operación: **🏭 Fábrica** → http://localhost:3737/fabrica, donde se dan de alta condominios y cuentas de administrador. No aparece enlazada en ninguna parte y necesita `FABRICA_USUARIO` y `FABRICA_PIN` en el `.env` (por ejemplo `FABRICA_USUARIO=jose` y `FABRICA_PIN=13571357`); la cuenta se crea sola al arrancar.

Ambos usuarios son del mismo condominio (Los Aromos), así que lo que marca el guardia aparece de inmediato en los informes del administrador. La demo también trae los usuarios anteriores: Los Aromos (admin `marta`/1111, guardias `pedro`/2222 y `luis`/3333) y Mirador del Valle (admin `carmen`/4444, guardia `jorge`/5555).

### Instalarla como app

Las dos son PWA y se instalan por separado, cada una desde su dirección: en la pantalla de entrada aparece el botón **📲 Instalar** (Chrome/Edge, en el PC o Android) — también sirve el ícono de instalar en la barra de direcciones. En iPhone: **Compartir → Añadir a pantalla de inicio**. Quedan como dos apps distintas, con ícono propio (escudo oscuro el guardia, tarjeta clara el panel) y abren en pantalla completa: el guardia en su login, el administrador en el panel.

> Ojo: fuera de `localhost` la instalación y la cámara exigen **HTTPS**. Para probar en un teléfono real hay que desplegarla (Railway/VPS con HTTPS) — en el PC se instala directo desde localhost.

Flujo de demo sugerido: en el panel, pestaña **Puntos** → "Imprimir hoja de QR" (ahí están los QR reales); en el teléfono, iniciar la ronda "Nocturna completa" y escanear los QR desde la pantalla (o usar "Ingresar código a mano" con los códigos de 6 letras, p. ej. `PRT234`). Al terminar, el informe aparece en la pestaña **Informes** del panel y el aviso en **Avisos**.

## Qué hace

- **PWA del guardia**: la ronda queda descargada en el teléfono; funciona sin señal (los escaneos se encolan y se sincronizan solos al volver la conexión). Escáner con la cámara (jsQR + BarcodeDetector) y entrada manual de respaldo con el código impreso bajo cada QR.
- **Motor de rondas**: valida cada marca (condominio, ronda, duplicados), y al cierre evalúa puntos faltantes, orden (rondas estrictas) y duración máxima.
- **Verificación de presencia por GPS** *(v1.1, bloqueante desde v1.9)*: cada marca lleva la ubicación del teléfono. Si el administrador fijó la ubicación real del punto (botón "📍 Fijar aquí" en el panel, parado en el lugar), **la app no deja marcar ese punto desde lejos** ni sin señal GPS: le muestra al guardia a cuántos metros está, cuál es el máximo con la señal del momento, y no encola nada. El servidor revalida con el mismo criterio. Umbrales ajustables por `.env`, ver tabla abajo.
- **Presupuesto de error del GPS** *(v1.13)*: el tope deja de ser un número fijo: **se le suma la imprecisión de las dos medidas que se comparan**, la del punto y la del teléfono ahora. Esto arregla el caso en que el guardia estaba parado sobre el QR y la app le decía "acércate al punto": con dos fixes de ±20 m, exigir 20 m clavados era imposible de cumplir. El control no se debilita — el margen lo pone el sensor, no el guardia — y un fix demasiado impreciso (WiFi/antena) se descarta en vez de usarse para decidir.
- **Medición honesta del GPS** *(v1.14)*: v1.13 planteó bien ese presupuesto y lo alimentó mal — las dos medidas eran "la mejor de N lecturas", que es elegir el error más favorable y llamarlo precisión. Ahora las dos se promedian con [`public/geo.js`](public/geo.js) (centroide ponderado por `1/acc²`, outliers descartados por mediana) y declaran el **máximo** entre la dispersión observada, el techo teórico y un piso físico: promediar mata el error aleatorio, no el multipath. El panel **mide 45 s en vez de 12** —calentando el receptor desde que se abre la pestaña— y guarda junto al punto cómo llegó a ese número; los puntos fijados antes salen marcados para re-medir, sin que ninguno cambie solo. En el teléfono, un rechazo por señal fría deja la marca **esperando hasta 15 s** y se registra sola si la señal entra: el criterio no se afloja, solo se le da tiempo a cumplirse. Y el GPS se enciende al entrar, con Wake Lock durante la ronda, porque con la pantalla apagada el navegador lo mata.
- **Puntos bajo techo: verificación por entrada** *(v1.10)*: en subterráneos, salas de calderas e interiores el GPS no llega y los 20 m son imposibles. Para esos, el administrador usa **"🏠 Fijar entrada"**: se para en la puerta del recinto (o donde el teléfono todavía toma señal) y fija ahí el ancla. El guardia puede marcar ese punto si pasó por la entrada en los **últimos 15 min**, dentro de **40 m** — el teléfono usa el fix que alcanzó a tomar antes de perder señal, sin que el guardia haga nada extra. Es una prueba más débil a propósito ("pasó por la entrada", no "está en el punto") y el informe lo dice: `📍 por entrada`. Radio y ventana se ajustan por punto con "Ajustar".
- **Cercanía reciente** *(v1.27, CU-29)*: bajo un alero o en un subterráneo el GPS falla justo cuando el guardia llega, aunque un minuto antes, caminando hacia el punto, tenía buena señal. La app guarda un rastro de sus lecturas y, **antes de rechazar**, lo revisa: la marca entra **por cercanía** si hubo una lectura buena (±20 m o menos) a 30 m o menos del punto en los últimos 5 min y ninguna lectura posterior lo ubica a más de 30 + 20 m. Funciona en todos los puntos con ubicación, sin elegir 🏠, y en los 🏠 arregla la entrada que se perdía a los 20 s (INC-002). La caseta sigue rechazada. En el informe es una marca normal, sin etiqueta. Decisión en `entrega/ADR-001-GPS-BAJO-TECHO.md`. En **Panel → Puntos** cada punto muestra su **señal de los últimos 30 días** (🟢 buena / 🟡 regular / 🔴 mala) con una recomendación de qué prueba usar (`lib/senal-puntos.js`); solo sugiere, la ubicación nunca cambia sola.
- **Informe automático**: al cerrar cada ronda se genera el informe (Completa / Con observaciones / INCOMPLETA) y se avisa al administrador en el panel (pestaña Avisos). Si una ronda queda incompleta o sospechosa, además sale un push al teléfono.
- **Notificación de ronda incompleta** *(v1.4)*: si un guardia termina su ronda sin escanear todos los puntos, al administrador le llega una notificación push al teléfono (con el nombre del guardia y los puntos que faltaron), aunque tenga el panel cerrado. Se activa con un botón en la pestaña **Avisos**; no requiere configurar nada (las claves VAPID se generan solas). Necesita HTTPS o localhost; en iPhone, instalar el panel en la pantalla de inicio primero.
- **Base de datos SQLite** *(v1.17)*: el historial ya no se reescribe entero en cada marca. Configuración en memoria, ejecuciones y avisos en tablas propias; se importa sola desde el `db.json` anterior en el primer arranque, con respaldo diario por correo. Medido: 100 guardias a la vez sobre 100 mil rondas, ninguna marca perdida. El listado de informes del panel muestra las últimas 200.
- **Alarma de ronda** *(v1.16)*: cada X tiempo suena una notificación en el teléfono designado del condominio (el de la garita) para que el guardia salga a hacer la ronda. El administrador elige el intervalo en la pestaña **Avisos** ("Enviar alarma cada": media hora, 1 hora, 2 horas…, o apagada) y puede hacerla sonar de prueba. El teléfono se activa desde la app del guardia con "Activar alarma de ronda en este teléfono"; la suscripción queda del condominio, así que sigue sonando aunque cambie el turno. Si el guardia ya empezó una ronda, el conteo parte de nuevo desde ese inicio, y mientras hay una ronda en curso no suena. *(v1.22)* En los teléfonos con **Fully Kiosk** (Android WebView, sin Web Push) la app pregunta cada minuto si toca y la hace sonar con las funciones de Fully: sonido por el canal de alarma, notificación y pantalla encendida. Necesita la interfaz JavaScript de Fully y la pantalla encendida o con protector; ver `entrega/FULLY-KIOSK.md`.
- **Informe semanal por correo** *(v1.8, por destinatario desde v1.11)*: cada lunes a las 8 de la mañana (hora de Chile) sale por correo el informe de la semana anterior en Word, con estadísticas, ranking de guardias e incidencias. El administrador guarda su correo en el panel (pestaña **Avisos**); el que administra **varios condominios pone el mismo correo en cada uno y recibe un solo mensaje con un .docx por condominio adjunto**. Se puede poner más de un correo por condominio (el administrador y el comité, por ejemplo). El botón "Enviar uno de prueba ahora" manda el de esa semana sin esperar al lunes.
- **Panel del administrador**: informes, puntos de control (con hoja de QR imprimible), guardias, rondas y registro de avisos.
- **Cuenta de acceso total** *(v1.12, restringida después)*: una sola cuenta de panel —la de la operación, creada desde el entorno con `ADMIN_TOTAL_*`— trae un **selector de condominio** en la barra y recorre condominio por condominio fijando las ubicaciones GPS de los puntos, sin cambiar de cuenta. **Cualquier otra cuenta `admin` queda encerrada en su condominio**, igual que el guardia, que solo recibe las rondas y los QR del suyo (eso es lo que sostiene el antifraude).
- **Fábrica** *(v1.11)*: `/fabrica`, pantalla de la operación. Da de alta un condominio con nombre + correo del informe (el código de registro para los guardias se genera solo) y queda operable al toque desde el selector del panel: **un condominio nuevo ya no necesita script ni deploy**. También carga los correos de cualquier condominio, manda un informe de prueba, y administra las cuentas de panel: crear (excepcional), cambiar PIN y **quitar** — nunca la última. **El alta no crea cuenta de panel** por defecto: la operación lo opera con la cuenta de acceso total. Si se crea una para el cliente, queda encerrada en ese condominio y su PIN es de 8 a 32 letras y números (distingue mayúsculas). Entra con el rol `fabrica`, que no pertenece a ningún condominio y no puede ver los datos de ninguno. Se configura con `FABRICA_USUARIO` / `FABRICA_PIN`. Desde la v1.26 cada ficha muestra la **salud del producto** de la última semana (`lib/salud.js`): rondas por estado y rondas con dificultades técnicas, separadas en fallo de la aplicación (GPS aparte) y del usuario; y sus **errores de Sentry** (`lib/sentry-lectura.js`, con `SENTRY_TOKEN_LECTURA`).

## Tests

```bash
npm test
```

Cubre los casos de uso del SPEC y los adversariales (permisos cruzados entre condominios y guardias, reenvío offline idempotente, cierres repetidos). No llama a ningún servicio externo.

## Configuración (.env)

| Variable | Default | Qué hace |
|---|---|---|
| `PORT` | `3737` | Puerto del servidor |
| `DB_PATH` | `data/rondas.sqlite` | Ruta de la base SQLite (en Railway, sobre el volumen persistente: `/data/rondas.sqlite`). Si apunta a un `.json` (como hasta la v1.16), se usa `rondas.sqlite` en la misma carpeta y ese `.json` se importa solo en el primer arranque |
| `RESPALDO_TO` | — | Buzón (de la operación, con 2FA) que recibe cada día el respaldo comprimido de la base. Vacío = el respaldo queda solo en el volumen. Ver `entrega/OPERACION.md` |
| `RESPALDO_HORA` | `10` | Hora de Chile desde la que se hace la foto diaria de la base |
| `RESPALDO_CONSERVAR` | `14` | Fotos diarias que se guardan en `respaldos/`, junto a la base |
| `RESPALDO_CORREO_CADA_DIAS` | `1` | Cada cuántos días sale el respaldo por correo |
| `FABRICA_USUARIO` | — | Cuenta de la operación para dar de alta condominios en `/fabrica`. Se crea sola al arrancar |
| `FABRICA_PIN` | — | Su PIN, de **8 dígitos**. Cambiarlo acá y reiniciar recupera el acceso. Vacío = pantalla de fábrica inaccesible |
| `GPS_RADIO_M` | `20` | Metros máximos entre el teléfono y el punto para poder marcar |
| `GPS_MARGEN_MAX_M` | `40` | Techo de la imprecisión perdonada (se **suma** al radio). `0` = radio estricto, como hasta v1.12 |
| `GPS_PRECISION_MAX_M` | `100` | Peor precisión de fix que sirve para decidir. Peor que esto (WiFi/antena) = la marca no se puede verificar |
| `GPS_PRECISION_SUPUESTA_M` | `15` | Precisión que se asume en un punto fijado sin medir (los anteriores a v1.13) |
| `GPS_PRECISION_MIN_M` | `3` | Piso del ± de un fix. Desde v1.14 ese número lo calcula la app, no el navegador: un ±0 m es un error de cálculo, no un fix perfecto |
| `GPS_FRESCO_MS` | `20000` | Antigüedad máxima del fix GPS para poder marcar |
| `GPS_BLOQUEA` | `1` | `1` = rechaza la marca lejos/sin GPS. `0` = la acepta y solo la deja observada en el informe (comportamiento v1.8) |
| `GPS_ANCLA_RADIO_M` | `40` | Radio alrededor del ancla en los puntos con verificación por entrada |
| `GPS_ANCLA_VENTANA_MIN` | `15` | Minutos que vale la señal tomada en la entrada |
| `GPS_LECTURA_BUENA_M` | `20` | Peor ± de una lectura que sirve para la cercanía reciente (v1.27) |
| `GPS_CERCANIA_M` | `30` | A cuántos metros del punto tuvo que estar esa lectura |
| `GPS_CERCANIA_MIN` | `5` | Minutos que vale esa lectura. `0` = sin cercanía, como hasta v1.26 |
| `GPS_ERROR_EXTRA_M` | `20` | Cuánto se puede equivocar el GPS más de lo que declara (rebote en muros y losas): una lectura posterior más lejos que `GPS_CERCANIA_M` + esto desmiente la cercanía |
| `GMAIL_CLIENT_ID` | — | Client ID del OAuth client de Google (tipo "Desktop app", Gmail API habilitada) |
| `GMAIL_CLIENT_SECRET` | — | Client secret de ese mismo OAuth client |
| `GMAIL_REFRESH_TOKEN` | — | Se saca UNA VEZ desde tu compu con `node scripts/obtener-refresh-token.js`. Sin las 3 credenciales el informe semanal por correo queda en pausa (no rompe nada) |
| `GMAIL_FROM` | `Ronda <tu-cuenta@gmail.com>` | Remitente. Tiene que ser la misma cuenta dueña del refresh token: Gmail rechaza mandar "de" otra cuenta |
| `INFORME_TO` | — | Respaldo: a dónde va el informe de los condominios que aún no cargaron su correo en el panel. Vacío = esos no se envían |
| `INFORME_DIA` / `INFORME_HORA` | `1` / `8` | Cuándo sale (1 = lunes, hora de Chile) |
| `INFORME_CONDOMINIOS` | — | Lista blanca opcional de ids. Vacío = todos los que tengan correo cargado |

> **A quién le llega el informe no se configura por `.env`**: vive en cada condominio (`correosInforme`) y lo edita el propio administrador desde el panel. El envío se agrupa por destinatario, así que un administrador con dos condominios recibe un correo, no dos. Se manda por la API HTTP de Gmail (OAuth2) y no por SMTP porque **Railway bloquea los puertos SMTP** (465/587 dan timeout); así sale de verdad desde tu cuenta de Gmail y no desde un tercero.

> Los umbrales de GPS viajan al teléfono en el paquete de rondas, así que basta cambiarlos en el servidor: la app se alinea al actualizar rondas, sin volver a desplegar nada. Si en terreno el bloqueo resulta demasiado duro, subir `GPS_MARGEN_MAX_M` antes de tocar `GPS_RADIO_M`, y apagar `GPS_BLOQUEA` solo como último recurso.

> **Cómo se decide si una marca es válida (v1.13).** El sistema compara dos medidas de GPS, no una: la que tomó el administrador al fijar el punto y la que toma el teléfono al escanear. Cada una trae su propio error y los errores se suman, así que el tope no es un número fijo:
>
> ```
> tope = radio del punto + mín(precisión del punto + precisión del fix, GPS_MARGEN_MAX_M)
> ```
>
> Con un punto bien medido (±5 m) y buena señal (±5 m), el tope queda en 30 m: sigue exigiendo estar sobre el punto. Con señal mala (±30 m) se estira hasta 60 m, que es todo lo que ese hardware puede prometer. El margen lo pone el sensor, no el guardia, y sigue siendo imposible marcar desde la caseta a 200 m. Un fix peor que `GPS_PRECISION_MAX_M` no se usa para nada: no sirve ni para aceptar ni para rechazar.

## Estructura

```
server.js        API + estáticos (Express)
seed.js          datos de demo
lib/store.js     persistencia SQLite (node:sqlite): configuración en memoria + tablas de ejecuciones y avisos; importa el db.json viejo solo
lib/respaldo.js  foto diaria de la base (VACUUM INTO, se guardan 14) y copia comprimida por correo a RESPALDO_TO
lib/fechas-chile.js  días y horas en zona horaria de Chile (rangos del panel y del informe semanal)
lib/rondas.js    motor: iniciar / escanear / cerrar / evaluar
lib/informes.js  informe en datos y en texto
lib/senal-puntos.js  señal GPS de cada punto en los últimos 30 días y qué prueba conviene (panel → Puntos)
lib/fabrica.js          alta de condominios y de cuentas de administrador
lib/informe-semanal.js  informe semanal del condominio en Word (.docx)
lib/destinatarios.js    a quién le llega el informe (agrupa por administrador)
lib/correo.js           envío por Gmail (OAuth2), con un .docx por condominio adjunto
scripts/obtener-refresh-token.js  saca el GMAIL_REFRESH_TOKEN una sola vez (se corre local)
scripts/exportar-json.js          vuelta atrás: regenera el db.json que lee la v1.16
scripts/restaurar-respaldo.js     valida un respaldo y lo deja listo para el próximo arranque
scripts/respaldo-ahora.js         hace el respaldo del día ya (para probar el correo)
scripts/prueba-carga.js           N guardias a la vez sobre una base de M rondas (por defecto 100 y 100 mil)
scripts/diagnostico-gps.js        señal por punto de toda la base, en solo lectura (en producción, solo con permiso)
lib/programador.js      reloj: cada hora revisa el respaldo del día y, los lunes, el informe semanal
lib/notificar.js aviso al admin (panel + consola)
lib/push.js      push al teléfono del admin cuando una ronda queda incompleta, y alarma de ronda a la garita
lib/recordatorios.js  cada cuánto suena la alarma de ronda de cada condominio (revisa cada minuto)
lib/alarma-kiosco.js  teléfonos con Fully Kiosk que consultan la alarma de ronda (no tienen Web Push)
lib/auth.js      PIN scrypt + sesiones Bearer
public/          app guardia (index + manifest) + app panel (admin.html + panel.webmanifest) + hoja QR + informe
test/            suite node --test (mock, $0)
```

## Producción (resumen — detalle en ../entrega/OPERACION.md)

- Deploy: Railway/VPS con `npm start` (requiere HTTPS para que la cámara funcione fuera de localhost).
- **El servicio de Railway tiene que apuntar su Root Directory a `app`**, no a `/`: la app vive en una subcarpeta del repo. Con el root en `/`, Railpack analiza la raíz, no encuentra `package.json` y el build muere con *"could not determine how to build the app"* — sin tocar nada del código. Ya pasó en v1.10 y en v1.11.
- Ojo con "Redeploy": vuelve a desplegar el **mismo** commit que estaba arriba, no el último de `main`. Para subir lo nuevo va "Deploy latest commit" o un push.
- **Base de datos SQLite (v1.17)** en el volumen, con respaldo diario propio (Railway no respalda el volumen en este plan): ver la sección **Base de datos** de `entrega/OPERACION.md` para el respaldo, la restauración y la vuelta atrás. Requiere **Node 24** o superior.
- Limitación conocida v1 (documentada): un QR fotografiado se puede escanear a distancia — la v2 contempla verificación de presencia (GPS/NFC).
