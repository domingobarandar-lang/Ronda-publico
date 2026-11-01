# PRUEBAS-NFC — cómo probar las chapitas antes de instalarlas en un condominio

Las pruebas automáticas (`npm test`) y la simulación cubren la lógica: qué abre «Escanear», qué se acepta y qué se rechaza, la cola sin señal, el informe. Lo que **no** cubren es el mundo físico: la antena de cada teléfono, la carcasa, el metal, el guardia apurado a las 3 AM. Esta guía va de lo que se puede probar hoy sin nada a lo que necesita chapitas reales.

## 1. Hoy, sin chapitas ni teléfono con NFC (en el computador)

1. `cd app && npm test` — 300+ pruebas, incluidas `test/chapita-nfc.test.js` (servidor), `test/app-nfc.test.js` (app con un lector simulado) y `test/compat-qr.test.js`, que comprueba que un condominio de puros QR ve exactamente lo mismo que con la v1.22.0 (respuestas, avisos, informes, informe semanal, hoja de QR y la app del guardia).
2. `node scripts/probar-nfc-simulado.js` (necesita Playwright) — levanta una demo, graba una chapita de mentira desde el panel y la marca desde la app del guardia en Chromium. Revisa que la foto del QR, el código a mano y una chapita copiada se rechacen, que la chapita verdadera marque y llegue al servidor, y (v1.25.1) que el lector siga escuchando después de leer y después de un rechazo, que la chapita lleve primero el enlace a la app, que la app abierta por ese enlace lo diga, y que dos pestañas de la app no se pisen. Deja capturas de pantalla.
3. `node scripts/probar-sesion-ronda.js` (necesita Playwright) — la ronda que no se pierde (v1.25.1): teléfono apagado y prendido con y sin señal, sesión vencida a mitad de la ronda, otro guardia en el mismo teléfono y Chrome borrando los datos. Ver §6.

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
| **Pantalla apagada o app en segundo plano** | Web NFC solo lee con la app **visible y el teléfono desbloqueado**. Con la app en segundo plano, la chapita la recibe Android (ver §5). | La app ya mantiene la pantalla encendida durante la ronda. Probar con el bloqueo automático del teléfono configurado. |
| **NFC apagado** (ahorro de batería, alguien lo apagó, después de reiniciar) | La app avisa «El NFC del teléfono está apagado». | Probar reiniciando el teléfono y con el modo ahorro de batería activado. |
| **Chapita dañada** (golpe, raspado, agua, sol directo en verano, frío, limpieza con químicos) | Deja de leer, a veces de a poco (lee solo si se acerca muy bien). | «La chapita no lee» avisa al administrador. Revisar el informe semanal: un punto con avisos repetidos es una chapita por cambiar. Pintura no metálica sobre la carcasa no molesta. |
| **Vandalismo / chapita despegada** | El guardia no tiene qué leer. | Mismo camino: «La chapita no lee» y reemplazo. Mientras, «Volver a QR» si va a tardar. |
| **Dos chapitas muy juntas** (dos puntos en la misma pared) | Puede leer la equivocada. | Separarlas al menos 10–15 cm. |
| **Ronda mixta sin orden: el guardia elige mal** («Un QR» frente a una chapita) | Se abre la cámara y no hay QR que leer. | Cancelar y elegir «Una chapita». Si se repite mucho, conviene poner esa ronda con orden. |
| **Punto bajo techo con ubicación GPS fijada** | La marca se rechaza por falta de señal GPS, aunque la chapita lea bien. | A los puntos con chapita bajo techo **no** se les fija ubicación (Quitar 📍). |
| **Teléfono sin NFC, iPhone o Fully Kiosk** | No puede marcar puntos con chapita. | Los guardias de condominios con chapitas necesitan Android con NFC y la app en Chrome (alternativas a Fully en `FULLY-KIOSK.md`). |
| **Grabación interrumpida** (se movió el teléfono, sonó una llamada) | La verificación falla y el punto queda como estaba. | Reintentar. Si la chapita quedó bloqueada con un texto equivocado (raro), ya no sirve: usar otra. |
| **Chapita reemplazada con guardias sin señal** | El teléfono rechaza la chapita nueva hasta que actualiza rondas. | Prueba 7 de arriba. |

## 5. «Se abrió una pantalla en blanco y me sacó de la app» (v1.25.1)

**Qué pasaba.** Android le entrega cada chapita a la app que la tiene «tomada» en ese momento. Hasta la v1.25.0 la app del guardia la tomaba **solo** mientras estaba abierta la pantalla «Acerca la parte trasera del teléfono…», y la soltaba **apenas leía**, con la chapita todavía pegada al teléfono. Si nadie la tiene tomada, Android hace lo suyo. Como la chapita solo traía texto, abría su pantalla de etiquetas («Nueva etiqueta», «Etiqueta NFC»), una app como NFC Tools o una ventana casi vacía con el texto `RQR:…`, que tapa la app. Esa es la «pantalla en blanco».

**Qué cambió (dos partes que se complementan):**
1. **Con la app abierta, la chapita es de la app.** En un condominio con chapitas, el lector se enciende con el primer toque (el «Iniciar» de una ronda con chapitas, o «Escanear») y queda **escuchando mientras la app esté a la vista**: no se apaga al leer, al rechazar ni al cancelar. Una chapita acercada en cualquier parte de la ronda (lista de puntos, cámara abierta, pregunta «¿Qué hay en este punto?») marca igual que desde su pantalla, con las mismas reglas. En el inicio o en el resumen final dice «Para marcar la chapita, primero inicia la ronda». Con el permiso de NFC ya dado, el lector se vuelve a encender solo al abrir la app o al volver a ella.
2. **Con la app cerrada o en segundo plano, la chapita abre la app.** El panel graba ahora **dos cosas** en la chapita: primero un **enlace a la app** (`https://<servidor>/#nfc`) y después el código de siempre (`RQR:…`). Android decide qué abrir mirando lo primero: en vez de la pantalla en blanco, abre la app del guardia (la app instalada si está instalada; si no, Chrome). La app dice «Abriste la app con la chapita: acércala otra vez para marcar el punto». **Esa primera lectura no marca:** desde un enlace no se puede leer el número de serie de la chapita, que es lo que el servidor exige. Hay que acercarla otra vez, ya con la app abierta.

**Compatibilidad:** las chapitas grabadas antes (solo texto) siguen marcando igual; solo no traen el enlace. La app de antes (v1.24) también lee las chapitas nuevas: busca el registro de texto, esté donde esté. Los QR no cambian. Condominio Piloto (puros QR) no enciende el lector ni pide el permiso de NFC. Si la dirección del servidor es tan larga que el enlace no cabe en la chapita (una NTAG213 guarda unos 137 bytes), el panel graba solo el texto, como antes, y lo dice.

**Regrabar la chapita de prueba** (la que no está bloqueada) para que lleve el enlace: en el teléfono Android, Chrome → `/panel` **con la misma dirección que usan los guardias** (el enlace se graba con la dirección desde donde se abrió el panel) → Puntos → en su punto, **«📶 Reemplazar chapita»** → Empezar → acercarla → alejar y acercar para verificar. Al final el panel dice «Lleva el enlace a la app». La serie es la misma, así que los guardias no necesitan actualizar rondas. Una chapita **bloqueada** no se puede regrabar: si se quiere el enlace, va una chapita nueva.

**Lo que la app todavía no puede evitar:**
- Con la **pantalla apagada**, la mayoría de los teléfonos ni siquiera lee NFC. Con el teléfono **bloqueado**, algunos piden desbloquear antes de abrir el enlace.
- Si la app estaba en una **pestaña de Chrome** (no instalada), el enlace puede abrir **otra pestaña** de la app. Las dos pestañas se ponen de acuerdo solas: lo que marca una lo toma la otra, y ninguna borra lo de la otra. Igual conviene **instalar la app** («📲 Instalar la app en este equipo»): así el enlace abre la app instalada.
- Una app de NFC instalada en el teléfono (NFC Tools u otra) puede adelantarse a Chrome. Si pasa, desinstalarla o quitarle «Abrir por defecto».

**Cómo probarlo en el teléfono** (Android con NFC, la app en Chrome o instalada desde Chrome, y la chapita de prueba **regrabada** como se explica arriba):

1. Comprobar la versión: el pie del login dice «Versión 1.25.1». Si no, cerrar y abrir la app con señal.
2. **Con la app abierta:**
   - Iniciar la ronda. La primera vez Chrome pide permiso de NFC al tocar «Iniciar»: Permitir.
   - **Sin tocar «Escanear»**, acercar la chapita del próximo punto: tiene que vibrar y marcar, sin que se abra nada más.
   - Tocar «Escanear», acercar la chapita y **dejar el teléfono apoyado 10 segundos** después de la vibración: no se abre nada. Si se aleja y se vuelve a acercar, dice «ya estaba marcado».
   - Acercar una chapita **equivocada** y en seguida la correcta, sin tocar nada entre medio: la primera se rechaza y la segunda marca.
   - Abrir la cámara («Escanear» en un punto de QR, o «Un QR» en la pregunta) y acercar la chapita: se cierra la cámara y la chapita marca.
   - En el inicio (sin ronda) acercar la chapita: «Para marcar la chapita, primero inicia la ronda», sin salir de la app.
3. **Con la app cerrada o en segundo plano:**
   - Con una ronda en curso, ir a la pantalla de inicio del teléfono y acercar la chapita: **tiene que abrirse la app** (no una pantalla en blanco) con «Abriste la app con la chapita…». Acercarla otra vez: marca.
   - Cerrar la app del todo (deslizarla en «Recientes») y acercar la chapita: se abre la app en la ronda; acercarla otra vez y marca.
   - Si la app no está instalada (solo una pestaña de Chrome): lo mismo; si se abrió otra pestaña, marcar en ella y volver a la pestaña anterior: tiene que mostrar la misma marca.
   - Con una chapita **vieja** (sin regrabar), lo mismo: ahí todavía se abre la pantalla de Android. Es lo esperado, y es lo que arregla regrabarla.
4. En un teléfono de **Condominio Piloto** (puros QR): todo igual que antes; Chrome **nunca** pide permiso de NFC.

Si con la app abierta se abre otra cosa, o con la app cerrada no se abre la app, anotar modelo, versión de Android, si la app estaba instalada y qué se abrió.

**Lo que no se hizo:** una app nativa (o Fully con su lector NFC) es lo único que podría **marcar** con la app cerrada, leyendo la serie en segundo plano. Queda para cuando se decida lo de Fully (`FULLY-KIOSK.md`).

## 6. Una ronda empezada no se pierde: apagado, sesión vencida, Chrome borra datos (v1.25.1)

La v1.25.0 ya resolvió dos partes: la sesión dura 1:30 h **desde la última marca** (no desde el login), y en el teléfono compartido lo pendiente de un guardia queda **guardado aparte** cuando entra otro, y vuelve cuando él entra de nuevo. La v1.25.1 agrega:

- **Sesión vencida a mitad de la ronda** (por ejemplo, el guardia dejó la ronda a medias más de 1:30 h). Hasta la v1.25.0, la marca siguiente al primer envío rechazado mandaba al **login**, y sin señal (un subterráneo) no se podía entrar: la ronda quedaba trabada. Ahora **no saca de la ronda**: arriba aparece «Tu sesión venció. La ronda sigue…» con **«Entrar de nuevo»**. Se puede seguir marcando y terminar la ronda. Lo marcado queda en el teléfono y se envía al volver a entrar (desde el login se puede «← Volver sin entrar»).
- **Salir con marcas sin enviar** ya no las borra («¿Salir igual?»): quedan guardadas aparte a nombre del guardia y vuelven cuando entra de nuevo.
- **Chrome borró los datos** (o cambio de teléfono): al entrar, la app le pregunta al servidor si el guardia tiene una ronda abierta y la retoma con las marcas que ya habían llegado. Lo que estaba **sin enviar** cuando se borraron los datos se pierde: eso no lo puede arreglar nadie.

**Cómo probarlo en el teléfono** (Chrome o la app instalada, sin Fully, un condominio de prueba). Para la sesión vencida hay que dejar pasar 1:30 h sin marcar. Para no esperar, en un servidor **de prueba** (nunca en producción) se puede bajar `VIDA_SESION_MS` en `app/lib/auth.js` a unos minutos:

1. **Apagado sin señal:** iniciar una ronda, marcar 2 puntos, poner modo avión, marcar 1 más, **apagar el teléfono**. Prenderlo, todavía en modo avión, y abrir la app: tiene que estar en la ronda con 3 marcas y «1 por enviar». Quitar el modo avión: se envía sola.
2. **Reinicio con señal:** igual, pero con «Reiniciar». La app vuelve a la ronda.
3. **Sesión vencida con señal:** con una ronda en curso, dejar que venza la sesión y marcar con señal. Tiene que aparecer el aviso arriba, y la ronda sigue. Marcar el resto y «Terminar ronda». Tocar «Entrar de nuevo» y entrar: el informe llega al panel con todas las marcas.
4. **Sesión vencida sin señal:** como el 3, pero marcando en modo avión. La app nunca tiene que mandar al login. Al volver la señal aparece el aviso; seguir hasta terminar.
5. **Otro guardia** (ya en la v1.25.0): con la ronda de A a medias y su sesión vencida, tocar «Entrar de nuevo» y entrar como B. B ve su inicio limpio y el aviso de que lo de A quedó guardado aparte. B hace una ronda completa y sale. A entra: retoma su ronda donde quedó y la termina. En el panel tienen que quedar dos rondas separadas, cada una con su guardia y todas sus marcas.
6. **Chrome borra los datos:** con una ronda en curso y todo enviado, en Chrome: candado → Configuración del sitio → **Borrar datos** (o Ajustes → Apps → Chrome → Almacenamiento). Abrir la app: pide entrar. Al entrar dice «Se recuperó tu ronda en curso desde el servidor». Terminarla.
7. **Para que Chrome no borre los datos por su cuenta:** la app le pide a Chrome almacenamiento persistente, que suele concederlo cuando la app está **instalada**. En los teléfonos de los guardias, conviene instalarla. Borrar a mano los datos, o desinstalar la app, sí borra todo: eso es el caso 6.

## 7. Piloto antes de vender

Un condominio, 2 o 3 puntos con chapita (al menos uno bajo techo y uno cerca de metal), una semana. Al final, en el panel: cuántas marcas 📶 NFC entraron y cuántos «La chapita no lee» hubo (Informes → cada ronda), y preguntarle a los guardias qué rechazos vieron. Los rechazos quedan guardados en cada ronda en el servidor, pero el panel todavía no los muestra: se pueden revisar con `scripts/exportar-json.js`. Si un punto acumula rechazos o avisos, es un problema de instalación (metal, altura, carcasa), no del guardia.
