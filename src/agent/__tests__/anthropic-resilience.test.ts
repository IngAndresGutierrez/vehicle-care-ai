import { describe, expect, it } from "vitest";
import { AnthropicLlm } from "../llm/anthropic-llm";
import { ADVISOR_SYSTEM_PROMPT } from "../prompts/advisor-v1";
import { LLM_TOOL_DEFINITIONS } from "../tools/definitions";

/** Transporte simulado: sin red ni API key. Cada llamada consume la siguiente respuesta programada. */
function transport(replies: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ body: Record<string, unknown>; headers: Headers; at: number }> = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers), at: Date.now() });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(r.body ?? { type: "error", error: { type: "api_error", message: "x" } }), { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const OK = {
  status: 200,
  body: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "hola" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 2100, cache_creation_input_tokens: 300 },
  },
};

const request = { system: ADVISOR_SYSTEM_PROMPT, tools: LLM_TOOL_DEFINITIONS, maxOutputTokens: 1024, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hola" }] }] };
const llm = (fetchFn: typeof fetch, extra: Partial<ConstructorParameters<typeof AnthropicLlm>[0]> = {}) =>
  new AnthropicLlm({ model: "claude-sonnet-5-5", effort: "medium", timeoutMs: 5_000, maxRetries: 2, serverFallbacks: true, apiKey: "test-key", fetch: fetchFn, ...extra });

describe("AnthropicLlm: prompt caching y contabilidad de tokens", () => {
  it("marca el prefijo estable (system) con caché explícita y activa la caché automática de la cola", async () => {
    const t = transport([OK]);
    const r = await llm(t.fetchFn).complete(request);
    const body = t.calls[0].body;
    expect(body.system).toEqual([{ type: "text", text: ADVISOR_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(r.usage).toEqual({ inputTokens: 40, outputTokens: 12, cacheReadInputTokens: 2100, cacheCreationInputTokens: 300 });
  });

  it("LLM_PROMPT_CACHE=false envía el system como texto y sin caché", async () => {
    const t = transport([OK]);
    await llm(t.fetchFn, { promptCache: false }).complete(request);
    expect(t.calls[0].body.system).toBe(ADVISOR_SYSTEM_PROMPT);
    expect(t.calls[0].body).not.toHaveProperty("cache_control");
  });
});

describe("AnthropicLlm: errores transitorios y definitivos", () => {
  it("429 con retry-after: espera lo indicado y reintenta (llamada al modelo, sin efectos de negocio)", async () => {
    const t = transport([{ status: 429, headers: { "retry-after-ms": "300" } }, OK]);
    const r = await llm(t.fetchFn).complete(request);
    expect(r.stopReason).toBe("end_turn");
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].at - t.calls[0].at).toBeGreaterThanOrEqual(280);
  });

  it("529/5xx persistentes: agota los reintentos configurados y falla (el orquestador responde de forma segura)", async () => {
    const t = transport([{ status: 529, headers: { "retry-after-ms": "10" } }]);
    await expect(llm(t.fetchFn).complete(request)).rejects.toThrow();
    expect(t.calls).toHaveLength(3); // 1 + maxRetries (2)
  });

  it("400 (solicitud inválida) no se reintenta", async () => {
    const t = transport([{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } }]);
    await expect(llm(t.fetchFn).complete(request)).rejects.toThrow();
    expect(t.calls).toHaveLength(1);
  });

  it("refusal llega como 200 y se mapea a stopReason=refusal (sin leer contenido como respuesta)", async () => {
    const t = transport([{ status: 200, body: { ...OK.body, content: [], stop_reason: "refusal", stop_details: { category: "general_harms" } } }]);
    const r = await llm(t.fetchFn).complete(request);
    expect(r.stopReason).toBe("refusal");
  });
});
