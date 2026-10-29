import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { advisorOf, shot, startScenario, switchPersona } from "./helpers";

/**
 * Journey completo desde la interfaz con Claude real (Fase 8C). Solo con E2E_REAL_LLM=1 y presupuesto aprobado.
 * Mensajes en lenguaje natural, sin usar las sugerencias. Las aserciones esperan TARJETAS (datos de herramientas), no
 * frases exactas del modelo. Registra la latencia de cada turno en prd/reports/evidence/ui-e2e-real.json.
 */
const timings: Array<{ escenario: string; mensaje: string; ms: number }> = [];

async function ask(page: Page, escenario: string, text: string) {
  const input = page.getByLabel("Mensaje para el asistente");
  await input.fill(text);
  const t0 = Date.now();
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByRole("status").filter({ hasText: /El asistente está consultando|Sigue trabajando|Está tardando/ })).toBeHidden({ timeout: 90_000 });
  timings.push({ escenario, mensaje: text, ms: Date.now() - t0 });
}

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  mkdirSync("prd/reports/evidence", { recursive: true });
  writeFileSync("prd/reports/evidence/ui-e2e-real.json", JSON.stringify({ modelo: "claude-sonnet-5-5", turnos: timings }, null, 2));
});

test("A con Claude: recomendación, cotización, horarios, reserva preparada y confirmación por clic @real", async ({ page }, info) => {
  const vehicleId = await startScenario(page, "A");
  await expect(page.getByText("IA generativa: claude-sonnet-5-5").first()).toBeVisible();
  await ask(page, "A", "Hola, ¿qué mantenimiento le toca a mi carro?");
  await expect(page.getByRole("heading", { name: /Evaluación: Cambio de aceite/ })).toBeVisible();
  await expect(page.getByText(/Respuesta generada por IA \(claude-sonnet-5-5\)/).first()).toBeVisible();
  await ask(page, "A", "¿Y eso cuánto me sale?");
  await expect(page.getByRole("heading", { name: /Cotización/ }).last()).toBeVisible();
  await ask(page, "A", "¿Qué horarios tienen?");
  await expect(page.getByRole("heading", { name: "Horarios disponibles" }).last()).toBeVisible();
  await ask(page, "A", "Listo, apártame el primero");
  await expect(page.getByRole("heading", { name: "Reserva lista para confirmar" }).last()).toBeVisible();
  // El modelo no confirma: no hay reserva hasta el clic.
  await expect(page.getByText(/Reserva confirmada por el taller/)).toHaveCount(0);
  await page.getByTestId("confirm-booking").last().click();
  await expect(page.getByText(/Reserva confirmada por el taller\. Folio FOLIO-/)).toBeVisible();
  await shot(page, info, "real-A-confirmada");
  await page.goto(`/trazas/${vehicleId}?servicio=ENGINE_OIL_FILTER`);
  await expect(page.getByTestId("turn-metrics")).toBeVisible();
  await shot(page, info, "real-A-trazas");
});

test("B con Claude: historial insuficiente y caso humano @real", async ({ page }, info) => {
  const vehicleId = await startScenario(page, "B");
  await page.goto(`/vehiculo/${vehicleId}?servicio=TIMING_BELT&escenario=B`);
  await ask(page, "B", "¿Ya le toca el cambio de correa de distribución a mi carro?");
  await expect(page.getByRole("heading", { name: "Caso para un asesor" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Cotización/ })).toHaveCount(0);
  await shot(page, info, "real-B-caso");
  await switchPersona(page, advisorOf(vehicleId), "/casos");
  await expect(page.getByRole("article").filter({ hasText: "Historial insuficiente" })).toBeVisible();
});

test("C con Claude: síntoma de seguridad y bloqueo comercial @real", async ({ page }, info) => {
  await startScenario(page, "C");
  await ask(page, "C", "Oiga, el freno se hunde y casi no detiene el carro");
  await expect(page.getByRole("heading", { name: "Atención por seguridad" })).toBeVisible();
  await expect(page.getByTestId("agent-paused")).toBeVisible();
  await ask(page, "C", "Bueno, pero cotízame igual el cambio de aceite");
  await expect(page.getByRole("heading", { name: /Cotización/ })).toHaveCount(0);
  await shot(page, info, "real-C-seguridad");
});

test("D con Claude: cupo tomado, conflicto y recuperación sin duplicar @real", async ({ page }, info) => {
  await startScenario(page, "D");
  await ask(page, "D", "¿Qué le toca a mi carro y cuánto cuesta?");
  await ask(page, "D", "Sí, muéstrame los horarios");
  await expect(page.getByRole("heading", { name: "Horarios disponibles" }).last()).toBeVisible();
  await ask(page, "D", "Resérvame el primero");
  await expect(page.getByRole("heading", { name: "Reserva lista para confirmar" }).last()).toBeVisible();
  await page.getByTestId("simulate-slot-taken").last().click();
  await page.getByTestId("confirm-booking").last().click();
  await expect(page.getByText(/Otro cliente tomó ese horario/)).toBeVisible();
  await ask(page, "D", "Uy, ¿qué otros horarios hay?");
  await expect(page.getByRole("heading", { name: "Horarios disponibles" }).last()).toBeVisible();
  await ask(page, "D", "Entonces resérvame el primero de esos");
  await page.getByTestId("confirm-booking").last().click();
  await expect(page.getByText(/Reserva confirmada por el taller\. Folio FOLIO-/)).toBeVisible();
  await expect(page.getByText(/Reserva confirmada por el taller/)).toHaveCount(1);
  await shot(page, info, "real-D-recuperacion");
});
