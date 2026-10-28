import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { expectDbRejection } from "./helpers/assertions";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V, customers: C, actors: A, specs: S } = DEMO_IDS;
const SYN = (id: string) => ({ dataOrigin: "SYNTHETIC" as const, syntheticSourceRef: `SYNTHETIC-DEMO:test#${id}` });

beforeEach(async () => {
  await resetAndSeed(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Titularidad (DATA_MODEL §4)", () => {
  it("un único titular vigente por vehículo", async () => {
    await expectDbRejection(
      db.vehicleOwnership.create({ data: { vehicleId: V.v1, customerId: C.c2, validFrom: new Date("2026-10-01T00:00:00Z") } }),
      /VehicleOwnership_one_active_owner_per_vehicle|Unique constraint/,
    );
  });

  it("una titularidad cerrada adicional sí es válida; un rango invertido no", async () => {
    await db.vehicleOwnership.create({
      data: { vehicleId: V.v1, customerId: C.c2, validFrom: new Date("2020-01-01T00:00:00Z"), validTo: new Date("2021-01-01T00:00:00Z") },
    });
    await expectDbRejection(
      db.vehicleOwnership.create({
        data: { vehicleId: V.v2, customerId: C.c1, validFrom: new Date("2021-01-01T00:00:00Z"), validTo: new Date("2020-01-01T00:00:00Z") },
      }),
      /VehicleOwnership_valid_range/,
    );
  });
});

describe("ADR-010 — comunicaciones salientes", () => {
  const base = {
    customerId: C.c2,
    vehicleId: V.v2,
    channel: "WHATSAPP" as const,
    purpose: "MAINTENANCE_REMINDERS" as const,
    templateId: "maintenance-reminder-v1",
    traceId: "trc-inv",
    cycleKey: "cycle-inv",
    ...SYN("msg"),
  };
  // Desde la Fase 3 cada mensaje exige una clave de deduplicación única (ADR-015).
  let seq = 0;
  const key = () => ({ dedupKey: `dedup-inv-${++seq}` });

  it("un mensaje SUPPRESSED no requiere consentEventId pero sí suppressionReason", async () => {
    await db.outboundMessage.create({ data: { ...base, ...key(), status: "SUPPRESSED", suppressionReason: "CONSENT_REQUIRED" } });
    await expectDbRejection(db.outboundMessage.create({ data: { ...base, ...key(), status: "SUPPRESSED" } }), /OutboundMessage_suppressed_needs_reason/);
  });

  it("un envío (simulado) exige la evidencia de consentimiento y que exista", async () => {
    await expectDbRejection(db.outboundMessage.create({ data: { ...base, ...key(), status: "SIMULATED_SENT" } }), /OutboundMessage_sent_needs_consent/);
    await expectDbRejection(
      db.outboundMessage.create({ data: { ...base, ...key(), status: "SIMULATED_SENT", consentEventId: "no-existe" } }),
      /Foreign key|OutboundMessage_consentEventId_fkey/,
    );
    await db.outboundMessage.create({ data: { ...base, ...key(), customerId: C.c1, vehicleId: V.v1, status: "SIMULATED_SENT", consentEventId: `cons-${C.c1}-rem-wa-ev1` } });
  });

  it("Fase 3: todo mensaje nuevo exige dedupKey y cycleKey, y la clave es única", async () => {
    await expectDbRejection(
      db.outboundMessage.create({ data: { ...base, status: "SUPPRESSED", suppressionReason: "CONSENT_REQUIRED" } }),
      /OutboundMessage_dedup_required/,
    );
    await db.outboundMessage.create({ data: { ...base, dedupKey: "fixed", status: "SUPPRESSED", suppressionReason: "CONSENT_REQUIRED" } });
    await expectDbRejection(
      db.outboundMessage.create({ data: { ...base, dedupKey: "fixed", status: "SUPPRESSED", suppressionReason: "CONSENT_REQUIRED" } }),
      /Unique constraint|OutboundMessage_dedupKey_key/,
    );
  });

  it("solo existen los estados SIMULATED_SENT y SUPPRESSED, y el registro es inmutable", async () => {
    await expectDbRejection(
      db.outboundMessage.create({ data: { ...base, ...key(), status: "SENT", consentEventId: `cons-${C.c1}-rem-wa-ev1` } }),
      /OutboundMessage_status_values/,
    );
    const msg = await db.outboundMessage.create({ data: { ...base, ...key(), status: "SUPPRESSED", suppressionReason: "CONSENT_REQUIRED" } });
    await expectDbRejection(
      db.outboundMessage.update({ where: { id: msg.id }, data: { status: "SIMULATED_SENT" } }),
      /append-only: OutboundMessage/,
    );
  });

  it("la revocación de C2 queda como evidencia: GRANTED y luego REVOKED, proyección isGranted=false", async () => {
    const consent = await db.consent.findUniqueOrThrow({
      where: { customerId_purpose_channel: { customerId: C.c2, purpose: "MAINTENANCE_REMINDERS", channel: "WHATSAPP" } },
      include: { events: { orderBy: { occurredAt: "asc" } } },
    });
    expect(consent.isGranted).toBe(false);
    expect(consent.events.map((e) => e.action)).toEqual(["GRANTED", "REVOKED"]);
    await expectDbRejection(
      db.consentEvent.update({ where: { id: consent.events[1].id }, data: { action: "GRANTED" } }),
      /append-only: ConsentEvent/,
    );
  });
});

describe("ADR-011 — origen sintético inequívoco", () => {
  it("SYNTHETIC exige rótulo SYNTHETIC-DEMO: (también si es NULL) y REAL no admite rótulo", async () => {
    await expectDbRejection(
      db.vehicle.create({ data: { id: "veh-x", specId: S.v1, dataOrigin: "SYNTHETIC" } }),
      /Vehicle_data_origin_label/,
    );
    await expectDbRejection(
      db.vehicle.create({ data: { id: "veh-y", specId: S.v1, dataOrigin: "SYNTHETIC", syntheticSourceRef: "demo" } }),
      /Vehicle_data_origin_label/,
    );
    await expectDbRejection(
      db.customer.create({ data: { displayName: "x", dataOrigin: "REAL", syntheticSourceRef: "SYNTHETIC-DEMO:x" } }),
      /Customer_data_origin_label/,
    );
    await db.vehicle.create({ data: { id: "veh-z", specId: S.v1, ...SYN("veh-z") } });
  });

  it("un plan sintético cita una fuente SYNTHETIC-DEMO:; uno real no puede citarla", async () => {
    const plan = { planId: DEMO_IDS.plan, status: "DRAFT" as const };
    await expectDbRejection(
      db.maintenancePlanVersion.create({ data: { ...plan, version: "x1", sourceRef: "Manual del propietario", dataOrigin: "SYNTHETIC" } }),
      /MaintenancePlanVersion_data_origin_label/,
    );
    await expectDbRejection(
      db.maintenancePlanVersion.create({ data: { ...plan, version: "x2", sourceRef: "SYNTHETIC-DEMO: x", dataOrigin: "REAL" } }),
      /MaintenancePlanVersion_data_origin_label/,
    );
  });

  it("un servicio WORKSHOP_VERIFIED exige orden de trabajo", async () => {
    await expectDbRejection(
      db.serviceRecord.create({
        data: { vehicleId: V.v2, serviceCode: "TIMING_BELT", performedOn: new Date("2026-01-01T00:00:00Z"), odometerKm: 80_000, provenance: "WORKSHOP_VERIFIED", recordedById: A.advisor, ...SYN("svc") },
      }),
      /ServiceRecord_verified_needs_work_order/,
    );
  });
});

describe("ADR-012 — técnico vs. comunicación y políticas", () => {
  const evaluation = {
    vehicleId: V.v1,
    serviceCode: "ENGINE_OIL_FILTER",
    reasons: [],
    suggestedAction: "NONE",
    asOfLocalDate: new Date("2026-10-28T00:00:00Z"),
    commPolicyVersion: "demo-comm-v1",
    dataQualityPolicyVersion: "demo-dq-v1",
    containsSyntheticData: false,
    syntheticSources: [],
    engineVersion: "1.0.0",
    inputHash: "a".repeat(64),
    inputSnapshot: {},
    decisionTrace: [],
    evaluatedAt: new Date("2026-10-28T17:00:00Z"),
  };

  it("una sola política de comunicación y una sola de calidad de datos activas", async () => {
    await expectDbRejection(
      db.communicationPolicy.create({ data: { version: "v2", leadKm: 1, leadDays: 1, overdueGraceKm: 1, overdueGraceDays: 1, isActive: true, ...SYN("cp2") } }),
      /CommunicationPolicy_single_active|Unique constraint/,
    );
    await expectDbRejection(
      db.dataQualityPolicy.create({ data: { version: "v2", maxOdometerAgeDays: 1, isActive: true, ...SYN("dq2") } }),
      /DataQualityPolicy_single_active|Unique constraint/,
    );
    await db.communicationPolicy.create({ data: { version: "v3", leadKm: 1, leadDays: 1, overdueGraceKm: 1, overdueGraceDays: 1, isActive: false, ...SYN("cp3") } });
  });

  it("UNKNOWN técnico no puede persistir cifras ni clasificación comercial", async () => {
    await expectDbRejection(
      db.maintenanceEvaluation.create({ data: { ...evaluation, status: "UNKNOWN", technicalStatus: "UNKNOWN", dueByKm: 75_000 } }),
      /MaintenanceEvaluation_status_integrity/,
    );
    await expectDbRejection(
      db.maintenanceEvaluation.create({ data: { ...evaluation, status: "UNKNOWN", technicalStatus: "UNKNOWN", communicationStatus: "UPCOMING" } }),
      /MaintenanceEvaluation_status_integrity/,
    );
  });

  it("un vencimiento técnico DUE nunca se comunica como UPCOMING ni NOT_DUE", async () => {
    await expectDbRejection(
      db.maintenanceEvaluation.create({ data: { ...evaluation, status: "UPCOMING", technicalStatus: "DUE", communicationStatus: "UPCOMING" } }),
      /MaintenanceEvaluation_status_integrity/,
    );
    await expectDbRejection(
      db.maintenanceEvaluation.create({ data: { ...evaluation, status: "OVERDUE", technicalStatus: "NOT_DUE", communicationStatus: "OVERDUE" } }),
      /MaintenanceEvaluation_status_integrity/,
    );
    // Regresión: un CHECK con communicationStatus NULL evaluaba a NULL y se aceptaba (ADR-014).
    await expectDbRejection(
      db.maintenanceEvaluation.create({ data: { ...evaluation, status: "DUE", technicalStatus: "DUE" } }),
      /MaintenanceEvaluation_status_integrity/,
    );
    await db.maintenanceEvaluation.create({ data: { ...evaluation, status: "OVERDUE", technicalStatus: "DUE", communicationStatus: "OVERDUE" } });
  });

  it("el indicador sintético coincide con las fuentes y el hash tiene formato sha256", async () => {
    const ok = { ...evaluation, status: "NOT_DUE" as const, technicalStatus: "NOT_DUE" as const, communicationStatus: "NOT_DUE" as const };
    await expectDbRejection(
      db.maintenanceEvaluation.create({ data: { ...ok, containsSyntheticData: true } }),
      /MaintenanceEvaluation_synthetic_flag/,
    );
    await expectDbRejection(
      db.maintenanceEvaluation.create({ data: { ...ok, inputHash: "abc" } }),
      /MaintenanceEvaluation_input_hash_format/,
    );
  });
});

describe("ADR-013/014 — planes, reglas y estados", () => {
  it("un plan VALIDATED exige aprobación registrada", async () => {
    await expectDbRejection(
      db.maintenancePlanVersion.create({ data: { planId: DEMO_IDS.plan, version: "x3", status: "VALIDATED", sourceRef: "SYNTHETIC-DEMO: x", dataOrigin: "SYNTHETIC" } }),
      /MaintenancePlanVersion_validated_is_approved/,
    );
  });

  it("intervalos positivos, una regla general por servicio y sin ámbito UNKNOWN", async () => {
    const rule = { planVersionId: DEMO_IDS.planVersion, description: "x", intervalMonths: 12 };
    await expectDbRejection(
      db.maintenanceRule.create({ data: { ...rule, serviceCode: "X1", intervalKm: 0 } }),
      /MaintenanceRule_positive_intervals/,
    );
    await expectDbRejection(
      db.maintenanceRule.create({ data: { ...rule, serviceCode: "ENGINE_OIL_FILTER", intervalKm: 1_000 } }),
      /MaintenanceRule_one_rule_per_condition|Unique constraint/,
    );
    await expectDbRejection(
      db.maintenanceRule.create({ data: { ...rule, serviceCode: "X2", intervalKm: 1_000, appliesToTimingDrive: "UNKNOWN" } }),
      /MaintenanceRule_timing_scope/,
    );
    await db.maintenanceRule.create({ data: { ...rule, serviceCode: "ENGINE_OIL_FILTER", intervalKm: 2_500, usageCondition: "SEVERE" } });
  });

  it("una reserva CONFIRMED exige folio y es única por vehículo y servicio", async () => {
    const quote = await db.quote.create({
      data: { vehicleId: V.v1, workshopId: DEMO_IDS.workshops.t1, serviceCode: "ENGINE_OIL_FILTER", status: "ACTIVE", isEstimate: false, totalCop: 1, validUntil: new Date("2026-10-29T00:00:00Z"), source: "MOCK", traceId: "trc" },
    });
    const intent = (n: number) =>
      db.bookingIntent.create({
        data: { confirmationToken: `tok-${n}`, vehicleId: V.v1, quoteId: quote.id, slotExternalRef: "slot-t1-2", slotStartsAt: new Date("2026-10-30T13:00:00Z"), workshopId: DEMO_IDS.workshops.t1, requestedById: A.ownerC1, expiresAt: new Date("2026-10-28T18:00:00Z"), traceId: "trc" },
      });
    const booking = (intentId: string, n: number, folio: string | null) => ({
      vehicleId: V.v1, quoteId: quote.id, serviceCode: "ENGINE_OIL_FILTER", intentId, workshopId: DEMO_IDS.workshops.t1, slotExternalRef: "slot-t1-2", startsAt: new Date("2026-10-30T13:00:00Z"), status: "CONFIRMED" as const, externalBookingRef: folio, idempotencyKey: `idem-${n}`, source: "MOCK" as const, traceId: "trc",
    });
    const i1 = await intent(1);
    await expectDbRejection(db.booking.create({ data: booking(i1.id, 1, null) }), /Booking_confirmed_has_folio/);
    await db.booking.create({ data: booking(i1.id, 2, "VC-0001") });
    const i2 = await intent(2);
    await expectDbRejection(db.booking.create({ data: booking(i2.id, 3, "VC-0002") }), /Booking_one_confirmed_per_vehicle_service|Unique constraint/);
  });

  it("cotización ACTIVE exige total y vigencia; UNAVAILABLE no admite montos", async () => {
    const q = { vehicleId: V.v1, workshopId: DEMO_IDS.workshops.t1, serviceCode: "ENGINE_OIL_FILTER", isEstimate: false, source: "MOCK" as const, traceId: "trc" };
    await expectDbRejection(db.quote.create({ data: { ...q, status: "ACTIVE" } }), /Quote_status_integrity/);
    await expectDbRejection(db.quote.create({ data: { ...q, status: "UNAVAILABLE", totalCop: 1 } }), /Quote_status_integrity/);
  });

  it("caso de seguridad siempre URGENT; caso resuelto exige fecha", async () => {
    const c = { vehicleId: V.v3, minimalContext: {}, slaDueAt: new Date("2026-10-28T18:00:00Z"), openedById: A.ownerC3, traceId: "trc", assigneeRole: "ADVISOR" as const };
    await expectDbRejection(
      db.humanCase.create({ data: { ...c, reason: "SAFETY_ESCALATION", priority: "NORMAL", idempotencyKey: "k1" } }),
      /HumanCase_safety_is_urgent/,
    );
    await expectDbRejection(
      db.humanCase.create({ data: { ...c, reason: "CUSTOMER_REQUEST", priority: "NORMAL", status: "RESOLVED", idempotencyKey: "k2" } }),
      /HumanCase_resolution_integrity/,
    );
  });

  it("orden COMPLETED exige cierre registrado; cupo mock dentro de su capacidad", async () => {
    await expectDbRejection(
      db.workOrder.create({ data: { vehicleId: V.v1, status: "COMPLETED", ...SYN("wo") } }),
      /WorkOrder_completed_integrity/,
    );
    await expectDbRejection(db.mockSlot.update({ where: { id: "slot-t1-1" }, data: { remaining: 2 } }), /MockSlot_capacity_bounds/);
    await expectDbRejection(db.mockSlot.update({ where: { id: "slot-t1-1" }, data: { remaining: -1 } }), /MockSlot_capacity_bounds/);
  });
});

describe("Append-only en registros auditables", () => {
  it("historial de odómetro y servicios no admite UPDATE ni DELETE", async () => {
    await expectDbRejection(db.odometerReading.update({ where: { id: "odo-demo-1" }, data: { valueKm: 1 } }), /append-only: OdometerReading no permite UPDATE/);
    await expectDbRejection(db.odometerReading.delete({ where: { id: "odo-demo-1" } }), /append-only: OdometerReading no permite DELETE/);
    await expectDbRejection(db.serviceRecord.update({ where: { id: "svc-demo-1" }, data: { odometerKm: 1 } }), /append-only: ServiceRecord/);
  });

  it("AuditLog y ToolCall solo admiten inserción", async () => {
    const log = await db.auditLog.create({ data: { actorId: A.advisor, actorRole: "ADVISOR", action: "TEST", entityType: "Vehicle", entityId: V.v1, details: {} } });
    await expectDbRejection(db.auditLog.update({ where: { id: log.id }, data: { action: "X" } }), /append-only: AuditLog/);
    const call = await db.toolCall.create({
      data: { traceId: "trc", toolName: "getVehicleProfile", actorId: A.ownerC1, actorRole: "OWNER", vehicleIdHash: "h", inputRedacted: {}, ok: true, source: "INTERNAL", durationMs: 1 },
    });
    await expectDbRejection(db.toolCall.delete({ where: { id: call.id } }), /append-only: ToolCall/);
  });

  it("borrar una orden de trabajo referida por un servicio verificado también se bloquea", async () => {
    await expectDbRejection(db.workOrder.delete({ where: { id: "wo-demo-v1-oil" } }), /append-only: ServiceRecord/);
    expect(await db.workOrder.count({ where: { id: "wo-demo-v1-oil" } })).toBe(1);
  });
});
