-- Una regla solo puede restringirse a correa o cadena; UNKNOWN describe vehículos, no reglas (ADR-014).
ALTER TABLE "MaintenanceRule" ADD CONSTRAINT "MaintenanceRule_timing_scope" CHECK (
  "appliesToTimingDrive" IS NULL OR "appliesToTimingDrive" IN ('BELT', 'CHAIN'));
