# OPERACIÓN — Rondas QR

Guía de administración y operación. Público: José (soporte) y el administrador del condominio (uso diario).

## Alta de un condominio nuevo (pantalla de fábrica)

Los condominios se crean desde `https://<servidor>/fabrica`, con la cuenta de la operación. Esa dirección **no está enlazada** desde ninguna parte de la app: hay que escribirla.

**Una sola vez**, en las variables del servidor: `FABRICA_USUARIO` y `FABRICA_PIN` (8 dígitos). La cuenta se crea sola en el primer arranque. Si se pierde el PIN, se cambia esa variable y se reinicia.

El modelo es: **el panel lo opera solo la operación**, con **una** cuenta de administrador que recorre todos los condominios con el selector de la barra. Los administradores de los condominios **no entran a la app**: reciben el informe semanal por correo. Por eso el alta no crea cuentas de panel.

**Por cada condominio nuevo:**

1. Entrar a `/fabrica` con la cuenta de la operación.
2. **Dar de alta un condominio**: nombre y el correo (o correos) a los que va el informe semanal. Crear. Queda el **código de registro** para sus guardias, generado solo.
3. Entrar al `/panel` con la cuenta de la operación y **elegir el condominio nuevo en el selector**. Crear los puntos (con **📍 Fijar aquí** / **🏠 Fijar entrada**, caminando el recorrido), armar la ronda e imprimir la hoja de QR.
4. Entregar el **código de registro** al administrador o al jefe de turno para que los guardias creen su cuenta solos desde la app del guardia.
5. Probar el correo con **"Enviar informe de prueba"** en la ficha del condominio, antes de esperar al lunes.

Eso es todo: el condominio queda andando sin que nadie más tenga acceso al panel, y el lunes a las 8 su administrador recibe el informe.

**Si un administrador tiene varios condominios**, se pone **el mismo correo en cada uno** y el lunes recibe **un solo correo** con un informe adjunto por condominio.

**Si algún cliente sí va a operar su propio panel** (excepción): en el alta se abre el bloque "Darle además una cuenta de panel al cliente", o se agrega después desde su ficha. Antes de hacerlo hay que entender el costo: desde la v1.12 **cualquier cuenta de panel ve todos los condominios**, no solo el suyo. Mientras eso no se restrinja, una cuenta entregada a un cliente le abre la información del resto.

Desde la ficha de cada condominio, la fábrica también: cambia los correos del informe, cambia el PIN de una cuenta de panel (le cierra las sesiones abiertas) y **quita** cuentas de panel que ya no correspondan (no deja borrar la última, o nadie podría entrar). La lista avisa cuando hay más de una cuenta dando vueltas.

> **Cuentas heredadas**: las cuentas de las demos y de las migraciones anteriores (`admin`/1234, `marta`, `carmen`, `admin-piloto`/1234) eran inofensivas cuando cada una veía solo su condominio. Desde la v1.12 **cada una abre todos**. En producción hay que dejar solo la de la operación —con PIN de 8 dígitos— y quitar el resto desde la fábrica.

> El login admite 10 intentos fallidos por usuario e IP y después bloquea 15 minutos. Aun así, la cuenta de fábrica es la llave maestra: PIN de 8 dígitos y no se comparte.

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
- **Guardias**: crear usuario + PIN (4-8 dígitos). "Nuevo PIN" si se le olvidó. Eliminar corta el acceso de inmediato.
- **Rondas**: armar la secuencia tocando los puntos en orden. "El orden importa" hace que marcar desordenado quede como observación. La duración máxima genera observación si se excede. Los guardias ven los cambios al tocar "Actualizar rondas".
- **Avisos**: historial de notificaciones enviadas.

## Guardias: instalación en el teléfono

1. Abrir `https://<servidor>/` en Chrome (Android) → menú → **"Agregar a pantalla de inicio"**. Queda como app.
2. Entrar con usuario y PIN **con conexión** (wifi de portería basta). Después la ronda funciona sin señal.
3. La cámara requiere **HTTPS** (o localhost). En producción el servidor ya va con HTTPS; si algún teléfono no da permiso de cámara, siempre está la entrada manual.

## Activar avisos por Telegram (opcional, 5 minutos)

1. En el servidor: editar `.env` → `MOCK=false` (el token del bot ya viene configurado). Reiniciar.
2. El administrador le escribe `/start` al bot del condominio en Telegram.
3. Obtener su `chat_id` (visitar `https://api.telegram.org/bot<TOKEN>/getUpdates` tras el /start y copiar `message.chat.id`).
4. Pegarlo en el panel → pestaña **Avisos** → guardar. Desde ahí, cada informe llega al Telegram del administrador.

Mientras `MOCK=true`, los avisos quedan solo en el panel — útil para demos y para operar sin Telegram.

## Deploy a producción (cuando José apruebe)

- **Railway** (o VPS): `npm install && npm start`, variable `PORT` la pone la plataforma. Railway da HTTPS solo — necesario para la cámara. Costo estimado: plan chico (~US$5/mes). **Runtime sin LLM: el uso diario cuesta $0 en APIs.**
- Un servidor sirve a **varios condominios** a la vez. Se dan de alta desde la pantalla de fábrica (ver arriba): no hace falta desplegar nada por cada condominio nuevo. Requiere `FABRICA_USUARIO` y `FABRICA_PIN` en las variables del servicio.
- **Desde v1.12 el aislamiento es solo del lado del guardia**: cada guardia ve únicamente las rondas y los QR de su condominio, pero **cualquier cuenta de administrador ve todos los condominios** (selector en la barra del panel). Es una decisión tomada para poder fijar las ubicaciones de los puntos condominio por condominio con una sola cuenta. Mientras los condominios sean de la operación no hay problema; **antes de entregarle el panel a un cliente externo** hay que volver a cerrar esto (restringirlo a un rol de operación).
- **Respaldo**: copiar `data/db.json` (todo el estado vive ahí). Basta un respaldo diario.
- **Escala**: con más de ~3 condominios activos o mucho historial, migrar `lib/store.js` a SQLite/Postgres (es el único módulo que toca disco; el resto del código no cambia).

## Limitaciones conocidas de la v1 (transparencia con el cliente)

- **QR fotografiado**: un guardia podría escanear una foto del QR sin ir al punto. Mitigación desde la v1.9: **el GPS bloquea la marca** — con la ubicación del punto fijada, marcar a más de 20 m o con la ubicación apagada simplemente no se puede. En los puntos bajo techo la v1.10 exige haber pasado por la entrada del recinto (más débil, pero obliga a caminar hasta el edificio). Huecos conocidos: en un punto anclado el guardia puede escanear la foto desde la entrada sin bajar, y el GPS del teléfono puede falsearse con apps de mock location (requiere root). Si un condominio exige cerrar eso, la v2 contempla NFC físico.
- **Hora offline**: las marcas sin señal usan el reloj del teléfono y quedan etiquetadas "(offline)" en el informe.
- El login inicial del guardia requiere conexión; después la ronda es 100 % offline.

## Solución de problemas rápidos

| Síntoma | Causa probable | Solución |
|---|---|---|
| "La cámara no abre" | Sin permiso o sin HTTPS | Dar permiso en Chrome; usar entrada manual mientras |
| "Ese código no corresponde…" | QR de otro condominio o punto fuera de la ronda | Verificar que la lámina pegada sea la del sector correcto |
| Guardia sin acceso | PIN olvidado | Panel → Guardias → "Nuevo PIN" |
| No llegan avisos a Telegram | `MOCK=true`, chat_id vacío o token inválido | Revisar los 4 pasos de activación; el error exacto queda en Avisos |
| Ronda quedó "En curso" | Guardia no cerró | Panel → Informes → "Cerrar" |
