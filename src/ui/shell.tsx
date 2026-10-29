"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, useRuns, type DemoConfig, type MeView } from "./api";
import { label, ROLE } from "./labels";
import { SimStamp } from "./primitives";

export interface Bootstrap {
  config: DemoConfig | null;
  me: MeView | null;
  /** null: cargando; false: sin sesión válida. */
  authed: boolean | null;
  reload: () => void;
}

/** Configuración de demo + identidad de la sesión (cookie HttpOnly firmada; el cliente nunca ve el token). */
export function useBootstrap(): Bootstrap {
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [me, setMe] = useState<MeView | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.config().then((c) => live && setConfig(c), () => undefined);
    api.me().then(
      (m) => {
        if (!live) return;
        setMe(m);
        setAuthed(true);
      },
      () => {
        if (!live) return;
        setMe(null);
        setAuthed(false);
      },
    );
    return () => {
      live = false;
    };
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { config, me, authed, reload };
}

export function LlmLabel({ config }: { config: DemoConfig | null }) {
  if (!config) return null;
  return config.llm.simulated ? (
    <SimStamp title="Respuestas deterministas programadas. No es IA generativa.">Asistente simulado (ScriptedLlm)</SimStamp>
  ) : (
    <span className="inline-flex items-center rounded-md border border-oil/40 bg-oil-soft px-2 text-[12px] font-semibold leading-5 text-[#1f5c40]" title={`Modelo ${config.llm.model}`}>
      IA generativa: {config.llm.model}
    </span>
  );
}

function PersonaSwitcher({ me, config }: { me: MeView | null; config: DemoConfig | null }) {
  const router = useRouter();
  const runs = useRuns();
  const [busy, setBusy] = useState(false);
  if (!config?.demoMode) return null;
  // Solo personas de corridas iniciadas en este navegador (el servidor lo verifica con una cookie firmada).
  const options = runs.flatMap((r) => [
    { id: r.ownerActorId, text: `Propietario, escenario ${r.scenario} (${r.runId.slice(0, 4)})`, go: `/vehiculo/${r.vehicleId}?servicio=${r.serviceCode}` },
    ...(r.advisorActorId ? [{ id: r.advisorActorId, text: `Asesor, escenario ${r.scenario} (${r.runId.slice(0, 4)})`, go: "/casos" }] : []),
  ]);
  if (options.length === 0) return null;
  const current = options.some((o) => o.id === me?.actorId) ? me?.actorId : "";
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="hidden text-white/70 sm:inline">Ver como</span>
      <select
        aria-label="Cambiar de persona de demo"
        className="h-9 max-w-[13rem] rounded-md border border-white/25 bg-ink-soft px-2 text-sm text-white"
        value={current}
        disabled={busy}
        onChange={async (e) => {
          const opt = options.find((o) => o.id === e.target.value);
          if (!opt) return;
          setBusy(true);
          try {
            await api.switchPersona(opt.id);
            router.push(opt.go);
            router.refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        {current === "" && <option value="">Elige una persona</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.text}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AppShell({ boot, nav, children }: { boot: Bootstrap; nav?: Array<{ href: string; text: string; current?: boolean }>; children: ReactNode }) {
  const { me, config } = boot;
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-ink text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="font-num text-2xl font-bold tracking-wide">
            Vehicle Care
          </Link>
          {nav && nav.length > 0 && (
            <nav aria-label="Secciones" className="flex gap-1">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} aria-current={n.current ? "page" : undefined} className={`rounded-md px-3 py-1.5 text-[15px] font-medium ${n.current ? "bg-white/15" : "text-white/80 hover:text-white"}`}>
                  {n.text}
                </Link>
              ))}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3">
            {me && (
              <span className="hidden text-sm text-white/80 md:inline">
                {me.displayName} <span className="text-white/70">({label(ROLE, me.role)})</span>
              </span>
            )}
            <PersonaSwitcher me={me} config={config} />
          </div>
        </div>
      </header>
      {config?.demoMode && (
        <div className="border-b border-line bg-card">
          <p className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px] text-muted">
            <SimStamp>Demo</SimStamp>
            <span>Personas, vehículos, talleres y precios son sintéticos. Taller y CRM son sistemas simulados.</span>
            <span className="ml-auto">
              <LlmLabel config={config} />
            </span>
          </p>
        </div>
      )}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:py-8">{children}</main>
    </div>
  );
}

export function SignedOut({ what }: { what: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="font-num text-3xl font-bold text-ink">Necesitas una sesión</h1>
      <p className="mt-2 text-muted">Para ver {what}, inicia un escenario de demo o cambia de persona desde la portada.</p>
      <Link href="/" className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-ink px-5 font-semibold text-white">
        Ir a la portada
      </Link>
    </div>
  );
}
