# Diseño — Informe semanal por condominio

**Fecha**: 2026-07-20
**Estado**: Diseño aprobado (pendiente validar con administrador real antes de construir)
**Origen**: sesión office-hours con José. Plantilla de referencia: `Informe_Rondas_Hibiscus` (informe del sistema antiguo Kastor que este reemplaza).

## Qué es

Cada semana, la app arma **un informe por condominio** — estilo el de Hibiscus, con estadísticas y gráficos — que le llega por correo al administrador de ese condominio. El administrador **no entra a la app**: recibe el documento y listo.

La app del guardia y el panel del administrador **quedan igual**. Esto se suma encima; no reemplaza el aviso por ronda (panel + push) que ya existe.

Maqueta visual aprobada como referencia de formato: informe semanal (datos de ejemplo), estilo acta imprimible.

## Decisión de entrega (office-hours, opción A)

**Ahora — PDF que José envía.** La app genera el informe de cada condominio; José lo descarga como PDF y lo manda desde su correo a cada administrador. Cero infraestructura de correo, se puede tener funcionando en días, y permite afinar el informe con administradores reales.

**Después — PDF automático (roadmap).** Un trabajo semanal (cron en Railway) arma cada PDF y lo envía solo por correo, desde un remitente propio (ej. `informes@…`), vía un servicio de correo transaccional. Se activa cuando el formato esté redondo y la app estable. Es el mismo informe; solo cambia el cartero.

Descartado por ahora: Documento de Google (más conexiones, el admin tiene que abrir un link, el documento es editable → menos "acta oficial").

## Qué muestra el informe

Secciones (numeradas, siguiendo la plantilla de Hibiscus):

1. **Resumen ejecutivo** — total de marcaciones, promedio diario, reparto turno día/noche, y **marcaciones sin identificar** (siempre 0 → argumento de venta).
2. **Marcaciones por día y turno** — tabla + gráfico de barras.
3. **Marcaciones por guardia** — *sección nueva que pidió José*: nombre, turno, marcaciones, rondas completas e incompletas. Es lo que el sistema antiguo no daba.
4. **Marcaciones por checkpoint** — ranking de puntos con barras.
5. **Rondas incompletas** — cuáles quedaron con puntos sin marcar, con guardia y punto faltante.
6. **Conclusiones** — 2-3 líneas de lectura de la semana.

> **Fuera por ahora**: sección de *brechas prolongadas* entre marcaciones (sí está en el informe de Hibiscus). Decisión de José, 2026-07-20: sin datos reales todavía no se puede definir a partir de cuántos minutos una pausa es anormal. Se reevalúa cuando la app lleve semanas corriendo.

## De dónde salen los datos (todo ya existe en la app)

Modelo actual (`app/lib/store.js`): `ejecuciones[]` con `escaneos[{puntoId, ts, offline, gps}]`, más `guardiaId`, `condominioId`, `rondaId`, `estado`, `evaluacion`.

| Sección del informe | Cálculo sobre los datos de la semana |
|---|---|
| Total / promedio diario | Contar escaneos del condominio en el rango de fechas. |
| Turno día / noche | Deducido de la **hora** de cada `escaneo.ts`, **sin configuración**. Hay 2-4 guardias por condominio y cada uno es claramente diurno o nocturno: el patrón de horas lo delata solo. Basta una división automática razonable (ej. ronda iniciada 06:00–18:00 = día). |
| Por guardia | Agrupar escaneos por `guardiaId` → nombre; el turno sale del patrón de horas de ese guardia. |
| Por checkpoint | Contar escaneos por `puntoId` → nombre del punto. |
| Rondas incompletas | `ejecuciones` con `estado = 'incompleta'` → listar faltantes. |
| Sin identificar | Siempre 0: el guardia entra con usuario y PIN. (Si un guardia fue borrado, la marca aparece como "guardia eliminado".) |

## Qué hay que agregar a la app

1. **Clasificación día/noche automática** por hora de la ronda. Sin pantalla de configuración: José no quiere administrar cortes de horario, y con 2-4 guardias dedicados el patrón es evidente.
2. **Generación del informe** en una página nueva del panel del admin (ej. `informe-semanal.html?desde=…&hasta=…`) que arma el informe con estos datos.
   - *Camino mínimo, sin dependencias nuevas*: la página se ve en el navegador y José hace **"Guardar como PDF"** (Ctrl+P). Reusa el HTML de la maqueta. Cero librerías.
   - *Alternativa*: un botón "Descargar PDF" que lo genera en el servidor (agrega una dependencia de PDF).
3. **Correo del administrador** por condominio: no es necesario para la opción A (José conoce los correos), pero **sí** para la opción B automática. Conviene agregar el campo ya (hoy el condominio solo guarda `adminTelegramChatId`).

## Supuestos / preguntas abiertas para José

- ~~Corte día/noche~~ — **resuelto** (2026-07-20): automático por hora, sin configuración.
- ~~Umbral de brecha larga~~ — **resuelto**: la sección de brechas queda fuera hasta tener datos reales.
- **Frecuencia y día de envío**: semanal; ¿lunes con la semana anterior (lun–dom)?
- **Datos reales**: el primer informe con números de verdad necesita la app corriendo en Railway y juntando rondas al menos una semana.

## La asignación (siguiente paso real)

Antes de escribir una línea de código: **mándale la maqueta a un administrador real** (uno que ya recibía el informe del sistema antiguo) y pregúntale:

1. ¿Esto reemplaza lo que recibías antes? ¿Le confiarías la revisión de las rondas?
2. ¿Qué le falta o le sobra?

Su respuesta define el formato final. Recién ahí construimos la opción A.

## Roadmap a automático (opción B)

Cuando el formato esté validado y la app estable en Railway:
1. Agregar el correo del administrador por condominio.
2. Elegir servicio de correo transaccional (remitente verificado).
3. Trabajo semanal (cron Railway) que arma cada PDF y lo envía solo.
4. Registro de envíos (igual que `db.notificaciones`) para saber qué se mandó y si llegó.

## Estado al 2026-08-01 — la opción B ya está construida

El informe se entrega en **Word (.docx)** en vez de PDF (se edita si el administrador quiere agregar una nota, y Word abre en cualquier parte). Lo demás del roadmap está hecho, con una diferencia de diseño en el punto 1:

| Roadmap | Cómo quedó |
|---|---|
| 1. Correo del administrador por condominio | `condominio.correosInforme[]` — una **lista** (el administrador y, si quiere, el comité), que **el propio administrador edita** desde el panel (pestaña Avisos). `INFORME_TO` quedó como respaldo global. |
| 2. Servicio de correo | **Gmail API (OAuth2)**, por API HTTP y no SMTP: Railway bloquea los puertos 465/587. Manda de verdad desde la cuenta de Gmail configurada, no desde un tercero. Ver `app/lib/correo.js` y `app/scripts/obtener-refresh-token.js`. |
| 3. Trabajo semanal | `app/lib/programador.js`, **dentro del server** (no hay cron externo: el servicio de Railway está siempre encendido). Revisa cada hora y manda el lunes a las 8 de Chile, con la semana ya enviada guardada en la base para no repetir tras un reinicio. |
| 4. Registro de envíos | **Pendiente.** Hoy queda en el log del server y en `db.informeEmailEstado` (qué semana se mandó a cada destinatario), pero no hay una pestaña de envíos en el panel ni registro de errores por destinatario. |

### Un administrador, varios condominios

Es el caso real de una corredora: 4 administradores con 2 condominios cada uno. El envío se agrupa **por destinatario**, no por condominio: cada administrador recibe **un solo correo** el lunes con el `.docx` de cada uno de sus condominios adjunto, no un correo por condominio. Un administrador con 10 condominios recibe un correo con 10 adjuntos (~13 KB cada uno).

La lógica vive en `app/lib/destinatarios.js` y está cubierta en `app/test/destinatarios.test.js`, incluido el caso 4×2. El correo cargado es el interruptor: **un condominio sin correo no se manda a nadie** (salvo que exista `INFORME_TO` de respaldo).

> **Ojo con el remitente**: `GMAIL_FROM` tiene que ser la misma cuenta dueña del `GMAIL_REFRESH_TOKEN` — Gmail rechaza mandar "de" una cuenta distinta a la autenticada. No hay problema para escribirle a administradores externos: al ser la API de Gmail (no un dominio de prueba de un tercero) entrega normal a cualquier destinatario.

## Reglas de redacción (2026-09-28)

Las frases del informe (lectura de puntos y conclusión) se arman con reglas fijas en `app/lib/informe-semanal.js`, sin modelo de lenguaje ni API externa:

1. **"Más" o "menos" solo con diferencia real.** Si todos los puntos tienen las mismas marcas, el informe lo dice ("no hay un punto más ni menos marcado"). A igualdad, la tabla va en orden alfabético: nunca decide el orden de carga.
2. **Los puntos se juzgan por cobertura**, no por cantidad: marcas / veces que tocaba marcarlo (rondas realizadas que lo incluían, según lo evaluado al cerrar cada ronda). Primero los que requieren atención.
3. **Porcentajes sin mentira en los bordes**: 100% solo si es todo, 0% solo si es nada, y las partes de un total suman 100 (reparto por resto mayor).
4. **Todo cuadra**: `revisarCoherencia()` comprueba que días, turnos, guardias y puntos sumen el total de marcaciones, que los estados sumen el total de rondas y que las incidencias calcen. Los tests lo corren con datos al azar.
