# OPERACIÓN — Rondas QR

Guía de administración y operación. Público: José (soporte) y el administrador del condominio (uso diario).

> Teléfonos que corren la app del guardia en **Fully Kiosk Browser** (el de la garita): ajustes obligatorios y prueba de 5 minutos en [FULLY-KIOSK.md](FULLY-KIOSK.md).
>
> Cuando algo falla en producción: gravedad, qué hacer mientras pasa y registro de fallos en [INCIDENTES.md](INCIDENTES.md).

## Alta de un condominio nuevo (pantalla de fábrica)

Los condominios se crean desde `https://<servidor>/fabrica`, con la cuenta de la operación. Esa dirección **no está enlazada** desde ninguna parte de la app: hay que escribirla.

**Una sola vez**, en las variables del servidor: `FABRICA_USUARIO` y `FABRICA_PIN` (8 dígitos). La cuenta se crea sola en el primer arranque. Si se pierde el PIN, se cambia esa variable y se reinicia.

El modelo es: **el panel lo opera la operación**, con **una** cuenta de administrador de **acceso total** que recorre todos los condominios con el selector de la barra. Esa cuenta se crea sola al arrancar desde las variables `ADMIN_TOTAL_USUARIO`, `ADMIN_TOTAL_NOMBRE`, `ADMIN_TOTAL_PIN` y `ADMIN_TOTAL_CONDOMINIO` (ver `app/.env.example`); no se puede crear ni marcar desde ninguna pantalla. Los administradores de los condominios **no entran a la app**: reciben el informe semanal por correo. Por eso el alta no crea cuentas de panel.

**Por cada condominio nuevo:**

1. Entrar a `/fabrica` con la cuenta de la operación.
2. **Dar de alta un condominio**: nombre y el correo (o correos) a los que va el informe semanal. Crear. Queda el **código de registro** para sus guardias, generado solo.
3. Entrar al `/panel` con la cuenta de la operación y **elegir el condominio nuevo en el selector**. Crear los puntos (con **📍 Fijar aquí** / **🏠 Fijar entrada**, caminando el recorrido), armar la ronda e imprimir la hoja de QR.
4. Entregar el **código de registro** al administrador o al jefe de turno para que los guardias creen su cuenta solos desde la app del guardia.
5. Probar el correo con **"Enviar informe de prueba"** en la ficha del condominio, antes de esperar al lunes.

Eso es todo: el condominio queda andando sin que nadie más tenga acceso al panel, y el lunes a las 8 su administrador recibe el informe.

**Si un administrador tiene varios condominios**, se pone **el mismo correo en cada uno** y el lunes recibe **un solo correo** con un informe adjunto por condominio.

**Si algún cliente sí va a operar su propio panel** (excepción): en el alta se abre el bloque "Darle además una cuenta de panel al cliente", o se agrega después desde su ficha. Esa cuenta queda **encerrada en su condominio**: no ve ni toca los demás. El PIN es de 8 a 32 letras y números, con al menos una letra y un dígito, y distingue mayúsculas.

Desde la ficha de cada condominio, la fábrica también: cambia los correos del informe, cambia el PIN de una cuenta de panel (le cierra las sesiones abiertas) y **quita** cuentas de panel que ya no correspondan (no deja borrar la última, o nadie podría entrar). La lista avisa cuando hay más de una cuenta dando vueltas.

**Salud del producto** (v1.26): cada ficha trae una tabla de los últimos 7 días con lo que falla sin ser un error, y por eso no avisa Sentry: cómo terminaron las rondas (completas, incompletas, con sospechas y **cerradas automáticamente**, que son las que el teléfono no terminó), en cuántas el guardia **tuvo que volver a iniciar sesión a mitad de ronda** y cuántas veces **la alarma no se mandó porque había una ronda en curso** (una ronda colgada calla la alarma de todo el condominio). Lo que está en ámbar es lo que hay que mirar. Los inicios de sesión y las alarmas se empezaron a anotar con la v1.26: la ficha dice desde cuándo, y antes de esa fecha un cero no quiere decir nada.

> **Cuentas heredadas**: las cuentas de las demos y de las migraciones anteriores (`admin`/1234, `marta`, `carmen`, `admin-piloto`/1234) ya no abren todos los condominios, pero siguen entrando al suyo con un PIN publicado en git. En producción: purgar las demo (`purga-demo.js --aplicar`) y cambiarle el PIN a `admin-piloto` desde la fábrica.

> El login admite 5 intentos fallidos por usuario e IP y después bloquea 15 minutos. El registro de guardias, 5 códigos erróneos por condominio. Aun así, la cuenta de fábrica es la llave maestra: PIN de 8 dígitos y no se comparte.

## Uso diario del administrador (panel web)

Todo se hace en `https://<servidor>/panel` con su usuario y PIN. Es una app aparte de la del guardia: conviene **instalarla** (botón "📲 Instalar el panel" en la pantalla de entrada, o Compartir → Añadir a pantalla de inicio en iPhone/iPad) o guardar esa dirección en favoritos. La app del guardia (`https://<servidor>/`) no da acceso al panel.

- **Informes**: cada ronda cerrada aparece al instante con su estado. "Ver informe" abre el detalle imprimible. Si un guardia dejó una ronda abierta (se le olvidó cerrar), el botón **Cerrar** la cierra y evalúa con lo marcado hasta ese momento.
- **Puntos**: agregar/renombrar/eliminar sectores. Tras cualquier cambio, reimprimir la **hoja de QR** y pegar la lámina nueva. El código de 6 letras bajo cada QR es el respaldo para entrada manual.
- **Verificación GPS de cada punto**: se hace **una sola vez, caminando la ronda con un teléfono** el día de la instalación. Hay dos botones y la elección depende de si el GPS llega o no a ese punto:
  - **📍 Fijar aquí** — puntos al aire libre (perímetro, patios, esquinas, superficie). Párate **encima del punto**, con el teléfono en la mano (no en el bolsillo), aprieta y **quédate quieto hasta 45 segundos** (desde v1.14; hasta 90 si la señal está mala y la app decide afinar). La app va mostrando cuántas lecturas lleva y con qué ± va. Al terminar dice con cuánta quedó — **±10 m o menos es lo bueno**. Desde ese momento el guardia no puede marcar ese punto desde lejos ni sin señal: la app le dice a cuántos metros está y no registra nada.
  - **🏠 Fijar entrada** — puntos **bajo techo**: subterráneos, salas de calderas, grupos electrógenos, interiores de torre. Ahí el GPS no llega y el radio exacto es imposible de cumplir. Párate en **la puerta del recinto, o en el último lugar del recorrido donde el teléfono todavía tiene señal** (la rampa de bajada, por ejemplo) y aprieta, con la misma medición. El guardia podrá marcar ese punto si pasó por esa entrada en los **últimos 15 min**, dentro de **40 m**. No tiene que hacer nada especial: el teléfono ya guardó la señal al pasar.
  - **La medición larga no es un capricho**: un GPS frío necesita medio minuto para converger, así que los 12 s de v1.13 medían sobre todo WiFi y antena — justo en los puntos semi-techados, que son los que duelen. Y el número que se guardaba era la *mejor* lectura, no la típica: sonaba mejor de lo que era. Conviene tener la pestaña "Puntos" abierta mientras se camina hacia el punto: el GPS empieza a calentar solo desde ahí.
  - **La calidad de cada medición queda a la vista** en la columna de verificación: "medido con ±7 m". Si dice **"⚠ fijado sin medir"**, ese punto se fijó con una versión anterior a la v1.13, con una sola lectura y calidad desconocida. Si dice **"medido con el método antiguo"**, se fijó con v1.13: sirve, pero su ± es optimista. En los dos casos conviene **volver a medirlo** cuando se pase por ahí. Si la medición sale peor que ±25 m la app avisa; peor que ±60 m no la guarda y hay que reintentar con mejor señal.
  - **Ajustar** cambia el radio y los minutos de un punto puntual, sin tocar el resto. **Quitar 📍** deja el punto sin verificación (se marca como antes).
  - ⚠️ Fijar **desde el lugar**, no desde la oficina: si se aprieta cualquiera de los dos botones en la caseta, esa queda como la ubicación de referencia y la verificación queda inservible.
  - Lo que hay que saber del anclaje: prueba que el guardia **pasó por la entrada**, no que entró al recinto. Es más débil que la verificación exacta y el informe lo marca como "📍 por entrada". Si el condominio necesita prueba de que entró, eso requiere NFC (ver SEGURIDAD.md).
  - **Si el guardia dice "estoy en el punto y no me deja marcar"**, en ese orden: (1) mirar en el panel la calidad con que se fijó ese punto — si dice "fijado sin medir", "método antiguo" o ±40 m, **volver a medirlo** es el arreglo de verdad; (2) el guardia tiene que ver "📍 Ubicación activa" con una precisión razonable antes de escanear — si dice "señal imprecisa", esperar unos segundos a que el GPS afine; (3) recién ahí, aflojar `GPS_MARGEN_MAX_M` (o el radio del punto con "Ajustar"). Apagar el bloqueo con `GPS_BLOQUEA=0` es el último recurso. Nada de esto requiere volver a desplegar la app del guardia.
  - **Desde v1.14 el guardia casi no debería ver rechazos por señal fría**: si al escanear la ubicación todavía no alcanza, la app muestra "📍 Afinando señal… N s" y registra la marca sola cuando entra, sin volver a escanear. Solo si en 15 segundos no alcanza aparece el rechazo — y ese rechazo ahora **queda registrado en el servidor**, que es el dato con el que se van a ajustar estos umbrales la próxima vez. Si un guardia reporta que ve "afinando señal" en todos los puntos, el problema es el teléfono o el edificio, no el umbral.
  - **El teléfono del guardia mantiene la pantalla encendida durante la ronda** (Wake Lock): con la pantalla apagada el navegador mata el GPS y el guardia llega al punto sin ubicación. Si el teléfono no lo permite, la app lo dice en la línea de estado. Cuesta batería: en rondas largas conviene que el guardia salga con el teléfono cargado.
- **Chapitas NFC** *(v1.24, CU-28)*: un punto puede marcarse con una chapita en vez de QR. Ver la guía completa más abajo, «Puntos con chapita NFC».
- **Guardias**: crear usuario + PIN (4-8 dígitos). "Nuevo PIN" si se le olvidó. Eliminar corta el acceso de inmediato.
- **Rondas**: armar la secuencia tocando los puntos en orden; con las flechas **↑ ↓** un punto se cambia de lugar (v1.24). Mover un punto no toca su QR ni su chapita: no hay que reimprimir ni regrabar nada. "El orden importa" hace que marcar desordenado quede como observación. La duración máxima genera observación si se excede. Los guardias ven los cambios al tocar "Actualizar rondas".
- **Avisos**: historial de notificaciones enviadas.

## Puntos con chapita NFC *(v1.24, CU-28)*

Una **chapita** es un sticker NFC NTAG213 (25 mm) dentro de una carcasa impresa en 3D. El guardia marca el punto acercando el teléfono; no hay QR que fotografiar. Es **por punto**: los puntos sin chapita siguen con su QR igual que siempre, y en una misma ronda pueden convivir los dos.

**Lo que hace falta:** para **grabar** la chapita, un teléfono **Android con NFC y Chrome** (en iPhone, en computadores y en Fully Kiosk no se puede). Para **marcar**, el guardia también necesita Android + Chrome con NFC. Ojo con los teléfonos de gama baja: hay modelos que salen en una variante sin NFC (en Ajustes, buscar «NFC»: si no aparece, no tiene).

### 1. Agregar el punto en el panel

1. Panel → **Puntos** → «Agregar punto»: escribir el nombre y elegir **📶 con chapita NFC** (o «📷 con QR» para uno normal).
2. Cada punto muestra en la tabla con qué se marca: **📷 QR**, **📶 NFC · falta grabar la chapita** o **📶 NFC · chapita grabada** (con la serie abreviada y si está 🔒 bloqueada). Un punto recién creado con chapita queda «falta grabar la chapita»: **no sale en la hoja de QR** y, mientras tanto, el guardia lo marca con el **código a mano** (la columna «Código» del panel).
3. Un punto que ya existe también se pasa a chapita: en su fila, **📶 Grabar chapita**.

### 2. Instalar y grabar la chapita (en terreno)

1. **Instalar primero**: pegar la carcasa con la chapita en el lugar del punto. Se graba **a través del plástico**, ya instalada.
2. Parado junto a la chapita, con el **NFC del teléfono encendido** (Ajustes → buscar «NFC»), abrir el panel (`https://<servidor>/panel`) en **Chrome**, entrar, ir a **Puntos** y tocar **📶 Grabar chapita** en ese punto. (Para cambiar una chapita rota: **Reemplazar chapita**.)
3. Tocar **Empezar** y **acercar la parte trasera del teléfono a la chapita** (la antena suele estar al centro o arriba de la espalda del teléfono). La primera vez Chrome pide permiso para usar NFC: permitir.
4. El panel va diciendo qué hace:
   - lee el **número de serie** de la chapita. Si la chapita ya tiene grabado otro punto, pregunta antes de seguir; si ya está registrada en otro punto, se detiene;
   - **graba** el punto («no muevas el teléfono»);
   - pide **alejar el teléfono y volver a acercarlo** para **verificar** que quedó bien;
   - **guarda** la serie en el servidor: «✅ Chapita grabada (sin bloquear)».
5. Si algo falla antes del final (se movió el teléfono, NFC apagado, permiso negado), el punto queda **como estaba**: el panel dice qué pasó y se toca **Reintentar**.
6. **La chapita queda sin bloquear**: se puede volver a grabar o usar en otro punto. **Pruébala** con la app del guardia (una ronda de prueba con ese punto).
7. **🔒 Bloquear chapita** — cuando ya es la definitiva. En la fila del punto aparece el botón (donde antes estaban los de ubicación). Junto a la chapita, tocarlo, leer el aviso y tocar **«Sí, bloquear para siempre»**, y acercar el teléfono. Antes de bloquear, el panel comprueba que sea **la chapita registrada para ese punto** y que tenga **su código**; si no, no bloquea y lo dice. Bloquearla impide que alguien le grabe otro punto encima. **Es para siempre**: después no se puede regrabar ni usar en otro punto ni en otro condominio. La tabla muestra «sin bloquear» en rojo hasta que se haga.
8. **Bajo techo:** si el punto está en un subterráneo o una sala cerrada, **no le fijes ubicación GPS** (ni 📍 ni 🏠): la chapita ya prueba que el guardia estuvo ahí, y una ubicación exacta bajo techo haría rechazar la marca por falta de señal. Si el punto ya tenía ubicación, **Quitar 📍**.
9. Un punto con chapita (grabada o por grabar) **no sale como QR** en la hoja de QR: sale marcado «Chapita NFC — no lleva QR». Si el punto antes era QR, retirar su lámina vieja.
10. Los guardias reciben el cambio al tocar «Actualizar rondas» (o al volver a entrar).

En la fila de un punto con chapita **no aparecen los botones de ubicación** (📍 Fijar aquí, 🏠 Fijar entrada, Ajustar): la chapita es la que prueba la presencia. Si el punto ya tenía una ubicación de antes, queda solo **Quitar 📍**, para sacársela si está bajo techo.

**Volver a QR:** en la fila del punto, **Volver a QR**. La chapita deja de valer; reimprimir la hoja de QR y pegar la lámina. Si la chapita **no estaba bloqueada**, queda libre para grabarla en otro punto u otro condominio.

**Probar una chapita en un condominio y después usarla en otro:** grabarla en el de prueba **sin bloquearla**; al terminar, **Volver a QR** (o eliminar el punto) en el de prueba —si no, el panel no deja usarla en otro lugar: una chapita no puede estar en dos puntos—; en el definitivo, **📶 Grabar chapita** (el panel avisa que trae otro punto y pregunta si grabar encima) y recién ahí **🔒 Bloquear chapita**.

### 3. Cómo marca el guardia

1. En la ronda toca el botón de siempre: en una ronda que tiene puntos con chapita dice **«Escanear»**; en una ronda sin chapitas sigue diciendo **«📷 Escanear QR»**, como antes.
2. Si el punto que toca es de chapita, en vez de la cámara aparece **«Acerca la parte trasera del teléfono a la chapita»**. Acerca el teléfono y lo deja quieto hasta que vibre: el punto queda ✅ con «📶 NFC». Si el punto es de QR, se abre solo la cámara. **Nunca se abren las dos cosas a la vez.**
   - En una ronda **con orden**, la app sabe cuál es el próximo punto y abre su medio directo.
   - En una ronda **sin orden** que mezcla puntos con QR y con chapita, la app no sabe frente a cuál está el guardia, así que pregunta **«¿Qué hay en este punto?»**: **📷 Un QR** o **📶 Una chapita**. Si la ronda es toda de chapitas o toda de QR, no pregunta.
3. **Sin señal también funciona:** la chapita no necesita internet ni GPS; la marca queda en la cola y se envía sola al volver la señal.
4. Si alguien escanea una **foto del QR** o una **copia** de la chapita, la app lo rechaza («Este punto se marca con la chapita NFC») y el rechazo queda registrado.
5. Si el teléfono no puede leer chapitas, la pantalla dice por qué y qué hacer: NFC apagado (activarlo en Ajustes y Reintentar), permiso negado (candado junto a la dirección → Permisos → NFC → Permitir), teléfono sin NFC, iPhone o Fully Kiosk. **Los puntos con chapita solo se marcan con un Android con NFC y Chrome.**
6. **En un punto con chapita el código a mano NO sirve.** El código a mano no prueba que el guardia fue (se aprende una vez y se tipea desde la caseta), y en los puntos bajo techo tampoco hay GPS que lo frene. Si alguien lo intenta, la app lo rechaza y el intento queda registrado.
7. **«⚠️ La chapita no lee»** (botón en la pantalla de la chapita): para cuando la chapita está rota, despegada o el teléfono no lee NFC. El punto queda **SIN marcar** (sale como faltante y la ronda como incompleta) y el informe le dice al administrador: «El guardia avisó que la chapita no leyó en: Sala de bombas (03:12). Revisar o reemplazar la chapita». En una ronda sin orden con varias chapitas pendientes, la app pregunta en cuál está. Avisar no marca: así no hay atajo.
   - El administrador revisa la chapita: si se rompió, **Reemplazar chapita**; si va a tardar, **Volver a QR** mientras tanto.
   - *Si algún día se quiere volver a aceptar el código a mano* (anotado como observación o como sospecha): una línea, `MANUAL_EN_PUNTO_NFC` en `app/lib/rondas.js`.

En el informe de cada ronda, cada punto muestra con qué se marcó: **📶 NFC**, **📷 QR** o **⌨️ a mano**.

## Guardias: instalación en el teléfono

1. Abrir `https://<servidor>/` en Chrome (Android) → menú → **"Agregar a pantalla de inicio"**. Queda como app.
2. Entrar con usuario y PIN **con conexión** (wifi de portería basta). Después la ronda funciona sin señal.
3. La cámara requiere **HTTPS** (o localhost). En producción el servidor ya va con HTTPS; si algún teléfono no da permiso de cámara, siempre está la entrada manual.

## Cómo le llegan los avisos al administrador

El aviso de cada cierre de ronda queda **siempre** en el panel → pestaña **Avisos**, y en la consola del servidor. No hay nada que activar.

Además hay dos canales que sí salen del servidor y se configuran aparte:

- **Push al teléfono** (ronda incompleta o sospechosa): panel → pestaña Avisos → "Activar avisos en este teléfono". Requiere las claves VAPID en el `.env`.
- **Informe semanal por correo**: panel → pestaña Avisos → cargar los correos. Requiere `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` en el `.env` (se manda desde la cuenta real de Gmail, vía su API — ver `entrega/INFORME-SEMANAL.md`).

> El canal **Telegram se eliminó en la v1.15**. Nunca se usó en producción y su llamada a la API no tenía tiempo máximo de espera: si Telegram no respondía, la petición del guardia al terminar la ronda quedaba colgada esperando a un tercero.

## Deploy a producción (cuando José apruebe)

- **Railway** (o VPS): `npm install && npm start`, variable `PORT` la pone la plataforma. Railway da HTTPS solo — necesario para la cámara. Costo estimado: plan chico (~US$5/mes). **Runtime sin LLM: el uso diario cuesta $0 en APIs.**
- Un servidor sirve a **varios condominios** a la vez. Se dan de alta desde la pantalla de fábrica (ver arriba): no hace falta desplegar nada por cada condominio nuevo. Requiere `FABRICA_USUARIO` y `FABRICA_PIN` en las variables del servicio.
- **Aislamiento entre condominios**: cada guardia ve únicamente las rondas y los QR de su condominio, y cada cuenta de administrador, únicamente su condominio. La excepción es la cuenta de **acceso total** de la operación (selector en la barra del panel), que se configura solo desde el entorno del servidor.
- **Datos y respaldo**: todo el estado vive en una base SQLite en el volumen (`/data/rondas.sqlite`). La app saca una foto diaria y la manda por correo a `RESPALDO_TO` — ver la sección **Base de datos** más abajo.
- **Escala**: medido en la v1.17, 100 guardias haciendo su ronda a la vez sobre una base de 100 mil rondas: ninguna marca perdida y ~0,1 ms de base por marca. El límite de este diseño es **un solo servidor** (una réplica): si algún día hacen falta varias, toca Postgres.
- **Node 24 o superior** (`engines` en `package.json`): la base usa `node:sqlite`, que viene con Node. Verificar en el log de build de Railway qué versión usa.

## Cuando un guardia elimina su cuenta *(v1.18, CU-25)*

Google Play exige que quien crea su cuenta dentro de la app pueda eliminarla. El guardia puede hacerlo de dos formas:

- **Desde la app**: pantalla de rondas → abajo, "Eliminar mi cuenta" → escribe su PIN. La app **no lo deja** si tiene una ronda en curso o marcas sin enviar (esas marcas solo están en su teléfono).
- **Sin la app**: `https://<servidor>/eliminar-cuenta.html`, con usuario + PIN. Es la dirección que se declara en Google Play y la que enlaza la política de privacidad. Tiene el mismo tope de intentos que el login (5 PIN malos por usuario e IP bloquean 15 min, y el bloqueo vale también para el login). Si no recuerda usuario o PIN, la página muestra el contacto `CONTACTO_PRIVACIDAD` (variable de entorno, hoy `+56911112222`: la página ofrece WhatsApp y llamada; también acepta un correo. Sin ella le dice que se lo pida a su administrador).

Las cuentas de administrador, fábrica y acceso total **no** se borran por ahí (responde que solo las de guardia).

**Qué ve el administrador:**

- El guardia **desaparece de la pestaña Guardias** y ya no puede entrar: sus sesiones abiertas se cortan en el acto.
- **Sus rondas siguen en Informes**, con hora, marcas y ubicaciones, pero el guardia aparece como **"Guardia eliminado"**. Lo mismo en el detalle de cada informe, en la pestaña Avisos (los avisos ya escritos se reescriben sin su nombre) y en el informe semanal (.docx), donde todos los guardias eliminados van juntos en una fila "Guardia eliminado" y sus marcas cuentan como "sin identificar".
- **Si tenía una ronda en curso**, se cierra en ese momento con lo que alcanzó a marcar, igual que el botón "Cerrar" del panel: queda en Informes y llega el aviso de siempre (si quedó incompleta, también el push), con la nota "(cerrada al eliminar el guardia su cuenta)".
- Si el teléfono de la garita tenía la **alarma de ronda** activada desde la sesión de ese guardia (por notificación o, desde la v1.22, en Fully Kiosk), esa activación se borra: hay que volver a activarla desde la app con otro guardia.
- **Eliminar un guardia desde el panel** (Guardias → Eliminar) hace exactamente lo mismo desde la v1.18: antes solo cortaba el acceso y dejaba su nombre en los avisos.

**Respaldos**: no se reescriben. Las fotos diarias del volumen rotan solas (`RESPALDO_CONSERVAR`, 14 días): lo borrado desaparece de ellas en ese plazo, y es el plazo que declara la política de privacidad. **Las copias que llegan por correo a `RESPALDO_TO` no rotan solas**: para que el plazo de 14 días se cumpla, ese buzón tiene que borrar los respaldos más viejos (en Gmail, un filtro + borrado periódico, o borrarlos a mano). Si se restaura un respaldo de antes del borrado, el guardia vuelve a aparecer: después de restaurar, hay que volver a eliminarlo desde el panel.

> Las rondas de un guardia eliminado ya no se pueden atribuir a una persona desde el sistema. Si el condominio necesita saber quién hizo una ronda antigua (por ejemplo, ante un incidente), tiene que resolverlo con sus propios registros de turno.

## Base de datos: respaldo, restauración y vuelta atrás *(v1.17)*

Desde la v1.17 todo el estado vive en **una base SQLite** (`rondas.sqlite`) en el volumen de Railway (`/data`). Junto a ella aparecen `rondas.sqlite-wal` y `rondas.sqlite-shm`: son parte de la base, **no se borran ni se copian por separado**.

- `DB_PATH` puede apuntar a `/data/rondas.sqlite` o, como hasta la v1.16, a `/data/db.json`: en ese caso se usa `/data/rondas.sqlite` en la misma carpeta.
- **Primer arranque de la v1.17**: si hay un `db.json` y la base no existe, se importa todo en una sola transacción, se verifican los conteos y el `.json` queda renombrado como `db.json.migrado-<fecha>` (no se borra). Si algo no cuadra, **el servidor no arranca** y el log dice por qué; el `.json` queda intacto.
- El log de arranque muestra la ruta de la base, la versión de Node y los conteos (condominios, usuarios, puntos, rondas, ejecuciones, avisos).

### Respaldo automático

El plan de Railway **no incluye respaldos del volumen**: los hace la app.

1. **Foto diaria** en `/data/respaldos/rondas-AAAA-MM-DD.sqlite` (fecha de Chile), desde las 10:00. Se conservan las últimas 14. Es una copia consistente aunque haya rondas en curso.
2. **Copia fuera de Railway por correo**: la foto se comprime y se manda como adjunto `rondas-AAAA-MM-DD.sqlite.gz` a `RESPALDO_TO`, con la misma cuenta de Gmail del informe semanal. Si el envío falla, se reintenta a la hora siguiente.

| Variable | Por defecto | Qué hace |
|---|---|---|
| `RESPALDO_TO` | — | Buzón que recibe el respaldo. **Vacío = no sale copia fuera de Railway** (el log lo dice en cada foto). |
| `RESPALDO_HORA` | `10` | Hora de Chile desde la que se hace la foto del día. |
| `RESPALDO_CONSERVAR` | `14` | Fotos que se guardan en el volumen. |
| `RESPALDO_CORREO_CADA_DIAS` | `1` | Cada cuántos días va por correo (la foto sigue siendo diaria). |
| `RESPALDO_DIR` | `/data/respaldos` | Carpeta de las fotos. |

> **El respaldo trae hashes de PIN, correos y ubicaciones GPS.** `RESPALDO_TO` tiene que ser un buzón de la operación con verificación en dos pasos, y el correo no se reenvía.

**Tamaño**: Gmail rechaza mensajes de más de 25 MB y el adjunto viaja en base64 (+33 %). Sobre **12 MB** comprimido el correo llega con ⚠️ en el asunto; sobre **18 MB** ya no va adjunto (el correo llega igual, avisando). En ese punto hay que pasar la copia externa a almacenamiento de objetos (R2/S3). Como referencia, 100 mil rondas ocupan ~200 MB sin comprimir.

**Espacio en el volumen**: 14 fotos ocupan 14 veces la base. Revisar el uso del volumen en Railway cuando la base pase de ~500 MB.

**Probar el envío a mano** (el día del deploy, o después de cambiar `RESPALDO_TO`):

```bash
railway ssh -- node scripts/respaldo-ahora.js
```

### Restaurar un respaldo

La base no se reemplaza en caliente: el script valida el respaldo y lo deja listo, y el cambio se hace al reiniciar el servicio. **La base actual no se borra**: queda como `rondas.sqlite.antes-restaurar-<fecha>`.

1. Tener el respaldo **dentro del volumen**:
   - Los de las últimas dos semanas ya están en `/data/respaldos/`.
   - Uno que llegó por correo hay que subirlo, desde **Git Bash** (no PowerShell 5.1: la redirección cambia los bytes):
     `export MSYS_NO_PATHCONV=1` y después `railway ssh -- sh -c 'cat > /data/respaldos/subido.sqlite.gz' < rondas-AAAA-MM-DD.sqlite.gz`
     y comprobar que llegó entero: `railway ssh -- ls -l /data/respaldos/` (el tamaño tiene que ser el del archivo original).
2. Validarlo en seco (no toca nada, muestra conteos y la fecha de la última ronda):
   `railway ssh -- node scripts/restaurar-respaldo.js /data/respaldos/rondas-AAAA-MM-DD.sqlite`
3. Dejarlo listo: el mismo comando con `--aplicar`.
4. **Reiniciar el servicio** en Railway (Restart). El log de arranque dice `RESTAURADO` y los conteos nuevos.
5. Lo que se registró entre la fecha del respaldo y ahora queda en la base apartada (`.antes-restaurar-…`), por si hay que rescatar algo a mano.

En local es lo mismo sin `railway ssh --`, con el servidor detenido o reiniciándolo después.

### Vuelta atrás a la v1.16 (si la v1.17 falla en producción)

1. Exportar la base a un `db.json` con la forma que lee la v1.16:
   `railway ssh -- node scripts/exportar-json.js`
   (escribe `/data/db.json`; si ya existe uno, pide `--forzar`). Hacerlo **justo antes** de redesplegar: lo que se escriba después no queda en el `.json`.
2. Redesplegar el deploy anterior (v1.16) en Railway, con `DB_PATH=/data/db.json`.
3. **Antes de volver a la v1.17 más adelante**: apartar la base SQLite (`railway ssh -- mv /data/rondas.sqlite /data/rondas.sqlite.viejo`, junto con sus `-wal` y `-shm` si están). Si no, la v1.17 sigue con la base SQLite (ya tiene versión, no reimporta) y lo que la v1.16 haya escrito en el `db.json` queda fuera.

### Scripts de mantenimiento con el servidor andando

`purga-demo.js --aplicar` y `migracion-rsf.js` escriben la configuración (usuarios, condominios…) directo en la base. El servidor que está corriendo tiene su copia en memoria y podría volver a escribir la versión vieja en su próximo guardado. **Después de aplicar uno de esos scripts, reiniciar el servicio.** `exportar-json.js`, `respaldo-ahora.js` y `restaurar-respaldo.js` (que solo deja el respaldo pendiente) no tienen ese problema.

## Limitaciones conocidas de la v1 (transparencia con el cliente)

- **QR fotografiado**: un guardia podría escanear una foto del QR sin ir al punto. Mitigación desde la v1.9: **el GPS bloquea la marca** — con la ubicación del punto fijada, marcar a más de 20 m o con la ubicación apagada simplemente no se puede. En los puntos bajo techo la v1.10 exige haber pasado por la entrada del recinto (más débil, pero obliga a caminar hasta el edificio). Huecos conocidos: en un punto anclado el guardia puede escanear la foto desde la entrada sin bajar, y el GPS del teléfono puede falsearse con apps de mock location (requiere root). Si un condominio exige cerrar eso, desde la v1.24 el punto puede llevar una **chapita NFC** (ver arriba).
- **Hora offline**: las marcas sin señal usan el reloj del teléfono y quedan etiquetadas "(offline)" en el informe.
- El login inicial del guardia requiere conexión; después la ronda es 100 % offline.

## Solución de problemas rápidos

| Síntoma | Causa probable | Solución |
|---|---|---|
| "La cámara no abre" | Sin permiso o sin HTTPS | Dar permiso en Chrome; usar entrada manual mientras |
| "Ese código no corresponde…" | QR de otro condominio o punto fuera de la ronda | Verificar que la lámina pegada sea la del sector correcto |
| Guardia sin acceso | PIN olvidado | Panel → Guardias → "Nuevo PIN" |
| No llegan avisos push al teléfono | Permiso de notificaciones denegado o claves VAPID sin configurar | Panel → Avisos → "Activar avisos en este teléfono"; en iPhone hay que instalar el panel primero |
| Guardia debe reingresar el PIN a mitad de ronda | Desde la v1.25 no debería pasar: la sesión dura 1 h 30 desde la última actividad de ronda (iniciar, marcar, terminar), no desde el login. Pasa si estuvo más de 1 h 30 sin marcar nada | Las marcas NO se pierden: quedan en el teléfono y se envían al volver a entrar |
| En un teléfono compartido, entra otro guardia y lo pendiente del anterior "desaparece" | Desde la v1.25 queda **guardado aparte** con el nombre de su dueño (el servidor solo acepta los datos de una ronda con la sesión de quien la hizo) | Se envía solo cuando ese guardia vuelve a entrar en ese teléfono. Si no vuelve, el servidor cierra su ronda por abandonada con lo que alcanzó a llegar |
| Ronda quedó "En curso" | Guardia no cerró | Se cierra sola: a los 15 min de la última marca si tiene todos los puntos (`RONDA_COMPLETA_CIERRE_MIN`), a las 2 h si le faltan (`RONDA_ABANDONO_MIN`). Para no esperar: Panel → Informes → "Cerrar" |
| Aviso "el guardia marcó todos los puntos pero no tocó «Terminar ronda»" | El guardia hizo la ronda entera y no la terminó | La ronda cuenta completa. Recordarle al guardia que, al marcar el último punto, aparece «✅ Marcaste todos los puntos» y el botón grande «Terminar ronda»: hay que tocarlo |
| El servidor no arranca y el log dice "No se pudo importar … db.json" | El `db.json` está roto o sus conteos no cuadraron al importarlo (primer arranque de la v1.17) | No se perdió nada: el `.json` sigue intacto. Revisar el motivo en el log; si no se resuelve, volver a la v1.16 (sección **Vuelta atrás**) |
| El panel muestra solo las últimas 200 rondas | Desde la v1.17 el listado trae las últimas 200 | Para fechas anteriores, el informe semanal por rango de fechas |
| No llega el correo del respaldo | `RESPALDO_TO` vacío, Gmail sin configurar, o respaldo sobre 18 MB | Mirar las líneas `[respaldo]` del log; probar con `node scripts/respaldo-ahora.js` |
