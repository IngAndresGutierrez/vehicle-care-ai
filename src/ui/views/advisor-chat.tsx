"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Card, type ConfirmedBooking, type DemoConfig, type VehicleOverview } from "../api";
import { fmtDateTime, JOURNEY, label } from "../labels";
import { Badge, Button, Spinner } from "../primitives";
import { LlmLabel } from "../shell";
import { CardView } from "./cards";

interface Msg {
  id: number;
  role: "user" | "assistant" | "notice";
  text: string;
  cards?: Card[];
  simulated?: boolean;
  tone?: "ok" | "danger" | "neutral";
}

/** Mensajes de error estables por código del backend (nunca se muestra un error técnico crudo). */
function confirmErrorText(code: string): string {
  switch (code) {
    case "SLOT_CONFLICT":
      return "Otro cliente tomó ese horario antes de tu confirmación. No se creó ninguna reserva. Pide los horarios de nuevo para elegir otro.";
    case "INTENT_EXPIRED":
      return "La reserva preparada venció antes de confirmarla. Pide los horarios de nuevo.";
    case "QUOTE_EXPIRED":
      return "La cotización venció. Pide una cotización nueva.";
    case "INTENT_INVALIDATED":
    case "INVALID_TOKEN":
      return "Esta reserva preparada ya no es válida. Pide los horarios de nuevo.";
    case "SAFETY_ESCALATED":
      return "Hay un caso de seguridad abierto: un asesor debe revisarlo antes de agendar.";
    case "WORKSHOP_UNAVAILABLE":
      return "El taller no respondió. La reserva quedó pendiente y el sistema la reconcilia; no la repitas.";
    case "RATE_LIMITED":
      return "Demasiados intentos seguidos. Espera un momento.";
    default:
      return "No fue posible confirmar la reserva.";
  }
}

export function AdvisorChat({
  vehicleId,
  serviceCode,
  overview,
  config,
  suggestions,
  onChanged,
}: {
  vehicleId: string;
  serviceCode: string;
  overview: VehicleOverview | null;
  config: DemoConfig | null;
  suggestions: string[];
  onChanged: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ text: string; message: string } | null>(null);
  const [confirmState, setConfirmState] = useState<"idle" | "confirming" | "done" | "failed">("idle");
  const [sent, setSent] = useState<string[]>([]);
  const nextId = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);
  const push = (m: Omit<Msg, "id">) => setMsgs((prev) => [...prev, { ...m, id: nextId.current++ }]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setFailed(null);
    push({ role: "user", text: message });
    setSent((s) => [...s, message]);
    setInput("");
    try {
      const r = await api.turn({ vehicleId, serviceCode, sessionId, message });
      setSessionId(r.sessionId);
      // Una intención nueva reemplaza la anterior: el botón de confirmar vuelve a habilitarse.
      if (r.cards.some((c) => c.type === "BOOKING_INTENT")) setConfirmState("idle");
      push({ role: r.assistant.kind === "SYSTEM_NOTICE" ? "notice" : "assistant", text: r.assistant.text, cards: r.cards, simulated: r.assistant.simulated, tone: r.assistant.kind === "SYSTEM_NOTICE" ? "danger" : undefined });
      onChanged();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      const messageText =
        err?.code === "RATE_LIMITED"
          ? "Enviaste muchos mensajes seguidos. Espera un momento y reintenta."
          : err?.code === "TURN_IN_PROGRESS" || err?.code === "CONCURRENT_TURN"
            ? "Tu mensaje anterior todavía se está procesando. Espera la respuesta y vuelve a intentarlo."
          : err?.code === "NETWORK"
            ? "Se perdió la conexión. Revisa tu red y reintenta."
            : err?.status === 401
              ? "Tu sesión de demo venció. Vuelve a la portada para iniciar otra."
              : "El asistente no pudo responder. Tu información no cambió.";
      setFailed({ text: message, message: messageText });
    } finally {
      setBusy(false);
    }
  }

  async function confirm(token: string) {
    if (confirmState === "confirming") return;
    setConfirmState("confirming");
    try {
      const { booking } = await api.confirm(token);
      setConfirmState("done");
      push(bookingNotice(booking));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "UNKNOWN";
      setConfirmState("failed");
      push({ role: "notice", text: confirmErrorText(code), tone: "danger" });
    } finally {
      onChanged();
    }
  }

  async function simulateSlotTaken() {
    try {
      await api.slotTaken();
      push({ role: "notice", text: "Simulación de demo: otro cliente tomó el horario que elegiste. Intenta confirmar para ver cómo responde el sistema.", tone: "neutral" });
    } catch {
      push({ role: "notice", text: "No hay una reserva pendiente para simular el conflicto.", tone: "neutral" });
    }
  }

  const lastIntentMsg = [...msgs].reverse().find((m) => m.cards?.some((c) => c.type === "BOOKING_INTENT"))?.id;
  const lastCardsMsg = [...msgs].reverse().find((m) => m.cards && m.cards.length > 0)?.id;
  const paused = overview?.journey.agentPaused ?? false;
  const pending = suggestions.filter((s) => !sent.includes(s));
  const quick = confirmState === "failed" ? ["¿Qué horarios hay?", ...pending.filter((s) => s !== "¿Qué horarios hay?")] : pending;

  return (
    <section aria-labelledby="chat-title" className="flex h-full min-h-[34rem] flex-col rounded-xl border border-line bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 id="chat-title" className="text-lg font-semibold text-ink">
          Asistente de mantenimiento
        </h2>
        <LlmLabel config={config} />
        {overview && (
          <Badge tone="ink" className="ml-auto" data-testid="journey-state">
            {label(JOURNEY, overview.journey.state)}
          </Badge>
        )}
      </header>

      {paused && (
        <div role="status" className="border-b border-brake/30 bg-brake-soft px-4 py-3 text-sm text-graphite" data-testid="agent-paused">
          <p className="font-semibold text-brake">El asistente dejó de actuar en este caso.</p>
          <p>Una persona del equipo de postventa lo tiene a cargo. No se ofrecen cotizaciones ni reservas hasta que lo resuelva.</p>
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite" aria-busy={busy}>
        {msgs.length === 0 && (
          <div className="rounded-lg bg-paper px-4 py-3 text-[15px] text-graphite">
            <p>Pregunta por el mantenimiento de tu vehículo. El asistente consulta el motor de reglas, cotiza en el taller y prepara la reserva; la confirmación siempre es tuya.</p>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
            {m.role === "user" ? (
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-ink px-4 py-2 text-[15px] text-white">{m.text}</p>
            ) : m.role === "notice" ? (
              <div className="space-y-2">
                <p role="status" className={`rounded-lg border px-4 py-2.5 text-[15px] ${m.tone === "ok" ? "border-oil/40 bg-oil-soft text-graphite" : m.tone === "danger" ? "border-brake/30 bg-brake-soft text-graphite" : "border-line bg-paper text-graphite"}`}>
                  {m.text}
                </p>
                {m.cards?.map((c, i) => (
                  <CardView key={`${m.id}-${i}`} card={c} live={false} a={{ send, confirm, confirmState, busy }} />
                ))}
              </div>
            ) : (
              <div className="max-w-[95%] space-y-2">
                <div className="rounded-2xl rounded-bl-sm bg-paper px-4 py-2.5 text-[15px] whitespace-pre-line text-graphite">{m.text}</div>
                {m.simulated && <p className="text-[12px] text-muted">Respuesta programada (simulación, no IA generativa).</p>}
                {m.cards?.map((c, i) => (
                  <CardView
                    key={`${m.id}-${i}`}
                    card={c.type === "BOOKING_INTENT" && m.id !== lastIntentMsg ? { ...c, confirmationToken: undefined } : c}
                    live={m.id === lastCardsMsg}
                    a={{ send, confirm, simulateSlotTaken: config?.demoMode ? simulateSlotTaken : undefined, confirmState, busy }}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <Spinner label="El asistente está consultando" />}
        {failed && (
          <div role="alert" className="rounded-lg border border-brake/30 bg-brake-soft px-4 py-3 text-sm">
            <p className="text-graphite">{failed.message}</p>
            <Button variant="secondary" className="mt-2 min-h-9" onClick={() => send(failed.text)} data-testid="retry-turn">
              Reintentar
            </Button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-line px-4 py-3">
        {quick.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Sugerencias">
            {quick.slice(0, 4).map((q) => (
              <button key={q} type="button" disabled={busy} onClick={() => send(q)} className="rounded-full border border-ink/25 px-3 py-1.5 text-sm text-ink hover:border-ink disabled:opacity-50">
                {q}
              </button>
            ))}
          </div>
        )}
        <p className="mb-1.5 text-[12px] text-muted">Demo con datos sintéticos: no escribas datos personales reales.</p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <label htmlFor="chat-input" className="sr-only">
            Mensaje para el asistente
          </label>
          <input
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={2000}
            placeholder="Escribe tu pregunta"
            autoComplete="off"
            className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-card px-3 text-[15px] placeholder:text-muted focus:border-ink"
          />
          <Button type="submit" disabled={busy || input.trim() === ""}>
            Enviar
          </Button>
        </form>
      </div>
    </section>
  );
}

function bookingNotice(b: ConfirmedBooking): Omit<Msg, "id"> {
  if (b.status === "CONFIRMED") {
    const text = `${b.duplicate ? "Esta reserva ya estaba confirmada" : "Reserva confirmada por el taller"}${b.folio ? `. Folio ${b.folio}` : ""}${typeof b.startsAt === "string" ? `, ${fmtDateTime(b.startsAt)}` : ""}`;
    return { role: "notice", tone: "ok", text: text.endsWith(".") ? text : `${text}.` };
  }
  if (b.duplicate) return { role: "notice", tone: "neutral", text: "Esta reserva ya se había enviado. No se creó otra; consulta el estado en «Tu cita»." };
  if (b.status === "PENDING" || b.status === "PENDING_RECONCILIATION") return { role: "notice", tone: "neutral", text: "El taller recibió la solicitud pero no ha respondido. No la repitas: el sistema la reconcilia y te avisa." };
  return { role: "notice", tone: "danger", text: "El taller no aceptó la reserva. Pide los horarios de nuevo." };
}

