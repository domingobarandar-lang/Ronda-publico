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

## Bugs encontrados y corregidos durante QA

- `npm test` con `node --test test/` no resuelve en Windows → script cambiado a `node --test` (autodescubre `test/`). Sin otros hallazgos: la suite pasó completa a la primera tras ese ajuste.
