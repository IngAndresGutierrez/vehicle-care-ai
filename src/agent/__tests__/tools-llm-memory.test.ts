import { describe, expect, it } from "vitest";
import { COMMERCIAL_TOOLS } from "@/domain/journey";
import { AnthropicLlm } from "../llm/anthropic-llm";
import { SCRIPTED_LLM_INFO, ScriptedLlm } from "../llm/scripted-llm";
import { parseMemory, pruneMemory } from "../memory";
import { ADVISOR_SYSTEM_PROMPT } from "../prompts/advisor-v1";
import { AGENT_TOOL_NAMES, isAgentTool, LLM_TOOL_DEFINITIONS, TOOL_SCHEMAS } from "../tools/definitions";

describe("catálogo de herramientas", () => {
  it("contiene exactamente las 10 herramientas del agente; ninguna confirma reservas ni cierra órdenes", () => {
    expect(AGENT_TOOL_NAMES).toEqual([
      "createHumanCase",
      "evaluateMaintenance",
      "getAvailableSlots",
      "getMaintenancePlan",
      "getQuote",
      "getServiceHistory",
      "getVehicleProfile",
      "listWorkshops",
      "prepareBooking",
      "recordOdometer",
    ]);
    for (const forbidden of ["confirmBooking", "completeWorkOrder", "reconcileBooking", "resolveHumanCase", "applyDiscount"]) expect(isAgentTool(forbidden)).toBe(false);
    for (const t of COMMERCIAL_TOOLS) expect(AGENT_TOOL_NAMES).toContain(t);
  });

  it("esquemas estrictos: rechazan identidad o campos extra inyectados por el modelo", () => {
    expect(TOOL_SCHEMAS.getVehicleProfile.safeParse({ vehicleId: "veh-otro" }).success).toBe(false);
    expect(TOOL_SCHEMAS.evaluateMaintenance.safeParse({ serviceCode: "TIMING_BELT" }).success).toBe(false);
    expect(TOOL_SCHEMAS.getQuote.safeParse({ workshopId: "ws", discount: 50 }).success).toBe(false);
    expect(TOOL_SCHEMAS.recordOdometer.safeParse({ valueKm: -1 }).success).toBe(false);
    expect(TOOL_SCHEMAS.recordOdometer.safeParse({ valueKm: 74_500 }).success).toBe(true);
    expect(TOOL_SCHEMAS.createHumanCase.safeParse({ reason: "OTRO", priority: "NORMAL", summary: "x" }).success).toBe(false);
  });

  it("definiciones para el modelo: objetos cerrados, todos los campos obligatorios y orden estable", () => {
    for (const def of LLM_TOOL_DEFINITIONS) {
      expect(def.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      const props = Object.keys((def.inputSchema.properties as object) ?? {});
      expect(((def.inputSchema.required as string[]) ?? []).sort()).toEqual(props.sort());
      expect(JSON.stringify(def.inputSchema)).not.toMatch(/minLength|maxLength|minimum|maximum|\$schema/);
    }
    expect(LLM_TOOL_DEFINITIONS.map((d) => d.name)).toEqual(AGENT_TOOL_NAMES);
  });

  it("el system prompt es estático (sin datos variables) para mantener el prefijo estable", () => {
    expect(ADVISOR_SYSTEM_PROMPT).not.toMatch(/\{\{|\$\{|veh-|2026-/);
  });
});

describe("ScriptedLlm (simulación determinista)", () => {
  it("se identifica como simulación, no como IA generativa", () => {
    expect(new ScriptedLlm().info).toEqual(SCRIPTED_LLM_INFO);
    expect(SCRIPTED_LLM_INFO).toMatchObject({ provider: "SCRIPTED", simulated: true });
    expect(SCRIPTED_LLM_INFO.model).toMatch(/simulación determinista, no es IA generativa/);
  });

  it("sin herramientas permitidas ni intención reconocida responde con opciones", async () => {
    const r = await new ScriptedLlm().complete({ system: "", tools: [], maxOutputTokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }] });
    expect(r).toMatchObject({ stopReason: "end_turn", content: [{ type: "text" }] });
  });
});

describe("AnthropicLlm (adaptador real, con transporte simulado: sin red ni API key)", () => {
  it("envía modelo y esfuerzo configurables, herramientas estrictas, tool_choice auto, fallbacks y contexto como mensaje system", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "tool_use", id: "tu_1", name: "evaluateMaintenance", input: {} },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 30 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const llm = new AnthropicLlm({ model: "claude-opus-5-5", effort: "low", timeoutMs: 5_000, maxRetries: 0, serverFallbacks: true, apiKey: "test-key", fetch: fakeFetch });
    const res = await llm.complete({
      system: "SYS",
      tools: LLM_TOOL_DEFINITIONS,
      maxOutputTokens: 4096,
      messages: [
        { role: "user", content: [{ type: "text", text: "hola" }] },
        { role: "system", content: [{ type: "text", text: "CONTEXTO_SERVIDOR\n{}" }] },
      ],
    });

    const req = captured!;
    expect(req.url).toContain("/v1/messages");
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 4096, system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }], cache_control: { type: "ephemeral" }, tool_choice: { type: "auto" }, output_config: { effort: "low" }, fallbacks: "default" });
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body).not.toHaveProperty("thinking");
    expect((req.body.tools as Array<{ strict: boolean }>).every((t) => t.strict)).toBe(true);
    expect((req.body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["user", "system"]);

    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(res.content[0]).toMatchObject({ type: "opaque", raw: { type: "thinking", signature: "sig" } });
    expect(res.content[1]).toEqual({ type: "tool_use", id: "tu_1", name: "evaluateMaintenance", input: {} });
  });
});

describe("memoria estructurada", () => {
  it("tolera JSON inválido y descarta entradas caducadas", () => {
    expect(parseMemory("basura").activeQuote).toBeNull();
    const m = parseMemory({
      activeQuote: { quoteId: "q", workshopId: "w", subtotalCop: 1, taxCop: 1, totalCop: 2, validUntil: "2026-10-28T10:00:00Z", source: "MOCK" },
      offeredSlots: [{ slotRef: "s", startsAt: "2026-10-27T10:00:00Z", workshopId: "w" }],
    });
    const pruned = pruneMemory(m, new Date("2026-10-28T12:00:00Z"));
    expect(pruned.activeQuote).toBeNull();
    expect(pruned.offeredSlots).toEqual([]);
  });
});
