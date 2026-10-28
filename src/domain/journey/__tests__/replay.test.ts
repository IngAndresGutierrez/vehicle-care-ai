import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseContext } from "../context";
import { JOURNEY_EVENT_TYPES } from "../events";
import { replayJourney, type RecordedEvent } from "../replay";

const history: RecordedEvent[] = [
  {
    seq: 1,
    event: { type: "EVALUATED", evaluationId: "e1", status: "UPCOMING", reasons: [], requiresOdometerConfirmation: false, cycleKey: "c" },
    actorId: "job",
    actorRole: "SYSTEM_JOB",
    fromState: "ACTIVATED",
    toState: "NEED_DETECTED",
  },
  {
    seq: 2,
    event: { type: "CONTACT_SUPPRESSED", outboundMessageId: "m", dedupKey: "k", reason: "CONSENT_REQUIRED" },
    actorId: "job",
    actorRole: "SYSTEM_JOB",
    fromState: "NEED_DETECTED",
    toState: "CONTACT_SUPPRESSED",
  },
  {
    seq: 3,
    event: { type: "SAFETY_SIGNAL", caseId: "s1", source: "STAFF" },
    actorId: "adv",
    actorRole: "ADVISOR",
    fromState: "CONTACT_SUPPRESSED",
    toState: "SAFETY_ESCALATED",
  },
];

describe("replayJourney — consistencia entre estado persistido y eventos", () => {
  it("un historial legal reproduce el estado y la versión persistidos", () => {
    const r = replayJourney(history, { state: "SAFETY_ESCALATED", version: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.context.openCaseId).toBe("s1");
  });

  it("detecta huecos de secuencia, estados que no encadenan y transiciones ilegales", () => {
    const tampered: RecordedEvent[] = [
      history[0],
      { ...history[1], seq: 3, fromState: "MONITORING" },
      { seq: 4, event: { type: "CASE_RESOLVED_BY_HUMAN", caseId: "s1", outcome: "CLEARED_FOR_SERVICE" }, actorId: "agent", actorRole: "SYSTEM_AGENT", fromState: "CONTACT_SUPPRESSED", toState: "CONVERSATION_OPEN" },
    ];
    const r = replayJourney(tampered, { state: "CONVERSATION_OPEN", version: 3 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const kinds = r.error.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["SEQUENCE_GAP", "FROM_STATE_MISMATCH", "ILLEGAL_TRANSITION", "FINAL_STATE_MISMATCH"]));
  });

  it("detecta un estado o una versión persistidos que no corresponden a los eventos", () => {
    expect(replayJourney(history, { state: "MONITORING", version: 3 })).toMatchObject({ ok: false, error: [{ kind: "FINAL_STATE_MISMATCH" }] });
    expect(replayJourney(history, { state: "SAFETY_ESCALATED", version: 4 })).toMatchObject({ ok: false, error: [{ kind: "VERSION_MISMATCH" }] });
    expect(replayJourney([{ ...history[0], toState: "MONITORING" }], { state: "MONITORING", version: 1 })).toMatchObject({
      ok: false,
      error: expect.arrayContaining([expect.objectContaining({ kind: "TO_STATE_MISMATCH" })]),
    });
  });

  it("un journey sin eventos está en ACTIVATED con versión 0", () => {
    expect(replayJourney([], { state: "ACTIVATED", version: 0 }).ok).toBe(true);
  });
});

describe("parseContext", () => {
  it("tolera JSON vacío o malformado sin inventar valores", () => {
    expect(parseContext({})).toMatchObject({ lastEvaluation: null, pendingIntentId: null });
    expect(parseContext(null).openCaseId).toBeNull();
    expect(parseContext({ lastEvaluation: { evaluationId: 1 }, pendingIntentId: 42 })).toMatchObject({ lastEvaluation: null, pendingIntentId: null });
  });
});

describe("catálogo de eventos sincronizado con la base", () => {
  it("el CHECK JourneyEvent_business_event_type lista exactamente JOURNEY_EVENT_TYPES", () => {
    const dir = join(__dirname, "..", "..", "..", "..", "prisma", "migrations");
    const migration = readdirSync(dir).find((d) => d.endsWith("phase3_journey_contact_scope"));
    expect(migration).toBeDefined();
    const sql = readFileSync(join(dir, migration!, "migration.sql"), "utf8");
    const block = sql.split('"JourneyEvent_business_event_type"')[1].split("NOT VALID")[0];
    expect([...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])).toEqual([...JOURNEY_EVENT_TYPES]);
  });
});

describe("eventPayload", () => {
  it("separa el tipo del contenido persistible", async () => {
    const { eventPayload } = await import("../events");
    expect(eventPayload({ type: "SAFETY_SIGNAL", caseId: "c", source: "STAFF" })).toEqual({ caseId: "c", source: "STAFF" });
    expect(eventPayload({ type: "OWNER_OPENED" })).toEqual({});
  });
});
