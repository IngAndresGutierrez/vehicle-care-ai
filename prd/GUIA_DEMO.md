# Guía de demostración (4 a 5 minutos)

**Antes de empezar (2 min, fuera del tiempo):**
- `pnpm db:up && pnpm build && pnpm start` con `DEMO_MODE=true` y `LLM_PROVIDER=scripted`.
- Navegador en `http://localhost:3000`, ventana de escritorio. Para mostrar el diseño móvil, usar las herramientas de desarrollo (Pixel 7).
- Plan B si algo falla: las capturas de `prd/reports/screenshots/` siguen el mismo orden.

**Qué decir siempre:** «Los datos son sintéticos y el taller y el CRM son simulados. El asistente que ven es **ScriptedLlm, una simulación determinista**, no IA generativa. El adaptador para Claude está implementado, pero no lo hemos probado en vivo».

| Tiempo | Pantalla y acción | Qué señalar (herramientas, decisiones, fuentes, handoffs) |
|---|---|---|
| **0:00–0:30** | Portada | El problema: el primer mantenimiento del comprador de usado. Cuatro escenarios, cada uno con identidades sintéticas aisladas. Sellos punteados = simulado. Etiqueta «Asistente simulado (ScriptedLlm)» |
| **0:30–1:50** | **A.** «Iniciar escenario A» → portal | **Decisión técnica:** el odómetro (74.200 km) y la regla de km dicen «Toca a los 75.000 km o el 2 abr 2027». En «Regla aplicada» se ven el intervalo, el plan `demo-2026.10-r1`, la fuente `SYNTHETIC-DEMO` y la versión del motor. El motor decide; el LLM no calcula |
| | Asistente: pulsar las sugerencias en orden («¿Qué mantenimiento…?», «¿Cuánto cuesta?», «¿Qué horarios hay?», «Reserva el primer horario») | **Herramientas:** cada tarjeta sale del resultado de una herramienta, no del texto. «Catálogo simulado» marca 333.200 COP y «Agenda simulada» los horarios. La tarjeta de reserva muestra la cuenta regresiva y la frase «el asistente no puede confirmar por ti» |
| | «Confirmar reserva» | **Autorización humana:** solo este clic confirma. Aparece el folio `FOLIO-T1-DEMO-…` del taller simulado y el estado pasa a «Reservado» |
| | Menú «Trazas» | **Trazabilidad:** la línea de tiempo numerada mezcla eventos del journey y llamadas a herramientas, con su fuente («Sistema simulado» o interno), estado y responsable. «Eventos y estado coinciden» es la verificación por *replay*. No hay tokens ni placa completa |
| **1:50–2:50** | **C.** Portada → «Iniciar escenario C» → «El freno se hunde…» | **Seguridad antes del LLM:** el léxico detecta el síntoma y el servidor responde con una plantilla (provisional, pendiente de aprobación técnica). El asistente dice «El asistente dejó de actuar…» y el estado pasa a «Escalado por seguridad» |
| | Sugerencia «Entonces cotízame…» | **Bloqueo comercial:** no hay cotización. En las trazas se ve `TOOL_NOT_ALLOWED_IN_STATE` |
| | «Ver como → Asesor, escenario C» → bandeja | **Handoff:** caso urgente asignado a «Tú», con plazo, contexto mínimo y el aviso «El asistente está detenido». «Resolver caso → Habilitar el agendamiento» con una nota: la decisión es humana y queda en las trazas |
| **2:50–3:30** | **B.** Portada → «Iniciar escenario B» → servicio «Correa de distribución» | **No inventa:** «Sin datos suficientes» y «No hay constancia de un servicio anterior». Preguntar «¿Debo cambiar la correa…?» abre un caso para un asesor, sin cotización |
| **3:30–4:20** | **D.** Portada → «Iniciar escenario D» → 4 sugerencias → «Simular que otro cliente tomó el cupo» → «Confirmar reserva» | **Recuperación:** «Otro cliente tomó ese horario… No se creó ninguna reserva». La sugerencia «¿Qué horarios hay?» ofrece alternativas; reservar y confirmar entrega un folio nuevo. Hay una sola reserva, porque la confirmación es idempotente |
| **4:20–5:00** | Cierre (sin pantalla o con `ENTREGA.md`) | **Evidencia:** 25 E2E en escritorio y móvil, axe sin violaciones y una evaluación agéntica de 12 casos con ScriptedLlm (0 precios ni km inventados, 0 reservas sin clic, 4/4 de seguridad). **Límites:** sistemas MOCK, LLM real sin medir y costo de IA de 780 COP estimado en el modelo. **Decisión solicitada:** piloto por compuertas (resumen ejecutivo p. 2) |

**Preguntas probables del comité:**
- *«¿El modelo financiero usa estos números?»* No. El modelo es una proyección con supuestos; el prototipo no produce métricas de mercado. Ver `AUDITORIA_CONSISTENCIA.md` §1: el ticket real es la variable crítica.
- *«¿Y con Claude real?»* El adaptador está listo. La medición se ejecuta con `EVAL_LLM=anthropic EVAL_BUDGET_USD=… pnpm eval:agent` y requiere aprobar el gasto.
- *«¿Qué falta para producción?»* El inventario MOCK y real está en `ENTREGA.md` §4.
