# SEGURIDAD — que los datos que ve el administrador sean verídicos

Resultado del análisis /office-hours (2026-07-17). Pregunta: ¿cómo garantizamos que una marca en el informe significa "el guardia estuvo ahí, a esa hora"?

## El modelo de amenaza (con quién estamos peleando)

No es un hacker: es **un guardia con incentivos para no caminar la ronda a las 3 AM**. Sus trucos, de más simple a más elaborado:

1. **Foto del QR**: se fotografía las láminas una vez y marca todo desde la caseta.
2. **Ronda exprés**: corre los puntos en 4 minutos y el resto de la hora duerme.
3. **Marcas inventadas offline**: ajusta el reloj del teléfono para fabricar horas.
4. **GPS falso**: apps de "mock location" (requiere teléfono preparado; raro pero existe).
5. **Préstamo de credenciales**: otro guardia marca por él con su usuario.

La industria confirma este diagnóstico: los sistemas serios combinan capas — NFC de proximidad física como el estándar anti-clonación ([Miratag](https://miratag.com/en/blog/nfc-guard-tour-system-patrol-verification), [TrackTik](https://www.tracktik.com/resources/blog-articles/enterprise-guard-tour-systems-with-nfc-integration-what-security-leaders-need-to-know/)), GPS como verificación de perímetro, y análisis de patrones; [Deggy](https://store.deggy.com/) llegó a grabar QR con láser + auditoría con IA para frenar la clonación.

## Lo que YA tiene la v1.1 (no partir de cero)

- ✅ **GPS por marca + distancia al punto**: en v1.1 la foto del QR escaneada desde la caseta quedaba *acusada* ("⚠️ a X m del punto") con un umbral de 75 m. **Desde v1.9 queda bloqueada**: la marca fuera de rango —o sin fix GPS reciente— se rechaza en la app y en el servidor. El fraude pasa de detectado a impedido.
  - **Desde v1.13 el rango es honesto con la física** (CU-23): se comparan dos medidas de GPS —la del punto y la del teléfono— y el tope es el radio (20 m) más la imprecisión declarada de ambas, topada en 40 m. El radio "estricto" de v1.9 a v1.12 exigía algo que el hardware no puede cumplir y rechazaba a guardias parados sobre el QR; un control que castiga al honesto se termina apagando, y eso sí habría regalado el antifraude. El margen lo pone el sensor, no el guardia: con punto bien medido y buena señal el tope queda en ~30 m, y escanear desde la caseta a 200 m sigue siendo imposible.
- ✅ **Puntos bajo techo: verificación por entrada** *(v1.10)*: en subterráneos y salas de calderas el GPS no llega, así que el radio de 20 m no es aplicable. En vez de dejarlos sin verificar, se ancla el punto a la **entrada del recinto**: la marca requiere que el teléfono haya tomado señal a menos de 40 m de esa entrada en los últimos 15 min. Obliga a caminar hasta el edificio.
  - **Su límite, explícito**: prueba que el guardia pasó por la entrada, no que entró al recinto. Un guardia puede quedarse en la puerta y escanear ahí la foto del QR de adentro. Se aprieta bajando la ventana por punto; **cerrarlo de verdad requiere NFC** (Capa 2). Como el punto anclado va en sándwich entre puntos exteriores verificados a 20 m, y la detección de ráfaga sigue activa, el fraude igual obliga a recorrer el condominio.
  - **NFC tiene una restricción de plataforma que hay que confirmar antes de venderla**: Web NFC solo existe en Chrome/Android. Desde iPhone una PWA no puede leer tags, y Fully Kiosk tampoco (v1.23: ahí se usa el código a mano). Antes de comprometer NFC con un cliente: verificar qué teléfonos usan sus guardias y que tengan NFC (hay modelos de gama baja sin NFC).
- ✅ Payload de QR con código secreto (no se puede forjar un QR válido sabiendo solo el nombre del punto).
- ✅ Horas, orden y duración en el informe; marcas offline etiquetadas.
- ✅ El servidor revalida todo; la app no decide nada que importe.

## Propuesta por capas (prioridad costo/beneficio)

### Capa 1 — v1.2, puro software, ~0 costo marginal ⭐ recomendada ahora

1. **Análisis de velocidad entre puntos**: si entre dos marcas la velocidad implícita supera lo humano (ej. > 2.5 m/s sostenido entre puntos con ubicación), observación "ritmo físicamente improbable". Mata la "ronda exprés" y la foto-desde-la-caseta a la vez.
2. **Sesgo de reloj**: al sincronizar marcas offline, comparar la hora del teléfono con la del servidor; si difieren > 3 min, el informe lo acusa. Mata las horas fabricadas.
3. **Vínculo de dispositivo**: la sesión queda amarrada al teléfono (huella simple de dispositivo); si el usuario entra desde otro aparato, el informe lo anota ("marcó desde un dispositivo distinto al habitual"). Frena el préstamo de credenciales.
4. **Cadena de integridad del registro**: cada ejecución guarda un hash encadenado de sus eventos; el informe lleva un sello verificable. Nadie —ni nosotros— puede editar una ronda pasada sin que se note. Argumento de venta fuerte para el administrador.
5. **Resumen semanal de confianza**: un indicador simple por guardia (rondas completas, % con observaciones GPS, sesgos de reloj) para que el administrador gestione personas, no logs.

### Capa 2 — v2, hardware barato, el candado físico

6. **NFC físico (NTAG213, ~US$0.3–0.5 por punto)** — ✅ **construido en la v1.23 (CU-28)**, por punto: el guardia acerca el teléfono al tag (2–4 cm). Chrome en Android soporta Web NFC, así que **la misma PWA lo lee sin app de tienda**.
   - **Corrección: un NTAG213 SÍ se puede copiar.** Su contenido no es secreto: cualquier teléfono lo lee y lo graba en otro tag en un minuto (y el texto es el mismo del QR, que está en una foto). Lo que no se copia en un tag común es el **número de serie de fábrica** (UID): viene grabado y no se puede cambiar. Por eso el panel registra la serie al grabar la chapita y el servidor **exige** que la marca traiga esa serie. Una foto del QR, o el texto copiado a otro sticker, se rechaza.
   - **El límite, explícito:** existen tags "mágicos" (chinos, de serie cambiable) a los que se les puede escribir la serie de otro. Con uno de esos y un lector, un guardia decidido podría clonar la chapita. Es un ataque caro para el modelo de amenaza de arriba (hay que comprar el tag, saber hacerlo y leer la chapita original), pero existe.
   - **Bloquear la chapita** (`makeReadOnly`, opción por defecto al grabarla) impide que alguien le grabe otro punto encima; no impide leerla ni copiarla.
   - **Por qué un "código secreto más largo" no sirve contra la copia.** Todo lo que la chapita o el QR tienen escrito es **fijo**: el que lo lee una vez (con la cámara o con una app como NFC Tools) tiene el código completo, sea de 6 o de 60 caracteres. Alargarlo frena a quien quiera *adivinarlo*, y eso ya es imposible hoy (el payload lleva el id del punto, un UUID, más el código). Lo que frena la *copia* es algo que no se pueda leer y repetir: la serie de fábrica (lo de hoy) o un código que cambie en cada lectura (NTAG 424 DNA, abajo).
   - **El límite de la serie, para ser honestos:** la serie también es un dato fijo. Quien la lea con una app y sepa armar una petición al servidor a mano podría mandarla sin estar en el punto. Desde la v1.23 la serie ya **no viaja al teléfono del guardia** (el paquete lleva solo su huella SHA-256), así que no basta con mirar la memoria de la app: hay que ir a la chapita con otra app y saber programar. Es una traba, no un candado.
   - **El candado de verdad: NTAG 424 DNA (SUN).** Cada vez que se acerca un teléfono, la chapita genera un código nuevo firmado con una clave AES que nunca sale del chip, más un contador que solo sube. El servidor verifica la firma y que el contador sea mayor que el anterior: una lectura copiada, fotografiada o repetida no sirve dos veces, y una chapita clonada no tiene la clave. Cuesta más por chapita que un NTAG213 (del orden de 1 a 3 dólares contra unos 30 centavos; confirmar con el proveedor) y hay que configurarla una vez con herramientas de NXP o de terceros (por ejemplo TagXplorer, en un PC con lector USB; confirmar cuál sirve antes de comprar), porque Web NFC no puede programar la clave. **Leerla sí** se puede con la misma app de hoy. Lado servidor: guardar la clave de cada chapita y verificar la firma (AES-CMAC). Funciona sin señal igual: la app guarda la lectura en la cola y el servidor la verifica al llegar (la app no puede verificarla sola, porque no tiene la clave). Es el siguiente paso recomendado si un cliente exige "imposible de copiar".
   - El **código a mano no sirve en los puntos NFC** (`MANUAL_EN_PUNTO_NFC = 'rechazo'`): sin GPS bajo techo, era la puerta para marcar sin ir. Si la chapita no lee, el guardia lo avisa desde la app y el punto queda faltante con la explicación en el informe.
   - Bajo techo es donde más rinde: la chapita no necesita señal ni GPS, y prueba que el guardia estuvo en el punto, no solo en la entrada.
7. **Foto-evidencia en puntos críticos** (opcional por punto): al marcar, la app toma una foto rápida del entorno que viaja con la marca; el administrador hace spot-checks. Disuasión alta, costo bajo; consume datos/almacenamiento, activar solo donde importe.

### Descartado (y por qué)

- **QR dinámico con pantallas** (cambia cada 30 s): sí existe en la industria, pero exige una pantalla con batería en cada punto — más caro y frágil que NFC, sin ser más seguro. No para condominios.
- **Biometría del guardia en cada marca**: fricción brutal a las 3 AM con frío; el vínculo de dispositivo + patrones logra el 90 % del beneficio.
- **Blockchain**: la cadena de hashes local da la misma integridad verificable sin costo ni complejidad.

## Honestidad con el cliente (para el one-pager y la venta)

Ninguna capa hace imposible el fraude; lo hacen **caro, detectable y acumulativo**. El mensaje al administrador: "cada truco conocido deja huella en el informe". Eso es más creíble —y más defendible en una venta— que prometer "invulnerable".

## Siguiente paso concreto (la tarea)

Antes de construir la Capa 1: **que José mire una ronda real** — un guardia, una noche, la app en la mano, sin ayudarlo. Lo que ese guardia haga (dónde duda, qué le incomoda, si intenta un atajo) ordena las prioridades de esta lista mejor que cualquier análisis.

---
*Fuentes: [Miratag — NFC guard tour](https://miratag.com/en/blog/nfc-guard-tour-system-patrol-verification), [TrackTik — NFC integration](https://www.tracktik.com/resources/blog-articles/enterprise-guard-tour-systems-with-nfc-integration-what-security-leaders-need-to-know/), [Deggy](https://store.deggy.com/), [Guía 2026 de guard tour systems](https://digitalguardtour.com/what-is-a-guard-tour-system-the-complete-2025-guide-for-u-s-security-teams/).*
