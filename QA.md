# QA — Rondas QR

**Fecha**: 2026-07-16 · **Resultado**: ✅ 12/12 escenarios automatizados en verde + smoke test manual en navegador. Todo en MOCK, $0 gastado, cero llamadas externas.

## Suite automatizada (`npm test`)

| Escenario | Casos del SPEC | Resultado |
|---|---|---|
| Login correcto / PIN malo | CU-01 | ✅ |
| API exige token válido | (adversarial) | ✅ |
| Paquete de rondas descargable con puntos y payloads | CU-02 | ✅ |
| Ronda completa en orden → informe `completa` + notificación sin alerta | CU-03, CU-04, CU-09 | ✅ |
| QR basura / de otro condominio / punto fuera de la ronda → rechazados | CU-05 | ✅ |
| Duplicado conserva el primero y avisa | CU-06 | ✅ |
| Código corto manual (minúsculas incluidas) | CU-13 | ✅ |
| Cierre con faltantes → `INCOMPLETA` + aviso "⚠️ ALERTA" con los puntos | CU-08, CU-10 | ✅ |
| Reenvío offline idempotente (iniciar 2 veces, ts del teléfono, flag offline) + observaciones de duración | CU-07 | ✅ |
| Orden estricto violado → `completa_obs` con el punto exacto | CU-08 | ✅ |
| CRUD admin de puntos/guardias/rondas + validaciones (PIN malo, usuario duplicado, punto ajeno) | CU-11 | ✅ |
| Hoja de QR: un PNG embebido por punto | CU-12 | ✅ |
| Aislamiento entre condominios (rondas, escaneos, informes, puntos) | CU-14 | ✅ |
| Guardia ajeno no toca la ejecución de otro; guardia no entra al panel | (adversarial) | ✅ |
| Cierre administrativo de ronda olvidada; cierre repetido inocuo; escaneo tras cierre → 409 | CU-08 (adversarial) | ✅ |

(15 verificaciones agrupadas en 12 tests de `test/rondas.test.js`.)

## Smoke test en navegador (servidor real, `npm run demo`)

1. Login guardia `pedro` → paquete descargado visible (2 rondas con reglas). ✅
2. Service worker registrado y controlando; jsQR cargado desde `/vendor`. ✅
3. Ronda "Perimetral express": 2 marcas manuales (una en minúsculas), código inválido rechazado con aviso, duplicado avisado; progreso 2/4. ✅
4. Cierre incompleto: pantalla final "⚠️ Ronda INCOMPLETA" con Piscina y Acceso trasero como faltantes; cola sincronizada a 0. ✅
5. Panel admin (`marta`): informe listado `INCOMPLETA 2/4`; pestaña Avisos muestra la notificación mock con "⚠️ ALERTA". ✅
6. Hoja de QR: 8 tarjetas con PNG renderizado. ✅
7. **Round-trip de QR**: el PNG de Portería decodificado con jsQR (el mismo motor del teléfono) devuelve exactamente `RQR:aromos:p-porteria:PRT234`. ✅

## No probado en esta pasada (requiere hardware real)

- Cámara física del teléfono (getUserMedia) — el pipeline de decodificación quedó verificado con el round-trip anterior; la captura de cámara se prueba en el teléfono de José en la revisión.
- Notificación Telegram real — queda en MOCK hasta que José apruebe activarla (token 2 del pool ya está en el `.env`, falta solo `MOCK=false` + chat_id del admin).

## Actualización v1.9 — GPS bloqueante (2026-07-29)

La suite quedó en **20/20 en verde**. Cambios de cobertura respecto a la tabla de arriba:

| Escenario | Casos del SPEC | Resultado |
|---|---|---|
| El GPS **bloquea**: a 1,1 km, a 30 m, sin GPS y con GPS basura → `422`, con la distancia en el mensaje | CU-15, CU-16, CU-18 | ✅ |
| A ~11 m del punto → marca aceptada, informe sin observaciones de GPS | CU-18 | ✅ |
| Punto **sin** ubicación fijada → se marca sin GPS (válvula de escape para bajo techo) | CU-18 | ✅ |
| Reenvío de un punto ya marcado desde lejos → duplicado idempotente, no se re-verifica | CU-07, CU-18 | ✅ |
| El paquete del teléfono trae `lat/lon` por punto y los umbrales del servidor | CU-02, CU-18 | ✅ |
| Marca que se cuela (ubicación fijada **después** de la ronda) → sigue saliendo `SOSPECHOSA` | CU-17 | ✅ |
| `GPS_MARGEN_MAX_M` y `GPS_BLOQUEA=0` cambian el comportamiento sin tocar código | CU-18 | ✅ |

**Pendiente de terreno** (no se puede automatizar): el radio de 20 m contra la precisión real de los teléfonos de los guardias. Es el objetivo de la prueba en el condominio de demo.

## Actualización v1.10 — verificación por entrada (2026-07-29)

**22/22 en verde.** Cubre los puntos bajo techo, donde el radio de 20 m es inalcanzable:

| Escenario | Casos del SPEC | Resultado |
|---|---|---|
| Ancla en la entrada: fix de hace 4 min a 11 m → marca aceptada | CU-19 | ✅ |
| A 35 m del ancla (dentro de los 40 m) → aceptada | CU-19 | ✅ |
| Fix de hace 20 min (ventana de 15) → `422` "hace 20 min" | CU-19 | ✅ |
| Marca desde 780 m con señal perfecta → `422` "de la entrada" | CU-19 | ✅ |
| Ubicación apagada toda la ronda → `422` | CU-19 | ✅ |
| App que no informa la antigüedad del fix → `422` (la edad **es** el control) | CU-19 | ✅ |
| `radioM`/`ventanaMin` por punto mandan sobre los defaults; vaciarlos vuelve al default | CU-19 | ✅ |
| Modo inválido y radio fuera de rango → `422` | CU-19 | ✅ |
| El informe marca `anclado: true` y la distancia es a la entrada, no al punto | CU-09, CU-19 | ✅ |
| Quitar la ubicación limpia también el modo y los umbrales | CU-19 | ✅ |

**Pendiente de terreno**: dónde queda el ancla de cada punto de Condominio Piloto (se define caminando la ronda con el teléfono) y si 15 min es la ventana correcta para la caldera de la Torre 4.

## Actualización v1.13 — presupuesto de error del GPS (2026-08-02)

**39/39 en verde.** Origen: en la prueba de terreno, escaneando **parado sobre el QR**, la app respondía "acércate al punto". Ver CU-23 en el SPEC para el diagnóstico completo.

| Escenario | Casos del SPEC | Resultado |
|---|---|---|
| A 30 m con señal ±25 m sobre punto medido a ±5 m → **aceptada** (tope 50 m): el bug de v1.12 | CU-23 | ✅ |
| A 56 m con la misma señal → `422`: el margen no es cheque en blanco | CU-23 | ✅ |
| A 1,1 km con buena señal → `422` con el tope en el mensaje | CU-15, CU-18 | ✅ |
| Fix de WiFi/antena (±300 m) **sobre** el punto → `422` "demasiado imprecisa" | CU-23 | ✅ |
| Punto medido a ±3 m + señal ±5 m → tope 28 m: una marca a 30 m se rechaza igual | CU-23 | ✅ |
| El mismo punto medido a ±40 m → tope 60 m: el guardia no paga el error de medición del admin | CU-23 | ✅ |
| Volver a fijar sin informar precisión **no** hereda la anterior; sin dato se asume ±15 m | CU-23 | ✅ |
| `precisionM` inválida → `422` **sin** dejar el punto a medio escribir | CU-11, CU-23 | ✅ |
| `quitarUbicacion` limpia también la precisión | CU-23 | ✅ |
| Señal imprecisa en el informe → observación, **no** sospecha (`completa_obs`) | CU-09, CU-23 | ✅ |
| `GPS_MARGEN_MAX_M=0` restaura el radio estricto de v1.9-v1.12 | CU-18 | ✅ |
| El paquete del teléfono trae `precisionM` por punto y los umbrales nuevos | CU-02, CU-23 | ✅ |

**Pendiente de terreno**: volver a medir los puntos de Condominio Piloto con la medición de 45 s de v1.14 (los actuales quedaron "fijados sin medir") y confirmar que con puntos bien medidos el tope típico se queda cerca de los 30 m, no del techo de 60.

**Pendiente de terreno (v1.14)** — lo que ninguna suite puede responder:

1. **Modo avión + purgar caché + abrir la app del guardia.** Debe arrancar. Si queda en blanco, falta un archivo en el `SHELL` del service worker. `test/sw-shell.test.js` cubre el caso conocido; esta prueba cubre el resto.
2. **Medir el mismo punto bajo techo con el método viejo y el nuevo** y comparar `precisionM`. Es la premisa de todo el cambio: si el ± se queda plano entre el segundo 12 y el 45, ese punto **no tiene arreglo por GPS** y pertenece a la verificación por trayecto (fase 2), no a más muestreo.
3. **Batería en una ronda larga** (60-90 min) con Wake Lock y GPS encendido desde el login. Es el riesgo aceptado de encender el GPS con la sesión: si el teléfono muere a mitad de ronda se pierde la ronda entera, que es peor que una marca rechazada.
4. **La métrica que no se puede mover**: ninguna marca fuera de `topeM` aceptada. Si esa cifra se mueve, el motor se aflojó por accidente. *(Desde la v1.27, en una marca por cercanía `distanciaM` y `topeM` son los de la lectura cercana: 30 m, o el tope de la entrada en un 🏠. La lectura del momento queda en `distanciaAhoraM` y su límite es 30 m (o el radio del ancla) + `GPS_ERROR_EXTRA_M` + su ±.)*

## Actualización v1.27 — cercanía reciente (2026-11-01)

Origen: marcas dudosas bajo techo (INC-002, ADR-001). Ver CU-29 en el SPEC.

| Escenario | Casos del SPEC | Resultado |
|---|---|---|
| Alero: lectura del momento a 45 m ±15, lectura de hace 50 s a 10 m ±8 → **aceptada por cercanía** | CU-29 | ✅ |
| Subterráneo: sin señal buena al marcar (±150 m, o sin lectura), lectura a 12 m ±8 de hace 1,5 min → aceptada | CU-29 | ✅ |
| Caseta: lectura del momento a 150 m ±10 → rechazada aunque haya una lectura cercana | CU-29 | ✅ |
| Ida y vuelta: pasó cerca, se fue a 150 m y volvió a 40 m → la de 150 m lo desmiente | CU-29 | ✅ |
| Bordes: a 30 m sí, a 35 m no; ±20 sí, ±25 no, sin ± no; 5 min sí, 6 min no; momento a 70 m ±15 no, a 65 m ±15 sí | CU-29 | ✅ |
| 🏠 con lecturas malas adentro durante 12 min: entra con la de la entrada (INC-002); a los 16 min, no | CU-19, CU-29 | ✅ |
| Una app sin cercanía (v1.25) → 422 como siempre; una lectura «cercana» inventada a 35 m → 422 | CU-29 | ✅ |
| El informe dice «📍 por cercanía (a 10 m hace 1 min; al marcar, a 45 m)»; no es «lejos» ni sospecha | CU-29 | ✅ |
| `GPS_CERCANIA_MIN=0` → vuelve la v1.25 | CU-29 | ✅ |
| App y servidor deciden lo mismo en toda la grilla de la rama nueva | CU-29 | ✅ |
| Señal por punto: buena / regular / mala y la recomendación; solo el administrador, solo su condominio, últimos 30 días | CU-29 | ✅ |
| El diagnóstico no cambia ni un byte de la base y no crea una si no existe | CU-29 | ✅ |

**Pendiente de terreno (v1.27)**: en el teléfono de la garita (Fully Kiosk), un punto semi-techado y uno bajo techo, escaneando 1-3 min después de perder la señal. Y correr `scripts/diagnostico-gps.js` en producción (con permiso) antes y unas semanas después del deploy: tienen que bajar los rechazos bajo techo, y las marcas por cercanía tienen que concentrarse en los puntos que el diagnóstico clasifica como semi-techados o bajo techo.

## Bugs encontrados y corregidos durante QA

- `npm test` con `node --test test/` no resuelve en Windows → script cambiado a `node --test` (autodescubre `test/`). Sin otros hallazgos: la suite pasó completa a la primera tras ese ajuste.
- **v1.13**: `PUT /api/admin/puntos/:id` escribía `lat`/`lon` **antes** de validar `precisionM`, así que un `422` dejaba la ubicación cambiada a medias. Se valida todo antes de tocar el punto.
- **v1.13**: `Number(null) === 0` hacía que un punto **sin medir** se tratara como medido con precisión perfecta (±0 m) — justo el caso que más margen necesita. Se distingue "sin dato" de "cero" en el motor y en la app.
