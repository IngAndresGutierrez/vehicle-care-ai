"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, useRuns, type VehicleOverview } from "../api";
import { CASE_REASON, label, SERVICE } from "../labels";
import { ErrorNote, Spinner } from "../primitives";
import { AppShell, SignedOut, useBootstrap } from "../shell";
import { AdvisorChat } from "./advisor-chat";
import { BookingSummary, History, MaintenanceStatus, VehicleHero } from "./portal-parts";

const SERVICES = ["ENGINE_OIL_FILTER", "TIMING_BELT"] as const;

export function VehicleView() {
  const { vehicleId } = useParams<{ vehicleId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const serviceCode = SERVICES.includes(search.get("servicio") as (typeof SERVICES)[number]) ? (search.get("servicio") as string) : "ENGINE_OIL_FILTER";
  const boot = useBootstrap();
  const [overview, setOverview] = useState<VehicleOverview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tab, setTab] = useState<"vehiculo" | "asistente">("vehiculo");
  const runs = useRuns();
  const scenario = search.get("escenario") ?? runs.find((r) => r.vehicleId === vehicleId)?.scenario ?? null;

  const load = useCallback(() => {
    api.overview(vehicleId, serviceCode).then(
      (o) => {
        setOverview(o);
        setError(null);
      },
      (e: unknown) => setError(e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "Error", null)),
    );
  }, [vehicleId, serviceCode]);

  useEffect(load, [load]);

  const suggestions = boot.config?.scenarios.find((s) => s.key === scenario && s.serviceCode === serviceCode)?.suggestedMessages ?? ["¿Qué mantenimiento le toca a mi carro?"];
  const isOwner = boot.me?.role === "OWNER";
  const nav = [
    { href: `/vehiculo/${vehicleId}?servicio=${serviceCode}`, text: "Mi vehículo", current: true },
    { href: `/trazas/${vehicleId}?servicio=${serviceCode}`, text: "Trazas" },
    ...(boot.me && !isOwner ? [{ href: "/casos", text: "Casos" }] : []),
  ];

  if (boot.authed === false) {
    return (
      <AppShell boot={boot}>
        <SignedOut what="este vehículo" />
      </AppShell>
    );
  }

  return (
    <AppShell boot={boot} nav={nav}>
      {error ? (
        <ErrorNote
          title={error.status === 403 || error.status === 404 ? "No tienes acceso a este vehículo" : "No fue posible cargar el vehículo"}
          action={
            error.status === 403 || error.status === 404 ? (
              <Link className="font-semibold text-ink underline" href="/">
                Volver a la portada
              </Link>
            ) : (
              <button type="button" className="font-semibold text-ink underline" onClick={load}>
                Reintentar
              </button>
            )
          }
        >
          {error.status === 403 || error.status === 404 ? "La sesión actual no es titular de este vehículo ni lo tiene asignado." : "Revisa tu conexión e intenta de nuevo."}
        </ErrorNote>
      ) : !overview ? (
        <Spinner label="Cargando tu vehículo" />
      ) : (
        <>
          <div role="tablist" aria-label="Vista" className="mb-4 grid grid-cols-2 rounded-lg border border-line bg-card p-1 lg:hidden">
            {(
              [
                ["vehiculo", "Mi vehículo"],
                ["asistente", "Asistente"],
              ] as const
            ).map(([k, t]) => (
              <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-10 rounded-md text-[15px] font-semibold ${tab === k ? "bg-ink text-white" : "text-ink"}`}>
                {t}
              </button>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-start">
            <div className={`${tab === "vehiculo" ? "block" : "hidden"} space-y-5 lg:block`}>
              <VehicleHero o={overview} />
              <div role="group" aria-label="Servicio" className="flex gap-2">
                {SERVICES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={s === serviceCode}
                    onClick={() => router.replace(`/vehiculo/${vehicleId}?servicio=${s}${scenario ? `&escenario=${scenario}` : ""}`)}
                    className={`min-h-10 rounded-lg border px-3 text-sm font-semibold ${s === serviceCode ? "border-ink bg-ink text-white" : "border-line bg-card text-ink"}`}
                  >
                    {label(SERVICE, s)}
                  </button>
                ))}
              </div>
              <BookingSummary o={overview} />
              <MaintenanceStatus o={overview} />
              {overview.openCases.length > 0 && (
                <div className="rounded-xl border border-amber/50 bg-amber-soft px-5 py-4 text-[15px] text-graphite" data-testid="open-cases">
                  <p className="font-semibold text-ink">Un asesor tiene tu caso</p>
                  <ul className="mt-1">
                    {overview.openCases.map((c) => (
                      <li key={c.caseId}>{label(CASE_REASON, c.reason)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <History o={overview} />
              {isOwner && (
                <button type="button" onClick={() => setTab("asistente")} className="w-full rounded-lg bg-ink py-3 text-[15px] font-semibold text-white lg:hidden">
                  Hablar con el asistente
                </button>
              )}
            </div>
            <div className={`${tab === "asistente" ? "block" : "hidden"} lg:sticky lg:top-4 lg:block`}>
              {isOwner ? (
                <AdvisorChat key={`${vehicleId}-${serviceCode}`} vehicleId={vehicleId} serviceCode={serviceCode} overview={overview} config={boot.config} suggestions={suggestions} onChanged={load} />
              ) : (
                <div className="rounded-xl border border-line bg-card p-5 text-[15px] text-muted">El asistente atiende solo a propietarios. Como asesor, revisa la bandeja de casos y las trazas.</div>
              )}
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
