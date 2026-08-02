# Rondas QR

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
- **Verificación de presencia por GPS** *(v1.1, bloqueante desde v1.9)*: cada marca lleva la ubicación del teléfono. Si el administrador fijó la ubicación real del punto (botón "📍 Fijar aquí" en el panel, parado en el lugar), **la app no deja marcar ese punto desde más de 20 m** ni sin señal GPS: le muestra al guardia a cuántos metros está y no encola nada. El servidor revalida con el mismo umbral. Umbrales ajustables por `.env`, ver tabla abajo.
- **Puntos bajo techo: verificación por entrada** *(v1.10)*: en subterráneos, salas de calderas e interiores el GPS no llega y los 20 m son imposibles. Para esos, el administrador usa **"🏠 Fijar entrada"**: se para en la puerta del recinto (o donde el teléfono todavía toma señal) y fija ahí el ancla. El guardia puede marcar ese punto si pasó por la entrada en los **últimos 15 min**, dentro de **40 m** — el teléfono usa el fix que alcanzó a tomar antes de perder señal, sin que el guardia haga nada extra. Es una prueba más débil a propósito ("pasó por la entrada", no "está en el punto") y el informe lo dice: `📍 por entrada`. Radio y ventana se ajustan por punto con "Ajustar".
- **Informe automático**: al cerrar cada ronda se genera el informe (Completa / Con observaciones / INCOMPLETA) y se avisa al administrador — en el panel siempre, y por Telegram si está configurado.
- **Notificación de ronda incompleta** *(v1.4)*: si un guardia termina su ronda sin escanear todos los puntos, al administrador le llega una notificación push al teléfono (con el nombre del guardia y los puntos que faltaron), aunque tenga el panel cerrado. Se activa con un botón en la pestaña **Avisos**; no requiere configurar nada (las claves VAPID se generan solas). Necesita HTTPS o localhost; en iPhone, instalar el panel en la pantalla de inicio primero.
- **Informe semanal por correo** *(v1.8, por destinatario desde v1.11)*: cada lunes a las 8 de la mañana (hora de Chile) sale por correo el informe de la semana anterior en Word, con estadísticas, ranking de guardias e incidencias. El administrador guarda su correo en el panel (pestaña **Avisos**); el que administra **varios condominios pone el mismo correo en cada uno y recibe un solo mensaje con un .docx por condominio adjunto**. Se puede poner más de un correo por condominio (el administrador y el comité, por ejemplo). El botón "Enviar uno de prueba ahora" manda el de esa semana sin esperar al lunes.
- **Panel del administrador**: informes, puntos de control (con hoja de QR imprimible), guardias, rondas y registro de avisos.
- **Un panel para todos los condominios** *(v1.12)*: el panel trae un **selector de condominio** en la barra y todo lo que muestra es del que esté elegido — así se recorre condominio por condominio fijando las ubicaciones GPS de los puntos, sin cambiar de cuenta. Ojo con lo que implica: **entre administradores ya no hay aislamiento**, cualquier cuenta `admin` ve los datos de todos los condominios. El **guardia sí sigue aislado**: solo recibe las rondas y los QR del suyo, y eso es lo que sostiene el antifraude.
- **Fábrica** *(v1.11)*: `/fabrica`, pantalla de la operación. Da de alta un condominio con nombre + correo del informe (el código de registro para los guardias se genera solo) y queda operable al toque desde el selector del panel: **un condominio nuevo ya no necesita script ni deploy**. También carga los correos de cualquier condominio, manda un informe de prueba, y administra las cuentas de panel: crear (excepcional), cambiar PIN y **quitar** — nunca la última. Coherente con la v1.12, **el alta no crea cuenta de panel**: como cualquier cuenta `admin` abre todos los condominios, una por condominio solo multiplicaría las llaves. Entra con el rol `fabrica`, que no pertenece a ningún condominio y no puede ver los datos de ninguno. Se configura con `FABRICA_USUARIO` / `FABRICA_PIN`.

## Tests

```bash
npm test
```

Cubre los casos de uso del SPEC y los adversariales (permisos cruzados entre condominios y guardias, reenvío offline idempotente, cierres repetidos). Todo corre en MOCK: no llama a ningún servicio externo.

## Configuración (.env)

| Variable | Default | Qué hace |
|---|---|---|
| `PORT` | `3737` | Puerto del servidor |
| `DB_PATH` | `data/db.json` | Ruta del archivo de datos (en Railway: `/data/db.json`, sobre el volumen persistente) |
| `MOCK` | `true` | En `true`, los avisos al admin quedan solo en el panel/consola. En `false`, salen por Telegram |
| `TELEGRAM_BOT_TOKEN` | — | Token del bot que envía los informes (necesario solo con `MOCK=false`) |
| `FABRICA_USUARIO` | — | Cuenta de la operación para dar de alta condominios en `/fabrica`. Se crea sola al arrancar |
| `FABRICA_PIN` | — | Su PIN, de **8 dígitos**. Cambiarlo acá y reiniciar recupera el acceso. Vacío = pantalla de fábrica inaccesible |
| `GPS_RADIO_M` | `20` | Metros máximos entre el teléfono y el punto para poder marcar |
| `GPS_MARGEN_MAX_M` | `0` | Cuánta imprecisión declarada por el GPS se perdona (se **suma** al radio). `0` = radio estricto |
| `GPS_FRESCO_MS` | `20000` | Antigüedad máxima del fix GPS para poder marcar |
| `GPS_BLOQUEA` | `1` | `1` = rechaza la marca lejos/sin GPS. `0` = la acepta y solo la deja observada en el informe (comportamiento v1.8) |
| `GPS_ANCLA_RADIO_M` | `40` | Radio alrededor del ancla en los puntos con verificación por entrada |
| `GPS_ANCLA_VENTANA_MIN` | `15` | Minutos que vale la señal tomada en la entrada |
| `RESEND_API_KEY` | — | Clave de Resend. Sin ella el informe semanal por correo queda en pausa (no rompe nada) |
| `INFORME_FROM` | `Rondas QR <onboarding@resend.dev>` | Remitente. El dominio de prueba de Resend **solo entrega al dueño de la cuenta**: para escribirle a administradores externos hay que verificar un dominio propio |
| `INFORME_TO` | — | Respaldo: a dónde va el informe de los condominios que aún no cargaron su correo en el panel. Vacío = esos no se envían |
| `INFORME_DIA` / `INFORME_HORA` | `1` / `8` | Cuándo sale (1 = lunes, hora de Chile) |
| `INFORME_CONDOMINIOS` | — | Lista blanca opcional de ids. Vacío = todos los que tengan correo cargado |

> **A quién le llega el informe no se configura por `.env`**: vive en cada condominio (`correosInforme`) y lo edita el propio administrador desde el panel. El envío se agrupa por destinatario, así que un administrador con dos condominios recibe un correo, no dos. Se manda por la API HTTP de Resend y no por SMTP porque **Railway bloquea los puertos SMTP** (465/587 dan timeout).

> Los umbrales de GPS viajan al teléfono en el paquete de rondas, así que basta cambiarlos en el servidor: la app se alinea al actualizar rondas, sin volver a desplegar nada. Si en terreno el bloqueo resulta demasiado duro (GPS con ±30-40 m de precisión junto a muros o torres), subir `GPS_RADIO_M` o dar aire con `GPS_MARGEN_MAX_M` antes de apagar `GPS_BLOQUEA`.

Para activar Telegram: `MOCK=false`, token en `.env`, y en el panel (pestaña Avisos) guardar el `chat_id` del administrador (se obtiene cuando el admin le escribe `/start` al bot).

## Estructura

```
server.js        API + estáticos (Express)
seed.js          datos de demo
lib/store.js     persistencia JSON atómica (migrable a SQLite/Postgres)
lib/rondas.js    motor: iniciar / escanear / cerrar / evaluar
lib/informes.js  informe en datos y en texto
lib/fabrica.js          alta de condominios y de cuentas de administrador
lib/informe-semanal.js  informe semanal del condominio en Word (.docx)
lib/destinatarios.js    a quién le llega el informe (agrupa por administrador)
lib/correo.js           envío por Resend, con un .docx por condominio adjunto
lib/programador.js      reloj semanal: cada lunes revisa y manda lo que falte
lib/notificar.js aviso al admin (mock | Telegram)
lib/push.js      push al teléfono del admin cuando una ronda queda incompleta
lib/auth.js      PIN scrypt + sesiones Bearer
public/          app guardia (index + manifest) + app panel (admin.html + panel.webmanifest) + hoja QR + informe
test/            suite node --test (mock, $0)
```

## Producción (resumen — detalle en ../entrega/OPERACION.md)

- Deploy: Railway/VPS con `npm start` (requiere HTTPS para que la cámara funcione fuera de localhost).
- **El servicio de Railway tiene que apuntar su Root Directory a `app`**, no a `/`: la app vive en una subcarpeta del repo. Con el root en `/`, Railpack analiza la raíz, no encuentra `package.json` y el build muere con *"could not determine how to build the app"* — sin tocar nada del código. Ya pasó en v1.10 y en v1.11.
- Ojo con "Redeploy": vuelve a desplegar el **mismo** commit que estaba arriba, no el último de `main`. Para subir lo nuevo va "Deploy latest commit" o un push.
- La persistencia JSON es para pilotos; con más de ~3 condominios activos o meses de historial, migrar `lib/store.js` a SQLite/Postgres.
- Limitación conocida v1 (documentada): un QR fotografiado se puede escanear a distancia — la v2 contempla verificación de presencia (GPS/NFC).
