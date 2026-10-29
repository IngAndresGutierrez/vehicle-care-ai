import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

export const SHOTS = "prd/reports/screenshots";

export async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png`, fullPage: true });
}

/** Inicia un escenario desde la portada (UI) y espera el portal del vehículo. */
export async function startScenario(page: Page, key: "A" | "B" | "C" | "D") {
  await page.goto("/");
  await page.getByTestId(`start-${key}`).click();
  await page.waitForURL(/\/vehiculo\//);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return page.url().match(/\/vehiculo\/([^?]+)/)![1];
}

/** En móvil el asistente vive en una pestaña. */
export async function openAssistant(page: Page) {
  const tab = page.getByRole("tab", { name: "Asistente" });
  if (await tab.isVisible()) await tab.click();
}

export async function openVehicleTab(page: Page) {
  const tab = page.getByRole("tab", { name: "Mi vehículo" });
  if (await tab.isVisible()) await tab.click();
}

/** Envía un mensaje al asistente y espera a que termine el turno. */
export async function say(page: Page, text: string) {
  const input = page.getByLabel("Mensaje para el asistente");
  await input.fill(text);
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByText("El asistente está consultando")).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText(text, { exact: true }).last()).toBeVisible();
}

export async function switchPersona(page: Page, actorId: string, then: string) {
  const res = await page.request.post("/api/demo/session", { data: { actorId } });
  expect(res.ok()).toBeTruthy();
  await page.goto(then);
}

/** Corrida por API (para pruebas de seguridad): devuelve el contexto con la cookie del propietario. */
export async function apiRun(request: APIRequestContext, scenario: "A" | "B" | "C" | "D") {
  const res = await request.post("/api/demo/scenarios", { data: { scenario } });
  expect(res.status()).toBe(200);
  return (await res.json()) as { runId: string; ownerActorId: string; vehicleId: string; serviceCode: string };
}

export async function apiTurn(request: APIRequestContext, vehicleId: string, message: string, sessionId?: string) {
  const res = await request.post("/api/agent/turn", { data: { vehicleId, message, ...(sessionId ? { sessionId } : {}) } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { sessionId: string; journey: { state: string }; cards: Array<{ type: string; confirmationToken?: string }> };
}

/** Lleva una corrida por API hasta AWAITING_CONFIRMATION y devuelve el token de confirmación. */
export async function apiToIntent(request: APIRequestContext, vehicleId: string) {
  let s = await apiTurn(request, vehicleId, "¿Qué mantenimiento le toca a mi carro?");
  s = await apiTurn(request, vehicleId, "¿Cuánto cuesta?", s.sessionId);
  s = await apiTurn(request, vehicleId, "¿Qué horarios hay?", s.sessionId);
  s = await apiTurn(request, vehicleId, "Reserva el primer horario", s.sessionId);
  expect(s.journey.state).toBe("AWAITING_CONFIRMATION");
  const token = s.cards.find((c) => c.type === "BOOKING_INTENT")?.confirmationToken;
  expect(token).toBeTruthy();
  return { token: token!, sessionId: s.sessionId };
}
