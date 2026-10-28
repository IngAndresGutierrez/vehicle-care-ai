-- Fase 3 — Journey persistente, idempotencia de eventos, deduplicación de recordatorios y alcance de personal
-- (ADR-015, ADR-016). Las columnas nuevas obligatorias usan CHECK ... NOT VALID: se exigen en filas nuevas
-- sin bloquear ni reescribir tablas existentes (patrón seguro; validar con VALIDATE CONSTRAINT tras revisar datos).

-- AlterTable
ALTER TABLE "CommunicationPolicy" ADD COLUMN     "maxRemindersPerCycle" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "minDaysBetweenReminders" INTEGER NOT NULL DEFAULT 14;

-- AlterTable
ALTER TABLE "JourneyEvent" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "JourneyInstance" ADD COLUMN     "context" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "MaintenanceEvaluation" ADD COLUMN     "baselineServiceRecordId" TEXT,
ADD COLUMN     "cycleKey" TEXT;

-- AlterTable
ALTER TABLE "OutboundMessage" ADD COLUMN     "cycleKey" TEXT,
ADD COLUMN     "dedupKey" TEXT,
ADD COLUMN     "evaluationId" TEXT;

-- CreateTable
CREATE TABLE "PortfolioAssignment" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortfolioAssignment_customerId_idx" ON "PortfolioAssignment"("customerId");

-- CreateIndex
CREATE INDEX "PortfolioAssignment_actorId_idx" ON "PortfolioAssignment"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "JourneyEvent_idempotencyKey_key" ON "JourneyEvent"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_dedupKey_key" ON "OutboundMessage"("dedupKey");

-- CreateIndex
CREATE INDEX "OutboundMessage_cycleKey_status_idx" ON "OutboundMessage"("cycleKey", "status");

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "MaintenanceEvaluation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioAssignment" ADD CONSTRAINT "PortfolioAssignment_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "ActorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioAssignment" ADD CONSTRAINT "PortfolioAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────────────────── Journey (ADR-015) ─────────────────────────

-- Todo evento nuevo lleva clave de idempotencia: un reintento devuelve el evento existente.
ALTER TABLE "JourneyEvent" ADD CONSTRAINT "JourneyEvent_idempotency_key_required"
  CHECK ("idempotencyKey" IS NOT NULL) NOT VALID;

-- Solo eventos de negocio (catálogo de src/domain/journey/events.ts); los mensajes conversacionales no entran aquí.
ALTER TABLE "JourneyEvent" ADD CONSTRAINT "JourneyEvent_business_event_type" CHECK ("type" IN (
    'EVALUATED',
    'PLAN_VALIDATED',
    'CONTACT_SENT',
    'CONTACT_SUPPRESSED',
    'OWNER_OPENED',
    'ODOMETER_RECORDED',
    'RECOMMENDATION_SHOWN',
    'HUMAN_CASE_OPENED',
    'QUOTE_ISSUED',
    'SLOTS_LISTED',
    'BOOKING_INTENT_CREATED',
    'BOOKING_CONFIRMED',
    'BOOKING_FAILED',
    'INTENT_EXPIRED',
    'BOOKING_CANCELLED',
    'WORK_ORDER_OPENED',
    'WORK_ORDER_COMPLETED',
    'REEVALUATED',
    'FEEDBACK_RECEIVED',
    'FOLLOW_UP_TIMEOUT',
    'SAFETY_SIGNAL',
    'CASE_RESOLVED_BY_HUMAN')) NOT VALID;

ALTER TABLE "JourneyEvent" ADD CONSTRAINT "JourneyEvent_seq_positive" CHECK ("seq" >= 1);

-- ───────────────────────── Recordatorios (ADR-015) ─────────────────────────

ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_dedup_required"
  CHECK ("dedupKey" IS NOT NULL AND "cycleKey" IS NOT NULL) NOT VALID;

ALTER TABLE "CommunicationPolicy" ADD CONSTRAINT "CommunicationPolicy_frequency_bounds"
  CHECK ("minDaysBetweenReminders" >= 1 AND "maxRemindersPerCycle" >= 0);

-- ───────────────────────── Cartera de asesores (ADR-016) ─────────────────────────

ALTER TABLE "PortfolioAssignment" ADD CONSTRAINT "PortfolioAssignment_valid_range"
  CHECK ("validTo" IS NULL OR "validTo" > "validFrom");

CREATE UNIQUE INDEX "PortfolioAssignment_one_active_per_actor_customer"
  ON "PortfolioAssignment" ("actorId", "customerId") WHERE "validTo" IS NULL;
