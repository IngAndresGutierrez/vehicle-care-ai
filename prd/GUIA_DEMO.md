# Guía de demostración y guion de grabación (máx. 5 min)

No hay despliegue público (ver `prd/DESPLIEGUE.md`). La demostración se hace **en local** y puede grabarse con el guion de §3.

**Mensajes que se dicen siempre** (decisiones D1–D6 de `prd/ENTREGA.md` §7):
- Los datos son **sintéticos**. Taller, CRM, agenda, autenticación y mensajería son **simulados**.
- El asistente es **ScriptedLlm, una simulación determinista**. **No se ha validado un LLM real.**
- El modelo financiero usa **Claude Sonnet 4.6 como hipótesis**, y los **780 COP por conversación son una estimación**.
- El ticket base es de **450.000 COP**. Con **280.000 COP netos**, el VPN base sería **≈ −95,5 M COP**.
- La ventana de **180 días** es un criterio de segmentación del piloto, no una regla del motor.
- El texto de seguridad es **provisional** y requiere aprobación de un responsable técnico antes de operar con clientes reales.

## 1. Demostración local reproducible

Requisitos: Node ≥ 24, pnpm, Docker Desktop **abierto**.

```bash
pnpm install
cp .env.example .env                 # DEMO_MODE=true, LLM_PROVIDER=scripted (sin costo)
pnpm db:up                           # PostgreSQL en localhost:54329
pnpm db:migrate:deploy && pnpm db:seed
pnpm build && pnpm start             # http://localhost:3000
```

**Verificación previa (30 s):**

```bash
curl -s localhost:3000/api/demo/config | grep -o '"demoMode":true\|"simulated":true'   # ambas líneas deben aparecer
pnpm test:e2e --project=desktop tests/e2e/scenarios.spec.ts        # opcional: 5 pruebas de A–D en verde
```

**Problemas frecuentes:**
- `ECONNREFUSED` → Docker está cerrado: abre Docker Desktop y repite `pnpm db:up`.
- Puerto ocupado → `pnpm start --port 3001`.
- Página en blanco tras reconstruir → detén el servidor anterior (`pkill -f next-server`) y vuelve a ejecutar `pnpm start`.

Cada escenario crea **datos nuevos y aislados**: se puede repetir la demostración sin reiniciar la base.

## 2. Guía de presentación en vivo (4–5 min)

| Tiempo | Acción | Qué señalar |
|---|---|---|
| 0:00–0:30 | Portada | Problema: primer mantenimiento del comprador de usado. Sellos punteados = simulado. Etiqueta «Asistente simulado (ScriptedLlm)» |
| 0:30–1:50 | **A:** iniciar → portal → 4 sugerencias → «Confirmar reserva» → «Trazas» | **El motor decide:** 74.200 km frente al límite de 75.000 km, con regla, plan y fuente `SYNTHETIC-DEMO`. **Las herramientas producen las tarjetas:** catálogo y agenda simulados. **Solo el clic confirma:** folio del taller simulado. En las trazas: herramientas, fuente, estado, responsable y consistencia |
| 1:50–2:50 | **C:** iniciar → «El freno se hunde…» → «Entonces cotízame…» → «Ver como → Asesor, escenario C» → resolver | La seguridad actúa antes del LLM, con una plantilla provisional (D6). El asistente se detiene, no hay cotización (`TOOL_NOT_ALLOWED_IN_STATE`) y el handoff llega a la bandeja: urgente, asignado y con decisión humana |
| 2:50–3:30 | **B:** iniciar → servicio «Correa de distribución» → «¿Debo cambiar la correa…?» | «Sin datos suficientes»: no se inventa el intervalo y se abre un caso para un asesor |
| 3:30–4:20 | **D:** iniciar → 4 sugerencias → «Simular que otro cliente tomó el cupo» → confirmar → «¿Qué horarios hay?» → reservar → confirmar | El conflicto no crea ninguna reserva; hay alternativas y un folio nuevo, sin duplicados |
| 4:20–5:00 | Cierre | Evidencia: 25 E2E, axe sin violaciones, evaluación de 12 casos con ScriptedLlm. Límites y decisiones D1–D6. Decisión solicitada: piloto por compuertas |

## 3. Guion de grabación (4:50 máximo)

**Configuración:**
- Ventana del navegador a 1440×900, zoom 100 %, solo la pestaña de la demo, sin marcadores ni notificaciones.
- Grabación de pantalla con micrófono (en macOS, `⌘⇧5`).
- Ensayar una vez: cada escenario nuevo usa datos limpios.

| Marca | Pantalla | Narración (leer textual) |
|---|---|---|
| **0:00** | Portada | «Vehicle Care acompaña al comprador de un carro usado en su primer mantenimiento. Todo lo que verán usa datos sintéticos y sistemas simulados, marcados con este sello. El asistente es ScriptedLlm, una simulación determinista: no estamos mostrando un LLM real validado». |
| **0:25** | Clic en «Iniciar escenario A» | «Escenario A. El portal muestra el odómetro, 74.200 km. El motor de reglas, no el modelo de lenguaje, calcula que el cambio de aceite toca a los 75.000 km, y muestra la regla, el plan y su fuente sintética». |
| **0:50** | Pulsar las 4 sugerencias | «El asistente consulta herramientas: evaluación, talleres, cotización del catálogo simulado y horarios de la agenda simulada. Cada tarjeta viene del resultado de una herramienta, no del texto del modelo». |
| **1:25** | «Confirmar reserva» | «El agente no puede confirmar: solo este clic del propietario reserva. El taller simulado devuelve el folio». |
| **1:40** | Menú «Trazas» | «La traza muestra cada paso: herramienta, fuente, estado del journey y responsable, sin tokens ni datos sensibles». |
| **2:00** | Portada → «Iniciar escenario C» → «El freno se hunde y casi no detiene el carro» | «Escenario C, riesgo de seguridad. El servidor detecta el síntoma antes del modelo y detiene al asistente. El texto es provisional y debe aprobarlo un responsable técnico antes de operar con clientes». |
| **2:25** | «Entonces cotízame el mantenimiento» | «Aunque el cliente insista, no hay cotización: el flujo comercial queda bloqueado». |
| **2:40** | «Ver como → Asesor, escenario C» → «Resolver caso» → «Habilitar el agendamiento» + nota → «Registrar decisión» | «El caso llega a la bandeja del asesor como urgente. La decisión es humana y queda registrada». |
| **3:05** | Portada → «Iniciar escenario B» → «Correa de distribución» → «¿Debo cambiar la correa de distribución?» | «Escenario B, historial insuficiente. No hay constancia de un cambio anterior, así que el sistema no inventa un intervalo: abre un caso para un asesor». |
| **3:30** | Portada → «Iniciar escenario D» → 4 sugerencias → «Simular que otro cliente tomó el cupo» → «Confirmar reserva» | «Escenario D. Otro cliente toma el horario antes de confirmar. No se crea ninguna reserva». |
| **3:55** | «¿Qué horarios hay?» → «Reserva el primer horario» → «Confirmar reserva» | «El asistente ofrece alternativas y la nueva confirmación produce un solo folio, sin duplicados». |
| **4:15** | Portada (o `prd/ENTREGA.md`) | «Esto está respaldado por 25 pruebas end-to-end en escritorio y móvil, una revisión de accesibilidad sin violaciones y una evaluación de 12 casos con ScriptedLlm. En el modelo financiero, Claude Sonnet 4.6 es una hipótesis y los 780 COP por conversación son una estimación. El ticket base es de 450.000 COP; con 280.000 el VPN base caería a unos −95,5 millones. Por eso pedimos un piloto por compuertas para validarlo». |
| **4:50** | Fin | — |

**Después de grabar:** verificar que dura 5 minutos o menos, que se oyen las frases sobre simulación y estimación y que no aparecen datos personales reales.
