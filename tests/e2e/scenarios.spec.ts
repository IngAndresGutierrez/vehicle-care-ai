import { expect, test } from "@playwright/test";
import { advisorOf, openAssistant, openVehicleTab, say, shot, startScenario, switchPersona } from "./helpers";

test.describe("Escenarios de demo (ScriptedLlm, datos sintéticos)", () => {
  test("portada: selector de escenarios rotulado como simulación", async ({ page }, info) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Escenarios de demostración" })).toBeVisible();
    await expect(page.getByText("Asistente simulado (ScriptedLlm)").first()).toBeVisible();
    await expect(page.getByText("Personas, vehículos, talleres y precios son sintéticos")).toBeVisible();
    for (const k of ["A", "B", "C", "D"]) await expect(page.getByTestId(`start-${k}`)).toBeVisible();
    await shot(page, info, "00-portada");
  });

  test("A: éxito hasta folio del taller simulado", async ({ page }, info) => {
    const vehicleId = await startScenario(page, "A");
    await expect(page.getByRole("img", { name: /Kilometraje actual/ })).toBeVisible();
    await expect(page.getByTestId("status-sentence")).toContainText("Toca a los");
    await expect(page.getByText("Regla sintética de demo").first()).toBeVisible();
    await shot(page, info, "A1-portal");

    await openAssistant(page);
    await say(page, "¿Qué mantenimiento le toca a mi carro?");
    await expect(page.getByRole("heading", { name: /Evaluación: Cambio de aceite/ })).toBeVisible();
    await say(page, "¿Cuánto cuesta?");
    await expect(page.getByText("$ 333.200").first()).toBeVisible();
    await say(page, "¿Qué horarios hay?");
    await expect(page.getByRole("heading", { name: "Horarios disponibles" })).toBeVisible();
    await say(page, "Reserva el primer horario");
    await expect(page.getByRole("heading", { name: "Reserva lista para confirmar" })).toBeVisible();
    await expect(page.getByText("El asistente no puede confirmar por ti")).toBeVisible();
    await shot(page, info, "A2-intencion");

    await page.getByTestId("confirm-booking").click();
    await expect(page.getByText(/Reserva confirmada por el taller\. Folio FOLIO-/)).toBeVisible();
    await expect(page.getByTestId("journey-state")).toHaveText("Reservado");
    await shot(page, info, "A3-confirmada");

    await openVehicleTab(page);
    await expect(page.getByTestId("booking-folio")).toHaveText(/FOLIO-T1-DEMO-/);

    await page.goto(`/trazas/${vehicleId}?servicio=ENGINE_OIL_FILTER`);
    await expect(page.getByTestId("trace-state")).toHaveText("Reservado");
    const timeline = page.getByTestId("timeline");
    await expect(timeline).toContainText("Herramienta: Cotización");
    await expect(timeline).toContainText("Reserva confirmada");
    await expect(timeline).toContainText("Sistema simulado");
    await expect(page.getByText("Eventos y estado coinciden")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("confirmationToken");
    await shot(page, info, "A4-trazas");
  });

  test("B: historial insuficiente → UNKNOWN → caso humano", async ({ page }, info) => {
    const vehicleId = await startScenario(page, "B");
    await page.goto(`/vehiculo/${vehicleId}?servicio=TIMING_BELT&escenario=B`);
    await expect(page.getByTestId("status-sentence")).toContainText("No hay datos suficientes");
    await expect(page.getByText("No hay constancia de un servicio anterior").first()).toBeVisible();
    await openAssistant(page);
    await say(page, "¿Debo cambiar la correa de distribución?");
    await expect(page.getByRole("heading", { name: "Caso para un asesor" })).toBeVisible();
    await expect(page.getByText("Cotización", { exact: true })).toHaveCount(0);
    await shot(page, info, "B1-caso-humano");

    await switchPersona(page, advisorOf(vehicleId), "/casos");
    const card = page.getByRole("article").filter({ hasText: "Historial insuficiente" }).filter({ has: page.locator(`a[href^="/trazas/${vehicleId}"]`) });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Tú");
    await shot(page, info, "B2-bandeja");
    await card.getByRole("button", { name: "Resolver caso" }).click();
    await card.getByRole("radio", { name: "Cerrar el caso" }).check();
    await card.getByLabel("Nota de resolución").fill("Cliente sin constancia; se agenda inspección presencial.");
    await card.getByRole("button", { name: "Registrar decisión" }).click();
    await expect(card).toHaveCount(0); // sale de «Abiertos»
  });

  test("C: seguridad → SAFETY_ESCALATED → bloqueo comercial", async ({ page }, info) => {
    const vehicleId = await startScenario(page, "C");
    await openAssistant(page);
    await say(page, "El freno se hunde y casi no detiene el carro");
    await expect(page.getByRole("heading", { name: "Atención por seguridad" })).toBeVisible();
    await expect(page.getByTestId("agent-paused")).toBeVisible();
    await expect(page.getByTestId("journey-state")).toHaveText("Escalado por seguridad");
    await say(page, "Entonces cotízame el mantenimiento");
    await expect(page.getByRole("heading", { name: /Cotización/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Reserva lista para confirmar" })).toHaveCount(0);
    await shot(page, info, "C1-seguridad");

    await switchPersona(page, advisorOf(vehicleId), "/casos");
    const card = page.getByRole("article").filter({ hasText: "Síntoma de seguridad" }).filter({ has: page.locator(`a[href^="/trazas/${vehicleId}"]`) });
    await expect(card).toContainText("Prioridad urgente");
    await expect(card).toContainText("El asistente está detenido");
    await shot(page, info, "C2-bandeja-urgente");
    // Acción humana autorizada: habilita de nuevo el agendamiento; el journey sale de SAFETY_ESCALATED.
    await card.getByRole("button", { name: "Resolver caso" }).click();
    await card.getByRole("radio", { name: "Habilitar el agendamiento" }).check();
    await card.getByLabel("Nota de resolución").fill("Inspección de frenos realizada en taller; vehículo apto.");
    await card.getByRole("button", { name: "Registrar decisión" }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole("button", { name: "Todos" }).click();

    await page.goto(`/trazas/${vehicleId}?servicio=ENGINE_OIL_FILTER`);
    await expect(page.getByTestId("timeline")).toContainText("Señal de seguridad");
    await expect(page.getByTestId("timeline")).toContainText("Caso resuelto por una persona");
    await shot(page, info, "C3-trazas");
  });

  test("D: cupo tomado → alternativas → nueva confirmación", async ({ page }, info) => {
    await startScenario(page, "D");
    await openAssistant(page);
    await say(page, "¿Qué mantenimiento le toca a mi carro?");
    await say(page, "¿Cuánto cuesta?");
    await say(page, "¿Qué horarios hay?");
    await say(page, "Reserva el primer horario");
    await page.getByTestId("simulate-slot-taken").click();
    await expect(page.getByText(/Simulación de demo: otro cliente tomó el horario/)).toBeVisible();
    await page.getByTestId("confirm-booking").click();
    await expect(page.getByText(/Otro cliente tomó ese horario antes de tu confirmación/)).toBeVisible();
    await shot(page, info, "D1-conflicto");

    await page.getByRole("button", { name: "¿Qué horarios hay?" }).click();
    await expect(page.getByText("El asistente está consultando")).toBeHidden({ timeout: 30_000 });
    await say(page, "Reserva el primer horario");
    await page.getByTestId("confirm-booking").last().click();
    await expect(page.getByText(/Reserva confirmada por el taller\. Folio FOLIO-/)).toBeVisible();
    await shot(page, info, "D2-nueva-confirmacion");
  });
});
