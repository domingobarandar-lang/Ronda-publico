# OPERACIÓN — Rondas QR

Guía de administración y operación. Público: José (soporte) y el administrador del condominio (uso diario).

## Uso diario del administrador (panel web)

Todo se hace en `https://<servidor>/panel` con su usuario y PIN. Es una app aparte de la del guardia: conviene **instalarla** (botón "📲 Instalar el panel" en la pantalla de entrada, o Compartir → Añadir a pantalla de inicio en iPhone/iPad) o guardar esa dirección en favoritos. La app del guardia (`https://<servidor>/`) no da acceso al panel.

- **Informes**: cada ronda cerrada aparece al instante con su estado. "Ver informe" abre el detalle imprimible. Si un guardia dejó una ronda abierta (se le olvidó cerrar), el botón **Cerrar** la cierra y evalúa con lo marcado hasta ese momento.
- **Puntos**: agregar/renombrar/eliminar sectores. Tras cualquier cambio, reimprimir la **hoja de QR** y pegar la lámina nueva. El código de 6 letras bajo cada QR es el respaldo para entrada manual.
- **Verificación GPS de cada punto**: se hace **una sola vez, caminando la ronda con un teléfono** el día de la instalación. Hay dos botones y la elección depende de si el GPS llega o no a ese punto:
  - **📍 Fijar aquí** — puntos al aire libre (perímetro, patios, esquinas, superficie). Párate **encima del punto** y aprieta. Desde ese momento el guardia no puede marcarlo si está a más de **20 m** o si no tiene señal: la app le dice a cuántos metros está y no registra nada.
  - **🏠 Fijar entrada** — puntos **bajo techo**: subterráneos, salas de calderas, grupos electrógenos, interiores de torre. Ahí el GPS no llega y los 20 m son imposibles de cumplir. Párate en **la puerta del recinto, o en el último lugar del recorrido donde el teléfono todavía tiene señal** (la rampa de bajada, por ejemplo) y aprieta. El guardia podrá marcar ese punto si pasó por esa entrada en los **últimos 15 min**, dentro de **40 m**. No tiene que hacer nada especial: el teléfono ya guardó la señal al pasar.
  - **Ajustar** cambia el radio y los minutos de un punto puntual, sin tocar el resto. **Quitar 📍** deja el punto sin verificación (se marca como antes).
  - ⚠️ Fijar **desde el lugar**, no desde la oficina: si se aprieta cualquiera de los dos botones en la caseta, esa queda como la ubicación de referencia y la verificación queda inservible.
  - Lo que hay que saber del anclaje: prueba que el guardia **pasó por la entrada**, no que entró al recinto. Es más débil que la verificación exacta y el informe lo marca como "📍 por entrada". Si el condominio necesita prueba de que entró, eso requiere NFC (ver SEGURIDAD.md).
  - Si en terreno aparecen rechazos legítimos (teléfonos con ±30-40 m de precisión junto a muros), subir `GPS_RADIO_M` —o el radio del punto con "Ajustar"— antes de apagar el bloqueo con `GPS_BLOQUEA=0`. No requiere volver a desplegar la app del guardia.
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
- Un servidor sirve a **varios condominios** a la vez (aislados entre sí). Los condominios y sus administradores se crean hoy por seed/soporte (no hay superadmin web en la v1 — decisión de alcance).
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
