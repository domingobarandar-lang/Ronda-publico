# PRUEBAS-NFC — cómo probar las chapitas antes de instalarlas en un condominio

Las pruebas automáticas (`npm test`) y la simulación cubren la lógica: qué abre «Escanear», qué se acepta y qué se rechaza, la cola sin señal, el informe. Lo que **no** cubren es el mundo físico: la antena de cada teléfono, la carcasa, el metal, el guardia apurado a las 3 AM. Esta guía va de lo que se puede probar hoy sin nada a lo que necesita chapitas reales.

## 1. Hoy, sin chapitas ni teléfono con NFC (en el computador)

1. `cd app && npm test` — 300+ pruebas, incluidas `test/chapita-nfc.test.js` (servidor), `test/app-nfc.test.js` (app con un lector simulado) y `test/compat-qr.test.js`, que comprueba que un condominio de puros QR ve exactamente lo mismo que con la v1.22.0 (respuestas, avisos, informes, informe semanal, hoja de QR y la app del guardia).
2. `node scripts/probar-nfc-simulado.js` (necesita Playwright) — levanta una demo, graba una chapita de mentira desde el panel y la marca desde la app del guardia en Chromium. Revisa que la foto del QR, el código a mano y una chapita copiada se rechacen, y que la chapita verdadera marque y llegue al servidor. Deja capturas de pantalla.

## 2. Con el teléfono, todavía sin chapitas

Sirve para saber si el teléfono sirve, antes de comprar nada.

1. **¿Tiene NFC?** Ajustes → buscar «NFC». Si no aparece, ese teléfono no tiene (el Redmi A7 Pro viene en una variante sin NFC). Un teléfono sin NFC no puede marcar puntos con chapita.
2. **¿Lee algo?** Abrir la app del guardia en **Chrome** (no en Fully), iniciar una ronda de prueba que tenga un punto con chapita y tocar «Escanear». Acercar **cualquier tarjeta sin contacto**: la tarjeta bip!, una tarjeta bancaria con el símbolo de pago sin contacto, una credencial de oficina. La app debería decir «Esa chapita no es de Rondas QR» o «No se pudo leer la chapita». **Cualquiera de los dos prueba que la antena y el permiso funcionan.** De paso se aprende dónde tiene la antena ese teléfono (centro de la espalda, arriba, junto a la cámara).
3. **Los mensajes de error**, uno por uno:
   - NFC apagado en Ajustes → la app tiene que decir que está apagado y ofrecer Reintentar.
   - Negar el permiso la primera vez → la app tiene que decir cómo darlo (candado junto a la dirección → Permisos → NFC).
   - La misma app en Fully Kiosk o en un iPhone → «Este teléfono todavía no lee chapitas NFC».
   - Anotar el texto exacto que sale en cada caso: los nombres de error de Web NFC se tomaron de las pruebas oficiales del estándar y hay que confirmarlos en un teléfono real (sobre todo «NFC apagado»).

## 3. Con chapitas de prueba (un paquete de stickers NTAG213)

Comprar un paquete chico de stickers **NTAG213** (no «NTAG215/216» ni «MIFARE Classic», que son otra cosa). El panel graba **sin bloquear**: así una misma chapita sirve para probar muchas veces. No toques «🔒 Bloquear chapita» en las chapitas de prueba que quieras reusar.

1. En un condominio de prueba, crear un punto «con chapita NFC», grabarla desde el panel y marcarla con la app.
2. **Sin señal:** activar modo avión (en la mayoría de los Android el NFC sigue encendido; si no, volver a activarlo en Ajustes), marcar la chapita y volver a encender los datos: la marca tiene que llegar sola.
3. **Copia:** con una app como «NFC Tools», copiar el contenido de la chapita a otro sticker y marcar con la copia: la app tiene que rechazarla («no es la registrada»).
4. **Foto del QR:** imprimir la hoja de QR antigua de ese punto y escanearla: tiene que rechazarla.
5. **Código a mano:** tipear el código del punto: tiene que rechazarlo.
6. **«La chapita no lee»:** tocarlo, terminar la ronda y revisar en el panel que el informe diga «El guardia avisó que la chapita no leyó en …» y que el punto salga faltante.
7. **Reemplazo:** reemplazar la chapita en el panel con otro sticker. En el teléfono del guardia **sin** tocar «Actualizar rondas», marcar con la chapita nueva: la app la va a rechazar porque tiene la información vieja. Tocar «Actualizar rondas» y volver a marcar: tiene que entrar. → Regla de operación: después de reemplazar una chapita, los guardias actualizan rondas.
8. **Bloqueo:** con un sticker que se pueda gastar, grabarlo, tocar «🔒 Bloquear chapita» y acercar **otra** chapita: no debe bloquear y tiene que decir por qué. Después acercar la correcta: queda bloqueada. Intentar regrabarla con «NFC Tools»: no debe dejar.
9. **Reusar en otro condominio:** grabar una chapita (sin bloquear) en un punto de un condominio de prueba, «Volver a QR» ahí, y grabarla en un punto de otro condominio: el panel avisa que trae otro punto y la graba encima. Sin el «Volver a QR» primero, tiene que negarse («ya pertenece a un punto de otro condominio»).

## 4. Situaciones de todos los días que solo se ven en terreno

| Situación | Qué pasa | Qué hacer / cómo probarlo |
|---|---|---|
| **Chapita pegada sobre metal** (puerta metálica, tablero eléctrico, caja de medidores, baranda) | Un NTAG213 común **no lee** o lee a 2 mm: el metal se come la señal. Es la causa número uno de chapitas «que no funcionan». | Usar stickers **anti-metal** (con capa de ferrita), o separar la chapita del metal con la carcasa (al menos 5–10 mm de plástico). Probar cada punto metálico antes de dejarlo instalado. |
| **Carcasa** | Plástico común de 1,2 mm no molesta. Plástico con carga metálica, pintura metálica o un tornillo justo detrás sí. | Grabar y leer con la chapita ya dentro de la carcasa y la carcasa ya pegada en su lugar. |
| **Funda del teléfono** | Fundas gruesas, con placa metálica para soporte magnético, con anillo o con tarjetas guardadas atrás bloquean o confunden la lectura. | Probar con la funda que usa el guardia. Sacar las tarjetas de la funda. |
| **Dónde está la antena** | Cambia por modelo (centro, arriba, cerca de la cámara). El guardia acerca la parte equivocada y «no lee». | En la inducción, mostrar a cada guardia dónde está la antena de SU teléfono (prueba 2). |
| **Guardia apurado** | Si retira el teléfono antes de 1 segundo, la lectura queda a medias: «No se pudo leer la chapita». | Enseñar: apoyar y esperar la vibración. |
| **Pantalla apagada o app en segundo plano** | Web NFC solo lee con la app **visible y el teléfono desbloqueado**. | La app ya mantiene la pantalla encendida durante la ronda. Probar con el bloqueo automático del teléfono configurado. |
| **NFC apagado** (ahorro de batería, alguien lo apagó, después de reiniciar) | La app avisa «El NFC del teléfono está apagado». | Probar reiniciando el teléfono y con el modo ahorro de batería activado. |
| **Chapita dañada** (golpe, raspado, agua, sol directo en verano, frío, limpieza con químicos) | Deja de leer, a veces de a poco (lee solo si se acerca muy bien). | «La chapita no lee» avisa al administrador. Revisar el informe semanal: un punto con avisos repetidos es una chapita por cambiar. Pintura no metálica sobre la carcasa no molesta. |
| **Vandalismo / chapita despegada** | El guardia no tiene qué leer. | Mismo camino: «La chapita no lee» y reemplazo. Mientras, «Volver a QR» si va a tardar. |
| **Dos chapitas muy juntas** (dos puntos en la misma pared) | Puede leer la equivocada. | Separarlas al menos 10–15 cm. |
| **Ronda mixta sin orden: el guardia elige mal** («Un QR» frente a una chapita) | Se abre la cámara y no hay QR que leer. | Cancelar y elegir «Una chapita». Si se repite mucho, conviene poner esa ronda con orden. |
| **Punto bajo techo con ubicación GPS fijada** | La marca se rechaza por falta de señal GPS, aunque la chapita lea bien. | A los puntos con chapita bajo techo **no** se les fija ubicación (Quitar 📍). |
| **Teléfono sin NFC, iPhone o Fully Kiosk** | No puede marcar puntos con chapita. | Los guardias de condominios con chapitas necesitan Android con NFC y la app en Chrome (alternativas a Fully en `FULLY-KIOSK.md`). |
| **Grabación interrumpida** (se movió el teléfono, sonó una llamada) | La verificación falla y el punto queda como estaba. | Reintentar. Si la chapita quedó bloqueada con un texto equivocado (raro), ya no sirve: usar otra. |
| **Chapita reemplazada con guardias sin señal** | El teléfono rechaza la chapita nueva hasta que actualiza rondas. | Prueba 7 de arriba. |

## 5. Piloto antes de vender

Un condominio, 2 o 3 puntos con chapita (al menos uno bajo techo y uno cerca de metal), una semana. Al final, en el panel: cuántas marcas 📶 NFC entraron y cuántos «La chapita no lee» hubo (Informes → cada ronda), y preguntarle a los guardias qué rechazos vieron. Los rechazos quedan guardados en cada ronda en el servidor, pero el panel todavía no los muestra: se pueden revisar con `scripts/exportar-json.js`. Si un punto acumula rechazos o avisos, es un problema de instalación (metal, altura, carcasa), no del guardia.
