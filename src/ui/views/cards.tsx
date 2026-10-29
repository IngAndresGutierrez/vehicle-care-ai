"use client";

import { useEffect, useState } from "react";
import type { Card } from "../api";
import { CASE_REASON, fmtCop, fmtDate, fmtDateTime, fmtKm, isSyntheticRef, label, PRIORITY, REASON, SERVICE, STATUS, VERIFICATION } from "../labels";
import { Badge, Button, Facts, SimStamp, Spinner } from "../primitives";

const ORDINAL = ["primer", "segundo", "tercer"];

export interface CardActions {
  send: (text: string) => void;
  confirm: (token: string) => void;
  simulateSlotTaken?: () => void;
  confirmState: "idle" | "confirming" | "done" | "failed";
  busy: boolean;
}

function Shell({ title, aside, children, tone = "line" }: { title: string; aside?: React.ReactNode; children: React.ReactNode; tone?: "line" | "amber" | "brake" | "oil" }) {
  const border = { line: "border-line", amber: "border-amber/60", brake: "border-brake/50", oil: "border-oil/50" }[tone];
  return (
    <div className={`rounded-lg border bg-card p-3.5 ${border}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[15px] font-semibold text-ink">{title}</h4>
        {aside}
      </div>
      {children}
    </div>
  );
}

function useCountdown(expiresAt: string): number {
  const [left, setLeft] = useState(() => Math.max(0, new Date(expiresAt).getTime() - Date.now()));
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, new Date(expiresAt).getTime() - Date.now())), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return left;
}

function IntentCard({ card, a }: { card: Extract<Card, { type: "BOOKING_INTENT" }>; a: CardActions }) {
  const left = useCountdown(card.expiresAt);
  const expired = left === 0;
  const mm = Math.floor(left / 60000);
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  const s = card.summary;
  return (
    <Shell title="Reserva lista para confirmar" tone="amber" aside={s.source === "MOCK" && <SimStamp>Taller simulado</SimStamp>}>
      <Facts
        items={[
          ["Servicio", label(SERVICE, s.serviceCode)],
          ["Taller", s.workshopName],
          ["Fecha", fmtDateTime(s.startsAt)],
          ["Total con IVA", <span key="t" className="font-num text-lg tabular">{fmtCop(s.totalCop)}</span>],
        ]}
      />
      {card.confirmationToken && a.confirmState !== "done" ? (
        <div className="mt-3 border-t border-line pt-3">
          <p className="text-sm text-muted" aria-live="polite">
            {expired ? "La reserva preparada venció. Pide los horarios de nuevo." : `Confirma en los próximos ${mm}:${ss} min. El asistente no puede confirmar por ti.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button data-testid="confirm-booking" disabled={expired || a.confirmState === "confirming" || a.busy} onClick={() => card.confirmationToken && a.confirm(card.confirmationToken)} className="flex-1 sm:flex-none">
              {a.confirmState === "confirming" ? <Spinner label="Confirmando con el taller" /> : "Confirmar reserva"}
            </Button>
            {a.simulateSlotTaken && !expired && a.confirmState === "idle" && (
              <Button variant="secondary" data-testid="simulate-slot-taken" onClick={a.simulateSlotTaken} disabled={a.busy}>
                Simular que otro cliente tomó el cupo
              </Button>
            )}
          </div>
        </div>
      ) : (
        a.confirmState !== "done" && <p className="mt-3 border-t border-line pt-3 text-sm text-muted">Esta reserva ya no se puede confirmar desde aquí.</p>
      )}
    </Shell>
  );
}

export function CardView({ card, a, live }: { card: Card; a: CardActions; live: boolean }) {
  switch (card.type) {
    case "EVALUATION": {
      const st = STATUS[card.status] ?? STATUS.UNKNOWN;
      return (
        <Shell title={`Evaluación: ${label(SERVICE, card.serviceCode)}`} aside={<Badge tone={st.tone}>{st.text}</Badge>}>
          <Facts
            items={[
              ...(card.dueBy?.km != null ? [["Límite en km", fmtKm(card.dueBy.km)] as [string, string]] : []),
              ...(card.dueBy?.date ? [["Límite en fecha", fmtDate(card.dueBy.date)] as [string, string]] : []),
              ["Plan", card.plan ? card.plan.version : "Sin plan validado"],
            ]}
          />
          {card.reasons.length > 0 && <p className="mt-2 text-sm text-graphite">{card.reasons.map((r) => label(REASON, r)).join(". ")}.</p>}
          {(card.syntheticData || isSyntheticRef(card.plan?.sourceRef)) && (
            <p className="mt-2">
              <SimStamp title={card.plan?.sourceRef}>Regla sintética de demo</SimStamp>
            </p>
          )}
        </Shell>
      );
    }
    case "PLAN":
      return (
        <Shell title="Plan de mantenimiento" aside={card.syntheticData && <SimStamp>Sintético</SimStamp>}>
          <ul className="text-sm text-graphite">
            {card.rules.map((r) => (
              <li key={`${r.serviceCode}-${r.appliesToTimingDrive}`}>
                {label(SERVICE, r.serviceCode)}: {[r.intervalKm != null ? `cada ${fmtKm(r.intervalKm)}` : null, r.intervalMonths != null ? `${r.intervalMonths} meses` : null].filter(Boolean).join(" o ")}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[13px] break-all text-muted">{card.sourceRef}</p>
        </Shell>
      );
    case "WORKSHOPS":
      return (
        <Shell title="Talleres" aside={<SimStamp>Datos sintéticos</SimStamp>}>
          <ul className="text-sm text-graphite">
            {card.workshops.map((w) => (
              <li key={w.workshopId}>
                {w.name}, {w.city}
              </li>
            ))}
          </ul>
        </Shell>
      );
    case "QUOTE":
      return (
        <Shell title={card.isEstimate ? "Cotización estimada" : "Cotización"} aside={card.source === "MOCK" && <SimStamp>Catálogo simulado</SimStamp>}>
          <ul className="mb-2 text-sm text-graphite">
            {card.includedItems.map((i) => (
              <li key={i.description}>
                {i.description}
                {i.qty > 1 && ` x${i.qty}`}
              </li>
            ))}
          </ul>
          <Facts
            items={[
              ["Subtotal", fmtCop(card.subtotalCop)],
              [card.taxLabel, fmtCop(card.taxCop)],
              ["Total", <span key="t" className="font-num text-lg font-semibold tabular">{fmtCop(card.totalCop)}</span>],
              ["Válida hasta", fmtDateTime(card.validUntil)],
            ]}
          />
          {card.restrictions.length > 0 && <p className="mt-2 text-[13px] text-muted">{card.restrictions.join(" ")}</p>}
        </Shell>
      );
    case "SLOTS":
      return (
        <Shell title="Horarios disponibles" aside={card.source === "MOCK" && <SimStamp>Agenda simulada</SimStamp>}>
          {card.slots.length === 0 ? (
            <p className="text-sm text-muted">No hay horarios disponibles en este momento.</p>
          ) : (
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {card.slots.map((s, i) => (
                <li key={s.slotRef}>
                  {i < 3 && live ? (
                    <button type="button" disabled={a.busy} onClick={() => a.send(`Reserva el ${ORDINAL[i]} horario (${fmtDateTime(s.startsAt)})`)} className="w-full rounded-md border border-ink/25 px-3 py-2 text-left text-sm font-medium text-ink hover:border-ink disabled:opacity-50">
                      {fmtDateTime(s.startsAt)}
                    </button>
                  ) : (
                    <span className="block rounded-md border border-line px-3 py-2 text-sm text-muted">{fmtDateTime(s.startsAt)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Shell>
      );
    case "BOOKING_INTENT":
      return <IntentCard card={card} a={a} />;
    case "HUMAN_CASE": {
      const p = PRIORITY[card.priority] ?? PRIORITY.NORMAL;
      return (
        <Shell title="Caso para un asesor" tone="amber" aside={<Badge tone={p.tone}>Prioridad {p.text.toLowerCase()}</Badge>}>
          <p className="text-sm text-graphite">
            {label(CASE_REASON, card.reason)}. Una persona del equipo revisa tu caso{card.slaDueAt ? ` antes del ${fmtDateTime(card.slaDueAt)}` : ""}.
          </p>
        </Shell>
      );
    }
    case "SAFETY":
      return (
        <Shell title="Atención por seguridad" tone="brake" aside={<Badge tone="danger">Urgente</Badge>}>
          <p className="text-sm text-graphite">Un asesor te contactará con prioridad. Mientras tanto no se ofrecen cotizaciones ni reservas. Si notas el problema mientras conduces, detente en un lugar seguro.</p>
        </Shell>
      );
    case "ODOMETER_RECORDED":
      return (
        <Shell title="Kilometraje registrado">
          <p className="text-sm text-graphite">
            {fmtKm(card.valueKm)}, {label(VERIFICATION, card.verification).toLowerCase()}.
          </p>
        </Shell>
      );
  }
}
