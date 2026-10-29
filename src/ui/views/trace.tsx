"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type TraceView } from "../api";
import { ACCESS_BASIS, EVENT, fmtDateTime, isSyntheticRef, JOURNEY, label, REASON, RESPONSIBLE, SERVICE, SOURCE, STATUS, TOOL } from "../labels";
import { Badge, ErrorNote, Panel, SimStamp, Spinner } from "../primitives";
import { AppShell, SignedOut, useBootstrap } from "../shell";

type Row =
  | { kind: "event"; at: string; e: TraceView["events"][number] }
  | { kind: "tool"; at: string; t: TraceView["toolCalls"][number] };

const timeFmt = new Intl.DateTimeFormat("es-CO", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/Bogota" });

function Details({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (entries.length === 0) return null;
  return (
    <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[13px] text-muted">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt className="inline">{k}: </dt>
          <dd className="inline text-graphite">{Array.isArray(v) ? v.map((x) => label(REASON, String(x))).join(", ") : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TraceViewPage() {
  const { vehicleId } = useParams<{ vehicleId: string }>();
  const search = useSearchParams();
  const serviceCode = search.get("servicio") === "TIMING_BELT" ? "TIMING_BELT" : "ENGINE_OIL_FILTER";
  const boot = useBootstrap();
  const [trace, setTrace] = useState<TraceView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    api.trace(vehicleId, serviceCode).then(
      (t) => {
        setTrace(t);
        setError(null);
      },
      (e: unknown) => setError(e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Error", null)),
    );
  }, [vehicleId, serviceCode]);
  useEffect(load, [load]);

  const isOwner = boot.me?.role === "OWNER";
  const nav = [
    { href: `/vehiculo/${vehicleId}?servicio=${serviceCode}`, text: isOwner ? "Mi vehículo" : "Vehículo" },
    { href: `/trazas/${vehicleId}?servicio=${serviceCode}`, text: "Trazas", current: true },
    ...(boot.me && !isOwner ? [{ href: "/casos", text: "Casos" }] : []),
  ];

  if (boot.authed === false)
    return (
      <AppShell boot={boot}>
        <SignedOut what="las trazas" />
      </AppShell>
    );

  const rows: Row[] = trace
    ? [...trace.events.map((e) => ({ kind: "event" as const, at: e.occurredAt, e })), ...trace.toolCalls.map((t) => ({ kind: "tool" as const, at: t.createdAt, t }))].sort((a, b) => a.at.localeCompare(b.at))
    : [];

  return (
    <AppShell boot={boot} nav={nav}>
      {error ? (
        <ErrorNote title={error.status === 403 || error.status === 404 ? "No tienes acceso a estas trazas" : "No fue posible cargar las trazas"}>
          {error.status === 403 ? "Solo el titular, el asesor con el vehículo en su cartera o compliance con justificación pueden verlas." : "Intenta de nuevo."}
        </ErrorNote>
      ) : !trace ? (
        <Spinner label="Cargando trazas" />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-num text-3xl font-bold text-ink">Trazas del journey</h1>
              <p className="text-[15px] text-graphite">
                {trace.vehicle.alias}
                {trace.vehicle.plateMasked && <span className="ml-2 font-num tracking-wider text-muted">{trace.vehicle.plateMasked}</span>}, {label(SERVICE, trace.serviceCode)}
              </p>
            </div>
            <p className="text-[13px] text-muted">Acceso: {label(ACCESS_BASIS, trace.access.basis)}</p>
          </div>

          <Panel className="grid gap-4 p-5 sm:grid-cols-4" aria-label="Estado del journey">
            <div>
              <p className="text-sm text-muted">Estado</p>
              <p className="mt-0.5 text-lg font-semibold text-ink" data-testid="trace-state">
                {label(JOURNEY, trace.journey.state)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted">Responsable ahora</p>
              <p className="mt-0.5 text-lg font-semibold text-ink">{label(RESPONSIBLE, trace.journey.state)}</p>
            </div>
            <div>
              <p className="text-sm text-muted">Asistente</p>
              <p className="mt-0.5">{trace.journey.agentPaused ? <Badge tone="danger">Detenido, a cargo de una persona</Badge> : <Badge tone="ok">Puede actuar</Badge>}</p>
            </div>
            <div>
              <p className="text-sm text-muted">Consistencia (versión {trace.journey.version})</p>
              <p className="mt-0.5">{trace.journey.consistent ? <Badge tone="ok">Eventos y estado coinciden</Badge> : <Badge tone="danger">Inconsistente: {trace.journey.issues.join(", ")}</Badge>}</p>
            </div>
          </Panel>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
            <Panel className="p-5" aria-labelledby="tl-title">
              <h2 id="tl-title" className="text-lg font-semibold text-ink">
                Línea de tiempo
              </h2>
              <p className="text-sm text-muted">Eventos del journey y herramientas que usó el asistente, en orden. Los tokens de confirmación, el VIN, la placa completa y los datos personales no se muestran.</p>
              {rows.length === 0 ? (
                <p className="mt-4 text-[15px] text-muted">Aún no hay actividad registrada.</p>
              ) : (
                <ol className="mt-4 space-y-0" data-testid="timeline">
                  {rows.map((r, i) => (
                    <li key={`${r.kind}-${i}`} className="relative grid grid-cols-[2.25rem_1fr] gap-3 pb-4">
                      <span aria-hidden className={`z-10 grid size-8 place-items-center rounded-full font-num text-sm font-bold ${r.kind === "event" ? "bg-ink text-white" : r.t.ok ? "border-2 border-ink/40 bg-card text-ink" : "border-2 border-brake bg-brake-soft text-brake"}`}>
                        {i + 1}
                      </span>
                      {i < rows.length - 1 && <span aria-hidden className="absolute top-8 bottom-0 left-4 w-px bg-line" />}
                      {r.kind === "event" ? (
                        <div>
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-graphite">{label(EVENT, r.e.type)}</span>
                            <Badge tone="ink">{r.e.actorLabel}</Badge>
                          </p>
                          <p className="text-sm text-muted">
                            {timeFmt.format(new Date(r.e.occurredAt))}: {label(JOURNEY, r.e.fromState)} a {label(JOURNEY, r.e.toState)}.
                          </p>
                          <Details data={r.e.details} />
                        </div>
                      ) : (
                        <div>
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-graphite">Herramienta: {label(TOOL, r.t.tool)}</span>
                            {r.t.source === "MOCK" ? <SimStamp>{label(SOURCE, r.t.source)}</SimStamp> : <Badge tone="neutral">{label(SOURCE, r.t.source)}</Badge>}
                            {!r.t.ok && <Badge tone="danger">Rechazada: {r.t.errorCode}</Badge>}
                          </p>
                          <p className="text-sm text-muted">
                            {timeFmt.format(new Date(r.t.createdAt))}: {r.t.durationMs} ms{r.t.stateAtCall ? `, en estado ${label(JOURNEY, r.t.stateAtCall)}` : ""}.
                          </p>
                          {r.t.summary && <p className="mt-1 text-sm text-graphite">{r.t.summary}</p>}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </Panel>

            <div className="space-y-5">
              <Panel className="p-5" aria-labelledby="ev-title">
                <h2 id="ev-title" className="text-lg font-semibold text-ink">
                  Decisiones del motor de reglas
                </h2>
                {trace.evaluations.length === 0 && <p className="mt-2 text-sm text-muted">Sin evaluaciones.</p>}
                <ul className="mt-3 space-y-4">
                  {trace.evaluations.map((ev) => {
                    const st = STATUS[ev.status] ?? STATUS.UNKNOWN;
                    return (
                      <li key={ev.evaluationId} className="border-t border-line pt-3 first:border-0 first:pt-0">
                        <p className="flex flex-wrap items-center gap-2">
                          <Badge tone={st.tone}>{st.text}</Badge>
                          <span className="text-sm text-muted">{fmtDateTime(ev.evaluatedAt)}</span>
                        </p>
                        {ev.reasons.length > 0 && <p className="mt-1 text-sm text-graphite">{ev.reasons.map((r) => label(REASON, r)).join(". ")}.</p>}
                        <ol className="mt-2 space-y-0.5 text-[13px]">
                          {ev.decisionTrace.map((d, j) => (
                            <li key={j} className="flex justify-between gap-3">
                              <span className="text-muted">{d.step}</span>
                              <span className="text-right font-medium text-graphite">{d.outcome}</span>
                            </li>
                          ))}
                        </ol>
                        <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] break-all text-muted">
                          {ev.planVersion ?? "Sin plan"}, motor {ev.engineVersion}, huella {ev.inputHash}
                          {isSyntheticRef(ev.sourceRef) && <SimStamp title={ev.sourceRef ?? undefined}>Regla sintética</SimStamp>}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
              <Panel className="p-5" aria-labelledby="guard-title">
                <h2 id="guard-title" className="text-lg font-semibold text-ink">
                  Controles de salida y seguridad
                </h2>
                {trace.guardFlags.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">Ningún mensaje fue marcado.</p>
                ) : (
                  <ul className="mt-2 space-y-1 text-sm">
                    {trace.guardFlags.map((g, i) => (
                      <li key={i} className="flex flex-wrap justify-between gap-2">
                        <span className="text-graphite">{g.flags.join(", ")}</span>
                        <span className="text-muted">{timeFmt.format(new Date(g.createdAt))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel className="p-5" aria-labelledby="perf-title">
                <h2 id="perf-title" className="text-lg font-semibold text-ink">
                  Rendimiento por turno
                </h2>
                <p className="text-sm text-muted">Duración por fase, tokens y costo estimado con tarifas de referencia (la facturación real está en la consola del proveedor).</p>
                {trace.turnMetrics.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">Sin turnos del asistente.</p>
                ) : (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-left text-[13px] tabular" data-testid="turn-metrics">
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 pr-2 font-medium">Hora</th>
                          <th className="py-1 pr-2 font-medium">Total</th>
                          <th className="py-1 pr-2 font-medium">IA</th>
                          <th className="py-1 pr-2 font-medium">Herram.</th>
                          <th className="py-1 pr-2 font-medium">BD y orq.</th>
                          <th className="py-1 pr-2 font-medium">Caché</th>
                          <th className="py-1 font-medium">Costo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trace.turnMetrics.map((t, i) => {
                          const m = t.metrics as { timings?: { totalMs: number; llmMs: number; gatewayMs: number; dbMs: number }; llm?: { cacheHitRatio: number | null; costUsd: number | null } };
                          const ms = (n?: number) => (n === undefined ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
                          return (
                            <tr key={i} className="border-t border-line">
                              <td className="py-1 pr-2 text-muted">{timeFmt.format(new Date(t.createdAt))}</td>
                              <td className="py-1 pr-2">{ms(m.timings?.totalMs)}</td>
                              <td className="py-1 pr-2">{ms(m.timings?.llmMs)}</td>
                              <td className="py-1 pr-2">{ms(m.timings?.gatewayMs)}</td>
                              <td className="py-1 pr-2">{ms(m.timings?.dbMs)}</td>
                              <td className="py-1 pr-2">{m.llm?.cacheHitRatio == null ? "—" : `${Math.round(m.llm.cacheHitRatio * 100)} %`}</td>
                              <td className="py-1">{m.llm?.costUsd == null ? "—" : `USD ${m.llm.costUsd.toFixed(4)}`}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
