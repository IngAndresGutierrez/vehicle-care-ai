# Vehicle Care — PRD v1.0 + Service Blueprint

**Producto:** Vehicle Care | **Mercado:** Colombia | **Fecha:** 28 de octubre de 2026  
**Estado:** Propuesta para prueba técnica; pendiente de validación con una agencia real  
**Owner de producto:** AI Product Engineer | **Versión:** 1.0

## 0. Resumen ejecutivo de producto

Vehicle Care transforma la primera necesidad de mantenimiento posterior a la compra en una experiencia proactiva, contextual y transaccional. Para compradores recientes de vehículos usados de combustión, la plataforma identifica servicios próximos a vencer utilizando un **plan técnico específico del vehículo**, datos de odómetro e historial; explica la recomendación; permite consultar una cotización y reservar un taller; y actualiza la bitácora tras el trabajo efectivamente realizado.

**Tesis:** ayudar al propietario a resolver el primer mantenimiento con confianza puede incrementar la proporción de compradores que realiza ese servicio en la agencia, generando margen incremental y una relación de postventa medible.

**Regla central:** la IA conversa y orquesta; **no inventa intervalos ni diagnostica fallos**. Un motor determinista y un catálogo validado por fuentes técnicas deciden si existe un servicio programado; las herramientas de negocio validan precios, disponibilidad y autorización.

**Fuera del MVP:** SOAT, pólizas todo riesgo, multas, siniestros, históricos externos RUNT/SIMIT, valoración de usados y recompra. Permanecen en la visión de ecosistema. Se preserva desde el primer día una bitácora trazable de mantenimiento del propio taller.

## 1. Contexto, evidencia y supuestos

### 1.1 Evidencia externa

- **Mazda Colombia** indica que el mantenimiento depende del manual del propietario y, como orientación general en su sitio, menciona cambios de aceite y filtro cada 5.000 km o al menos una vez al año, además de revisiones programadas cada 10.000 km. **No** generalizamos estos intervalos a todas las marcas, años, motores o condiciones de uso. Fuente: https://www.mazda.com.co/propietarios/preguntas/mantenimiento-y-reparacion/
- El **RUNT** dispone de un Histórico Vehicular que incluye información de propietarios, accidentes registrados, vigencias de SOAT y revisión técnico-mecánica, entre otras categorías. No implica un historial mecánico completo ni cobertura de todos los incidentes. Fuente: https://www.runt.gov.co/system/files/instructivos/RUNT2-IN-282%20Instructivo%20Generar%20PDF%20de%20Hist%C3%B3rico%20Vehicular%20V2.pdf
- El **Ministerio de Transporte** describe consultas de SOAT y RTM por canales del RUNT. La existencia de un portal público **no** acredita que exista una API comercial autorizada para nuestra aplicación. Fuente: https://mintransporte.gov.co/publicaciones/11445/wwwruntgovco-unico-portal-disponible-del-runt/
- La **Ley 1581 de 2012** establece principios de finalidad, autorización, calidad, seguridad, acceso restringido y derechos del titular para tratamiento de datos personales. Fuente: https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981

### 1.2 Supuestos de trabajo (no hechos de mercado)

| Código | Supuesto de diseño | Qué validaremos |
|---|---|---|
| S01 | Agencia multimarca ficticia ubicada en una ciudad colombiana, con CRM, expedientes de entrega y un taller propio o aliado. | Sistemas, permisos y contratos de servicio reales. |
| S02 | El taller puede exponer disponibilidad y catálogo de precios mediante una capa de integración; en el prototipo serán mocks. | Integrabilidad, exactitud y actualización de tarifas y cupos. |
| S03 | Existe una base de compradores recientes con fecha de entrega, identificación del vehículo y canales de contacto. | Calidad, campos faltantes, autorización y contactabilidad. |
| S04 | Se empezará con 2–3 referencias de vehículo que cuenten con planes técnicos verificables de su mercado y motor. | Disponibilidad de documentación por VIN/versión. |
| S05 | El propietario confirma datos faltantes (p. ej., kilometraje) cuando son indispensables. | Fricción y tasa de datos completados. |
| S06 | La agencia puede registrar orden de trabajo finalizada, factura y kilometraje del servicio. | Integridad y acceso al DMS/taller. |

## 2. Usuarios, segmento y problema

**Segmento P0:** comprador particular de automóvil usado de combustión, con 2–7 años de antigüedad, entregado por la agencia en los últimos 180 días, con un plan de mantenimiento técnicamente verificable. El rango de edad es una hipótesis para focalizar la prueba, no un criterio de seguridad mecánica.

**Usuario primario:** propietario que necesita claridad sobre qué servicio corresponde, cuándo, costo y disponibilidad.  
**Usuarios operativos:** asesor de postventa, coordinador de taller y responsable de calidad/compliance.  
**JTBD:** «Cuando mi vehículo se acerque a un mantenimiento, quiero entender qué se debe hacer y resolverlo fácilmente, sin llamadas innecesarias ni recomendaciones dudosas».

**Problema:** la relación postventa no utiliza consistentemente los datos de compra y servicio para anticipar necesidades; el cliente puede resolverlas fuera de la agencia.

## 3. Objetivo, North Star y principios

**Objetivo del MVP:** elevar el número incremental de *primeros mantenimientos completados* en la red de la agencia por compradores elegibles, sin sacrificar seguridad, consentimiento o margen.

**Métrica principal:** diferencia de tasas de primer mantenimiento completado entre grupo piloto y grupo de control, dentro de una ventana observacional definida desde la elegibilidad al mantenimiento; analizar por intención de tratar.

**Definición de elegibilidad de experimento:** comprador con vehículo identificable, plan técnico validado y mantenimiento que vence dentro de la ventana de observación; medir por separado a quienes tienen contacto autorizado. Evitar denominadores con propietarios cuyo mantenimiento no corresponde todavía.

**Principios:** pertinencia > frecuencia; datos con procedencia; explicación verificable; consentimiento por finalidad; autonomía proporcional al riesgo; humano accesible; ingresos incrementales reales, no reservas desplazadas de canal.

## 4. Alcance y priorización

| P0 — prototipo / MVP | P1 — evolución | P2 — futuro |
|---|---|---|
| Alta de vehículo y contexto de entrega | Más referencias y servicios preventivos | SOAT/RTM con acceso autorizado |
| Consentimiento y preferencias | Neumáticos, filtros, frenos e inspecciones | Pólizas todo riesgo / aliados |
| Plan técnico validado por vehículo | Historial de talleres aliados | Histórico vehicular enriquecido |
| Odómetro, historial y reglas de aceite/filtro | Facturación y pagos | Valoración, retoma y recompra |
| Recomendación explicada + cotización | Medición real de uso y telemática | Predicción avanzada con datos suficientes |
| Disponibilidad, reserva, confirmación | Más canales / servicio omnicanal | Ecosistema amplio de servicios |
| Dos excepciones y handoff humano | Campañas basadas en eventos adicionales | Comercialización del historial con permisos |
| Bitácora del servicio realmente ejecutado | | |

**NO construir en 24 h:** integración real con RUNT, SIMIT, WhatsApp o aseguradoras, motor predictivo de averías, cobros reales ni diagnóstico de seguridad.

## 5. Journey UC-01: «Mi primer mantenimiento después de comprar»

**Precondiciones:** vehículo asociado al propietario, identidad autenticada en web (para demo: sesión simulada rotulada); plan técnico validado; datos de servicio disponibles; consentimiento verificado antes de iniciar cualquier mensaje saliente; taller con catálogo y agenda.

1. **Entrega/activación.** La agencia registra el vehículo, datos disponibles, odómetro, inspección preentrega, historial acreditado y preferencias; muestra un plan inicial o «pendiente de verificar».
2. **Detección de necesidad.** Un job evalúa servicio y vence según kilómetros **o** tiempo; categoriza `UPCOMING`, `DUE`, `OVERDUE` o `UNKNOWN`; evita contacto si no hay autorización.
3. **Contacto contextual.** Mensaje al canal autorizado o tarjeta dentro del portal: «Según el historial disponible, se aproxima [servicio] por [motivo]. ¿Revisamos los detalles?». No prometer diagnósticos.
4. **Confirmación de contexto.** El asistente confirma odómetro cuando es antiguo; si falta historia esencial, cambia a `UNKNOWN` y ofrece revisión humana.
5. **Recomendación respaldada.** Muestra servicio, motivo, lectura tomada, intervalo y fuente/versión del plan, más alcance y limitaciones.
6. **Cotización.** Consulta catálogo/tarifa. Muestra valor estimado o final, impuestos, elementos incluidos, restricciones y vigencia; si no está disponible, solicita cotización humana.
7. **Agenda.** Consulta cupos reales, cliente elige opción y aprueba reserva. La API revalida el cupo; operación idempotente; muestra folio confirmado.
8. **Taller y cierre.** Un humano realiza y valida el trabajo. Solo la confirmación desde taller permite registrar servicio completado; agente informa resumen, nunca «certifica» el trabajo.
9. **Continuidad.** Se recalculan próximos servicios y se solicita retroalimentación; el historial del vehículo queda asociado a documentos y procedencia.

**Resultado observable:** recomendación verificable → cita confirmada → caso listo para taller. En el prototipo, el cierre real de taller puede ser una simulación claramente rotulada.

## 6. Service Blueprint (frontstage, backstage y evidencia)

| Etapa | Acción cliente | Interfaz/agente visible | Backstage / sistemas | Humano y evidencia |
|---|---|---|---|---|
| 1. Entrega | Acepta o rechaza finalidades | Ve plan inicial y consentimiento | CRM, ficha de vehículo, expediente entrega | Vendedor registra origen de datos; comprobante de consentimiento |
| 2. Evaluación | Ninguna | Tarjeta «próximo servicio» | Scheduler, reglas y catálogo técnico | Bitácora evaluación con regla y fuente |
| 3. Contacto | Abre aviso o portal | Mensaje contextual, no genérico | Preferencias, opt-in, canal permitido | Registro de campaña y autorización |
| 4. Validación | Confirma km/datos | Agente solicita solo campos faltantes | Servicio de perfil y actualización de odómetro | Procedencia de declaración y timestamp |
| 5. Recomendación | Revisa explicación | Motivo, fecha/km, confiabilidad | Motor determinista y fuente técnica | `decision_trace` y versión de plan |
| 6. Cotización | Revisa opciones | Precio verificado y alcance | Catálogo, cotizador, impuestos | Cotización ID, vigencia y versión |
| 7. Reserva | Elige y confirma cupo | Confirmación o recuperación de error | Sistema de taller con idempotency key | Booking ID o caso abierto |
| 8. Atención | Lleva vehículo | Estado de cita y resumen | Orden de trabajo y facturación | Técnico ejecuta, aprueba y documenta |
| 9. Retención | Califica/consulta historial | Próximo mantenimiento y recibo | Registro de servicio, eventos y analítica | Encuesta, historial con trazabilidad |

**Línea de visibilidad:** el cliente ve motivo, fuente, precio, estado y opción humana; no ve datos de otros propietarios, prompts internos, credenciales ni detalles sensibles de los sistemas.

## 7. Motor de mantenimiento (determinista)

**Inputs obligatorios:** `vehicle_id`, plan vigente `maintenance_plan_version`, especificación de motor identificada, servicio `service_code`, límite `interval_km` y/o `interval_months`, `last_service_date`/`last_service_odometer_km` cuando apliquen, odómetro y fecha de lectura actual, condiciones de uso si el plan las requiere.

**Regla:**

- `next_due_km = last_service_odometer_km + interval_km` (si existe y está validado).
- `next_due_date = last_service_date + interval_months` (si existe y está validado).
- Se considera **vencido** si se alcanzó *cualquiera* de los límites obligatorios, según la regla técnica específica.
- `UPCOMING` si el servicio no venció pero está dentro de un umbral preventivo configurable (`lead_km` o `lead_days`); estos umbrales son decisiones de comunicación, **no intervalos técnicos**.
- `UNKNOWN` si no está identificado el plan/motor, falta una fecha/lectura necesaria o existen registros contradictorios. No crear una cifra por defecto.

**Fuente de verdad:** manual o plan técnico específico para marca/modelo/año/motor/mercado, revisado y versionado por un responsable técnico. El FAQ de Mazda Colombia sirve como evidencia de variabilidad, **no** como catálogo universal.

**Ejemplo sintético:** un servicio con intervalo validado de 5.000 km o 12 meses, último mantenimiento documentado a 70.000 km el 1-abr-2026 y lectura confirmada de 74.200 km al 28-oct-2026 vence por kilometraje a 75.000 km o por tiempo el 1-abr-2027. Si el umbral comercial son 1.000 km, está `UPCOMING` por 800 km. Este ejemplo es una **regla de demo**, no una recomendación para un vehículo real.

**Correa de distribución:** verificar primero si corresponde correa o cadena y si hay fuente técnica exacta. Si no existe evidencia de sustitución o intervalo aplicable, `UNKNOWN` → consulta humana. No proponer una sustitución automática ni un intervalo genérico.

## 8. Arquitectura funcional y agentes

**Arquitectura:** web Next.js/TypeScript → API / controlador de workflow → (a) motor de reglas y planes técnicos, (b) agente conversacional con herramientas tipadas, (c) adaptadores CRM, catálogo/precios, calendario, consentimientos y casos humanos → registro de eventos y auditoría. En demo, adaptadores mock con datos sintéticos.

**Un solo agente P0: `MaintenanceAdvisor`**. Objetivo: explicar planes y ayudar a gestionar servicios; herramientas restringidas; sin acceso a datos de otros vehículos. No necesita agentes múltiples para el MVP.

| Capacidad | Permitido | No permitido |
|---|---|---|
| Informar | Leer datos autorizados y citar plan técnico | Inventar kilometrajes, plazos, averías o coberturas |
| Recomendar | Explicar el resultado del motor y ofrecer alternativas | Sustituir criterio del técnico ante avería/seguridad |
| Cotizar | Mostrar un precio retornado por catálogo | Cambiar tarifas, aplicar descuentos no autorizados |
| Reservar | Con confirmación explícita, cupo revalidado e idempotencia | Reservar sin autorización o fabricar cupos |
| Registrar | Guardar declaraciones del cliente con procedencia | Declarar un servicio completado sin evidencia de taller |
| Escalar | Abrir caso y entregar resumen mínimo necesario | Cerrar unilateralmente casos de seguridad |

**Memoria:** estructurada por vehículo y sesión (`vehicle_id`, perfil validado, preferencias, estado del caso, últimos tool results con caducidad, tareas pendientes). No usar el historial conversacional como fuente técnica. Separar datos de nuevos y antiguos propietarios; restringir lectura por identidad y autorización.

### 8.1 Contratos mínimos de herramientas

Cada llamada lleva `actor_id`, `vehicle_id`, `trace_id`, permiso, y en mutaciones `idempotency_key`.

| Herramienta | Entrada clave | Salida clave | Condición |
|---|---|---|---|
| `getVehicleProfile` | vehicle_id | motor, odómetro con fecha, estado de verificación | Usuario autorizado |
| `getServiceHistory` | vehicle_id, service_code | últimas intervenciones, fuentes y evidencia | Autorización y control de acceso |
| `getMaintenancePlan` | vehicle_spec, market | reglas versionadas, referencias | Plan validado; si no, UNKNOWN |
| `evaluateMaintenance` | vehicle_id, service_code | estado, vencimiento, explicación, plan_version | Determinista; sin LLM para el cálculo |
| `getQuote` | vehicle_id, service_code | quote_id, precio, alcance, caducidad | Tarifa vigente |
| `getAvailableSlots` | workshop_id, service_code | slot_id y horarios vigentes | Taller disponible |
| `createBooking` | slot_id, quote_id, explicit_confirmation, idempotency_key | booking_id o error tipado | Revalidar cupo y permiso |
| `createHumanCase` | reason_code, priority, minimal_context | case_id y responsable | Seguridad o incertidumbre |
| `recordOdometer` | value, observed_at, source | lectura registrada no certificada | Declaración/confirmación del usuario |
| `completeWorkOrder` | work_order_id, verified_workshop_actor | service_record_id | **Solo herramienta del taller**, no del agente |

**Error handling:** `CONSENT_REQUIRED`, `PLAN_NOT_VERIFIED`, `INSUFFICIENT_HISTORY`, `NO_SLOTS`, `SLOT_CONFLICT`, `QUOTE_EXPIRED`, `WORKSHOP_UNAVAILABLE`, `SAFETY_ESCALATION`, `UNAUTHORIZED`. Las mutaciones fallidas no deben mostrarse como exitosas.

## 9. Excepciones y recuperación

**EX-01 — Historial insuficiente (obligatoria).** Vehículo con 95.000 km y sin constancia de cambio de correa. El agente verifica tipo de distribución y plan. Si no puede determinar un intervalo válido o historial relevante: estado `UNKNOWN`, explicación de incertidumbre, ofrecimiento de inspección y `createHumanCase(reason=INSUFFICIENT_HISTORY)`. Prohibido recomendar sustitución o asegurar que está «al día».

**EX-02 — Posible riesgo de seguridad (obligatoria).** Cliente dice «el freno se hunde y casi no detiene el carro». El agente interrumpe el flujo de venta; no ofrece diagnóstico ni recomienda seguir conduciendo; aconseja no conducir el vehículo ante síntomas críticos, buscar asistencia adecuada y crea `createHumanCase(reason=SAFETY_ESCALATION, priority=URGENT)`; confirma referencia del caso. La respuesta se valida con protocolos redactados por personal cualificado.

**EX-03 — Cupo desaparecido (extra).** El cliente confirma, pero `createBooking` devuelve `SLOT_CONFLICT`. No se muestra reserva exitosa; se consultan nuevos cupos o se deriva a asesor. Idempotencia evita duplicados por reintentos.

**EX-04 — Sin consentimiento.** El sistema no inicia mensajes salientes; permite consulta voluntaria dentro del portal, según base legal y finalidades aplicables, y explica cómo administrar preferencias.

## 10. Privacidad, seguridad, trazabilidad y evals

- Verificar identidad y titularidad/autorización de acceso; un VIN o placa por sí solos no conceden acceso a expedientes del propietario.
- Consentimiento explícito y revocable por finalidad; diferenciar comunicaciones operativas y mercadeo, con revisión jurídica específica; conservar prueba de aceptación y retiro.
- Minimizar datos compartidos con modelos y proveedores; cifrado y accesos por rol; política de conservación y eliminación definida con la empresa.
- Tratar textos y documentos de usuario como datos no confiables: nunca seguir instrucciones adversariales que pidan saltar reglas o consultar datos de terceros.
- Registro por decisión: fecha, `trace_id`, `vehicle_id` pseudonimizado, reglas, fuentes/versiones, herramientas llamadas, resultado, autorización y motivo del handoff. No guardar secretos ni información personal innecesaria en logs.
- Controles de fraude: no permitir que un cliente edite el historial certificado del taller ni cambie el precio; distinguir «km declarado» de «km verificado»; proteger la reserva con idempotencia y rate limits.
- Evals antes de demo/producción: 20+ casos de reglas y excepciones (variantes de tiempo/km, historia incompleta, motor equivocado, ausencia de plan, falta de consentimientos, cupos agotados, conflictos, prompt injection, solicitud de datos de otro propietario, averías críticas). Cero mutaciones sin permiso o reservas ficticias en las pruebas; revisión humana de todos los escenarios críticos.

## 11. Criterios de aceptación (Definition of Done)

- [ ] AC01: La demo permite elegir un vehículo sintético y consultar el perfil.
- [ ] AC02: El motor muestra estado, motivo, unidad, regla específica y `plan_version`.
- [ ] AC03: Si falta motor/plan/historial esencial, el sistema muestra `UNKNOWN`, nunca un intervalo inventado.
- [ ] AC04: El asistente puede consultar herramientas y la UI muestra **qué consultó** con resumen comprensible (sin exponer información privada).
- [ ] AC05: Solo muestra precios recibidos del catálogo (o «cotización pendiente»).
- [ ] AC06: Solo confirma reservas tras aprobación explícita y respuesta exitosa de `createBooking`.
- [ ] AC07: La excepción de historial incierto termina en caso humano trazable.
- [ ] AC08: La excepción de seguridad interrumpe el journey comercial y deriva al responsable indicado.
- [ ] AC09: El conflicto de cupo se recupera sin duplicar reservas.
- [ ] AC10: Sin consentimiento no se simula una campaña saliente autorizada.
- [ ] AC11: El historial distingue registros acreditados por taller, datos declarados y ejemplos simulados.
- [ ] AC12: La demo incluye panel de trazas, estado del workflow y actor responsable.
- [ ] AC13: UI usable en móvil y escritorio; controles y mensajes accesibles.
- [ ] AC14: Se documenta qué endpoints son mock y qué se requeriría para producción.

## 12. Métricas y experimento piloto

**North Star:** uplift del primer mantenimiento realizado en la red durante ventana definida respecto a grupo control.  
**Adopción:** tasa de opt-in, apertura/visita voluntaria, porcentaje de vehículos con datos suficientes, inicio de cotización.  
**Funnel:** elegible → contactable → mensaje autorizado/visita → recomendación vista → cotización → reserva → asistencia → servicio finalizado.  
**Experiencia:** CSAT postservicio, esfuerzo percibido, quejas, solicitudes de baja.  
**Calidad técnica:** tasa de planes correctamente identificados, recomendaciones citadas, errores de booking, falsas confirmaciones (objetivo cero), handoff correcto.  
**Operación:** ocupación real, no-shows, tiempo hasta cita, carga por asesor, resolución de excepciones.  
**Economía:** margen de contribución incremental por servicio, costo por mantenimiento incremental, costos de canal/IA y costo de soporte; evitar atribuir como incremento servicios que habrían ocurrido igualmente.

**Diseño de piloto sugerido:** aleatorizar clientes elegibles en piloto/control dentro de las capacidades operativas; excluir de comunicaciones salientes a quienes no autorizaron; instrumentar eventos y comparar tasas con cohortes y ventanas equivalentes. Si el tamaño es insuficiente para significancia estadística, reportar dirección, intervalos e incertidumbre sin afirmar causalidad.

## 13. Roadmap de seis meses y compuertas

| Mes | Resultado | Compuerta |
|---|---|---|
| 1 | Discovery, mapa de datos, consentimiento, 2–3 planes técnicos aprobados | Calidad de datos y revisión legal/técnica satisfactorias |
| 2 | Adaptadores CRM/taller, catálogo, motor y trazabilidad | QA de reglas e integración superado |
| 3 | Piloto cerrado de primer mantenimiento y soporte humano | Cero fallos críticos de consentimiento/seguridad |
| 4 | Iteración, medición del funnel y costos reales | Señales suficientes de uso y ejecución correcta |
| 5 | Expandir cupos o cohortes solo si hay capacidad | Taller sostiene SLA y margen |
| 6 | Evaluación de uplift, unit economics y propuesta de escalamiento | Comité decide continuar, ajustar o detener |

## 14. Decisiones del cliente pendientes de validar

1. ¿Qué cartera de vehículos usados y qué referencias tienen documentación técnica suficiente?
2. ¿Cuál es el baseline de retorno al primer mantenimiento y en qué ventana?
3. ¿Qué capacidad ociosa real tiene el taller por tipo de servicio y franja?
4. ¿Quién aprueba planes técnicos y protocolos para síntomas de seguridad?
5. ¿Qué CRM/DMS/agenda existen y qué accesos de integración están disponibles?
6. ¿Qué finalidades de tratamiento y mensajería están autorizadas y con qué evidencia?
7. ¿Quién absorbe la atención humana de excepciones, con qué SLA?
8. ¿Qué precio/costo/margen por servicio es verificable?
9. ¿Qué acuerdos y límites legales aplicarían si luego se incorporan historiales externos?

## 15. Backlog de implementación inmediato (vertical slice)

1. Seed sintético de 3 vehículos (uno `UPCOMING`, uno `UNKNOWN`, uno con caso crítico conversacional), dos talleres y disponibilidad limitada.
2. Implementar `maintenanceRules.evaluate()` como función pura con tests de fechas, distancias y prioridades.
3. API de herramientas mock con esquemas tipados, errores y `trace_id`.
4. State machine del journey, eventos inmutables, consentimiento de demo y confirmación explícita.
5. UI: ficha de vehículo → plan → conversación contextual → cotización → agenda → confirmación.
6. Panel de «qué hizo el agente» con llamadas, motivos, reglas y handoffs.
7. Tres pruebas E2E: éxito, historial insuficiente, riesgo de seguridad; extra: conflicto de reserva.
8. Checklist de evaluación y video/capturas solo después de superar la Definition of Done.

---

### Declaración corta del uso de IA (para incorporar al paquete final)

«Se utilizaron herramientas de IA generativa para explorar alternativas de producto, estructurar el PRD, revisar escenarios de excepción y apoyar la implementación de un prototipo con datos simulados. Las fuentes, hipótesis, reglas y decisiones de producto fueron contrastadas y/o identificadas explícitamente como pendientes de validación. La IA no se empleó como fuente de intervalos de mantenimiento ni para certificación mecánica».

### Límites del documento

La agencia, los datos de vehículos, los umbrales de aviso, los cupos de taller y los casos de prueba son **ficticios** salvo indicación contraria. Este PRD no sustituye manuales técnicos oficiales, asesoría legal ni validación operativa. La reproducción de consultas a RUNT, SOAT o terceros requeriría comprobar condiciones de acceso y autorización antes de cualquier integración.
