# Teléfonos con Fully Kiosk Browser

Público: José (soporte). Aplica a cualquier teléfono de guardia que corra la app del guardia dentro de **Fully Kiosk Browser** (Android), en especial al de la garita, que nadie recarga a mano.

Fully no es Chrome. Muestra la app con el **Android System WebView** del teléfono y decide qué puede usar la página: cámara, GPS, pantalla, recargas, borrado de datos. Varias de esas cosas dependen de ajustes **PLUS** (licencia por equipo). Si un ajuste de esta lista está mal, la app falla de una forma que desde el panel parece culpa del guardia: puntos sin marcar, rondas que desaparecen, "sin ubicación".

Marcas en las tablas: ✅ confirmado en la documentación oficial de Fully (revisada el 2026-10-21; interfaz JavaScript, contenido web, ajustes web avanzados y API REST, el 2026-10-26) · 🔎 documentado o reportado, pero pendiente de comprobar en un teléfono real.

## 1. Ajustes obligatorios

| Ajuste (sección de Fully) | Valor | Si está mal | |
|---|---|---|---|
| **Enable Webcam Access** (Web Content Settings, PLUS) | Activado | La cámara no abre: "No se pudo abrir la cámara. Usa el código manual." | ✅ |
| **Enable Geolocation Access** (Web Content Settings, PLUS) | Activado | Sin GPS: ningún punto con ubicación fijada se puede marcar. | ✅ |
| Permisos de Android de **cámara** y **ubicación precisa** para Fully | Permitir | Fully los pide al activar los ajustes de arriba; alguien tiene que aceptarlos en el teléfono. | ✅ |
| **Start URL** | La raíz del dominio (`https://<servidor>/`), sin `index.html` ni parámetros | La copia sin señal se guarda para la raíz; otra dirección puede no abrir sin red. | 🔎 |
| **Enable JavaScript Alerts** | Activado | La app usa diálogos de confirmación para terminar la ronda y para salir. | 🔎 |
| **Enable Visual Motion Detection** (Motion Detection, PLUS) | Desactivado | Tiene la cámara ocupada todo el tiempo; el desarrollador de Fully dijo que choca con la cámara de la página. | 🔎 |
| **Disable Camera** (Kiosk Mode o KNOX) | Desactivado | Bloquea la cámara también para la página. | ✅ |

## 2. Pantalla: que no se apague en plena ronda

Fully lo dice explícitamente: **con la pantalla apagada, el WebView detiene los scripts y la red al poco tiempo, y ningún ajuste lo evita** ✅. Para la app eso significa que el GPS deja de seguir al guardia, las marcas no se envían y el vigía del GPS no corre. Fully recomienda usar el protector de pantalla en vez de apagarla.

Ojo: para Fully, "inactividad" es **no tocar la pantalla**, y el guardia camina la ronda sin tocarla.

| Ajuste | Valor | |
|---|---|---|
| **Keep Screen On** (Device Management) | Activado | ✅ |
| **Screen Off Timer** (Device Management, PLUS) | Desactivado, o más largo que la ronda más larga | ✅ |
| **Schedule Wakeup and Sleep** (Power Settings, PLUS) | Desactivado, o fuera de todo horario de ronda | ✅ |
| **Sleep on Power Disconnect** | Desactivado: si el guardia desenchufa el teléfono para salir a la ronda, lo duerme | ✅ |
| **Force Screen Off If Not Powered** | Desactivado | ✅ |
| **Turn Screen Off in Darkness** y **Screen Off on Proximity** | Desactivados: de noche, o con el teléfono en el bolsillo, apagan la pantalla | ✅ |
| **Go To Background Timer** (Other Settings, PLUS) | Desactivado | ✅ |
| **Screensaver Timer** (PLUS) | Desactivado. Si se usa para la garita: más largo que una ronda, brillo 0 y fondo `fully://color#000000`; un toque lo despierta y la página sigue viva | ✅ |

## 3. Recargas y borrado de datos (lo más peligroso)

La ronda en curso y las marcas que todavía no llegaron al servidor viven en el almacenamiento del teléfono (localStorage + IndexedDB). **Borrarlo es perder la ronda.** Y la app ya se recarga sola para actualizarse, pero solo cuando es seguro (sin ronda en curso, sin marcas pendientes, sin nadie escribiendo); una recarga de Fully no mira nada de eso.

| Ajuste | Valor | |
|---|---|---|
| **Web Auto Reload**: todas las opciones (por inactividad, por error de página, al encender la pantalla, al salir del protector, al volver la red o Internet) | Desactivadas / 0 | 🔎 |
| **Delete Webstorage / Cookies / Cache / History on Auto Reload** | Desactivadas: borrar webstorage borra la sesión, la ronda en curso y las marcas sin enviar | 🔎 |
| **Clear Cache After Each Page** (Advanced Web Settings) | Desactivado: según el historial de Fully, su limpieza de caché también borra el webstorage | 🔎 |
| **Load Error URL on Disconnection** | Vacío / desactivado: reemplaza la app por una página de error al caer Internet, y la app está hecha para seguir sin señal | 🔎 |
| **Wait for Network Connection** | Desactivado | 🔎 |
| **Cache Mode** | LOAD_DEFAULT | 🔎 |

Además:

- **No usar "Clear Cache" de Fully para destrabar el teléfono** si hay una ronda en curso o marcas pendientes (el chip de arriba dice "N por enviar"). Primero esperar a que se envíen.
- **No desinstalar Fully** ni pasar de la versión APK a la de Google Play (o al revés): desinstalar borra su almacenamiento.
- Las actualizaciones de Android System WebView cierran Fully 🔎. Que el teléfono se actualice fuera de los horarios de ronda.

## 4. Alarma de ronda en Fully (desde la v1.22)

La alarma normal es Web Push, y el WebView de Fully no la tiene 🔎 (no trae las APIs de push ni de notificaciones). Desde la v1.22, en Fully la app hace otra cosa: **le pregunta al servidor una vez por minuto si toca la alarma** y, si toca, la hace sonar con las funciones propias de Fully ✅: saca el protector de pantalla y enciende la pantalla, trae Fully al frente, muestra una notificación de Android, vibra y toca pitidos por el **canal de alarma** de Android durante un minuto. En la app aparece un aviso arriba con **Entendido**, que corta el sonido. Empezar una ronda también lo corta.

Cuándo toca lo sigue decidiendo el servidor, con el mismo reloj que el Web Push: el intervalo que fijó el administrador, contado desde la última alarma o desde el inicio de la última ronda. El teléfono no cuenta nada por su cuenta.

Se activa igual que en Chrome: en la app del guardia, **⏰ Activar alarma de ronda en este teléfono**. La activación es del teléfono, no del guardia: sigue sonando aunque la sesión venza, cambie el turno o la app quede en la pantalla de entrada.

| Ajuste | Valor | Si está mal | |
|---|---|---|---|
| **Enable JavaScript Interface** (Advanced Web Settings, PLUS) | Activado | La alarma no puede sonar. La app lo dice bajo el botón («falta activar su interfaz JavaScript») y, si ya estaba activada, el panel muestra ese teléfono con «la interfaz JavaScript de Fully apagada». | ✅ |
| **URL Whitelist** (Web Content Settings) | `https://<servidor>/*` | Fully advierte que, con la interfaz JavaScript activa, **cualquier página que cargue** puede leer los archivos y cambiar ajustes del teléfono, y **no tiene un ajuste para limitar la interfaz a un dominio**. Lo que recomienda es la lista blanca: así Fully solo carga la app. Después de ponerla, repetir la prueba de 5 minutos (la app tiene que cargar y marcar igual). | ✅ / 🔎 |
| Volumen de **alarma** de Android | Alto | La app toca el sonido por el canal de alarma, que tiene su propio volumen (aparte del de multimedia). En cero no se oye; la notificación y el aviso en pantalla salen igual. | 🔎 |
| Permiso de **notificaciones** de Android para Fully (Android 13 o más nuevo) | Permitir | Sin él no aparece la notificación; el sonido y el aviso en pantalla salen igual. | 🔎 |
| Pantalla (sección 2) | Encendida o con protector | **Con la pantalla apagada la alarma no suena**: el WebView está detenido y la página no puede preguntar. Con el protector de pantalla sí (la página sigue viva). | ✅ |
| Alarma en **Chrome** en ese mismo teléfono | Desactivada | Si alguna vez se activó la alarma en Chrome en ese teléfono, Chrome la sigue recibiendo aparte y suena dos veces. Desactivarla en Chrome (mismo botón) o desinstalar la app de Chrome. | 🔎 |

Cómo se comporta:

- **Una vez por alarma y por teléfono.** El teléfono anota cada alarma que ya sonó: no la repite en la consulta del minuto siguiente ni después de que la app se recargue para actualizarse. Si en la garita hay **dos teléfonos con la alarma activada, suenan los dos**, igual que con Web Push: para que suene uno solo, activarla en uno solo.
- **Sin señal no llega** (tampoco el Web Push). Cuando vuelve, si la alarma sigue en pie (nadie salió a la ronda desde que sonó y no se cumplió el intervalo), suena atrasada. Lo mismo al encender la pantalla.
- **Si el guardia ya está en una ronda en ese teléfono**, no suena, aunque el servidor todavía no lo sepa (ronda iniciada sin señal). La prueba del panel suena igual.
- **Qué ve el administrador** (Avisos → Alarma de ronda): cada teléfono con Fully, con su nombre y quién activó la alarma, y si está conectado y cuándo sonó la última alarma ahí, o desde cuándo no se conecta («ahí la alarma no puede sonar»), o que tiene la interfaz JavaScript apagada. «Hacerla sonar ahora» llega a esos teléfonos en menos de un minuto. Un teléfono que no se conecta en 7 días sale de la lista y hay que volver a activarlo.

Lo que se descartó: que el servidor le mande la orden a Fully por su **API REST / Remote Admin** ✅. Esa API escucha en el propio teléfono (`http://<ip-del-teléfono>:2323`) y está pensada para la red local: el servidor en Railway no llega a un teléfono con datos móviles o detrás del router de la garita sin abrir puertos o montar un túnel. Además cada llamada lleva la contraseña de Remote Admin en la dirección, y esa contraseña permite cosas como borrar los datos de la app; guardarla en el servidor por cada teléfono es un riesgo que no se justifica. Y aun así solo funcionaría con Fully encendido, igual que la consulta de cada minuto.

## 5. Otras cosas de Fully

- **Linterna en el lector de la app:** aparece si la cámara que el teléfono eligió declara flash (mismo código que Chrome). Comprobarlo en cada modelo con la prueba de abajo.
- Fully trae su **propio lector de QR** (`fully.scanQrCode`, con opción de linterna; requiere "Enable JavaScript Interface" y "Enable QR Code Scanner", PLUS) ✅. La app no lo usa.

## 5b. Chapitas NFC en Fully — PENDIENTE (v1.24)

La app lee las chapitas NFC con **Web NFC** (`NDEFReader`), que existe solo en Chrome de Android. El WebView de Fully no lo tiene. Fully trae su propio lector NFC en la interfaz JavaScript (`fully.nfcScanStart` y los eventos `onNdefDiscovered` / `onNfcTagDiscovered`, según su documentación), pero **no se pudo verificar** cómo entrega el texto y el número de serie del tag (el sitio de Fully estaba bloqueado desde la sesión de desarrollo). Sin la serie, la marca no valdría en un punto con chapita (ver CU-28).

Mientras tanto, en Fully la app detecta el entorno y en un punto con chapita dice **«Este teléfono todavía no lee chapitas NFC»**. Desde que el código a mano no sirve en los puntos con chapita, **un teléfono con Fully no puede marcar puntos NFC**: el guardia solo puede avisar «La chapita no lee». Para condominios con chapitas, ver las alternativas de abajo.

### Alternativas a Fully que sí leen chapitas

Web NFC solo existe en **Chrome** de Android. Cualquier modo kiosco que muestre la app dentro de Chrome (no dentro de un WebView propio, como Fully) puede leer chapitas. De más simple a más completo:

1. **Fijar la app (función de Android, gratis).** Instalar la app del guardia desde Chrome («Agregar a pantalla de inicio» → queda instalada como app), activar en Ajustes → Seguridad → «Fijar aplicaciones» (el nombre cambia según la marca) con «Pedir PIN para desfijar», y fijarla. El guardia no puede salir sin el PIN del teléfono. No enciende la pantalla sola ni se recupera si alguien la desfija con el PIN; la alarma de ronda llega por Web Push, como en cualquier Chrome.
2. **Un MDM con modo kiosco de Android Enterprise** («dispositivo dedicado» / *lock task mode*): Google Android Management API, o productos como Scalefusion, Hexnode, ManageEngine, 42Gears SureLock, Esper. El teléfono queda inscrito como dispositivo de la empresa (se resetea de fábrica para inscribirlo) y solo puede abrir las apps permitidas: Chrome con la app del guardia instalada. Se administra a distancia (forzar NFC encendido, actualizaciones, pantalla). Cobran por equipo al mes.
3. **Envolver la app como app de Android (Trusted Web Activity)** y publicarla en Google Play o instalarla por MDM. Por dentro sigue siendo Chrome, así que Web NFC funciona, y se combina con (1) o (2).

**Antes de elegir, probar en el teléfono real** que la chapita se lee con la app instalada y fijada: lo que se sabe (Web NFC es de Chrome; la app instalada y las TWA corren en Chrome) indica que funciona, pero no se pudo comprobar desde la sesión de desarrollo. La prueba está en `entrega/PRUEBAS-NFC.md`.

Para hacerlo:
1. Confirmar en la documentación de la interfaz JavaScript de Fully los nombres exactos (`nfcScanStart`/`nfcScanStop`, cómo se registra el evento con `fully.bind`) y qué datos trae cada evento: el texto NDEF y el UID del tag, y en qué formato.
2. Probar en un teléfono con Fully PLUS y NFC qué llega al acercar una chapita grabada por el panel.
3. En `app.js`, una segunda fuente de lecturas que llame a `chapitaLeida()` con el mismo `{ message, serialNumber }`; `sinLectorNfc()` deja de devolver el aviso cuando `fully.nfcScanStart` exista.

## 6. Prueba de 5 minutos en cada teléfono Fully (antes de dar por buena la versión)

1. Abrir la app e iniciar sesión. A cielo abierto, la línea de GPS de la pantalla de inicio pasa a "Señal lista" en menos de un minuto.
2. Iniciar una ronda de prueba, abrir **Escanear** y dejar el teléfono **quieto un minuto bajo techo** con el lector abierto (es cuando la app vuelve a pedir la ubicación si el GPS se calla): no debe aparecer ningún diálogo de ubicación, y al cerrar el lector la línea de GPS no debe decir "falta el permiso de ubicación".
3. Con la ronda de prueba, tocar **Escanear**: la cámara abre. Si el teléfono tiene flash, aparece **Encender luz** y enciende.
4. Dejar el lector abierto **10 s sin QR**: aparece la ayuda y **Código a mano**, y **Cancelar** se ve entero.
5. Escanear un QR de la ronda: queda marcado, o aparece el panel "afinando ubicación".
6. Con la ronda en curso, dejar el teléfono **2 minutos sin tocar**: la pantalla no se apaga ni la página se recarga.
7. En el panel → Guardias, la versión de ese teléfono dice **v1.24.0** y "al día".
8. **Alarma de ronda** (solo en el teléfono que la tiene que recibir), con la ronda de prueba ya terminada: bajo el botón de la alarma **no** debe decir «falta activar su interfaz JavaScript». Tocar **Activar alarma de ronda en este teléfono**; en el panel → Avisos aparece ese teléfono como «conectado». Tocar **Hacerla sonar ahora** en el panel: en menos de un minuto el teléfono pita, vibra, muestra la notificación y el aviso con **Entendido**, que corta el sonido. Repetirlo con el protector de pantalla puesto: tiene que salir del protector y sonar.

## Fuentes

- Ajustes de contenido web (cámara, ubicación): https://www.fully-kiosk.com/docs/en/configuration/web-content
- Lista de funciones: https://www.fully-kiosk.com/docs/en/features/all
- Permisos de Android que pide Fully: https://www.fully-kiosk.com/docs/en/getting-started/permissions
- Pantalla y energía: https://www.fully-kiosk.com/docs/en/configuration/device-management · https://www.fully-kiosk.com/docs/en/faq/screensaver
- Detección de movimiento: https://www.fully-kiosk.com/docs/en/features/motion-detection
- Interfaz JavaScript (notificación, sonido, pantalla) y lector de QR: https://www.fully-kiosk.com/docs/en/api/javascript · https://www.fully-kiosk.com/docs/en/configuration/advanced-web · https://www.fully-kiosk.com/docs/en/faq/barcode
- API REST / Remote Admin (descartada para la alarma): https://www.fully-kiosk.com/docs/en/api/rest
- Historial de versiones: https://www.fully-kiosk.com/docs/en/getting-started/version-history
