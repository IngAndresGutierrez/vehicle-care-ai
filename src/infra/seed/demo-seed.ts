/**
 * ⚠️ SEED SINTÉTICO DE DEMO (prd/DATA_MODEL.md §5, ADR-009, ADR-011).
 *
 * - Todo registro lleva dataOrigin=SYNTHETIC y una fuente "SYNTHETIC-DEMO:prisma/seed#<id>".
 * - Planes, reglas y políticas se toman de los fixtures del Maintenance Engine: el seed no define
 *   intervalos propios ni usa datos de fabricantes. Marca ficticia "DemoMotors", motores "DEMO-*".
 * - Fechas fijas alrededor del reloj demo (2026-10-28, America/Bogota) para resultados reproducibles.
 */
import {
  DEMO_COMMUNICATION_POLICY,
  DEMO_DATA_QUALITY_POLICY,
  DEMO_PLAN,
  odometerReading,
  serviceRecord,
  v1OilInput,
  v2BeltInput,
} from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import type { Db } from "@/infra/prisma";

export const SEED_SOURCE_PREFIX = "SYNTHETIC-DEMO:prisma/seed#";
const src = (id: string) => `${SEED_SOURCE_PREFIX}${id}`;
const synthetic = (id: string) => ({ dataOrigin: "SYNTHETIC" as const, syntheticSourceRef: src(id) });

/** IDs estables: coinciden con los fixtures del motor donde existen. */
export const DEMO_IDS = {
  communicationPolicy: "commpol-demo-v1",
  dataQualityPolicy: "dqpol-demo-v1",
  plan: "plan-demo",
  planVersion: DEMO_PLAN.planVersionId,
  vehicles: { v1: v1OilInput().vehicleId, v2: v2BeltInput().vehicleId, v3: "veh-demo-v3", v4: "veh-demo-v4" },
  specs: { v1: "spec-demo-v1", v2: "spec-demo-v2", v3: "spec-demo-v3", v4: "spec-demo-v4" },
  customers: { c1: "cust-demo-c1", c2: "cust-demo-c2", c3: "cust-demo-c3" },
  workshops: { t1: "ws-demo-t1", t2: "ws-demo-t2" },
  actors: {
    ownerC1: "act-owner-c1",
    ownerC2: "act-owner-c2",
    ownerC3: "act-owner-c3",
    advisor: "act-advisor",
    workshopT1: "act-ws-coord-t1",
    workshopT2: "act-ws-coord-t2",
    compliance: "act-compliance",
    systemJob: "act-system-job",
  },
} as const;

const D = (iso: string) => new Date(iso);
const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

export interface SeedSummary {
  seeded: boolean;
}

/**
 * Siembra una base vacía. Si ya está sembrada no repite la carga base (las tablas auditables son append-only)
 * pero sí completa, de forma idempotente, los datos añadidos en fases posteriores.
 */
export async function seedDemoData(db: Db): Promise<SeedSummary> {
  const existing = await db.communicationPolicy.findUnique({ where: { id: DEMO_IDS.communicationPolicy } });
  if (!existing) await seedBase(db);
  await seedPortfolioAssignments(db);
  await seedMockCatalog(db);
  return { seeded: !existing };
}

/** Versión del catálogo simulado; el prefijo la rotula como sintética en toda cotización que la cite. */
export const MOCK_CATALOG_VERSION = "SYNTHETIC-DEMO:catalogo-mock-v1";

/**
 * Fase 4 (ADR-017): catálogo de precios del taller SIMULADO. Valores ficticios para la demo, no tarifas reales.
 * La clave de especificación debe coincidir con `specKeyOf` (make|model|year|engine). V4 (motor no identificado)
 * no tiene precio a propósito. Sin precio de correa: una cotización de correa termina en caso humano.
 */
async function seedMockCatalog(db: Db): Promise<void> {
  const items = [
    { descripcion: "Aceite de motor (referencia ficticia)", cantidad: 1 },
    { descripcion: "Filtro de aceite (referencia ficticia)", cantidad: 1 },
    { descripcion: "Mano de obra", cantidad: 1 },
  ];
  const restrictions = ["Precio sintético de demostración: no es una tarifa real.", "Sujeto a inspección del vehículo en el taller."];
  const specKeys = {
    sedan: "DemoMotors|Sedán Demo|2021|DEMO-1.6",
    suv: "DemoMotors|SUV Demo|2019|DEMO-2.0",
    hatch: "DemoMotors|Hatchback Demo|2020|DEMO-1.4",
  };
  // [taller, especificación, subtotal COP, impuesto COP]
  const rows: Array<[string, string, number, number]> = [
    ["T1-DEMO", specKeys.sedan, 280_000, 53_200],
    ["T1-DEMO", specKeys.suv, 340_000, 64_600],
    ["T1-DEMO", specKeys.hatch, 250_000, 47_500],
    ["T2-DEMO", specKeys.sedan, 295_000, 56_050],
    ["T2-DEMO", specKeys.suv, 355_000, 67_450],
    ["T2-DEMO", specKeys.hatch, 262_000, 49_780],
  ];
  await db.mockCatalogPrice.createMany({
    data: rows.map(([workshopExternalRef, specKey, subtotalCop, taxCop]) => ({
      id: `price-${workshopExternalRef}-${specKey}`.replace(/[^A-Za-z0-9-]/g, "_"),
      workshopExternalRef,
      externalServiceCode: "EXT-OIL-01",
      specKey,
      subtotalCop,
      taxCop,
      taxLabel: "IVA 19% (valor sintético del catálogo MOCK)",
      includedItems: items,
      restrictions,
      catalogVersion: MOCK_CATALOG_VERSION,
      validityHours: 48,
      isEstimate: false,
    })),
    skipDuplicates: true,
  });
}

/**
 * Fase 3 (ADR-016): el asesor demo atiende la cartera de C1 y C2. C3 queda fuera a propósito, para
 * demostrar que el asesor no accede a vehículos que no tiene asignados.
 */
async function seedPortfolioAssignments(db: Db): Promise<void> {
  const { customers: C, actors: A } = DEMO_IDS;
  await db.portfolioAssignment.createMany({
    data: [C.c1, C.c2].map((customerId) => ({
      id: `pf-${A.advisor}-${customerId}`,
      actorId: A.advisor,
      customerId,
      validFrom: D("2026-08-01T05:00:00Z"),
    })),
    skipDuplicates: true,
  });
}

async function seedBase(db: Db): Promise<void> {
  const { vehicles: V, specs: S, customers: C, workshops: W, actors: A } = DEMO_IDS;

  await db.$transaction(async (tx) => {
    // ── Políticas (ADR-012), tomadas de los fixtures ──
    await tx.communicationPolicy.create({
      data: {
        id: DEMO_IDS.communicationPolicy,
        version: DEMO_COMMUNICATION_POLICY.policyVersion,
        leadKm: DEMO_COMMUNICATION_POLICY.leadKm,
        leadDays: DEMO_COMMUNICATION_POLICY.leadDays,
        overdueGraceKm: DEMO_COMMUNICATION_POLICY.overdueGraceKm,
        overdueGraceDays: DEMO_COMMUNICATION_POLICY.overdueGraceDays,
        isActive: true,
        ...synthetic(DEMO_IDS.communicationPolicy),
      },
    });
    await tx.dataQualityPolicy.create({
      data: {
        id: DEMO_IDS.dataQualityPolicy,
        version: DEMO_DATA_QUALITY_POLICY.policyVersion,
        maxOdometerAgeDays: DEMO_DATA_QUALITY_POLICY.maxOdometerAgeDays,
        isActive: true,
        ...synthetic(DEMO_IDS.dataQualityPolicy),
      },
    });

    // ── Especificaciones ficticias ──
    const verified = { verifiedBy: "Responsable técnico (demo, sintético)", verifiedAt: D("2026-10-01T15:00:00Z") };
    await tx.vehicleSpec.createMany({
      data: [
        { id: S.v1, make: "DemoMotors", model: "Sedán Demo", modelYear: 2021, engineCode: "DEMO-1.6", fuelType: "GASOLINE", timingDrive: "CHAIN", ...verified, ...synthetic(S.v1) },
        { id: S.v2, make: "DemoMotors", model: "SUV Demo", modelYear: 2019, engineCode: "DEMO-2.0", fuelType: "GASOLINE", timingDrive: "BELT", ...verified, ...synthetic(S.v2) },
        { id: S.v3, make: "DemoMotors", model: "Hatchback Demo", modelYear: 2020, engineCode: "DEMO-1.4", fuelType: "GASOLINE", timingDrive: "CHAIN", ...verified, ...synthetic(S.v3) },
        // V4: motor no identificado → el motor responde ENGINE_UNIDENTIFIED (AC03).
        { id: S.v4, make: "DemoMotors", model: "Pickup Demo", modelYear: 2018, engineCode: null, fuelType: "DIESEL", timingDrive: "UNKNOWN", ...synthetic(S.v4) },
      ],
    });

    // ── Plan demo validado (fixture DEMO_PLAN: aceite PRD §7 + correa ficticia, ADR-009) ──
    await tx.maintenancePlan.create({ data: { id: DEMO_IDS.plan, name: "Plan demo DemoMotors (SINTÉTICO)" } });
    await tx.maintenancePlanVersion.create({
      data: {
        id: DEMO_PLAN.planVersionId,
        planId: DEMO_IDS.plan,
        version: DEMO_PLAN.version,
        status: DEMO_PLAN.status,
        sourceRef: DEMO_PLAN.sourceRef,
        dataOrigin: DEMO_PLAN.dataOrigin,
        approvedBy: "Responsable técnico (demo, sintético)",
        approvedAt: D("2026-10-01T15:00:00Z"),
        effectiveFrom: D("2026-10-01T05:00:00Z"),
        rules: {
          create: DEMO_PLAN.rules.map((r) => ({
            id: r.ruleId,
            serviceCode: r.serviceCode,
            description: `${r.serviceCode} — regla de demostración sintética`,
            intervalKm: r.intervalKm,
            intervalMonths: r.intervalMonths,
            appliesToTimingDrive: r.appliesToTimingDrive,
            usageCondition: r.usageCondition,
            requiresUsageCondition: r.requiresUsageCondition,
            allowDeliveryBaseline: r.allowDeliveryBaseline,
            notes: "Valores ficticios; no provienen de ningún manual de fabricante.",
          })),
        },
      },
    });
    await tx.planApplicability.createMany({
      data: Object.values(S).map((specId) => ({ id: `pa-${specId}`, planId: DEMO_IDS.plan, specId })),
    });

    // ── Clientes (contactos en dominio reservado .invalid) ──
    await tx.customer.createMany({
      data: [
        { id: C.c1, displayName: "Cliente Demo 1", email: "c1@demo.invalid", phone: "+57 000 000 0001", city: "Ciudad Demo", ...synthetic(C.c1) },
        { id: C.c2, displayName: "Cliente Demo 2", email: "c2@demo.invalid", phone: "+57 000 000 0002", city: "Ciudad Demo", ...synthetic(C.c2) },
        { id: C.c3, displayName: "Cliente Demo 3", email: "c3@demo.invalid", phone: "+57 000 000 0003", city: "Ciudad Demo", ...synthetic(C.c3) },
      ],
    });

    // ── Talleres y actores demo ──
    await tx.workshop.createMany({
      data: [
        { id: W.t1, name: "Taller Norte (demo)", city: "Ciudad Demo", externalRef: "T1-DEMO" },
        { id: W.t2, name: "Taller Sur (demo)", city: "Ciudad Demo", externalRef: "T2-DEMO" },
      ],
    });
    await tx.workshopService.createMany({
      data: [W.t1, W.t2].flatMap((workshopId) => [
        { workshopId, serviceCode: "ENGINE_OIL_FILTER", externalServiceCode: "EXT-OIL-01" },
        { workshopId, serviceCode: "TIMING_BELT", externalServiceCode: "EXT-BELT-01" },
      ]),
    });
    await tx.actorAccount.createMany({
      data: [
        { id: A.ownerC1, role: "OWNER", displayName: "Propietario C1 (demo)", customerId: C.c1 },
        { id: A.ownerC2, role: "OWNER", displayName: "Propietario C2 (demo)", customerId: C.c2 },
        { id: A.ownerC3, role: "OWNER", displayName: "Propietario C3 (demo)", customerId: C.c3 },
        { id: A.advisor, role: "ADVISOR", displayName: "Asesor postventa (demo)" },
        { id: A.workshopT1, role: "WORKSHOP_COORDINATOR", displayName: "Coordinador T1 (demo)", workshopId: W.t1 },
        { id: A.workshopT2, role: "WORKSHOP_COORDINATOR", displayName: "Coordinador T2 (demo)", workshopId: W.t2 },
        { id: A.compliance, role: "COMPLIANCE", displayName: "Compliance (demo)" },
        { id: A.systemJob, role: "SYSTEM_JOB", displayName: "Job de evaluación" },
      ],
    });

    // ── Vehículos y titularidad (V1 tuvo un titular anterior: C3) ──
    await tx.vehicle.createMany({
      data: [
        { id: V.v1, plate: "DMO001", specId: S.v1, deliveredAt: D("2026-09-15T15:00:00Z"), deliveryOdometerKm: 72_500, usageCondition: v1OilInput().usageCondition, ...synthetic(V.v1) },
        { id: V.v2, plate: "DMO002", specId: S.v2, deliveredAt: D("2026-10-20T15:00:00Z"), deliveryOdometerKm: 95_000, usageCondition: v2BeltInput().usageCondition, ...synthetic(V.v2) },
        { id: V.v3, plate: "DMO003", specId: S.v3, deliveredAt: D("2026-08-20T15:00:00Z"), deliveryOdometerKm: 39_000, usageCondition: "NORMAL", ...synthetic(V.v3) },
        { id: V.v4, plate: "DMO004", specId: S.v4, deliveredAt: D("2026-07-10T15:00:00Z"), deliveryOdometerKm: 120_000, usageCondition: null, ...synthetic(V.v4) },
      ],
    });
    await tx.vehicleOwnership.createMany({
      data: [
        { id: "own-v1-c3-prev", vehicleId: V.v1, customerId: C.c3, validFrom: D("2023-05-01T15:00:00Z"), validTo: D("2026-09-15T15:00:00Z"), evidenceRef: src("own-v1-c3-prev") },
        { id: "own-v1-c1", vehicleId: V.v1, customerId: C.c1, validFrom: D("2026-09-15T15:00:00Z"), evidenceRef: src("own-v1-c1") },
        { id: "own-v2-c2", vehicleId: V.v2, customerId: C.c2, validFrom: D("2026-10-20T15:00:00Z"), evidenceRef: src("own-v2-c2") },
        { id: "own-v3-c3", vehicleId: V.v3, customerId: C.c3, validFrom: D("2026-08-20T15:00:00Z"), evidenceRef: src("own-v3-c3") },
        { id: "own-v4-c3", vehicleId: V.v4, customerId: C.c3, validFrom: D("2026-07-10T15:00:00Z"), evidenceRef: src("own-v4-c3") },
      ],
    });

    // ── Consentimientos con evidencia (C2 revocó MAINTENANCE_REMINDERS → EX-04) ──
    const consentRows: Array<{
      id: string;
      customerId: string;
      ownerActor: string;
      purpose: "SERVICE_OPERATIONAL" | "MAINTENANCE_REMINDERS" | "AI_ASSISTANT_PROCESSING";
      channel: "PORTAL" | "EMAIL" | "WHATSAPP";
      events: Array<{ action: "GRANTED" | "REVOKED"; at: string }>;
    }> = [
      ...[
        [C.c1, A.ownerC1],
        [C.c3, A.ownerC3],
      ].flatMap(([customerId, ownerActor]) => [
        { id: `cons-${customerId}-rem-wa`, customerId, ownerActor, purpose: "MAINTENANCE_REMINDERS" as const, channel: "WHATSAPP" as const, events: [{ action: "GRANTED" as const, at: "2026-08-20T15:00:00Z" }] },
        { id: `cons-${customerId}-rem-email`, customerId, ownerActor, purpose: "MAINTENANCE_REMINDERS" as const, channel: "EMAIL" as const, events: [{ action: "GRANTED" as const, at: "2026-08-20T15:00:00Z" }] },
        { id: `cons-${customerId}-ops-wa`, customerId, ownerActor, purpose: "SERVICE_OPERATIONAL" as const, channel: "WHATSAPP" as const, events: [{ action: "GRANTED" as const, at: "2026-08-20T15:00:00Z" }] },
        { id: `cons-${customerId}-ai-portal`, customerId, ownerActor, purpose: "AI_ASSISTANT_PROCESSING" as const, channel: "PORTAL" as const, events: [{ action: "GRANTED" as const, at: "2026-08-20T15:00:00Z" }] },
      ]),
      { id: `cons-${C.c2}-ops-email`, customerId: C.c2, ownerActor: A.ownerC2, purpose: "SERVICE_OPERATIONAL", channel: "EMAIL", events: [{ action: "GRANTED", at: "2026-10-20T15:00:00Z" }] },
      { id: `cons-${C.c2}-ai-portal`, customerId: C.c2, ownerActor: A.ownerC2, purpose: "AI_ASSISTANT_PROCESSING", channel: "PORTAL", events: [{ action: "GRANTED", at: "2026-10-20T15:00:00Z" }] },
      {
        id: `cons-${C.c2}-rem-wa`,
        customerId: C.c2,
        ownerActor: A.ownerC2,
        purpose: "MAINTENANCE_REMINDERS",
        channel: "WHATSAPP",
        events: [
          { action: "GRANTED", at: "2026-10-20T15:00:00Z" },
          { action: "REVOKED", at: "2026-10-22T15:00:00Z" },
        ],
      },
    ];
    for (const c of consentRows) {
      await tx.consent.create({
        data: {
          id: c.id,
          customerId: c.customerId,
          purpose: c.purpose,
          channel: c.channel,
          isGranted: c.events.at(-1)?.action === "GRANTED",
          events: {
            create: c.events.map((e, i) => ({
              id: `${c.id}-ev${i + 1}`,
              action: e.action,
              legalTextVersion: "demo-legal-v1",
              evidenceRef: src(`${c.id}-ev${i + 1}`),
              capturedVia: "PORTAL" as const,
              capturedById: c.ownerActor,
              occurredAt: D(e.at),
            })),
          },
        },
      });
    }

    // ── Órdenes de trabajo cerradas que respaldan los servicios WORKSHOP_VERIFIED ──
    const v1Service = serviceRecord();
    await tx.workOrder.createMany({
      data: [
        { id: "wo-demo-v1-oil", vehicleId: V.v1, externalRef: "OT-DEMO-0001", status: "COMPLETED", completedAt: D("2026-04-01T20:00:00Z"), completedById: A.workshopT1, completionOdometerKm: v1Service.odometerKm, invoiceRef: src("invoice-0001"), ...synthetic("wo-demo-v1-oil") },
        { id: "wo-demo-v3-oil", vehicleId: V.v3, externalRef: "OT-DEMO-0002", status: "COMPLETED", completedAt: D("2026-09-01T20:00:00Z"), completedById: A.workshopT2, completionOdometerKm: 38_000, invoiceRef: src("invoice-0002"), ...synthetic("wo-demo-v3-oil") },
      ],
    });

    // ── Historial de servicios (procedencia variada, AC11) ──
    await tx.serviceRecord.createMany({
      data: [
        // V1: fixture serviceRecord() — 70.000 km el 2026-04-01, acreditado por taller.
        { id: v1Service.recordId, vehicleId: V.v1, serviceCode: v1Service.serviceCode, performedOn: day(v1Service.performedOn), odometerKm: v1Service.odometerKm, provenance: v1Service.provenance, workshopId: W.t1, workOrderId: "wo-demo-v1-oil", recordedById: A.workshopT1, ...synthetic(v1Service.recordId) },
        // V2: aceite documentado por el propietario anterior (factura ficticia); sin constancia de correa (ADR-009).
        { id: "svc-demo-v2-oil", vehicleId: V.v2, serviceCode: "ENGINE_OIL_FILTER", performedOn: day("2026-02-15"), odometerKm: 90_000, provenance: "PRIOR_OWNER_DOCUMENT", evidenceRef: src("invoice-prior-owner-v2"), recordedById: A.advisor, ...synthetic("svc-demo-v2-oil") },
        // V3: servicio reciente acreditado por taller.
        { id: "svc-demo-v3-oil", vehicleId: V.v3, serviceCode: "ENGINE_OIL_FILTER", performedOn: day("2026-09-01"), odometerKm: 38_000, provenance: "WORKSHOP_VERIFIED", workshopId: W.t2, workOrderId: "wo-demo-v3-oil", recordedById: A.workshopT2, ...synthetic("svc-demo-v3-oil") },
      ],
    });

    // ── Lecturas de odómetro ──
    const v1Reading = odometerReading();
    const v2Reading = v2BeltInput().odometer!;
    await tx.odometerReading.createMany({
      data: [
        { id: "odo-demo-v1-svc", vehicleId: V.v1, valueKm: 70_000, observedAt: D("2026-04-01T10:00:00-05:00"), provenance: "WORKSHOP_VERIFIED", verification: "VERIFIED", recordedById: A.workshopT1, ...synthetic("odo-demo-v1-svc") },
        { id: v1Reading.readingId, vehicleId: V.v1, valueKm: v1Reading.valueKm, observedAt: D(v1Reading.observedAt), provenance: v1Reading.provenance, verification: "UNVERIFIED", recordedById: A.ownerC1, ...synthetic(v1Reading.readingId) },
        { id: v2Reading.readingId, vehicleId: V.v2, valueKm: v2Reading.valueKm, observedAt: D(v2Reading.observedAt), provenance: v2Reading.provenance, verification: "VERIFIED", recordedById: A.advisor, ...synthetic(v2Reading.readingId) },
        { id: "odo-demo-v3-svc", vehicleId: V.v3, valueKm: 38_000, observedAt: D("2026-09-01T10:00:00-05:00"), provenance: "WORKSHOP_VERIFIED", verification: "VERIFIED", recordedById: A.workshopT2, ...synthetic("odo-demo-v3-svc") },
        { id: "odo-demo-v3", vehicleId: V.v3, valueKm: 41_000, observedAt: D("2026-10-25T10:00:00-05:00"), provenance: "OWNER_DECLARED", verification: "UNVERIFIED", recordedById: A.ownerC3, ...synthetic("odo-demo-v3") },
        { id: "odo-demo-v4", vehicleId: V.v4, valueKm: 120_000, observedAt: D("2026-07-10T10:00:00-05:00"), provenance: "DELIVERY_INSPECTION", verification: "VERIFIED", recordedById: A.advisor, ...synthetic("odo-demo-v4") },
      ],
    });

    // ── Cupos del taller simulado (sistema externo mock; T1 tiene uno de capacidad 1 para EX-03) ──
    const slot = (id: string, ws: string, startIso: string, capacity: number) => ({
      id,
      workshopExternalRef: ws,
      externalServiceCode: "EXT-OIL-01",
      startsAt: D(startIso),
      endsAt: new Date(D(startIso).getTime() + 2 * 3_600_000),
      capacity,
      remaining: capacity,
    });
    await tx.mockSlot.createMany({
      data: [
        slot("slot-t1-1", "T1-DEMO", "2026-10-29T08:00:00-05:00", 1),
        slot("slot-t1-2", "T1-DEMO", "2026-10-30T08:00:00-05:00", 2),
        slot("slot-t1-3", "T1-DEMO", "2026-10-31T10:00:00-05:00", 2),
        slot("slot-t1-4", "T1-DEMO", "2026-11-02T14:00:00-05:00", 2),
        slot("slot-t2-1", "T2-DEMO", "2026-10-30T09:00:00-05:00", 2),
        slot("slot-t2-2", "T2-DEMO", "2026-11-03T09:00:00-05:00", 2),
        slot("slot-t2-3", "T2-DEMO", "2026-11-04T15:00:00-05:00", 1),
      ],
    });
  });
}
