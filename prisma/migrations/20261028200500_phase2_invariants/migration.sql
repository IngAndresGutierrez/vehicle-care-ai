-- Fase 2 — Invariantes que Prisma no expresa (prd/DATA_MODEL.md §4, ADR-010, ADR-011, ADR-012, ADR-014).
-- Solo agrega restricciones sobre tablas recién creadas (sin datos previos): segura y reproducible desde una base limpia.

-- ───────────────────────── Titularidad ─────────────────────────

-- Un único titular vigente por vehículo.
CREATE UNIQUE INDEX "VehicleOwnership_one_active_owner_per_vehicle"
  ON "VehicleOwnership" ("vehicleId") WHERE "validTo" IS NULL;

ALTER TABLE "VehicleOwnership"
  ADD CONSTRAINT "VehicleOwnership_valid_range" CHECK ("validTo" IS NULL OR "validTo" > "validFrom");

-- ───────────────────────── Origen de datos (ADR-011) ─────────────────────────
-- SYNTHETIC ⇔ fuente rotulada "SYNTHETIC-DEMO:…"; REAL ⇒ sin rótulo sintético.

ALTER TABLE "Customer" ADD CONSTRAINT "Customer_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));
ALTER TABLE "VehicleSpec" ADD CONSTRAINT "VehicleSpec_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));
ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));
ALTER TABLE "CommunicationPolicy" ADD CONSTRAINT "CommunicationPolicy_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));
ALTER TABLE "DataQualityPolicy" ADD CONSTRAINT "DataQualityPolicy_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

-- Los planes rotulan su origen en la propia fuente citada.
ALTER TABLE "MaintenancePlanVersion" ADD CONSTRAINT "MaintenancePlanVersion_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC') = ("sourceRef" LIKE 'SYNTHETIC-DEMO:%'));

-- ───────────────────────── Planes y reglas ─────────────────────────

ALTER TABLE "MaintenancePlanVersion" ADD CONSTRAINT "MaintenancePlanVersion_validated_is_approved" CHECK (
  "status" <> 'VALIDATED' OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL));

ALTER TABLE "MaintenanceRule" ADD CONSTRAINT "MaintenanceRule_positive_intervals" CHECK (
  ("intervalKm" IS NULL OR "intervalKm" > 0) AND ("intervalMonths" IS NULL OR "intervalMonths" > 0));

-- La unicidad de Prisma trata NULL como distinto; una regla general (usageCondition NULL) por servicio y versión.
CREATE UNIQUE INDEX "MaintenanceRule_one_rule_per_condition"
  ON "MaintenanceRule" ("planVersionId", "serviceCode", "usageCondition") NULLS NOT DISTINCT;

-- ───────────────────────── Políticas (ADR-012) ─────────────────────────

ALTER TABLE "CommunicationPolicy" ADD CONSTRAINT "CommunicationPolicy_non_negative" CHECK (
  "leadKm" >= 0 AND "leadDays" >= 0 AND "overdueGraceKm" >= 0 AND "overdueGraceDays" >= 0);
ALTER TABLE "DataQualityPolicy" ADD CONSTRAINT "DataQualityPolicy_non_negative" CHECK ("maxOdometerAgeDays" >= 0);

CREATE UNIQUE INDEX "CommunicationPolicy_single_active" ON "CommunicationPolicy" ("isActive") WHERE "isActive";
CREATE UNIQUE INDEX "DataQualityPolicy_single_active" ON "DataQualityPolicy" ("isActive") WHERE "isActive";

-- ───────────────────────── Historial ─────────────────────────

ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_non_negative" CHECK ("valueKm" >= 0);
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_non_negative" CHECK ("odometerKm" >= 0);
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_verified_needs_work_order" CHECK (
  "provenance" <> 'WORKSHOP_VERIFIED' OR "workOrderId" IS NOT NULL);

-- ───────────────────────── Evaluaciones (ADR-012) ─────────────────────────
-- El estado consolidado debe ser coherente con el técnico y la clasificación de comunicación;
-- UNKNOWN nunca persiste cifras de vencimiento.

ALTER TABLE "MaintenanceEvaluation" ADD CONSTRAINT "MaintenanceEvaluation_status_integrity" CHECK (
  CASE "technicalStatus"
    WHEN 'UNKNOWN' THEN "status" = 'UNKNOWN' AND "communicationStatus" IS NULL
      AND "dueByKm" IS NULL AND "dueByDate" IS NULL AND "remainingKm" IS NULL AND "remainingDays" IS NULL
    WHEN 'NOT_APPLICABLE' THEN "status" = 'NOT_APPLICABLE' AND "communicationStatus" IS NULL
    WHEN 'DUE' THEN "communicationStatus" IN ('DUE', 'OVERDUE') AND "status" = "communicationStatus"
    WHEN 'NOT_DUE' THEN "communicationStatus" IN ('NOT_DUE', 'UPCOMING') AND "status" = "communicationStatus"
  END);
ALTER TABLE "MaintenanceEvaluation" ADD CONSTRAINT "MaintenanceEvaluation_synthetic_flag" CHECK (
  "containsSyntheticData" = (cardinality("syntheticSources") > 0));
ALTER TABLE "MaintenanceEvaluation" ADD CONSTRAINT "MaintenanceEvaluation_input_hash_format" CHECK (
  "inputHash" ~ '^[0-9a-f]{64}$');

-- ───────────────────────── Comunicaciones salientes (ADR-010) ─────────────────────────

ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_status_values" CHECK (
  "status" IN ('SIMULATED_SENT', 'SUPPRESSED'));
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_sent_needs_consent" CHECK (
  "status" <> 'SIMULATED_SENT' OR ("consentEventId" IS NOT NULL AND "suppressionReason" IS NULL));
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_suppressed_needs_reason" CHECK (
  "status" <> 'SUPPRESSED' OR "suppressionReason" IS NOT NULL);

-- ───────────────────────── Cotizaciones, reservas y órdenes ─────────────────────────

ALTER TABLE "Quote" ADD CONSTRAINT "Quote_status_integrity" CHECK (
  ("status" <> 'ACTIVE' OR ("totalCop" IS NOT NULL AND "validUntil" IS NOT NULL))
  AND ("status" <> 'UNAVAILABLE' OR ("totalCop" IS NULL AND "subtotalCop" IS NULL AND "taxCop" IS NULL)));
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_non_negative_amounts" CHECK (
  coalesce("subtotalCop", 0) >= 0 AND coalesce("taxCop", 0) >= 0 AND coalesce("totalCop", 0) >= 0);

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_confirmed_has_folio" CHECK (
  "status" <> 'CONFIRMED' OR "externalBookingRef" IS NOT NULL);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_failed_has_code" CHECK (
  "status" <> 'FAILED' OR "failureCode" IS NOT NULL);
-- Una sola reserva confirmada por vehículo y servicio (ADR-014).
CREATE UNIQUE INDEX "Booking_one_confirmed_per_vehicle_service"
  ON "Booking" ("vehicleId", "serviceCode") WHERE "status" = 'CONFIRMED';

ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_completed_integrity" CHECK (
  "status" <> 'COMPLETED' OR ("completedAt" IS NOT NULL AND "completedById" IS NOT NULL));

ALTER TABLE "HumanCase" ADD CONSTRAINT "HumanCase_resolution_integrity" CHECK (
  "status" NOT IN ('RESOLVED', 'CLOSED') OR "resolvedAt" IS NOT NULL);
ALTER TABLE "HumanCase" ADD CONSTRAINT "HumanCase_safety_is_urgent" CHECK (
  "reason" <> 'SAFETY_ESCALATION' OR "priority" = 'URGENT');

ALTER TABLE "JourneyInstance" ADD CONSTRAINT "JourneyInstance_version_non_negative" CHECK ("version" >= 0);

ALTER TABLE "MockSlot" ADD CONSTRAINT "MockSlot_capacity_bounds" CHECK (
  "capacity" > 0 AND "remaining" >= 0 AND "remaining" <= "capacity" AND "endsAt" > "startsAt");

-- ───────────────────────── Append-only ─────────────────────────
-- Registros auditables: se corrigen con un registro nuevo (supersedesId), nunca con UPDATE/DELETE.
-- Nota: TRUNCATE no dispara triggers de fila; en producción el rol de la aplicación no debe tener privilegio TRUNCATE.

CREATE FUNCTION "vc_forbid_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % no permite % (registro %)', TG_TABLE_NAME, TG_OP, OLD."id"
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "JourneyEvent_append_only" BEFORE UPDATE OR DELETE ON "JourneyEvent"
  FOR EACH ROW EXECUTE FUNCTION "vc_forbid_mutation"();
CREATE TRIGGER "ToolCall_append_only" BEFORE UPDATE OR DELETE ON "ToolCall"
  FOR EACH ROW EXECUTE FUNCTION "vc_forbid_mutation"();
CREATE TRIGGER "ConsentEvent_append_only" BEFORE UPDATE OR DELETE ON "ConsentEvent"
  FOR EACH ROW EXECUTE FUNCTION "vc_forbid_mutation"();
CREATE TRIGGER "MaintenanceEvaluation_append_only" BEFORE UPDATE OR DELETE ON "MaintenanceEvaluation"
  FOR EACH ROW EXECUTE FUNCTION "vc_forbid_mutation"();
CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "vc_forbid_mutation"();
CREATE TRIGGER "OdometerReading_append_only" BEFORE UPDATE OR DELETE ON "OdometerReading"
  FOR EACH ROW EXECUTE FUNCTION "vc_forbid_mutation"();
CREATE TRIGGER "ServiceRecord_append_only" BEFORE UPDATE OR DELETE ON "ServiceRecord"
  FOR EACH ROW EXECUTE FUNCTION "vc_forbid_mutation"();
CREATE TRIGGER "OutboundMessage_append_only" BEFORE UPDATE OR DELETE ON "OutboundMessage"
  FOR EACH ROW EXECUTE FUNCTION "vc_forbid_mutation"();
