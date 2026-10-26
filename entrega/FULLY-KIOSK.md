# Teléfonos con Fully Kiosk Browser

Público: José (soporte). Aplica a cualquier teléfono de guardia que corra la app del guardia dentro de **Fully Kiosk Browser** (Android), en especial al de la garita, que nadie recarga a mano.

Fully no es Chrome. Muestra la app con el **Android System WebView** del teléfono y decide qué puede usar la página: cámara, GPS, pantalla, recargas, borrado de datos. Varias de esas cosas dependen de ajustes **PLUS** (licencia por equipo). Si un ajuste de esta lista está mal, la app falla de una forma que desde el panel parece culpa del guardia: puntos sin marcar, rondas que desaparecen, "sin ubicación".

Marcas en las tablas: ✅ confirmado en la documentación oficial de Fully (revisada el 2026-10-21) · 🔎 documentado o reportado, pero pendiente de comprobar en un teléfono real.

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

## 4. Lo que hoy NO funciona en Fully

- **La alarma de ronda (Web Push) no suena en Fully.** El WebView no tiene las APIs de notificaciones push 🔎 (lo dicen la documentación de compatibilidad de los navegadores y la de Fully). La app lo detecta: oculta el botón y dice que el navegador no puede recibir la alarma. Para la garita con Fully hay dos alternativas, ninguna construida todavía: usar las funciones propias de Fully desde la página (notificación, sonido, encender la pantalla; PLUS, y solo con la página viva) o que el servidor le mande la orden a Fully por su API remota.
- **Linterna en el lector de la app:** aparece si la cámara que el teléfono eligió declara flash (mismo código que Chrome). Comprobarlo en cada modelo con la prueba de abajo.
- Fully trae su **propio lector de QR** (`fully.scanQrCode`, con opción de linterna; requiere "Enable JavaScript Interface" y "Enable QR Code Scanner", PLUS) ✅. La app no lo usa. Si se activa "Enable JavaScript Interface", restringirlo al dominio de la app.

## 5. Prueba de 5 minutos en cada teléfono Fully (antes de dar por buena la v1.21)

1. Abrir la app e iniciar sesión. A cielo abierto, la línea de GPS de la pantalla de inicio pasa a "Señal lista" en menos de un minuto.
2. Iniciar una ronda de prueba, abrir **Escanear QR** y dejar el teléfono **quieto un minuto bajo techo** con el lector abierto (es cuando la app vuelve a pedir la ubicación si el GPS se calla): no debe aparecer ningún diálogo de ubicación, y al cerrar el lector la línea de GPS no debe decir "falta el permiso de ubicación".
3. Con la ronda de prueba, tocar **Escanear QR**: la cámara abre. Si el teléfono tiene flash, aparece **Encender luz** y enciende.
4. Dejar el lector abierto **10 s sin QR**: aparece la ayuda y **Código a mano**, y **Cancelar** se ve entero.
5. Escanear un QR de la ronda: queda marcado, o aparece el panel "afinando ubicación".
6. Con la ronda en curso, dejar el teléfono **2 minutos sin tocar**: la pantalla no se apaga ni la página se recarga.
7. En el panel → Guardias, la versión de ese teléfono dice **v1.21.0** y "al día".

## Fuentes

- Ajustes de contenido web (cámara, ubicación): https://www.fully-kiosk.com/docs/en/configuration/web-content
- Lista de funciones: https://www.fully-kiosk.com/docs/en/features/all
- Permisos de Android que pide Fully: https://www.fully-kiosk.com/docs/en/getting-started/permissions
- Pantalla y energía: https://www.fully-kiosk.com/docs/en/configuration/device-management · https://www.fully-kiosk.com/docs/en/faq/screensaver
- Detección de movimiento: https://www.fully-kiosk.com/docs/en/features/motion-detection
- Interfaz JavaScript y lector de QR: https://www.fully-kiosk.com/docs/en/api/javascript · https://www.fully-kiosk.com/docs/en/configuration/advanced-web · https://www.fully-kiosk.com/docs/en/faq/barcode
- Historial de versiones: https://www.fully-kiosk.com/docs/en/getting-started/version-history
