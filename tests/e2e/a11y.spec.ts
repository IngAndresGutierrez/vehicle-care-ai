import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { advisorOf, openAssistant, say, startScenario, switchPersona } from "./helpers";

/** WCAG 2.1 A/AA con axe-core. Se reportan todas las violaciones; la prueba falla si hay serias o críticas. */
async function audit(page: Page, name: string, project: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")} :: ${(n.any[0]?.message ?? "").slice(0, 140)}`) }));
  mkdirSync("prd/reports/evidence/a11y", { recursive: true });
  writeFileSync(`prd/reports/evidence/a11y/${project}-${name}.json`, JSON.stringify({ url: new URL(page.url()).pathname.replace(/demo-[0-9a-f]{8}-/, "demo-<run>-"), passes: r.passes.length, violations: summary }, null, 2));
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), JSON.stringify(summary, null, 2)).toEqual([]);
}

test("accesibilidad (axe): portada, portal con asistente, trazas y bandeja", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByTestId("start-A")).toBeVisible();
  await audit(page, "portada", info.project.name);

  const vehicleId = await startScenario(page, "C");
  await audit(page, "portal", info.project.name);
  await openAssistant(page);
  await say(page, "El freno se hunde y casi no detiene el carro");
  await audit(page, "asistente-seguridad", info.project.name);

  await page.goto(`/trazas/${vehicleId}?servicio=ENGINE_OIL_FILTER`);
  await expect(page.getByTestId("timeline")).toBeVisible();
  await audit(page, "trazas", info.project.name);

  await switchPersona(page, advisorOf(vehicleId), "/casos");
  await expect(page.getByRole("button", { name: "Resolver caso" })).toBeVisible();
  await page.getByRole("button", { name: "Resolver caso" }).click();
  await audit(page, "bandeja", info.project.name);
});
