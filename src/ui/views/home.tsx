"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError, saveRun, type DemoConfig } from "../api";
import { label, SERVICE } from "../labels";
import { Button, ErrorNote, Panel, SimStamp, Spinner } from "../primitives";
import { AppShell, LlmLabel, useBootstrap } from "../shell";

const OUTCOME_HINT: Record<string, string> = {
  A: "Termina con folio del taller simulado",
  B: "Termina en un caso para un asesor",
  C: "El asistente se detiene y bloquea la venta",
  D: "Termina con una reserva en otro horario",
};

export function HomeView() {
  const boot = useBootstrap();
  const router = useRouter();
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { config } = boot;

  async function start(s: DemoConfig["scenarios"][number]) {
    setStarting(s.key);
    setError(null);
    try {
      const run = await api.startScenario(s.key);
      saveRun({ ...run, startedAt: new Date().toISOString() });
      router.push(`/vehiculo/${run.vehicleId}?servicio=${run.serviceCode}&escenario=${s.key}`);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "RATE_LIMITED" ? "Se iniciaron demasiadas corridas desde esta red. Espera unos minutos." : "No fue posible preparar el escenario. Intenta de nuevo.");
      setStarting(null);
    }
  }

  async function openInbox() {
    setStarting("inbox");
    try {
      await api.switchPersona("act-advisor");
      router.push("/casos");
    } catch {
      setError("No fue posible entrar como asesor.");
      setStarting(null);
    }
  }

  return (
    <AppShell boot={boot}>
      <div className="grid gap-8 lg:grid-cols-[1fr_1.35fr] lg:gap-12">
        <div className="lg:pt-6">
          <h1 className="font-num text-4xl leading-[1.05] font-bold text-ink sm:text-5xl">El primer mantenimiento, del aviso a la cita.</h1>
          <p className="mt-4 max-w-prose text-[17px] leading-relaxed text-graphite">
            Un propietario recibe la alerta de su primer servicio, entiende por qué le toca, ve el precio y agenda en el taller sin llamar. Cuando faltan datos o hay riesgo, el asistente se detiene y una persona toma el caso.
          </p>
          <ul className="mt-6 space-y-2 text-[15px] text-muted">
            <li>El motor de reglas decide qué toca; el asistente solo lo explica.</li>
            <li>Solo el propietario confirma la reserva, con un clic propio.</li>
            <li>Cada decisión queda en las trazas, con su fuente.</li>
          </ul>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <LlmLabel config={config} />
            {config?.demoMode && <SimStamp>Datos sintéticos</SimStamp>}
          </div>
        </div>

        <div>
          <h2 className="font-num text-2xl font-semibold text-ink">Escenarios de demostración</h2>
          <p className="mt-1 text-sm text-muted">Cada escenario crea un propietario y un vehículo sintéticos nuevos, aislados de otras sesiones.</p>
          {config && !config.demoMode && (
            <div className="mt-4">
              <ErrorNote title="La demo está deshabilitada">Activa DEMO_MODE=true en el entorno para iniciar escenarios.</ErrorNote>
            </div>
          )}
          {error && (
            <div className="mt-4">
              <ErrorNote title={error} />
            </div>
          )}
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {(config?.scenarios ?? []).map((s) => (
              <li key={s.key}>
                <Panel as="article" className="flex h-full flex-col p-4" aria-labelledby={`esc-${s.key}`}>
                  <div className="flex items-baseline gap-3">
                    <span aria-hidden className="font-num text-3xl font-bold text-amber">
                      {s.key}
                    </span>
                    <h3 id={`esc-${s.key}`} className="text-[17px] font-semibold text-ink">
                      {s.title}
                    </h3>
                  </div>
                  <p className="mt-2 flex-1 text-[15px] text-graphite">{s.description}</p>
                  <p className="mt-3 text-[13px] text-muted">
                    {label(SERVICE, s.serviceCode)}. {OUTCOME_HINT[s.key]}.
                  </p>
                  <Button className="mt-4 w-full" disabled={starting !== null} onClick={() => start(s)} data-testid={`start-${s.key}`}>
                    {starting === s.key ? <Spinner label="Preparando datos" /> : `Iniciar escenario ${s.key}`}
                  </Button>
                </Panel>
              </li>
            ))}
          </ul>
          {config?.demoMode && (
            <Panel className="mt-4 flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <h3 className="font-semibold text-ink">Bandeja del asesor</h3>
                <p className="text-sm text-muted">Casos escalados de las corridas de demo y acciones humanas permitidas.</p>
              </div>
              <Button variant="secondary" disabled={starting !== null} onClick={openInbox} data-testid="open-inbox">
                Entrar como asesor
              </Button>
            </Panel>
          )}
          {!config && <Spinner label="Cargando escenarios" />}
        </div>
      </div>
    </AppShell>
  );
}
