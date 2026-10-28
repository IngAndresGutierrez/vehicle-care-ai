-- CreateEnum
CREATE TYPE "ActorRole" AS ENUM ('OWNER', 'ADVISOR', 'WORKSHOP_COORDINATOR', 'TECHNICIAN', 'COMPLIANCE', 'SYSTEM_AGENT', 'SYSTEM_JOB');

-- CreateEnum
CREATE TYPE "Provenance" AS ENUM ('WORKSHOP_VERIFIED', 'DELIVERY_INSPECTION', 'PRIOR_OWNER_DOCUMENT', 'OWNER_DECLARED');

-- CreateEnum
CREATE TYPE "DataOrigin" AS ENUM ('REAL', 'SYNTHETIC');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('VERIFIED', 'UNVERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TimingDrive" AS ENUM ('BELT', 'CHAIN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('GASOLINE', 'DIESEL', 'OTHER');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'VALIDATED', 'RETIRED');

-- CreateEnum
CREATE TYPE "UsageCondition" AS ENUM ('NORMAL', 'SEVERE');

-- CreateEnum
CREATE TYPE "TechnicalDueStatus" AS ENUM ('NOT_DUE', 'DUE', 'NOT_APPLICABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DueStatus" AS ENUM ('NOT_DUE', 'UPCOMING', 'DUE', 'OVERDUE', 'NOT_APPLICABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('SERVICE_OPERATIONAL', 'MAINTENANCE_REMINDERS', 'MARKETING', 'AI_ASSISTANT_PROCESSING');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('PORTAL', 'EMAIL', 'SMS', 'WHATSAPP', 'PHONE');

-- CreateEnum
CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "JourneyState" AS ENUM ('ACTIVATED', 'PLAN_PENDING_VERIFICATION', 'MONITORING', 'NEED_DETECTED', 'CONTACT_SUPPRESSED', 'CONVERSATION_OPEN', 'AWAITING_CONTEXT', 'RECOMMENDATION_PRESENTED', 'QUOTE_PRESENTED', 'QUOTE_PENDING_HUMAN', 'SLOT_SELECTION', 'AWAITING_CONFIRMATION', 'BOOKED', 'IN_SERVICE', 'SERVICE_COMPLETED', 'FOLLOW_UP', 'HUMAN_REVIEW', 'SAFETY_ESCALATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CONSUMED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BookingIntentStatus" AS ENUM ('AWAITING_USER', 'CONSUMED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HumanCaseReason" AS ENUM ('INSUFFICIENT_HISTORY', 'PLAN_NOT_VERIFIED', 'SAFETY_ESCALATION', 'QUOTE_UNAVAILABLE', 'BOOKING_FAILURE', 'CUSTOMER_REQUEST', 'DATA_CONFLICT');

-- CreateEnum
CREATE TYPE "CasePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'ASSIGNED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM_NOTICE');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('MOCK', 'REAL', 'INTERNAL');

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "externalCrmRef" TEXT,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT,
    "documentType" TEXT,
    "documentNumber" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "city" TEXT,
    "dataOrigin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "syntheticSourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActorAccount" (
    "id" TEXT NOT NULL,
    "role" "ActorRole" NOT NULL,
    "displayName" TEXT NOT NULL,
    "customerId" TEXT,
    "workshopId" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActorAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleSpec" (
    "id" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelYear" INTEGER NOT NULL,
    "engineCode" TEXT,
    "displacementCc" INTEGER,
    "fuelType" "FuelType" NOT NULL,
    "timingDrive" "TimingDrive" NOT NULL DEFAULT 'UNKNOWN',
    "market" TEXT NOT NULL DEFAULT 'CO',
    "dataOrigin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "syntheticSourceRef" TEXT,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "VehicleSpec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "vin" TEXT,
    "plate" TEXT,
    "specId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "deliveryOdometerKm" INTEGER,
    "usageCondition" "UsageCondition",
    "dataOrigin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "syntheticSourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleOwnership" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "evidenceRef" TEXT,

    CONSTRAINT "VehicleOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "MaintenancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanApplicability" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "specId" TEXT NOT NULL,

    CONSTRAINT "PlanApplicability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlanVersion" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceRef" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "dataOrigin" "DataOrigin" NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "effectiveFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenancePlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRule" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "intervalKm" INTEGER,
    "intervalMonths" INTEGER,
    "appliesToTimingDrive" "TimingDrive",
    "usageCondition" "UsageCondition",
    "requiresUsageCondition" BOOLEAN NOT NULL DEFAULT false,
    "allowDeliveryBaseline" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "MaintenanceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationPolicy" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "leadKm" INTEGER NOT NULL,
    "leadDays" INTEGER NOT NULL,
    "overdueGraceKm" INTEGER NOT NULL,
    "overdueGraceDays" INTEGER NOT NULL,
    "dataOrigin" "DataOrigin" NOT NULL,
    "syntheticSourceRef" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataQualityPolicy" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "maxOdometerAgeDays" INTEGER NOT NULL,
    "dataOrigin" "DataOrigin" NOT NULL,
    "syntheticSourceRef" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataQualityPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdometerReading" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "valueKm" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "provenance" "Provenance" NOT NULL,
    "dataOrigin" "DataOrigin" NOT NULL,
    "syntheticSourceRef" TEXT,
    "verification" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "recordedById" TEXT NOT NULL,
    "supersedesId" TEXT,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdometerReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRecord" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "performedOn" DATE NOT NULL,
    "odometerKm" INTEGER NOT NULL,
    "provenance" "Provenance" NOT NULL,
    "dataOrigin" "DataOrigin" NOT NULL,
    "syntheticSourceRef" TEXT,
    "workshopId" TEXT,
    "workOrderId" TEXT,
    "evidenceRef" TEXT,
    "recordedById" TEXT NOT NULL,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceEvaluation" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "status" "DueStatus" NOT NULL,
    "technicalStatus" "TechnicalDueStatus" NOT NULL,
    "communicationStatus" "DueStatus",
    "reasons" TEXT[],
    "dueByKm" INTEGER,
    "dueByDate" DATE,
    "reachedBy" TEXT,
    "triggeredBy" TEXT,
    "remainingKm" INTEGER,
    "remainingDays" INTEGER,
    "requiresOdometerConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "suggestedAction" TEXT NOT NULL,
    "planVersionId" TEXT,
    "planVersionLabel" TEXT,
    "planSourceRef" TEXT,
    "ruleId" TEXT,
    "asOfLocalDate" DATE NOT NULL,
    "commPolicyVersion" TEXT NOT NULL,
    "dataQualityPolicyVersion" TEXT NOT NULL,
    "containsSyntheticData" BOOLEAN NOT NULL,
    "syntheticSources" TEXT[],
    "engineVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "decisionTrace" JSONB NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "traceId" TEXT,

    CONSTRAINT "MaintenanceEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "channel" "Channel" NOT NULL,
    "isGranted" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentEvent" (
    "id" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "action" "ConsentAction" NOT NULL,
    "legalTextVersion" TEXT NOT NULL,
    "evidenceRef" TEXT NOT NULL,
    "capturedVia" "Channel" NOT NULL,
    "capturedById" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workshop" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Workshop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkshopService" (
    "id" TEXT NOT NULL,
    "workshopId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "externalServiceCode" TEXT NOT NULL,

    CONSTRAINT "WorkshopService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "workshopId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "externalQuoteRef" TEXT,
    "status" "QuoteStatus" NOT NULL,
    "isEstimate" BOOLEAN NOT NULL,
    "subtotalCop" INTEGER,
    "taxCop" INTEGER,
    "totalCop" INTEGER,
    "taxLabel" TEXT,
    "includedItems" JSONB,
    "restrictions" TEXT[],
    "catalogVersion" TEXT,
    "validUntil" TIMESTAMP(3),
    "source" "DataSource" NOT NULL,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingIntent" (
    "id" TEXT NOT NULL,
    "confirmationToken" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "slotExternalRef" TEXT NOT NULL,
    "slotStartsAt" TIMESTAMP(3) NOT NULL,
    "workshopId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "BookingIntentStatus" NOT NULL DEFAULT 'AWAITING_USER',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "workshopId" TEXT NOT NULL,
    "slotExternalRef" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "status" "BookingStatus" NOT NULL,
    "externalBookingRef" TEXT,
    "failureCode" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "source" "DataSource" NOT NULL,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "bookingId" TEXT,
    "externalRef" TEXT,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completionOdometerKm" INTEGER,
    "invoiceRef" TEXT,
    "dataOrigin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "syntheticSourceRef" TEXT,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanCase" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "reason" "HumanCaseReason" NOT NULL,
    "priority" "CasePriority" NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeRole" "ActorRole" NOT NULL,
    "assigneeId" TEXT,
    "minimalContext" JSONB NOT NULL,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HumanCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyInstance" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "useCase" TEXT NOT NULL DEFAULT 'UC-01',
    "serviceCode" TEXT NOT NULL,
    "state" "JourneyState" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JourneyInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyEvent" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "fromState" "JourneyState" NOT NULL,
    "toState" "JourneyState" NOT NULL,
    "payload" JSONB NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" "ActorRole" NOT NULL,
    "traceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JourneyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationSession" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "memory" JSONB NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "cards" JSONB,
    "traceId" TEXT NOT NULL,
    "flagged" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "traceId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" "ActorRole" NOT NULL,
    "vehicleIdHash" TEXT NOT NULL,
    "inputRedacted" JSONB NOT NULL,
    "outputSummary" JSONB,
    "ok" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "stateAtCall" "JourneyState",
    "source" "DataSource" NOT NULL,
    "idempotencyKey" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" "ActorRole" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "traceId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "templateId" TEXT NOT NULL,
    "consentEventId" TEXT,
    "status" TEXT NOT NULL,
    "suppressionReason" TEXT,
    "dataOrigin" "DataOrigin" NOT NULL,
    "syntheticSourceRef" TEXT,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockCatalogPrice" (
    "id" TEXT NOT NULL,
    "workshopExternalRef" TEXT NOT NULL,
    "externalServiceCode" TEXT NOT NULL,
    "specKey" TEXT NOT NULL,
    "subtotalCop" INTEGER NOT NULL,
    "taxCop" INTEGER NOT NULL,
    "taxLabel" TEXT NOT NULL,
    "includedItems" JSONB NOT NULL,
    "restrictions" TEXT[],
    "catalogVersion" TEXT NOT NULL,
    "validityHours" INTEGER NOT NULL,
    "isEstimate" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MockCatalogPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockSlot" (
    "id" TEXT NOT NULL,
    "workshopExternalRef" TEXT NOT NULL,
    "externalServiceCode" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,

    CONSTRAINT "MockSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockBooking" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "externalQuoteRef" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockWorkOrder" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "mockBookingId" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "MockWorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockScenario" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "remainingUses" INTEGER,
    "params" JSONB,

    CONSTRAINT "MockScenario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_externalCrmRef_key" ON "Customer"("externalCrmRef");

-- CreateIndex
CREATE INDEX "ActorAccount_role_idx" ON "ActorAccount"("role");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleSpec_make_model_modelYear_engineCode_market_key" ON "VehicleSpec"("make", "model", "modelYear", "engineCode", "market");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_vin_key" ON "Vehicle"("vin");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_plate_key" ON "Vehicle"("plate");

-- CreateIndex
CREATE INDEX "VehicleOwnership_vehicleId_validTo_idx" ON "VehicleOwnership"("vehicleId", "validTo");

-- CreateIndex
CREATE INDEX "VehicleOwnership_customerId_idx" ON "VehicleOwnership"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanApplicability_planId_specId_key" ON "PlanApplicability"("planId", "specId");

-- CreateIndex
CREATE INDEX "MaintenancePlanVersion_planId_status_idx" ON "MaintenancePlanVersion"("planId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenancePlanVersion_planId_version_key" ON "MaintenancePlanVersion"("planId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRule_planVersionId_serviceCode_usageCondition_key" ON "MaintenanceRule"("planVersionId", "serviceCode", "usageCondition");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationPolicy_version_key" ON "CommunicationPolicy"("version");

-- CreateIndex
CREATE UNIQUE INDEX "DataQualityPolicy_version_key" ON "DataQualityPolicy"("version");

-- CreateIndex
CREATE INDEX "OdometerReading_vehicleId_observedAt_idx" ON "OdometerReading"("vehicleId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRecord_workOrderId_key" ON "ServiceRecord"("workOrderId");

-- CreateIndex
CREATE INDEX "ServiceRecord_vehicleId_serviceCode_performedOn_idx" ON "ServiceRecord"("vehicleId", "serviceCode", "performedOn");

-- CreateIndex
CREATE INDEX "MaintenanceEvaluation_vehicleId_serviceCode_evaluatedAt_idx" ON "MaintenanceEvaluation"("vehicleId", "serviceCode", "evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_customerId_purpose_channel_key" ON "Consent"("customerId", "purpose", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Workshop_externalRef_key" ON "Workshop"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "WorkshopService_workshopId_serviceCode_key" ON "WorkshopService"("workshopId", "serviceCode");

-- CreateIndex
CREATE INDEX "Quote_vehicleId_serviceCode_status_idx" ON "Quote"("vehicleId", "serviceCode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BookingIntent_confirmationToken_key" ON "BookingIntent"("confirmationToken");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_intentId_key" ON "Booking"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_externalBookingRef_key" ON "Booking"("externalBookingRef");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_idempotencyKey_key" ON "Booking"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_bookingId_key" ON "WorkOrder"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_externalRef_key" ON "WorkOrder"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "HumanCase_idempotencyKey_key" ON "HumanCase"("idempotencyKey");

-- CreateIndex
CREATE INDEX "HumanCase_status_priority_slaDueAt_idx" ON "HumanCase"("status", "priority", "slaDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "JourneyInstance_vehicleId_useCase_serviceCode_key" ON "JourneyInstance"("vehicleId", "useCase", "serviceCode");

-- CreateIndex
CREATE INDEX "JourneyEvent_traceId_idx" ON "JourneyEvent"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "JourneyEvent_journeyId_seq_key" ON "JourneyEvent"("journeyId", "seq");

-- CreateIndex
CREATE INDEX "ConversationMessage_sessionId_createdAt_idx" ON "ConversationMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolCall_traceId_idx" ON "ToolCall"("traceId");

-- CreateIndex
CREATE INDEX "ToolCall_toolName_createdAt_idx" ON "ToolCall"("toolName", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "MockCatalogPrice_workshopExternalRef_externalServiceCode_sp_key" ON "MockCatalogPrice"("workshopExternalRef", "externalServiceCode", "specKey");

-- CreateIndex
CREATE INDEX "MockSlot_workshopExternalRef_externalServiceCode_startsAt_idx" ON "MockSlot"("workshopExternalRef", "externalServiceCode", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "MockBooking_folio_key" ON "MockBooking"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "MockBooking_idempotencyKey_key" ON "MockBooking"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MockWorkOrder_folio_key" ON "MockWorkOrder"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "MockWorkOrder_mockBookingId_key" ON "MockWorkOrder"("mockBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "MockScenario_key_key" ON "MockScenario"("key");

-- AddForeignKey
ALTER TABLE "ActorAccount" ADD CONSTRAINT "ActorAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActorAccount" ADD CONSTRAINT "ActorAccount_workshopId_fkey" FOREIGN KEY ("workshopId") REFERENCES "Workshop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_specId_fkey" FOREIGN KEY ("specId") REFERENCES "VehicleSpec"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleOwnership" ADD CONSTRAINT "VehicleOwnership_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleOwnership" ADD CONSTRAINT "VehicleOwnership_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanApplicability" ADD CONSTRAINT "PlanApplicability_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MaintenancePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanApplicability" ADD CONSTRAINT "PlanApplicability_specId_fkey" FOREIGN KEY ("specId") REFERENCES "VehicleSpec"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlanVersion" ADD CONSTRAINT "MaintenancePlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MaintenancePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRule" ADD CONSTRAINT "MaintenanceRule_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "MaintenancePlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceEvaluation" ADD CONSTRAINT "MaintenanceEvaluation_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceEvaluation" ADD CONSTRAINT "MaintenanceEvaluation_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "MaintenancePlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkshopService" ADD CONSTRAINT "WorkshopService_workshopId_fkey" FOREIGN KEY ("workshopId") REFERENCES "Workshop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingIntent" ADD CONSTRAINT "BookingIntent_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "BookingIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanCase" ADD CONSTRAINT "HumanCase_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyInstance" ADD CONSTRAINT "JourneyInstance_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyEvent" ADD CONSTRAINT "JourneyEvent_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "JourneyInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationSession" ADD CONSTRAINT "ConversationSession_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConversationSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ConversationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_consentEventId_fkey" FOREIGN KEY ("consentEventId") REFERENCES "ConsentEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
