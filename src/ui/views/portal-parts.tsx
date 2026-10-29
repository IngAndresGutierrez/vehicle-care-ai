"use client";

import type { VehicleOverview } from "../api";
import { BOOKING_STATUS, fmtCop, fmtDate, fmtDateTime, fmtKm, fmtNum, isSyntheticRef, label, PROVENANCE, REASON, SERVICE, STATUS, VERIFICATION } from "../labels";
import { Badge, Facts, Panel, SimStamp } from "../primitives";

/** Odómetro: el elemento memorable de la pantalla. Dígitos condensados en celdas, como el tablero. */
export function Odometer({ valueKm }: { valueKm: number | null }) {
  const digits = valueKm === null ? "------" : String(Math.max(0, Math.round(valueKm))).padStart(6, "0");
  return (
    <div aria-label={valueKm === null ? "Kilometraje desconocido" : `Kilometraje actual: ${fmtKm(valueKm)}`} role="img" className="inline-flex items-end gap-1">
      {digits.split("").map((d, i) => (
        <span key={i} aria-hidden className="font-num tabular grid h-14 w-10 place-items-center rounded-md bg-graphite text-[40px] leading-none font-semibold text-white shadow-[inset_0_-10px_0_rgba(255,255,255,0.06)] sm:h-16 sm:w-11 sm:text-[46px]">
          {d}
        </span>
      ))}
      <span aria-hidden className="ml-1 pb-1 font-num text-xl font-semibold text-muted">
        km
      </span>
    </div>
  );
}

/** Regla de kilómetros: del último servicio que sirve de base al límite que calcula el motor. */
export function KmTrack({ baseKm, currentKm, dueKm, tone }: { baseKm: number | null; currentKm: number | null; dueKm: number | null; tone: string }) {
  if (dueKm === null || currentKm === null || baseKm === null) {
    return (
      <div className="mt-4">
        <div className="h-3 rounded-full border-2 border-dashed border-line" />
        <p className="mt-2 text-sm text-muted">Sin un servicio anterior documentado no se calcula el límite. El sistema no inventa un intervalo.</p>
      </div>
    );
  }
  const span = Math.max(1, dueKm - baseKm);
  const pct = Math.min(100, Math.max(0, ((currentKm - baseKm) / span) * 100));
  const fill = tone === "danger" ? "bg-brake" : tone === "warn" ? "bg-amber" : "bg-oil";
  return (
    <div className="mt-5">
      <div className="relative h-3 rounded-full bg-paper ring-1 ring-line" role="progressbar" aria-valuemin={baseKm} aria-valuemax={dueKm} aria-valuenow={currentKm} aria-label="Kilómetros recorridos desde el último servicio">
        <div className={`absolute inset-y-0 left-0 rounded-full ${fill}`} style={{ width: `${pct}%` }} />
        {[25, 50, 75].map((t) => (
          <span key={t} aria-hidden className="absolute top-full mt-0.5 h-1.5 w-px bg-line" style={{ left: `${t}%` }} />
        ))}
        <span aria-hidden className="absolute -top-1.5 size-6 -translate-x-1/2 rounded-full border-4 border-card bg-graphite shadow" style={{ left: `${pct}%` }} />
      </div>
      <div className="mt-3 flex justify-between text-[13px] text-muted">
        <span>
          Último servicio
          <span className="block font-num text-base font-semibold text-graphite tabular">{fmtKm(baseKm)}</span>
        </span>
        <span className="text-right">
          Límite
          <span className="block font-num text-base font-semibold text-graphite tabular">{fmtKm(dueKm)}</span>
        </span>
      </div>
    </div>
  );
}

export function VehicleHero({ o }: { o: VehicleOverview }) {
  const p = o.profile;
  const synthetic = p.dataOrigin === "SYNTHETIC";
  return (
    <Panel className="overflow-hidden" aria-labelledby="veh-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 pt-5 pb-4">
        <div>
          <h1 id="veh-title" className="font-num text-3xl leading-tight font-bold text-ink">
            {p.vehicleAlias}
          </h1>
          <p className="text-[15px] text-graphite">
            {p.spec.make} {p.spec.model} {p.spec.modelYear}
            {p.plateMasked && <span className="ml-2 rounded border border-line px-1.5 font-num text-sm tracking-wider text-muted">{p.plateMasked}</span>}
          </p>
        </div>
        {synthetic && <SimStamp title={p.syntheticSourceRef ?? undefined}>Vehículo sintético</SimStamp>}
      </div>
      <div className="px-5 py-5">
        <p className="mb-2 text-sm font-medium text-muted">Kilometraje actual</p>
        <Odometer valueKm={p.odometer?.valueKm ?? null} />
        {p.odometer ? (
          <p className="mt-3 text-sm text-muted">
            Registrado el {fmtDate(p.odometer.observedAt)}, {label(PROVENANCE, p.odometer.provenance).toLowerCase()}, {label(VERIFICATION, p.odometer.verification).toLowerCase()}.
            {p.odometer.ageDays > 0 && ` Hace ${p.odometer.ageDays} días.`}
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted">No hay lecturas de kilometraje. El asistente te lo pedirá.</p>
        )}
      </div>
    </Panel>
  );
}

export function MaintenanceStatus({ o }: { o: VehicleOverview }) {
  const e = o.evaluation;
  const rule = o.plan?.rules.find((r) => r.serviceCode === o.serviceCode && (r.appliesToTimingDrive === null || r.appliesToTimingDrive === o.profile.spec.timingDrive));
  const baseKm = e?.baselineServiceRecordId ? (o.history.serviceRecords.find((r) => r.recordId === e.baselineServiceRecordId)?.odometerKm ?? null) : null;
  const st = STATUS[e?.status ?? "UNKNOWN"] ?? STATUS.UNKNOWN;
  return (
    <Panel className="p-5" aria-labelledby="status-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="status-title" className="text-lg font-semibold text-ink">
          {label(SERVICE, o.serviceCode)}
        </h2>
        <Badge tone={st.tone}>{st.text}</Badge>
      </div>
      {!e ? (
        <p className="mt-3 text-[15px] text-muted">Aún no hay una evaluación para este servicio.</p>
      ) : (
        <>
          <p className="mt-3 text-[17px] leading-snug text-graphite" data-testid="status-sentence">
            {e.dueByKm !== null || e.dueByDate ? (
              <>
                Toca {e.dueByKm !== null && <>a los <strong className="font-num text-xl tabular">{fmtKm(e.dueByKm)}</strong></>}
                {e.dueByKm !== null && e.dueByDate && " o "}
                {e.dueByDate && <>el <strong>{fmtDate(e.dueByDate)}</strong></>}
                {e.dueByKm !== null && e.dueByDate && ", lo que ocurra primero"}.
                {e.remainingKm !== null && e.remainingKm > 0 && ` Faltan ${fmtNum(e.remainingKm)} km`}
                {e.remainingDays !== null && e.remainingDays > 0 && `${e.remainingKm !== null && e.remainingKm > 0 ? " y" : " Faltan"} ${e.remainingDays} días`}
                {(e.remainingKm ?? 1) > 0 && (e.remainingDays ?? 1) > 0 ? "." : ""}
              </>
            ) : e.status === "UNKNOWN" ? (
              "No hay datos suficientes para calcular cuándo toca. Un asesor revisa el caso; no se inventa un intervalo."
            ) : e.status === "NOT_APPLICABLE" ? (
              "Este servicio no aplica para tu vehículo."
            ) : (
              "Sin fecha límite calculada."
            )}
          </p>
          <KmTrack baseKm={baseKm} currentKm={o.profile.odometer?.valueKm ?? null} dueKm={e.dueByKm} tone={st.tone} />
          {e.reasons.length > 0 && (
            <div className="mt-5">
              <h3 className="text-sm font-semibold text-graphite">Por qué</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[15px] text-graphite">
                {e.reasons.map((r) => (
                  <li key={r}>{label(REASON, r)}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-5 rounded-lg bg-paper px-4 py-3">
            <h3 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-graphite">
              Regla aplicada
              {isSyntheticRef(e.sourceRef) && <SimStamp title={e.sourceRef ?? undefined}>Regla sintética de demo</SimStamp>}
            </h3>
            <Facts
              items={[
                ["Intervalo", rule ? [rule.intervalKm !== null ? `cada ${fmtKm(rule.intervalKm)}` : null, rule.intervalMonths !== null ? `${rule.intervalMonths} meses` : null].filter(Boolean).join(" o ") || "Sin intervalo" : "Sin regla validada"],
                ["Plan", e.planVersion ?? "Sin plan validado"],
                ["Fuente", <span key="src" className="break-all">{e.sourceRef ?? "—"}</span>],
                ["Evaluado", `${fmtDate(e.evaluatedAt)} (motor ${e.engineVersion})`],
              ]}
            />
          </div>
        </>
      )}
      {o.planError && <p className="mt-3 text-sm text-muted">El plan de mantenimiento no está validado para este vehículo.</p>}
    </Panel>
  );
}

export function BookingSummary({ o }: { o: VehicleOverview }) {
  const b = o.booking;
  if (!b) return null;
  const confirmed = b.status === "CONFIRMED";
  return (
    <Panel className={`p-5 ${confirmed ? "border-oil/50" : ""}`} aria-labelledby="booking-title" data-testid="booking-summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="booking-title" className="text-lg font-semibold text-ink">
          Tu cita
        </h2>
        <Badge tone={confirmed ? "ok" : b.status === "PENDING" ? "warn" : "danger"}>{label(BOOKING_STATUS, b.status)}</Badge>
      </div>
      {b.folio && (
        <p className="mt-3">
          <span className="text-sm text-muted">Folio del taller</span>
          <span className="block font-num text-3xl font-bold tracking-wide text-oil" data-testid="booking-folio">
            {b.folio}
          </span>
        </p>
      )}
      <div className="mt-3">
        <Facts
          items={[
            ["Taller", b.workshopName],
            ["Fecha", fmtDateTime(b.startsAt)],
            ["Total", b.totalCop !== null ? fmtCop(b.totalCop) : "—"],
            ["Sistema", b.source === "MOCK" ? <SimStamp key="m">Taller simulado</SimStamp> : b.source],
          ]}
        />
      </div>
      {b.status === "PENDING" && <p className="mt-3 text-sm text-graphite">El taller no ha respondido. No repitas la confirmación: el sistema la reconcilia y te avisa.</p>}
    </Panel>
  );
}

export function History({ o }: { o: VehicleOverview }) {
  const recs = [...o.history.serviceRecords].sort((a, b) => b.performedOn.localeCompare(a.performedOn));
  return (
    <Panel className="p-5" aria-labelledby="hist-title">
      <h2 id="hist-title" className="text-lg font-semibold text-ink">
        Historial de servicios
      </h2>
      {recs.length === 0 ? (
        <p className="mt-2 text-[15px] text-muted">No hay servicios registrados para este vehículo.</p>
      ) : (
        <ol className="mt-3 divide-y divide-line">
          {recs.map((r) => (
            <li key={r.recordId} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
              <div>
                <p className="font-medium text-graphite">{label(SERVICE, r.serviceCode)}</p>
                <p className="text-sm text-muted">
                  {fmtDate(r.performedOn)}, a los <span className="tabular">{fmtKm(r.odometerKm)}</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={r.provenance === "WORKSHOP_VERIFIED" ? "ok" : "neutral"}>{label(PROVENANCE, r.provenance)}</Badge>
                {r.dataOrigin === "SYNTHETIC" && <SimStamp title={r.syntheticSourceRef ?? undefined}>Sintético</SimStamp>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
