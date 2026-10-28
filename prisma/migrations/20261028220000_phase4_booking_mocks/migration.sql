-- Fase 4 — Reservas con sistemas MOCK (ADR-017).
-- Segura sobre datos existentes: el token pasa a guardarse como hash mediante RENAME + UPDATE (sin DROP),
-- y las columnas obligatorias nuevas usan CHECK ... NOT VALID.

-- Token de confirmación: nunca en texto plano. Se renombra la columna y se convierte cada valor a sha256,
-- de modo que las intenciones pendientes siguen siendo confirmables con su token original.
ALTER TABLE "BookingIntent" RENAME COLUMN "confirmationToken" TO "confirmationTokenHash";
ALTER INDEX "BookingIntent_confirmationToken_key" RENAME TO "BookingIntent_confirmationTokenHash_key";
UPDATE "BookingIntent" SET "confirmationTokenHash" = encode(sha256(convert_to("confirmationTokenHash", 'UTF8')), 'hex')
  WHERE "confirmationTokenHash" !~ '^[0-9a-f]{64}$';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "confirmedById" TEXT,
ADD COLUMN     "confirmedByRole" "ActorRole",
ADD COLUMN     "escalatedCaseId" TEXT,
ADD COLUMN     "lastReconciledAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BookingIntent" ADD COLUMN     "consumedAt" TIMESTAMP(3),
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "serviceCode" TEXT;

-- AlterTable
ALTER TABLE "MockBooking" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "customerRef" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "vehicleRef" TEXT,
ADD COLUMN     "workshopExternalRef" TEXT;

-- AlterTable
ALTER TABLE "MockWorkOrder" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completionOdometerKm" INTEGER,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "MockQuote" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "workshopExternalRef" TEXT NOT NULL,
    "externalServiceCode" TEXT NOT NULL,
    "specKey" TEXT NOT NULL,
    "subtotalCop" INTEGER NOT NULL,
    "taxCop" INTEGER NOT NULL,
    "totalCop" INTEGER NOT NULL,
    "catalogVersion" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockCrmInteraction" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "customerRef" TEXT NOT NULL,
    "vehicleRef" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockCrmInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MockQuote_externalRef_key" ON "MockQuote"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "MockCrmInteraction_idempotencyKey_key" ON "MockCrmInteraction"("idempotencyKey");

-- ───────────────────────── Invariantes de reserva (ADR-017) ─────────────────────────

ALTER TABLE "BookingIntent" ADD CONSTRAINT "BookingIntent_token_is_hash"
  CHECK ("confirmationTokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "BookingIntent" ADD CONSTRAINT "BookingIntent_scope_required"
  CHECK ("customerId" IS NOT NULL AND "serviceCode" IS NOT NULL) NOT VALID;
ALTER TABLE "BookingIntent" ADD CONSTRAINT "BookingIntent_consumed_has_time"
  CHECK ("status" <> 'CONSUMED' OR "consumedAt" IS NOT NULL) NOT VALID;

-- Toda reserva enviada al taller fue aprobada por un humano: el agente nunca figura como confirmador.
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_confirmed_by_human"
  CHECK ("status" NOT IN ('PENDING', 'CONFIRMED')
         OR ("confirmedById" IS NOT NULL AND "confirmedByRole" IS NOT NULL AND "confirmedByRole" IN ('OWNER', 'ADVISOR'))) NOT VALID;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_reconciliation_non_negative" CHECK ("reconciliationAttempts" >= 0);

-- ───────────────────────── Sistemas simulados ─────────────────────────

ALTER TABLE "MockBooking" ADD CONSTRAINT "MockBooking_status_values" CHECK ("status" IN ('CONFIRMED', 'CANCELLED'));
ALTER TABLE "MockQuote" ADD CONSTRAINT "MockQuote_amounts" CHECK (
  "subtotalCop" >= 0 AND "taxCop" >= 0 AND "totalCop" = "subtotalCop" + "taxCop");
ALTER TABLE "MockWorkOrder" ADD CONSTRAINT "MockWorkOrder_status_values" CHECK ("status" IN ('OPEN', 'COMPLETED'));
