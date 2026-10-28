/**
 * Puerto del modelo de lenguaje (ARCHITECTURE.md ADR-08). Neutral respecto al proveedor: el orquestador
 * no conoce el SDK. Los bloques que el proveedor exige devolver intactos (p. ej. bloques de pensamiento)
 * viajan como `opaque` y se reenvían sin modificar (preserved thinking, ADR-018).
 */

export type LlmBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "opaque"; raw: unknown };

export interface LlmMessage {
  /** `system`: instrucción del operador añadida a mitad de conversación (contexto del servidor por turno). */
  role: "user" | "assistant" | "system";
  content: LlmBlock[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmResponse {
  stopReason: LlmStopReason;
  content: LlmBlock[];
  usage: { inputTokens: number; outputTokens: number };
  /** Modelo que respondió (puede diferir si actuó un fallback del proveedor). */
  servedBy: string;
}

export interface LlmInfo {
  provider: "ANTHROPIC" | "SCRIPTED";
  model: string;
  /** true: respuestas deterministas programadas, NO IA generativa. */
  simulated: boolean;
}

export interface LlmPort {
  readonly info: LlmInfo;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
