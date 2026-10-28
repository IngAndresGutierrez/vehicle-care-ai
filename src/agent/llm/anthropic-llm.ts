import Anthropic from "@anthropic-ai/sdk";
import type { LlmBlock, LlmInfo, LlmMessage, LlmPort, LlmRequest, LlmResponse } from "./types";

export interface AnthropicLlmConfig {
  /** Modelo configurable por entorno (LLM_MODEL). Por defecto Claude Opus 5.5. */
  model: string;
  /** low | medium | high | xhigh | max (LLM_EFFORT). */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Timeout por solicitud en milisegundos (LLM_TIMEOUT_MS). */
  timeoutMs: number;
  maxRetries: number;
  /** Fallback del lado del servidor ante rechazos por políticas (activado por defecto; LLM_SERVER_FALLBACKS=false lo desactiva). */
  serverFallbacks: boolean;
  apiKey?: string;
  /** Solo tests: transporte HTTP inyectado para inspeccionar la solicitud sin red. */
  fetch?: typeof fetch;
}

/**
 * Adaptador del Messages API de Anthropic (SDK oficial, bucle de herramientas manual en el orquestador).
 * - Herramientas con `strict: true` (entrada validada por el esquema); `tool_choice` automático.
 * - Pensamiento adaptativo por defecto (no se envía `thinking`); los bloques de pensamiento se devuelven intactos.
 * - El contexto por turno llega como mensaje `role: "system"` añadido: el prefijo (system + tools) no cambia.
 */
export class AnthropicLlm implements LlmPort {
  readonly info: LlmInfo;
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicLlmConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: config.maxRetries, ...(config.fetch ? { fetch: config.fetch } : {}) });
    this.info = { provider: "ANTHROPIC", model: config.model, simulated: false };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.beta.messages.create(
      {
        model: this.config.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: request.messages.map(toParam),
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
          strict: true,
        })),
        tool_choice: { type: "auto" },
        output_config: { effort: this.config.effort },
        ...(this.config.serverFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: request.signal },
    );

    return {
      stopReason: mapStop(response.stop_reason),
      content: response.content.map(fromBlock),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      servedBy: response.model,
    };
  }
}

function mapStop(reason: Anthropic.Beta.BetaStopReason | null): LlmResponse["stopReason"] {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}

function fromBlock(block: Anthropic.Beta.BetaContentBlock): LlmBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  // Pensamiento, fallbacks u otros bloques: se conservan tal cual para reenviarlos sin modificar.
  return { type: "opaque", raw: block };
}

function toParam(message: LlmMessage): Anthropic.Beta.BetaMessageParam {
  if (message.role === "system") {
    return { role: "system", content: message.content.flatMap((b) => (b.type === "text" ? [{ type: "text" as const, text: b.text }] : [])) };
  }
  const content = message.content.map((b): Anthropic.Beta.BetaContentBlockParam => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      case "tool_result":
        return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
      case "opaque":
        return b.raw as Anthropic.Beta.BetaContentBlockParam;
    }
  });
  return { role: message.role, content };
}
