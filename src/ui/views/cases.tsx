"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type CaseView } from "../api";
import { CASE_REASON, CASE_STATUS, fmtDateTime, JOURNEY, label, OUTCOME, PRIORITY, ROLE, SERVICE } from "../labels";
import { Badge, Button, ErrorNote, Panel, Spinner } from "../primitives";
import { AppShell, SignedOut, useBootstrap } from "../shell";

const BLOCKED: Record<string, string> = {
  CASE_NOT_OPEN: "El caso ya está resuelto.",
  NOT_ASSIGNED: "Solo la persona asignada puede resolverlo.",
  ROLE_NOT_PERMITTED: "Tu rol solo puede consultar el caso.",
  JOURNEY_STATE: "El estado del journey no admite una resolución manual ahora.",
};

function ResolveForm({ c, onDone }: { c: CaseView; onDone: () => void }) {
  const [opened, setOpened] = useState(false);
  const [outcome, setOutcome] = useState(c.allowedOutcomes[0] ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!opened)
    return (
      <div className="mt-4 border-t border-line pt-4">
        <Button variant="secondary" onClick={() => setOpened(true)} data-testid={`open-resolve-${c.caseId}`}>
          Resolver caso
        </Button>
      </div>
    );
  return (
    <form
      className="mt-4 space-y-3 border-t border-line pt-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.resolveCase(c.caseId, outcome, note.trim());
          onDone();
        } catch (err) {
          setError(err instanceof ApiError && err.status === 400 ? "Escribe una nota de al menos 5 caracteres." : "No fue posible registrar la decisión. Recarga la bandeja e intenta de nuevo.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset>
        <legend className="text-sm font-semibold text-graphite">Decisión</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {c.allowedOutcomes.map((o) => (
            <label key={o} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${outcome === o ? "border-ink bg-ink/5 font-semibold text-ink" : "border-line text-graphite"}`}>
              <input type="radio" name={`outcome-${c.caseId}`} value={o} checked={outcome === o} onChange={() => setOutcome(o)} className="accent-[var(--color-ink)]" />
              {label(OUTCOME, o)}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor={`note-${c.caseId}`} className="text-sm font-semibold text-graphite">
          Nota de resolución
        </label>
        <textarea id={`note-${c.caseId}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} required minLength={5} className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-[15px]" placeholder="Qué revisaste y qué decidiste" />
      </div>
      {error && <p role="alert" className="text-sm text-brake">{error}</p>}
      <Button type="submit" disabled={busy || note.trim().length < 5 || !outcome} data-testid={`resolve-${c.caseId}`}>
        {busy ? <Spinner label="Registrando" /> : "Registrar decisión"}
      </Button>
    </form>
  );
}

function CaseCard({ c, onDone }: { c: CaseView; onDone: () => void }) {
  const p = PRIORITY[c.priority] ?? PRIORITY.NORMAL;
  const open = c.status === "OPEN" || c.status === "ASSIGNED";
  return (
    <Panel as="article" className={`p-5 ${c.priority === "URGENT" && open ? "border-l-4 border-l-brake" : ""}`} aria-labelledby={`case-${c.caseId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`case-${c.caseId}`} className="text-lg font-semibold text-ink">
            {label(CASE_REASON, c.reason)}
          </h2>
          <p className="text-sm text-muted">
            {c.vehicle.alias}
            {c.vehicle.plateMasked && <span className="ml-1.5 font-num tracking-wider">{c.vehicle.plateMasked}</span>}
            {c.vehicle.serviceCode && `, ${label(SERVICE, c.vehicle.serviceCode)}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={p.tone}>Prioridad {p.text.toLowerCase()}</Badge>
          <Badge tone={open ? "ink" : "ok"}>{label(CASE_STATUS, c.status)}</Badge>
        </div>
      </div>

      {open && c.journey.agentPaused && (
        <p className="mt-3 rounded-md bg-brake-soft px-3 py-2 text-sm text-graphite">
          <strong className="text-brake">El asistente está detenido.</strong> No cotiza ni agenda hasta que registres una decisión.
        </p>
      )}

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-2 sm:block">
          <dt className="text-muted">Responsable</dt>
          <dd className="font-medium text-graphite">{c.assignee.isMe ? "Tú" : c.assignee.actorId ? label(ROLE, c.assignee.role) : "Sin asignar"}</dd>
        </div>
        <div className="flex justify-between gap-2 sm:block">
          <dt className="text-muted">Plazo de atención</dt>
          <dd className={`font-medium ${c.slaBreached && open ? "text-brake" : "text-graphite"}`}>
            {fmtDateTime(c.slaDueAt)}
            {c.slaBreached && open && " (vencido)"}
          </dd>
        </div>
        <div className="flex justify-between gap-2 sm:block">
          <dt className="text-muted">Abierto por</dt>
          <dd className="font-medium text-graphite">
            {label(ROLE, c.openedByRole)}, {fmtDateTime(c.createdAt)}
          </dd>
        </div>
        <div className="flex justify-between gap-2 sm:block">
          <dt className="text-muted">Journey</dt>
          <dd className="font-medium text-graphite">{c.journey.state ? label(JOURNEY, c.journey.state) : "—"}</dd>
        </div>
      </dl>

      {c.summary && (
        <div className="mt-3">
          <p className="text-[13px] text-muted">Contexto registrado (texto no verificado)</p>
          <p className="mt-0.5 rounded-md bg-paper px-3 py-2 text-sm whitespace-pre-line text-graphite">{c.summary}</p>
        </div>
      )}
      {c.resolution && (
        <p className="mt-3 text-sm text-graphite">
          <span className="text-muted">Resolución: </span>
          {c.resolution}
        </p>
      )}

      <p className="mt-3 flex flex-wrap gap-4 text-sm">
        <Link className="font-semibold text-ink underline underline-offset-4" href={`/trazas/${c.vehicle.vehicleId}?servicio=${c.vehicle.serviceCode ?? "ENGINE_OIL_FILTER"}`}>
          Ver trazas
        </Link>
        <Link className="font-semibold text-ink underline underline-offset-4" href={`/vehiculo/${c.vehicle.vehicleId}?servicio=${c.vehicle.serviceCode ?? "ENGINE_OIL_FILTER"}`}>
          Ver vehículo
        </Link>
      </p>

      {open && (c.canResolve && c.allowedOutcomes.length > 0 ? <ResolveForm c={c} onDone={onDone} /> : <p className="mt-3 text-sm text-muted">{BLOCKED[c.resolveBlockedReason ?? ""] ?? "No puedes resolver este caso."}</p>)}
    </Panel>
  );
}

export function CasesView() {
  const boot = useBootstrap();
  const [cases, setCases] = useState<CaseView[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const load = useCallback(() => {
    api.cases().then(
      (r) => {
        setCases(r.cases);
        setError(null);
      },
      (e: unknown) => setError(e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Error", null)),
    );
  }, []);
  useEffect(load, [load]);

  if (boot.authed === false)
    return (
      <AppShell boot={boot}>
        <SignedOut what="la bandeja de casos" />
      </AppShell>
    );

  const visible = (cases ?? []).filter((c) => filter === "all" || c.status === "OPEN" || c.status === "ASSIGNED");
  const openCount = (cases ?? []).filter((c) => c.status === "OPEN" || c.status === "ASSIGNED").length;

  return (
    <AppShell boot={boot} nav={[{ href: "/casos", text: "Casos", current: true }]}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-num text-3xl font-bold text-ink">Bandeja de atención</h1>
          <p className="text-[15px] text-muted">Casos que el asistente no puede resolver. Mientras estén abiertos, el asistente no actúa sobre ese vehículo.</p>
        </div>
        <div role="group" aria-label="Filtro" className="flex rounded-lg border border-line bg-card p-1">
          {(
            [
              ["open", `Abiertos (${openCount})`],
              ["all", "Todos"],
            ] as const
          ).map(([k, t]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`min-h-9 rounded-md px-3 text-sm font-semibold ${filter === k ? "bg-ink text-white" : "text-ink"}`}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-5 space-y-4">
        {error ? (
          <ErrorNote title={error.status === 403 ? "La bandeja es solo para el equipo de atención" : "No fue posible cargar la bandeja"}>
            {error.status === 403 ? "Cambia a la persona «Asesor de postventa (demo)» desde el menú superior." : "Intenta de nuevo."}
          </ErrorNote>
        ) : !cases ? (
          <Spinner label="Cargando casos" />
        ) : visible.length === 0 ? (
          <Panel className="p-6 text-center text-[15px] text-muted">No hay casos abiertos. Inicia el escenario B o C desde la portada para generar uno.</Panel>
        ) : (
          visible.map((c) => <CaseCard key={c.caseId} c={c} onDone={load} />)
        )}
      </div>
    </AppShell>
  );
}
