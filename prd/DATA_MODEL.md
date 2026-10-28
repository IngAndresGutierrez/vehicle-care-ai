# Vehicle Care — Modelo de datos (Prisma + PostgreSQL)

**Versión:** 0.1 (diseño) · **Fecha:** 28-oct-2026 · Ver [`ARCHITECTURE.md`](./ARCHITECTURE.md) para contexto y lista de decisiones **[D-xx]** / supuestos **[A-xx]**.

---

## 1. Principios de modelado

1. **Procedencia y origen explícitos** en todo dato técnico (ADR-011): `Provenance` indica *quién lo respalda* (taller, alistamiento, documento de propietario anterior, declaración del cliente) y `DataOrigin` indica si es `REAL` o `SYNTHETIC`. Todo dato sintético lleva además `syntheticSourceRef` con prefijo `SYNTHETIC-DEMO:` que identifica el fixture/seed de origen (AC11).
2. **Inmutabilidad donde hay evidencia**: `JourneyEvent`, `ToolCall`, `AuditLog`, `MaintenanceEvaluation`, `ConsentEvent`, `OdometerReading` y `ServiceRecord` son *append-only*. Las correcciones se hacen con un registro nuevo que referencia al anterior (`supersedesId`), nunca con `UPDATE`.
3. **Plan técnico versionado y separado de las políticas** (ADR-012): `MaintenancePlanVersion` (técnico, aprobado por responsable) ≠ `CommunicationPolicy` (`leadKm`, `leadDays`, gracia de `OVERDUE`) ≠ `DataQualityPolicy` (`maxOdometerAgeDays`). `MaintenanceEvaluation` guarda por separado el estado técnico y la clasificación de comunicación.
4. **Dinero en COP enteros** (`Int`, sin decimales) **[A-03]**; impuestos los entrega el catálogo **[A-02]**.
5. **Tiempo**: `DateTime` → `timestamptz` en UTC; fechas de calendario de negocio (fecha de servicio) como `@db.Date`. Zona de negocio `America/Bogota` aplicada en dominio.
6. **IDs**: `cuid2`/ULID como `String`; referencias a sistemas externos en columnas `external*Ref` separadas.
7. **Mocks aislados**: tablas `Mock*` representan el estado *del sistema externo*; el dominio nunca las lee directamente, solo vía adaptador.
8. **PII minimizada**: datos de contacto en `Customer`; logs referencian `vehicleIdHash`.

---

## 2. Diagrama entidad-relación (simplificado)

```
Customer 1─* VehicleOwnership *─1 Vehicle *─1 VehicleSpec *─* MaintenancePlan 1─* MaintenancePlanVersion 1─* MaintenanceRule
   │                                │                                                         │
   ├─* Consent ─* ConsentEvent      ├─* OdometerReading                                       │
   ├─* ActorAccount (rol OWNER)     ├─* ServiceRecord ─?─ WorkOrder                            │
   │                                ├─* MaintenanceEvaluation ──────────────────────────────── ┘ (planVersionId, ruleId)
   │                                ├─1 JourneyInstance 1─* JourneyEvent
   │                                ├─* Quote ─* Booking ─?─ WorkOrder
   │                                ├─* HumanCase
   │                                └─* ConversationSession 1─* ConversationMessage
   │                                                         1─* ToolCall
Workshop 1─* WorkshopService (serviceCode ↔ código externo)
IdempotencyRecord · AuditLog · OutboundMessage · CommunicationPolicy · DataQualityPolicy · BookingIntent
Mock*: MockCatalogPrice · MockSlot · MockBooking · MockWorkOrder · MockScenario
```

---

## 3. `prisma/schema.prisma` (propuesto)

> **Implementado en Fases 2–3.** Copia de `prisma/schema.prisma` (fuente de verdad) al 2026-10-28. Fase 3 añade `JourneyInstance.context`, `JourneyEvent.idempotencyKey`, deduplicación en `OutboundMessage`, frecuencia en `CommunicationPolicy`, `PortfolioAssignment` y `HumanCase.journeyId` (ADR-015/016). Fase 4 añade `BookingIntent.confirmationTokenHash`/`customerId`/`serviceCode`, confirmación humana y reconciliación en `Booking`, `MockQuote`, `MockCrmInteraction` y estados en `MockBooking`/`MockWorkOrder` (ADR-017). Prisma 7.10.1: generador `prisma-client` con `output`; URL en `prisma.config.ts`. Cambios respecto al borrador previo en ADR-014.

```prisma
// Vehicle Care — modelo de datos (prd/DATA_MODEL.md §3, ADR-009…ADR-014).
// Invariantes que Prisma no expresa (CHECK, índices parciales, triggers append-only) viven en
// prisma/migrations/*_phase2_invariants/migration.sql.
// La URL de conexión vive en prisma.config.ts (Prisma 7).

generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

// ───────────────────────────── Enums ─────────────────────────────

enum ActorRole {
  OWNER
  ADVISOR
  WORKSHOP_COORDINATOR
  TECHNICIAN
  COMPLIANCE
  SYSTEM_AGENT
  SYSTEM_JOB
}

enum Provenance {
  WORKSHOP_VERIFIED // acreditado por OT cerrada del taller propio/aliado
  DELIVERY_INSPECTION // inspección/alistamiento de entrega de la agencia
  PRIOR_OWNER_DOCUMENT // factura/constancia aportada, no verificada por el taller
  OWNER_DECLARED // declarado por el propietario en la app
}

/// Origen del dato (ADR-011), ortogonal a Provenance. SYNTHETIC exige syntheticSourceRef "SYNTHETIC-DEMO:...".
enum DataOrigin {
  REAL
  SYNTHETIC
}

enum VerificationStatus {
  VERIFIED
  UNVERIFIED
  REJECTED
}

enum TimingDrive {
  BELT
  CHAIN
  UNKNOWN
}

enum FuelType {
  GASOLINE
  DIESEL
  OTHER
}

enum PlanStatus {
  DRAFT
  VALIDATED
  RETIRED
}

enum UsageCondition {
  NORMAL
  SEVERE
}

enum TechnicalDueStatus {
  NOT_DUE
  DUE
  NOT_APPLICABLE
  UNKNOWN
}

enum DueStatus {
  NOT_DUE
  UPCOMING
  DUE
  OVERDUE
  NOT_APPLICABLE
  UNKNOWN
}

enum ConsentPurpose {
  SERVICE_OPERATIONAL // avisos sobre una cita ya reservada
  MAINTENANCE_REMINDERS // contacto proactivo por mantenimiento
  MARKETING
  AI_ASSISTANT_PROCESSING // [D-12] pendiente validación jurídica
}

enum Channel {
  PORTAL
  EMAIL
  SMS
  WHATSAPP
  PHONE
}

enum ConsentAction {
  GRANTED
  REVOKED
}

enum JourneyState {
  ACTIVATED
  PLAN_PENDING_VERIFICATION
  MONITORING
  NEED_DETECTED
  CONTACT_SUPPRESSED
  CONVERSATION_OPEN
  AWAITING_CONTEXT
  RECOMMENDATION_PRESENTED
  QUOTE_PRESENTED
  QUOTE_PENDING_HUMAN
  SLOT_SELECTION
  AWAITING_CONFIRMATION
  BOOKED
  IN_SERVICE
  SERVICE_COMPLETED
  FOLLOW_UP
  HUMAN_REVIEW
  SAFETY_ESCALATED
  CLOSED
}

enum QuoteStatus {
  ACTIVE
  EXPIRED
  CONSUMED
  UNAVAILABLE // catálogo sin precio → cotización humana
}

enum BookingStatus {
  PENDING // enviado al taller, sin respuesta definitiva
  CONFIRMED
  FAILED
  CANCELLED
}

enum BookingIntentStatus {
  AWAITING_USER
  CONSUMED
  EXPIRED
  REJECTED
}

enum WorkOrderStatus {
  OPEN
  IN_PROGRESS
  COMPLETED
  CANCELLED
}

enum HumanCaseReason {
  INSUFFICIENT_HISTORY
  PLAN_NOT_VERIFIED
  SAFETY_ESCALATION
  QUOTE_UNAVAILABLE
  BOOKING_FAILURE
  CUSTOMER_REQUEST
  DATA_CONFLICT
}

enum CasePriority {
  LOW
  NORMAL
  HIGH
  URGENT
}

enum CaseStatus {
  OPEN
  ASSIGNED
  RESOLVED
  CLOSED
}

enum MessageRole {
  USER
  ASSISTANT
  SYSTEM_NOTICE // mensajes de plantilla (p.ej. seguridad), no generados por LLM
}

enum DataSource {
  MOCK
  REAL
  INTERNAL
}

// ─────────────────────── Identidad y clientes ───────────────────────

model Customer {
  id                 String     @id @default(cuid())
  externalCrmRef     String?    @unique
  displayName        String // alias usado con el LLM
  legalName          String?
  documentType       String? // PII: nunca al LLM
  documentNumber     String?
  email              String?
  phone              String?
  city               String?
  dataOrigin         DataOrigin @default(REAL)
  syntheticSourceRef String?
  createdAt          DateTime   @default(now())

  portfolioAssignments PortfolioAssignment[]

  ownerships    VehicleOwnership[]
  consents      Consent[]
  actorAccounts ActorAccount[]
}

model ActorAccount {
  id          String    @id @default(cuid())
  role        ActorRole
  displayName String
  customerId  String? // solo para OWNER
  customer    Customer? @relation(fields: [customerId], references: [id])
  workshopId  String? // para roles de taller
  workshop    Workshop? @relation(fields: [workshopId], references: [id])
  isDemo      Boolean   @default(true)
  createdAt   DateTime  @default(now())

  portfolioAssignments PortfolioAssignment[]

  @@index([role])
}

// ─────────────────────── Vehículo y especificación ───────────────────────

model VehicleSpec {
  id                 String      @id @default(cuid())
  make               String
  model              String
  modelYear          Int
  engineCode         String? // null → motor no identificado → UNKNOWN
  displacementCc     Int?
  fuelType           FuelType
  timingDrive        TimingDrive @default(UNKNOWN)
  market             String      @default("CO")
  dataOrigin         DataOrigin  @default(REAL) // marcas/motores ficticios ("DemoMotors", "DEMO-*") ⇒ SYNTHETIC
  syntheticSourceRef String?
  verifiedBy         String? // responsable técnico
  verifiedAt         DateTime?

  vehicles  Vehicle[]
  planLinks PlanApplicability[]

  @@unique([make, model, modelYear, engineCode, market])
}

model Vehicle {
  id                 String          @id @default(cuid())
  vin                String?         @unique // nunca concede acceso por sí solo
  plate              String?         @unique // PII-adyacente: enmascarar en UI/LLM
  specId             String
  spec               VehicleSpec     @relation(fields: [specId], references: [id])
  deliveredAt        DateTime? // entrega por la agencia (segmento P0 ≤180 días)
  deliveryOdometerKm Int?
  usageCondition     UsageCondition? // declarado/validado; null = desconocido
  dataOrigin         DataOrigin      @default(REAL)
  syntheticSourceRef String?
  createdAt          DateTime        @default(now())

  ownerships       VehicleOwnership[]
  odometerReadings OdometerReading[]
  serviceRecords   ServiceRecord[]
  evaluations      MaintenanceEvaluation[]
  journeys         JourneyInstance[]
  quotes           Quote[]
  bookings         Booking[]
  humanCases       HumanCase[]
  sessions         ConversationSession[]
  workOrders       WorkOrder[]
}

model VehicleOwnership {
  id          String    @id @default(cuid())
  vehicleId   String
  vehicle     Vehicle   @relation(fields: [vehicleId], references: [id])
  customerId  String
  customer    Customer  @relation(fields: [customerId], references: [id])
  validFrom   DateTime
  validTo     DateTime? // null = titular vigente
  evidenceRef String? // expediente de entrega

  @@index([vehicleId, validTo])
  @@index([customerId])
}

// ─────────────────────── Planes técnicos ───────────────────────

model MaintenancePlan {
  id            String                   @id @default(cuid())
  name          String // "Plan demo — Sedán 1.6 gasolina"
  versions      MaintenancePlanVersion[]
  applicability PlanApplicability[]
}

model PlanApplicability {
  id     String          @id @default(cuid())
  planId String
  plan   MaintenancePlan @relation(fields: [planId], references: [id])
  specId String
  spec   VehicleSpec     @relation(fields: [specId], references: [id])

  @@unique([planId, specId])
}

model MaintenancePlanVersion {
  id            String          @id @default(cuid())
  planId        String
  plan          MaintenancePlan @relation(fields: [planId], references: [id])
  version       String // semver o "2026-10-r1"
  status        PlanStatus      @default(DRAFT)
  sourceRef     String // manual / documento técnico citado; si SYNTHETIC empieza por "SYNTHETIC-DEMO:"
  sourceUrl     String?
  dataOrigin    DataOrigin // sin default: debe declararse explícitamente (ADR-011)
  approvedBy    String?
  approvedAt    DateTime?
  effectiveFrom DateTime?
  createdAt     DateTime        @default(now())

  rules       MaintenanceRule[]
  evaluations MaintenanceEvaluation[]

  @@unique([planId, version])
  @@index([planId, status])
}

model MaintenanceRule {
  id                     String                 @id @default(cuid())
  planVersionId          String
  planVersion            MaintenancePlanVersion @relation(fields: [planVersionId], references: [id])
  serviceCode            String // ENGINE_OIL_FILTER, TIMING_BELT, ...
  description            String
  intervalKm             Int?
  intervalMonths         Int?
  appliesToTimingDrive   TimingDrive? // p.ej. BELT para TIMING_BELT
  usageCondition         UsageCondition? // regla específica por condición
  requiresUsageCondition Boolean                @default(false)
  allowDeliveryBaseline  Boolean                @default(false) // [D-04]
  notes                  String?

  @@unique([planVersionId, serviceCode, usageCondition])
}

/// Umbrales comerciales de comunicación (ADR-012). Nunca alteran el vencimiento técnico.
model CommunicationPolicy {
  id                      String     @id @default(cuid())
  version                 String     @unique
  leadKm                  Int // [D-02] → UPCOMING
  leadDays                Int
  overdueGraceKm          Int // [D-01] → OVERDUE
  overdueGraceDays        Int
  minDaysBetweenReminders Int        @default(14) // separación mínima y ancho de ventana de contacto (ADR-015)
  maxRemindersPerCycle    Int        @default(2) // tope de recordatorios enviados por ciclo
  dataOrigin              DataOrigin
  syntheticSourceRef      String?
  isActive                Boolean    @default(false)
  createdAt               DateTime   @default(now())
}

/// Calidad de datos (ADR-012): cuándo una lectura de odómetro deja de ser concluyente.
model DataQualityPolicy {
  id                 String     @id @default(cuid())
  version            String     @unique
  maxOdometerAgeDays Int // [D-03]
  dataOrigin         DataOrigin
  syntheticSourceRef String?
  isActive           Boolean    @default(false)
  createdAt          DateTime   @default(now())
}

// ─────────────────────── Historial con procedencia ───────────────────────

model OdometerReading {
  id                 String             @id @default(cuid())
  vehicleId          String
  vehicle            Vehicle            @relation(fields: [vehicleId], references: [id])
  valueKm            Int
  observedAt         DateTime
  provenance         Provenance
  dataOrigin         DataOrigin
  syntheticSourceRef String?
  verification       VerificationStatus @default(UNVERIFIED)
  recordedById       String // ActorAccount.id
  supersedesId       String? // corrección sin UPDATE
  traceId            String?
  createdAt          DateTime           @default(now())

  @@index([vehicleId, observedAt])
}

model ServiceRecord {
  id                 String     @id @default(cuid())
  vehicleId          String
  vehicle            Vehicle    @relation(fields: [vehicleId], references: [id])
  serviceCode        String
  performedOn        DateTime   @db.Date
  odometerKm         Int
  provenance         Provenance
  dataOrigin         DataOrigin
  syntheticSourceRef String?
  workshopId         String?
  workOrderId        String?    @unique
  workOrder          WorkOrder? @relation(fields: [workOrderId], references: [id])
  evidenceRef        String? // factura/OT/documento
  recordedById       String
  supersedesId       String?
  createdAt          DateTime   @default(now())

  @@index([vehicleId, serviceCode, performedOn])
}

// ─────────────────────── Motor: resultados persistidos ───────────────────────

model MaintenanceEvaluation {
  id                           String                  @id @default(cuid())
  vehicleId                    String
  vehicle                      Vehicle                 @relation(fields: [vehicleId], references: [id])
  serviceCode                  String
  status                       DueStatus // consolidado (journey/UI)
  technicalStatus              TechnicalDueStatus // solo plan + historial (ADR-012)
  communicationStatus          DueStatus? // NOT_DUE | UPCOMING | DUE | OVERDUE; null si técnico UNKNOWN/NOT_APPLICABLE
  reasons                      String[] // ReasonCode[]
  dueByKm                      Int?
  dueByDate                    DateTime?               @db.Date
  reachedBy                    String? // KM | TIME | BOTH (técnico)
  triggeredBy                  String? // KM | TIME | BOTH (comunicación)
  remainingKm                  Int?
  remainingDays                Int?
  requiresOdometerConfirmation Boolean                 @default(false)
  suggestedAction              String
  planVersionId                String?
  planVersion                  MaintenancePlanVersion? @relation(fields: [planVersionId], references: [id])
  planVersionLabel             String? // snapshot de la versión citada
  planSourceRef                String? // snapshot de la fuente citada (SYNTHETIC-DEMO:… si es demo)
  ruleId                       String?
  baselineServiceRecordId      String? // servicio de referencia del ciclo evaluado
  cycleKey                     String? // clave estable del ciclo (vehículo, servicio, regla, servicio de referencia)
  asOfLocalDate                DateTime                @db.Date // fecha de negocio America/Bogota
  commPolicyVersion            String
  dataQualityPolicyVersion     String
  containsSyntheticData        Boolean
  syntheticSources             String[]
  engineVersion                String
  inputHash                    String
  inputSnapshot                Json // EvaluationInput canónico (sin PII)
  decisionTrace                Json
  evaluatedAt                  DateTime
  traceId                      String?

  outboundMessages OutboundMessage[]

  @@index([vehicleId, serviceCode, evaluatedAt])
}

// ─────────────────────── Consentimiento (Ley 1581) ───────────────────────

model Consent {
  id         String         @id @default(cuid())
  customerId String
  customer   Customer       @relation(fields: [customerId], references: [id])
  purpose    ConsentPurpose
  channel    Channel
  isGranted  Boolean // proyección del último ConsentEvent
  updatedAt  DateTime       @updatedAt
  events     ConsentEvent[]

  @@unique([customerId, purpose, channel])
}

model ConsentEvent {
  id               String        @id @default(cuid())
  consentId        String
  consent          Consent       @relation(fields: [consentId], references: [id])
  action           ConsentAction
  legalTextVersion String
  evidenceRef      String // comprobante (firma, checkbox+IP, etc.)
  capturedVia      Channel
  capturedById     String
  occurredAt       DateTime      @default(now())

  outboundMessages OutboundMessage[]
}

// ─────────────────────── Talleres, cotizaciones y reservas ───────────────────────

model Workshop {
  id          String            @id @default(cuid())
  name        String
  city        String
  externalRef String            @unique
  isActive    Boolean           @default(true)
  services    WorkshopService[]
  actors      ActorAccount[]
}

model WorkshopService {
  id                  String   @id @default(cuid())
  workshopId          String
  workshop            Workshop @relation(fields: [workshopId], references: [id])
  serviceCode         String // código interno
  externalServiceCode String // capa anticorrupción

  @@unique([workshopId, serviceCode])
}

model Quote {
  id               String          @id @default(cuid())
  vehicleId        String
  vehicle          Vehicle         @relation(fields: [vehicleId], references: [id])
  workshopId       String
  serviceCode      String
  externalQuoteRef String?
  status           QuoteStatus
  isEstimate       Boolean // estimado vs final
  subtotalCop      Int?
  taxCop           Int?
  totalCop         Int?
  taxLabel         String? // "IVA 19%" tal como lo devuelve el catálogo
  includedItems    Json? // [{code, description, qty}]
  restrictions     String[]
  catalogVersion   String?
  validUntil       DateTime?
  source           DataSource
  traceId          String
  createdAt        DateTime        @default(now())
  bookings         Booking[]
  intents          BookingIntent[]

  @@index([vehicleId, serviceCode, status])
}

model BookingIntent {
  id                    String              @id @default(cuid())
  /// sha256 del token de confirmación; el token en claro solo se entrega una vez al solicitante (ADR-017)
  confirmationTokenHash String              @unique
  vehicleId             String
  customerId            String? // titular para quien se prepara la reserva (obligatorio en filas nuevas)
  serviceCode           String? // servicio reservado (obligatorio en filas nuevas)
  quoteId               String
  quote                 Quote               @relation(fields: [quoteId], references: [id])
  slotExternalRef       String
  slotStartsAt          DateTime
  workshopId            String
  requestedById         String // actor que preparó la intención (agente por cuenta del titular o asesor)
  status                BookingIntentStatus @default(AWAITING_USER)
  consumedAt            DateTime?
  expiresAt             DateTime
  traceId               String
  createdAt             DateTime            @default(now())
  booking               Booking?
}

model Booking {
  id                     String        @id @default(cuid())
  vehicleId              String
  vehicle                Vehicle       @relation(fields: [vehicleId], references: [id])
  quoteId                String
  quote                  Quote         @relation(fields: [quoteId], references: [id])
  serviceCode            String // desnormalizado de Quote: índice parcial "una reserva activa" (ADR-014)
  intentId               String        @unique
  intent                 BookingIntent @relation(fields: [intentId], references: [id])
  workshopId             String
  slotExternalRef        String
  startsAt               DateTime
  status                 BookingStatus
  externalBookingRef     String?       @unique // folio; null ⇒ nunca mostrar «confirmada»
  failureCode            String? // SLOT_CONFLICT, QUOTE_EXPIRED, ...
  idempotencyKey         String        @unique
  source                 DataSource
  traceId                String
  createdAt              DateTime      @default(now())
  workOrder              WorkOrder?
  /// Humano que aprobó la reserva (propietario o asesor autorizado); el agente nunca confirma.
  confirmedById          String?
  confirmedByRole        ActorRole?
  /// Reconciliación de resultados inciertos del taller (ADR-017).
  reconciliationAttempts Int           @default(0)
  lastReconciledAt       DateTime?
  escalatedCaseId        String?
}

model WorkOrder {
  id                   String          @id @default(cuid())
  vehicleId            String
  vehicle              Vehicle         @relation(fields: [vehicleId], references: [id])
  bookingId            String?         @unique
  booking              Booking?        @relation(fields: [bookingId], references: [id])
  externalRef          String?         @unique
  status               WorkOrderStatus @default(OPEN)
  completedAt          DateTime?
  completedById        String? // actor con rol de taller
  completionOdometerKm Int?
  invoiceRef           String?
  dataOrigin           DataOrigin      @default(REAL) // cierre de demo ⇒ SYNTHETIC (ADR-011, D-09)
  syntheticSourceRef   String?
  serviceRecord        ServiceRecord?
}

// ─────────────────────── Casos humanos ───────────────────────

model HumanCase {
  id             String           @id @default(cuid())
  vehicleId      String
  vehicle        Vehicle          @relation(fields: [vehicleId], references: [id])
  journeyId      String? // journey (vehículo + servicio) afectado por el caso (ADR-015)
  journey        JourneyInstance? @relation(fields: [journeyId], references: [id])
  reason         HumanCaseReason
  priority       CasePriority
  status         CaseStatus       @default(OPEN)
  assigneeRole   ActorRole // ADVISOR, COMPLIANCE, ...
  assigneeId     String?
  minimalContext Json // resumen mínimo, sin PII innecesaria
  slaDueAt       DateTime
  idempotencyKey String           @unique
  openedById     String
  traceId        String
  resolution     String?
  resolvedAt     DateTime?
  createdAt      DateTime         @default(now())

  @@index([status, priority, slaDueAt])
  @@index([journeyId])
}

// ─────────────────────── Journey (FSM + eventos) ───────────────────────

model JourneyInstance {
  id          String         @id @default(cuid())
  vehicleId   String
  vehicle     Vehicle        @relation(fields: [vehicleId], references: [id])
  useCase     String         @default("UC-01")
  serviceCode String
  state       JourneyState
  version     Int            @default(0) // bloqueo optimista
  context     Json           @default("{}") // JourneyContext de la FSM, se actualiza con el estado (ADR-015)
  updatedAt   DateTime       @updatedAt
  events      JourneyEvent[]
  humanCases  HumanCase[]

  @@unique([vehicleId, useCase, serviceCode])
}

model JourneyEvent {
  id             String          @id @default(cuid())
  journeyId      String
  journey        JourneyInstance @relation(fields: [journeyId], references: [id])
  seq            Int // = version tras aplicar
  type           String // EVALUATED, BOOKING_CONFIRMED, SAFETY_SIGNAL...
  fromState      JourneyState
  toState        JourneyState
  payload        Json
  actorId        String
  actorRole      ActorRole
  traceId        String
  idempotencyKey String?         @unique // obligatorio en filas nuevas (CHECK NOT VALID); reintentos no duplican eventos
  occurredAt     DateTime        @default(now())

  @@unique([journeyId, seq])
  @@index([traceId])
}

// ─────────────────────── Conversación y trazas del agente ───────────────────────

model ConversationSession {
  id            String                @id @default(cuid())
  vehicleId     String
  vehicle       Vehicle               @relation(fields: [vehicleId], references: [id])
  actorId       String
  memory        Json // memoria estructurada (AGENT_DESIGN §7)
  promptVersion String
  model         String
  startedAt     DateTime              @default(now())
  lastActiveAt  DateTime              @updatedAt
  messages      ConversationMessage[]
  toolCalls     ToolCall[]
}

model ConversationMessage {
  id        String              @id @default(cuid())
  sessionId String
  session   ConversationSession @relation(fields: [sessionId], references: [id])
  role      MessageRole
  content   String // texto mostrado al usuario
  cards     Json? // tarjetas estructuradas (quote, slots, booking)
  traceId   String
  flagged   String[] // SAFETY_HIT, INJECTION_SUSPECT, OUTPUT_BLOCKED
  createdAt DateTime            @default(now())

  @@index([sessionId, createdAt])
}

model ToolCall {
  id             String               @id @default(cuid())
  sessionId      String?
  session        ConversationSession? @relation(fields: [sessionId], references: [id])
  traceId        String
  toolName       String
  actorId        String
  actorRole      ActorRole
  vehicleIdHash  String // pseudonimizado
  inputRedacted  Json
  outputSummary  Json?
  ok             Boolean
  errorCode      String?
  stateAtCall    JourneyState?
  source         DataSource
  idempotencyKey String?
  durationMs     Int
  createdAt      DateTime             @default(now())

  @@index([traceId])
  @@index([toolName, createdAt])
}

model IdempotencyRecord {
  key         String   @id
  operation   String // createBooking, createHumanCase, recordOdometer
  actorId     String
  requestHash String // mismo key + distinto hash ⇒ IDEMPOTENCY_MISMATCH
  response    Json
  createdAt   DateTime @default(now())
  expiresAt   DateTime
}

model AuditLog {
  id         String    @id @default(cuid())
  actorId    String
  actorRole  ActorRole
  action     String // CASE_RESOLVED, PLAN_VALIDATED, WORK_ORDER_COMPLETED...
  entityType String
  entityId   String
  details    Json
  traceId    String?
  occurredAt DateTime  @default(now())

  @@index([entityType, entityId])
}

model OutboundMessage {
  id                 String                 @id @default(cuid())
  customerId         String
  vehicleId          String
  channel            Channel
  purpose            ConsentPurpose
  templateId         String
  consentEventId     String? // opt-in usado; null solo si SUPPRESSED (ADR-010)
  consentEvent       ConsentEvent?          @relation(fields: [consentEventId], references: [id])
  status             String // SIMULATED_SENT | SUPPRESSED
  suppressionReason  String? // p.ej. CONSENT_REQUIRED; obligatorio si SUPPRESSED
  dataOrigin         DataOrigin
  syntheticSourceRef String?
  dedupKey           String?                @unique // ciclo + política + ventana (ADR-015); obligatorio en filas nuevas
  cycleKey           String?
  evaluationId       String?
  evaluation         MaintenanceEvaluation? @relation(fields: [evaluationId], references: [id])
  traceId            String
  createdAt          DateTime               @default(now())

  @@index([cycleKey, status])
}

// ─────────────────────── Estado de sistemas externos (MOCK) ───────────────────────

model MockCatalogPrice {
  id                  String   @id @default(cuid())
  workshopExternalRef String
  externalServiceCode String
  specKey             String // make|model|year|engine
  subtotalCop         Int
  taxCop              Int
  taxLabel            String
  includedItems       Json
  restrictions        String[]
  catalogVersion      String
  validityHours       Int
  isEstimate          Boolean  @default(false)

  @@unique([workshopExternalRef, externalServiceCode, specKey])
}

model MockSlot {
  id                  String   @id @default(cuid())
  workshopExternalRef String
  externalServiceCode String
  startsAt            DateTime
  endsAt              DateTime
  capacity            Int
  remaining           Int // UPDATE ... WHERE remaining > 0

  @@index([workshopExternalRef, externalServiceCode, startsAt])
}

model MockBooking {
  id                  String    @id @default(cuid())
  folio               String    @unique // p.ej. "VC-2026-000123"
  slotId              String
  externalQuoteRef    String
  idempotencyKey      String    @unique
  requestHash         String
  createdAt           DateTime  @default(now())
  status              String    @default("CONFIRMED") // CONFIRMED | CANCELLED (estado en el sistema del taller simulado)
  workshopExternalRef String?
  vehicleRef          String?
  customerRef         String?
  cancelledAt         DateTime?
}

/// Cotizaciones emitidas por el taller simulado: el taller valida su vigencia al reservar.
model MockQuote {
  id                  String   @id @default(cuid())
  externalRef         String   @unique
  workshopExternalRef String
  externalServiceCode String
  specKey             String
  subtotalCop         Int
  taxCop              Int
  totalCop            Int
  catalogVersion      String
  validUntil          DateTime
  createdAt           DateTime @default(now())
}

/// Interacciones registradas en el CRM simulado (idempotentes).
model MockCrmInteraction {
  id             String   @id @default(cuid())
  idempotencyKey String   @unique
  kind           String
  customerRef    String
  vehicleRef     String
  payload        Json
  createdAt      DateTime @default(now())
}

model MockWorkOrder {
  id                   String    @id @default(cuid())
  folio                String    @unique
  mockBookingId        String    @unique
  status               String // OPEN | COMPLETED
  createdAt            DateTime  @default(now())
  completedAt          DateTime?
  completionOdometerKm Int?
}

model MockScenario {
  id            String  @id @default(cuid())
  key           String  @unique // SLOT_CONFLICT_ON_NEXT_BOOKING, QUOTE_UNAVAILABLE, WORKSHOP_DOWN
  isActive      Boolean @default(false)
  remainingUses Int? // null = permanente
  params        Json?
}

// ─────────────────────── Asignaciones de personal (ADR-016) ───────────────────────

/// Cartera de un asesor: limita su acceso a los clientes asignados (mínimo privilegio).
model PortfolioAssignment {
  id         String       @id @default(cuid())
  actorId    String
  actor      ActorAccount @relation(fields: [actorId], references: [id])
  customerId String
  customer   Customer     @relation(fields: [customerId], references: [id])
  validFrom  DateTime
  validTo    DateTime?
  createdAt  DateTime     @default(now())

  @@index([customerId])
  @@index([actorId])
}
```

---

## 4. Restricciones e invariantes fuera de Prisma

Prisma no expresa todo; se añaden en una migración SQL manual (`prisma migrate dev --create-only`) o se validan en la capa de aplicación:

| Invariante | Mecanismo |
|---|---|
| Un único titular vigente por vehículo | Índice único parcial `CREATE UNIQUE INDEX ... ON "VehicleOwnership"("vehicleId") WHERE "validTo" IS NULL` |
| Tablas append-only (`JourneyEvent`, `ToolCall`, `ConsentEvent`, `MaintenanceEvaluation`, `AuditLog`) | Trigger `BEFORE UPDATE OR DELETE ... RAISE EXCEPTION` (y repositorios sin métodos `update`) |
| `MockSlot.remaining >= 0` | `CHECK` constraint |
| Una sola reserva `CONFIRMED` activa por vehículo+servicio | Índice único parcial `WHERE status = 'CONFIRMED'` sobre `(vehicleId, …)` (requiere `serviceCode` en `Booking`, se deriva de `Quote`; evaluar desnormalizar) |
| `ServiceRecord.provenance = WORKSHOP_VERIFIED` ⇒ `workOrderId NOT NULL` | `CHECK` constraint |
| Odómetro declarado no menor que la última lectura verificada | Validación en `record-odometer` (transacción `SERIALIZABLE` o `SELECT ... FOR UPDATE`) |
| `Booking.status = CONFIRMED` ⇒ `externalBookingRef NOT NULL` | `CHECK` constraint |
| `MaintenancePlanVersion` con `status = VALIDATED` ⇒ `approvedBy`/`approvedAt` no nulos | `CHECK` constraint |
| `OutboundMessage`: `status='SIMULATED_SENT'` ⇒ `consentEventId NOT NULL`; `status='SUPPRESSED'` ⇒ `suppressionReason NOT NULL` (ADR-010) | `CHECK` constraint |
| `dataOrigin='SYNTHETIC'` ⇒ `syntheticSourceRef LIKE 'SYNTHETIC-DEMO:%'`; `dataOrigin='REAL'` ⇒ `syntheticSourceRef IS NULL` (en `MaintenancePlanVersion` sobre `sourceRef`) (ADR-011) | `CHECK` constraint en cada tabla con `dataOrigin` |
| Una sola `CommunicationPolicy` y una sola `DataQualityPolicy` activas | Índice único parcial `WHERE "isActive"` |
| Una regla general por servicio y versión (`usageCondition` NULL incluido) | Índice único `NULLS NOT DISTINCT` |
| Regla con `appliesToTimingDrive` solo `BELT`/`CHAIN`/NULL | `CHECK` (ADR-014) |
| `MaintenanceEvaluation`: técnico `UNKNOWN` ⇒ sin cifras ni clasificación; `DUE` ⇒ `DUE/OVERDUE`; `NOT_DUE` ⇒ `NOT_DUE/UPCOMING`; `containsSyntheticData` ⇔ fuentes; `inputHash` sha256 | `CHECK` (ADR-012) |
| `Quote` ACTIVE ⇒ total y vigencia; UNAVAILABLE ⇒ sin montos · `WorkOrder` COMPLETED ⇒ cierre registrado · `HumanCase` SAFETY ⇒ URGENT y resuelto ⇒ fecha · `MockSlot` 0 ≤ remaining ≤ capacity | `CHECK` |
| Append-only también en `OdometerReading`, `ServiceRecord` y `OutboundMessage` | Trigger `vc_forbid_mutation` (SQLSTATE `P0A01`) |

| `JourneyEvent`: tipo dentro del catálogo de eventos de negocio; `idempotencyKey` obligatoria y única; `seq ≥ 1` y único por journey | `CHECK … NOT VALID` + índices únicos (ADR-015) |
| `OutboundMessage`: `dedupKey` (única) y `cycleKey` obligatorias | `CHECK … NOT VALID` + índice único (ADR-015) |
| `CommunicationPolicy`: `minDaysBetweenReminders ≥ 1`, `maxRemindersPerCycle ≥ 0` | `CHECK` |
| `PortfolioAssignment`: rango válido; una asignación activa por asesor y cliente | `CHECK` + índice único parcial (ADR-016) |

| `BookingIntent`: token solo como sha256 (`^[0-9a-f]{64}$`); `customerId`/`serviceCode` obligatorios; `CONSUMED` ⇒ `consumedAt` | `CHECK` (+ `NOT VALID` en columnas nuevas) (ADR-017) |
| `Booking` `PENDING`/`CONFIRMED` ⇒ confirmador humano registrado con rol `OWNER` o `ADVISOR` | `CHECK … NOT VALID` (ADR-017) |
| `MockQuote.totalCop = subtotal + impuesto`; estados válidos en `MockBooking`/`MockWorkOrder` | `CHECK` |

**Migraciones:** `prisma/migrations/` — `baseline` → `phase2_data_model` (tablas generadas por Prisma) → `phase2_invariants` → `phase2_rule_timing_scope` → `phase2_append_only_errcode` → `phase2_null_safe_checks` → `phase3_journey_contact_scope` → `phase3_case_journey_link` → `phase4_booking_mocks`. Se verifican desde una base vacía con `pnpm db:verify-migrations`.

**Nota de SQL:** un `CHECK` que evalúa a `NULL` se considera satisfecho. Toda condición sobre columnas opcionales usa `IS NULL`/`IS NOT NULL` explícitos (corregido en `phase2_null_safe_checks`).

---

## 5. Seed sintético (PRD §15.1)

Todos los registros con `dataOrigin=SYNTHETIC` y `syntheticSourceRef='SYNTHETIC-DEMO:prisma/seed.ts#<id>'`. Marca ficticia **«DemoMotors»**, motores `DEMO-*`; ningún intervalo proviene de un fabricante (D-30). Fecha de referencia del reloj demo: **2026-10-28**, zona `America/Bogota`. Los mismos escenarios existen como fixtures del motor en `src/domain/maintenance-engine/__fixtures__/synthetic-demo.ts`.

| Vehículo | Spec | Plan | Historial | Odómetro | Resultado esperado |
|---|---|---|---|---|---|
| **V1 «Sedán demo»** (C1; antes C3) | 2021, motor `DEMO-1.6`, CHAIN | `VALIDATED`, aceite+filtro 5.000 km / 12 meses (regla de demo del PRD §7) | `ServiceRecord` 70.000 km el 2026-04-01 (`WORKSHOP_VERIFIED`) | 74.200 km el 2026-10-28 (`OWNER_DECLARED`) | `ENGINE_OIL_FILTER = UPCOMING` (800 km); journey feliz + EX-03 con escenario `SLOT_CONFLICT` |
| **V2 «SUV demo»** (C2) | 2019, motor `DEMO-2.0`, BELT | `VALIDATED` con regla aceite **y regla demo validada de correa** (`TIMING_BELT`, 100.000 km / 72 meses, valores ficticios, `appliesToTimingDrive=BELT`) | Aceite 90.000 km el 2026-02-15 (`PRIOR_OWNER_DOCUMENT`); **sin** constancia de cambio de correa | 95.000 km el 2026-10-20 (`DELIVERY_INSPECTION`) | `TIMING_BELT = UNKNOWN(INSUFFICIENT_HISTORY)` → EX-01 (ADR-009); `ENGINE_OIL_FILTER = DUE` → recordatorio `SUPPRESSED` (EX-04) |
| **V3 «Hatchback demo»** (C3) | 2020, motor `DEMO-1.4`, CHAIN | `VALIDATED` | Aceite 38.000 km el 2026-09-01 (`WORKSHOP_VERIFIED`) | 41.000 km el 2026-10-25 (`OWNER_DECLARED`) | `ENGINE_OIL_FILTER = NOT_DUE`; guion con síntoma de frenos → EX-02 (Fase 5) |
| **V4 «Pickup demo»** (C3) | 2018, `engineCode=null`, `UNKNOWN` | Plan demo aplicable al modelo | — | 120.000 km (`DELIVERY_INSPECTION`) | `UNKNOWN(ENGINE_UNIDENTIFIED)` (AC03) |

Políticas: `CommunicationPolicy demo-comm-v1` (1.000 km / 30 días; gracia 500 km / 30 días) y `DataQualityPolicy demo-dq-v1` (30 días), ambas `SYNTHETIC`. Clientes: C1 (todos los consentimientos), C2 (sin `MAINTENANCE_REMINDERS` → EX-04; su `OutboundMessage` queda `SUPPRESSED` con `consentEventId=null`), C3 (consentimientos completos). Talleres: T1 «Taller Norte (demo)», T2 «Taller Sur (demo)», cada uno con 3–5 `MockSlot` en los próximos 7 días y uno con `capacity=1` para provocar conflicto. Actores demo: un propietario por cliente, `ADVISOR`, un `WORKSHOP_COORDINATOR` por taller, `COMPLIANCE`, `SYSTEM_JOB`. C2 tiene `MAINTENANCE_REMINDERS`/WhatsApp otorgado y luego **revocado** (evidencia de ambos eventos). Implementación: `src/infra/seed/demo-seed.ts` (reutiliza los fixtures del motor; IDs estables). `MockCatalogPrice` no se siembra hasta la Fase 4.

---

## 6. Preguntas abiertas del modelo

- ¿Necesitamos historizar `VehicleSpec` (corrección del motor tras inspección)? Hoy se modela como dato maestro verificado; un cambio re-dispararía evaluación con `AuditLog`.
- ¿Retención de `ConversationMessage`? Política pendiente con la empresa (PRD §10); se propone purga/anonimización configurable.
- ¿`ServiceCode` como enum o tabla? Se deja `String` validado por Zod contra un catálogo en código para iterar rápido; pasar a tabla en P1.
- Desnormalizar `serviceCode` en `Booking` para el índice parcial de «una reserva activa».
