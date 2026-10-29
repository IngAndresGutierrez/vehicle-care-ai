import { randomBytes } from "node:crypto";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import type { ActorContext } from "@/domain/policies/access-policy";
import { addDaysToLocalDate, daysBetween, toLocalDate } from "@/domain/shared/local-date";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { MockNotificationPort } from "@/integrations/mock/mock-notifications";
import { audit } from "../booking/common";
import { appError, type AppError } from "../errors";
import { runEvaluationJob } from "../run-evaluation-job";
import { runInTransaction } from "../transaction";

/**
 * ⚠️ SOLO DEMO (DEMO_MODE). Corridas aisladas de los escenarios A–D (ADR-019).
 *
 * «Reiniciar» un escenario no borra nada: crea una corrida nueva clonando el vehículo plantilla SINTÉTICO del seed
 * con un propietario sintético propio y las fechas desplazadas al reloj actual, de modo que cada visitante tiene sus
 * propios datos, el historial auditable (append-only) se conserva y el escenario se comporta igual cualquier día.
 * No crea intervalos, precios ni reglas: reutiliza plan, catálogo y especificaciones existentes.
 */
export type DemoScenarioKey = "A" | "B" | "C" | "D";

const { vehicles: V, customers: C, actors: A } = DEMO_IDS;

export const DEMO_SCENARIOS: Record<DemoScenarioKey, { title: string; description: string; templateVehicleId: string; consentTemplateCustomerId: string; serviceCode: string; suggestedMessages: string[] }> = {
  A: {
    title: "Primer mantenimiento con reserva",
    description: "Cambio de aceite próximo. Cotización, horario, confirmación y folio del taller simulado.",
    templateVehicleId: V.v1,
    consentTemplateCustomerId: C.c1,
    serviceCode: "ENGINE_OIL_FILTER",
    suggestedMessages: ["¿Qué mantenimiento le toca a mi carro?", "¿Cuánto cuesta?", "¿Qué horarios hay?", "Reserva el primer horario"],
  },
  B: {
    title: "Historial insuficiente",
    description: "Correa de distribución sin constancia de cambio. El sistema no inventa un intervalo y abre un caso.",
    templateVehicleId: V.v2,
    consentTemplateCustomerId: C.c2,
    serviceCode: "TIMING_BELT",
    suggestedMessages: ["¿Debo cambiar la correa de distribución?"],
  },
  C: {
    title: "Síntoma de seguridad",
    description: "El propietario reporta frenos. El asistente se detiene y una persona toma el caso con prioridad urgente.",
    templateVehicleId: V.v3,
    consentTemplateCustomerId: C.c3,
    serviceCode: "ENGINE_OIL_FILTER",
    suggestedMessages: ["El freno se hunde y casi no detiene el carro", "Entonces cotízame el mantenimiento"],
  },
  D: {
    title: "Cupo que desaparece",
    description: "Otro cliente toma el horario elegido antes de confirmar. Se ofrecen alternativas sin duplicar la reserva.",
    templateVehicleId: V.v1,
    consentTemplateCustomerId: C.c1,
    serviceCode: "ENGINE_OIL_FILTER",
    suggestedMessages: ["¿Qué mantenimiento le toca a mi carro?", "¿Cuánto cuesta?", "¿Qué horarios hay?", "Reserva el primer horario"],
  },
};

export interface DemoRun {
  runId: string;
  scenario: DemoScenarioKey;
  ownerActorId: string;
  /** Asesor sintético de esta corrida: su cartera es solo este cliente (aislamiento entre visitantes, ADR-020). */
  advisorActorId: string;
  customerId: string;
  vehicleId: string;
  serviceCode: string;
}

const SYSTEM_JOB: ActorContext = { actorId: A.systemJob, role: "SYSTEM_JOB", customerId: null, workshopId: null };

export async function startDemoScenario({ db, clock }: { db: Db; clock: Clock }, { scenario, traceId }: { scenario: DemoScenarioKey; traceId: string }): Promise<Result<DemoRun, AppError>> {
  const def = DEMO_SCENARIOS[scenario];
  if (!def) return err(appError("INVALID_INPUT", "UNKNOWN_SCENARIO"));
  const now = clock.now();
  const offsetMs = now.getTime() - DEMO_NOW.getTime();
  const dayOffset = daysBetween(toLocalDate(DEMO_NOW), toLocalDate(now));
  const shift = (d: Date) => new Date(d.getTime() + offsetMs);
  const shiftDay = (d: Date) => new Date(`${addDaysToLocalDate(d.toISOString().slice(0, 10), dayOffset)}T00:00:00.000Z`);

  const runId = randomBytes(4).toString("hex");
  const ids = { customer: `demo-${runId}-cliente`, owner: `demo-${runId}-propietario`, advisor: `demo-${runId}-asesor`, vehicle: `demo-${runId}-vehiculo` };
  const src = (what: string) => `SYNTHETIC-DEMO:demo-run/${runId}/${what}`;

  const template = await db.vehicle.findUnique({
    where: { id: def.templateVehicleId },
    include: { serviceRecords: { include: { workOrder: true } }, odometerReadings: true },
  });
  const consentTemplate = await db.consent.findMany({ where: { customerId: def.consentTemplateCustomerId }, include: { events: true } });
  if (!template) return err(appError("NOT_FOUND", "DEMO_TEMPLATE_MISSING"));

  const created = await runInTransaction<DemoRun, AppError>(db, async (tx) => {
    await tx.customer.create({ data: { id: ids.customer, displayName: `Cliente demo ${runId}`, city: "Ciudad Demo", dataOrigin: "SYNTHETIC", syntheticSourceRef: src("cliente") } });
    await tx.actorAccount.create({ data: { id: ids.owner, role: "OWNER", displayName: `Propietario demo ${runId}`, customerId: ids.customer, isDemo: true } });
    await tx.actorAccount.create({ data: { id: ids.advisor, role: "ADVISOR", displayName: `Asesor demo ${runId}`, isDemo: true } });
    for (const c of consentTemplate) {
      await tx.consent.create({
        data: {
          customerId: ids.customer,
          purpose: c.purpose,
          channel: c.channel,
          isGranted: c.isGranted,
          events: {
            create: c.events.map((e) => ({ action: e.action, legalTextVersion: e.legalTextVersion, evidenceRef: src(`consentimiento/${c.purpose}/${c.channel}`), capturedVia: e.capturedVia, capturedById: ids.owner, occurredAt: shift(e.occurredAt) })),
          },
        },
      });
    }
    await tx.vehicle.create({
      data: {
        id: ids.vehicle,
        plate: `DEMO${runId.toUpperCase()}`,
        specId: template.specId,
        deliveredAt: template.deliveredAt ? shift(template.deliveredAt) : null,
        deliveryOdometerKm: template.deliveryOdometerKm,
        usageCondition: template.usageCondition,
        dataOrigin: "SYNTHETIC",
        syntheticSourceRef: src("vehiculo"),
      },
    });
    await tx.vehicleOwnership.create({ data: { vehicleId: ids.vehicle, customerId: ids.customer, validFrom: shift(template.deliveredAt ?? DEMO_NOW), evidenceRef: src("titularidad") } });
    // Cada corrida tiene su propio asesor sintético: un visitante nunca ve los casos de otro (ADR-020).
    await tx.portfolioAssignment.create({ data: { actorId: ids.advisor, customerId: ids.customer, validFrom: new Date(now.getTime() - 86_400_000) } });

    for (const [i, r] of template.serviceRecords.entries()) {
      let workOrderId: string | null = null;
      if (r.workOrder) {
        const wo = await tx.workOrder.create({
          data: {
            vehicleId: ids.vehicle,
            externalRef: `OT-${runId}-${i}`,
            status: r.workOrder.status,
            completedAt: r.workOrder.completedAt ? shift(r.workOrder.completedAt) : null,
            completedById: r.workOrder.completedById,
            completionOdometerKm: r.workOrder.completionOdometerKm,
            dataOrigin: "SYNTHETIC",
            syntheticSourceRef: src(`ot/${i}`),
          },
        });
        workOrderId = wo.id;
      }
      await tx.serviceRecord.create({
        data: {
          vehicleId: ids.vehicle,
          serviceCode: r.serviceCode,
          performedOn: shiftDay(r.performedOn),
          odometerKm: r.odometerKm,
          provenance: r.provenance,
          workshopId: r.workshopId,
          workOrderId,
          evidenceRef: r.evidenceRef ? src(`evidencia/${i}`) : null,
          recordedById: r.recordedById,
          dataOrigin: "SYNTHETIC",
          syntheticSourceRef: src(`servicio/${i}`),
          createdAt: now,
        },
      });
    }
    for (const [i, o] of template.odometerReadings.entries()) {
      await tx.odometerReading.create({
        data: {
          vehicleId: ids.vehicle,
          valueKm: o.valueKm,
          observedAt: shift(o.observedAt),
          provenance: o.provenance,
          verification: o.verification,
          recordedById: o.recordedById === A.ownerC1 || o.recordedById === A.ownerC2 || o.recordedById === A.ownerC3 ? ids.owner : o.recordedById,
          dataOrigin: "SYNTHETIC",
          syntheticSourceRef: src(`odometro/${i}`),
          createdAt: now,
        },
      });
    }
    await audit(tx, { actor: { actorId: "system:demo", role: "SYSTEM_JOB" }, action: "DEMO_RUN_STARTED", entityType: "Vehicle", entityId: ids.vehicle, details: { scenario, runId, templateVehicleId: def.templateVehicleId }, traceId, at: now });
    return ok({ runId, scenario, ownerActorId: ids.owner, advisorActorId: ids.advisor, customerId: ids.customer, vehicleId: ids.vehicle, serviceCode: def.serviceCode });
  });
  if (!created.ok) return created;

  await ensureMockCalendar(db, now);
  await restoreSimulatedSlots(db, now);
  await runEvaluationJob({ db, clock, notifications: new MockNotificationPort() }, { actor: SYSTEM_JOB, traceId, vehicleIds: [ids.vehicle] });
  return created;
}

/**
 * Agenda del taller SIMULADO para los próximos días (08:00 y 14:00, hora de Bogotá), idempotente. Evita que la demo
 * se quede sin cupos cuando el reloj real avanza más allá de los cupos fijos del seed.
 */
/**
 * Cupo amplio por horario: el calendario simulado es compartido por todos los visitantes de la demo y cada corrida
 * reserva en él. Con el cupo real de un taller (p.ej. 3) la demo se agotaría en horas. El conflicto de cupo sigue
 * demostrándose de forma explícita con el escenario D. Solo afecta datos MOCK, no reglas de negocio (ADR-019).
 */
export const DEMO_SLOT_CAPACITY = 50;

export async function ensureMockCalendar(db: Db, now: Date): Promise<void> {
  const today = toLocalDate(now);
  const rows: Array<{ id: string; workshopExternalRef: string; externalServiceCode: string; startsAt: Date; endsAt: Date; capacity: number; remaining: number }> = [];
  for (let d = 1; d <= 6; d++) {
    const date = addDaysToLocalDate(today, d);
    for (const ws of ["T1-DEMO", "T2-DEMO"]) {
      for (const [hh, utc] of [["0800", 13], ["1400", 19]] as const) {
        const startsAt = new Date(`${date}T${String(utc).padStart(2, "0")}:00:00.000Z`);
        rows.push({ id: `slot-${ws}-${date.replaceAll("-", "")}-${hh}`, workshopExternalRef: ws, externalServiceCode: "EXT-OIL-01", startsAt, endsAt: new Date(startsAt.getTime() + 2 * 3_600_000), capacity: DEMO_SLOT_CAPACITY, remaining: DEMO_SLOT_CAPACITY });
      }
    }
  }
  // No duplica horarios que ya existan (p.ej. los del seed) para el mismo taller y hora.
  const existing = await db.mockSlot.findMany({ where: { workshopExternalRef: { in: ["T1-DEMO", "T2-DEMO"] }, startsAt: { in: rows.map((r) => r.startsAt) } }, select: { workshopExternalRef: true, startsAt: true } });
  const taken = new Set(existing.map((e) => `${e.workshopExternalRef}|${e.startsAt.toISOString()}`));
  await db.mockSlot.createMany({ data: rows.filter((r) => !taken.has(`${r.workshopExternalRef}|${r.startsAt.toISOString()}`)), skipDuplicates: true });
}

/**
 * ⚠️ SOLO DEMO. Simula que otro cliente tomó el horario de la intención pendiente del propietario (escenario D):
 * agota ese cupo en el taller simulado. Solo afecta al cupo de la propia intención vigente del propietario.
 */
export async function simulateSlotTaken({ db, clock }: { db: Db; clock: Clock }, { actor, traceId }: { actor: ActorContext; traceId: string }): Promise<Result<{ slotRef: string; intentId: string }, AppError>> {
  if (actor.role !== "OWNER" || !actor.customerId) return err(appError("UNAUTHORIZED", "ROLE_NOT_PERMITTED"));
  const now = clock.now();
  const intent = await db.bookingIntent.findFirst({
    where: { customerId: actor.customerId, status: "AWAITING_USER", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!intent) return err(appError("NOT_FOUND", "NO_PENDING_INTENT"));
  const slot = await db.mockSlot.findUnique({ where: { id: intent.slotExternalRef }, select: { remaining: true } });
  await db.mockSlot.updateMany({ where: { id: intent.slotExternalRef }, data: { remaining: 0 } });
  await audit(db, { actor: { actorId: actor.actorId, role: actor.role }, action: "DEMO_SLOT_TAKEN_SIMULATED", entityType: "BookingIntent", entityId: intent.id, details: { slotRef: intent.slotExternalRef, previousRemaining: slot?.remaining ?? 0, note: "Simulación de demo: otro cliente tomó el cupo" }, traceId, at: now });
  return ok({ slotRef: intent.slotExternalRef, intentId: intent.id });
}

/** Tiempo tras el que se devuelve un cupo «tomado» por la simulación de D (la intención dura 10 min). */
const SIMULATED_TAKE_TTL_MS = 15 * 60_000;

/**
 * Devuelve al calendario compartido los cupos que el escenario D dejó en cero, una vez vencida la intención: así la
 * simulación de un visitante no deteriora la demo de los demás (ADR-020). Cada devolución queda en AuditLog.
 */
export async function restoreSimulatedSlots(db: Db, now: Date): Promise<number> {
  const sims = await db.auditLog.findMany({
    where: { action: "DEMO_SLOT_TAKEN_SIMULATED", occurredAt: { lte: new Date(now.getTime() - SIMULATED_TAKE_TTL_MS), gte: new Date(now.getTime() - 7 * 86_400_000) } },
    select: { id: true, details: true },
  });
  if (sims.length === 0) return 0;
  const done = new Set((await db.auditLog.findMany({ where: { action: "DEMO_SLOT_RESTORED", entityId: { in: sims.map((x) => x.id) } }, select: { entityId: true } })).map((x) => x.entityId));
  let restored = 0;
  for (const sim of sims.filter((x) => !done.has(x.id))) {
    const d = sim.details as { slotRef?: string; previousRemaining?: number };
    if (d.slotRef && (d.previousRemaining ?? 0) > 0) {
      await db.$executeRaw`UPDATE "MockSlot" SET "remaining" = LEAST("capacity", "remaining" + ${d.previousRemaining}) WHERE "id" = ${d.slotRef}`;
      restored++;
    }
    await audit(db, { actor: { actorId: "system:demo", role: "SYSTEM_JOB" }, action: "DEMO_SLOT_RESTORED", entityType: "AuditLog", entityId: sim.id, details: { slotRef: d.slotRef ?? null }, traceId: "demo-restore", at: now });
  }
  return restored;
}
