import type { ToolOutcome } from "./gateway";

/**
 * Tarjetas para la UI (Fase 6), construidas SOLO desde resultados estructurados de herramientas, nunca desde
 * el texto del modelo (AGENT_DESIGN.md §2). Contrato estable para el frontend.
 */
export type Card =
  | {
      type: "EVALUATION";
      evaluationId: string;
      serviceCode: string;
      status: string;
      technicalStatus: string;
      dueBy: { km: number | null; date: string | null } | null;
      remaining: { km: number | null; days: number | null } | null;
      reasons: string[];
      suggestedAction: string;
      requiresOdometerConfirmation: boolean;
      plan: { version: string; sourceRef: string } | null;
      syntheticData: boolean;
    }
  | { type: "PLAN"; version: string; sourceRef: string; syntheticData: boolean; rules: Array<{ serviceCode: string; intervalKm: number | null; intervalMonths: number | null; appliesToTimingDrive: string | null }> }
  | { type: "WORKSHOPS"; workshops: Array<{ workshopId: string; name: string; city: string }> }
  | {
      type: "QUOTE";
      quoteId: string;
      workshopId: string;
      isEstimate: boolean;
      subtotalCop: number;
      taxCop: number;
      totalCop: number;
      taxLabel: string;
      includedItems: Array<{ description: string; qty: number }>;
      restrictions: string[];
      validUntil: string;
      catalogVersion: string;
      source: string;
    }
  | { type: "SLOTS"; workshopId: string; slots: Array<{ slotRef: string; startsAt: string; endsAt: string }>; source: string }
  | {
      type: "BOOKING_INTENT";
      intentId: string;
      expiresAt: string;
      requiresUserConfirmation: true;
      summary: { serviceCode: string; workshopId: string; workshopName: string; slotRef: string; startsAt: string; totalCop: number; taxCop: number; source: string };
      /** Solo en la respuesta en vivo al propietario autenticado; nunca se persiste ni llega al modelo. */
      confirmationToken?: string;
    }
  | { type: "HUMAN_CASE"; caseId: string; reason: string; priority: string; slaDueAt: string | null }
  | { type: "SAFETY"; caseId: string | null; categories: string[]; lexiconVersion: string }
  | { type: "ODOMETER_RECORDED"; readingId: string; valueKm: number; verification: string };

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/** Una tarjeta por tipo (la última de cada tipo en el turno), en orden de aparición. */
export function buildCards(outcomes: readonly ToolOutcome[]): Card[] {
  const byType = new Map<Card["type"], Card>();
  for (const o of outcomes) {
    if (!o.ok) continue;
    const d = o.data as Record<string, never>;
    const card = toCard(o.tool, d);
    if (card) {
      byType.delete(card.type);
      byType.set(card.type, card);
    }
  }
  return [...byType.values()];
}

function toCard(tool: string, d: Record<string, never>): Card | null {
  switch (tool) {
    case "evaluateMaintenance": {
      const t = d.technical as unknown as { status: string; dueBy: Card & { km: number } | null; remaining: never };
      return {
        type: "EVALUATION",
        evaluationId: d.evaluationId,
        serviceCode: d.serviceCode,
        status: d.status,
        technicalStatus: t.status,
        dueBy: t.dueBy as never,
        remaining: t.remaining,
        reasons: d.reasons,
        suggestedAction: d.suggestedAction,
        requiresOdometerConfirmation: d.requiresOdometerConfirmation,
        plan: d.plan,
        syntheticData: d.syntheticData,
      };
    }
    case "getMaintenancePlan":
      return { type: "PLAN", version: d.version, sourceRef: d.sourceRef, syntheticData: (d.dataOrigin as string) === "SYNTHETIC", rules: d.rules };
    case "listWorkshops":
      return { type: "WORKSHOPS", workshops: d.workshops };
    case "getQuote":
      return {
        type: "QUOTE",
        quoteId: d.quoteId,
        workshopId: d.workshopId,
        isEstimate: d.isEstimate,
        subtotalCop: d.subtotalCop,
        taxCop: d.taxCop,
        totalCop: d.totalCop,
        taxLabel: d.taxLabel,
        includedItems: d.includedItems,
        restrictions: d.restrictions,
        validUntil: iso(d.validUntil),
        catalogVersion: d.catalogVersion,
        source: d.source,
      };
    case "getAvailableSlots":
      return {
        type: "SLOTS",
        workshopId: d.workshopId,
        source: d.source,
        slots: (d.slots as Array<{ slotRef: string; startsAt: Date; endsAt: Date }>).map((s) => ({ slotRef: s.slotRef, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt) })),
      };
    case "prepareBooking": {
      const s = d.summary as unknown as Record<string, never>;
      return {
        type: "BOOKING_INTENT",
        intentId: d.intentId,
        expiresAt: iso(d.expiresAt),
        requiresUserConfirmation: true,
        summary: { serviceCode: s.serviceCode, workshopId: s.workshopId, workshopName: s.workshopName, slotRef: s.slotRef, startsAt: iso(s.startsAt), totalCop: s.totalCop, taxCop: s.taxCop, source: s.source },
        confirmationToken: d.confirmationToken,
      };
    }
    case "createHumanCase":
      return (d.reason as string) === "SAFETY_ESCALATION"
        ? { type: "SAFETY", caseId: d.caseId, categories: ["AGENT_TOOL"], lexiconVersion: "n/a" }
        : { type: "HUMAN_CASE", caseId: d.caseId, reason: d.reason, priority: d.priority, slaDueAt: d.slaDueAt ?? null };
    case "recordOdometer":
      return { type: "ODOMETER_RECORDED", readingId: d.readingId, valueKm: d.valueKm, verification: d.verification };
    default:
      return null;
  }
}

/** Tarjeta de reserva preparada a partir del resultado tipado (también para la reentrega tras perder la respuesta). */
export function intentCard(d: { intentId: string; expiresAt: Date | string; confirmationToken?: string; summary: { serviceCode: string; workshopId: string; workshopName: string; slotRef: string; startsAt: Date | string; totalCop: number; taxCop: number; source: string } }): Card {
  const s = d.summary;
  return {
    type: "BOOKING_INTENT",
    intentId: d.intentId,
    expiresAt: iso(d.expiresAt),
    requiresUserConfirmation: true,
    summary: { serviceCode: s.serviceCode, workshopId: s.workshopId, workshopName: s.workshopName, slotRef: s.slotRef, startsAt: iso(s.startsAt), totalCop: s.totalCop, taxCop: s.taxCop, source: s.source },
    confirmationToken: d.confirmationToken,
  };
}

/** Versión para persistir: sin token de confirmación. */
export function redactCards(cards: readonly Card[]): Card[] {
  return cards.map((c) => {
    if (c.type !== "BOOKING_INTENT") return c;
    const { confirmationToken: _t, ...rest } = c;
    void _t;
    return rest;
  });
}
