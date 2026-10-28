-- Corrige CHECKs que aceptaban NULL por la lógica de tres valores de SQL: un CHECK que evalúa a NULL
-- se considera satisfecho. Detectado por los tests de integración (ADR-014).
--  1) dataOrigin=SYNTHETIC con syntheticSourceRef NULL era aceptado.
--  2) technicalStatus DUE/NOT_DUE con communicationStatus NULL era aceptado.

ALTER TABLE "Customer" DROP CONSTRAINT "Customer_data_origin_label";
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" IS NOT NULL AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

ALTER TABLE "VehicleSpec" DROP CONSTRAINT "VehicleSpec_data_origin_label";
ALTER TABLE "VehicleSpec" ADD CONSTRAINT "VehicleSpec_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" IS NOT NULL AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

ALTER TABLE "Vehicle" DROP CONSTRAINT "Vehicle_data_origin_label";
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" IS NOT NULL AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

ALTER TABLE "OdometerReading" DROP CONSTRAINT "OdometerReading_data_origin_label";
ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" IS NOT NULL AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

ALTER TABLE "ServiceRecord" DROP CONSTRAINT "ServiceRecord_data_origin_label";
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" IS NOT NULL AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

ALTER TABLE "WorkOrder" DROP CONSTRAINT "WorkOrder_data_origin_label";
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" IS NOT NULL AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

ALTER TABLE "CommunicationPolicy" DROP CONSTRAINT "CommunicationPolicy_data_origin_label";
ALTER TABLE "CommunicationPolicy" ADD CONSTRAINT "CommunicationPolicy_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" IS NOT NULL AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

ALTER TABLE "DataQualityPolicy" DROP CONSTRAINT "DataQualityPolicy_data_origin_label";
ALTER TABLE "DataQualityPolicy" ADD CONSTRAINT "DataQualityPolicy_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" IS NOT NULL AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

ALTER TABLE "OutboundMessage" DROP CONSTRAINT "OutboundMessage_data_origin_label";
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_data_origin_label" CHECK (
  ("dataOrigin" = 'SYNTHETIC' AND "syntheticSourceRef" IS NOT NULL AND "syntheticSourceRef" LIKE 'SYNTHETIC-DEMO:%')
  OR ("dataOrigin" = 'REAL' AND "syntheticSourceRef" IS NULL));

ALTER TABLE "MaintenanceEvaluation" DROP CONSTRAINT "MaintenanceEvaluation_status_integrity";
ALTER TABLE "MaintenanceEvaluation" ADD CONSTRAINT "MaintenanceEvaluation_status_integrity" CHECK (
  CASE "technicalStatus"
    WHEN 'UNKNOWN' THEN "status" = 'UNKNOWN' AND "communicationStatus" IS NULL
      AND "dueByKm" IS NULL AND "dueByDate" IS NULL AND "remainingKm" IS NULL AND "remainingDays" IS NULL
    WHEN 'NOT_APPLICABLE' THEN "status" = 'NOT_APPLICABLE' AND "communicationStatus" IS NULL
    WHEN 'DUE' THEN "communicationStatus" IS NOT NULL AND "communicationStatus" IN ('DUE', 'OVERDUE')
      AND "status" = "communicationStatus"
    WHEN 'NOT_DUE' THEN "communicationStatus" IS NOT NULL AND "communicationStatus" IN ('NOT_DUE', 'UPCOMING')
      AND "status" = "communicationStatus"
    ELSE FALSE
  END);
