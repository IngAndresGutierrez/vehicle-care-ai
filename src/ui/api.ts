"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { Card } from "@/agent/cards";
import type { TurnResult } from "@/agent/maintenance-advisor";
import type { CaseView, MeView, TraceView, VehicleOverview } from "@/application/views/read-models";

export type { Card, CaseView, MeView, TraceView, TurnResult, VehicleOverview };

export interface DemoConfig {
  demoMode: boolean;
  llm: { provider: "ANTHROPIC" | "SCRIPTED"; model: string; simulated: boolean };
  scenarios: Array<{ key: "A" | "B" | "C" | "D"; title: string; description: string; serviceCode: string; suggestedMessages: string[] }>;
  staff: Array<{ actorId: string; label: string }>;
}

export interface DemoRun {
  runId: string;
  scenario: "A" | "B" | "C" | "D";
  ownerActorId: string;
  vehicleId: string;
  serviceCode: string;
  startedAt: string;
}

export interface ConfirmedBooking {
  bookingId: string;
  status: string;
  folio: string | null;
  startsAt?: string;
  duplicate?: boolean;
  [k: string]: unknown;
}

/** Error de API con el código estable del backend (nunca se inventa en el cliente). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly traceId: string | null,
    readonly retryable = false,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
      headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...init?.headers },
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "NETWORK", "No hay conexión con el servidor.", null, true);
  }
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message?: string; retryable?: boolean }; traceId?: string } | null;
  if (!res.ok) {
    const code = body?.error?.code ?? `HTTP_${res.status}`;
    throw new ApiError(res.status, code, body?.error?.message ?? "La solicitud falló.", body?.traceId ?? res.headers.get("x-trace-id"), body?.error?.retryable ?? (res.status === 429 || res.status >= 500));
  }
  return body as T;
}

export const api = {
  config: () => call<DemoConfig>("/api/demo/config"),
  me: () => call<MeView>("/api/me"),
  startScenario: (scenario: DemoRun["scenario"]) => call<Omit<DemoRun, "startedAt">>("/api/demo/scenarios", { json: { scenario } }),
  switchPersona: (actorId: string) => call<{ actorId: string; role: string; displayName: string }>("/api/demo/session", { json: { actorId } }),
  overview: (vehicleId: string, serviceCode: string) => call<VehicleOverview>(`/api/vehicles/${encodeURIComponent(vehicleId)}/overview?serviceCode=${serviceCode}`),
  trace: (vehicleId: string, serviceCode: string) => call<TraceView>(`/api/vehicles/${encodeURIComponent(vehicleId)}/trace?serviceCode=${serviceCode}`),
  turn: (input: { vehicleId: string; serviceCode: string; sessionId?: string; message: string }) => call<TurnResult>("/api/agent/turn", { json: input }),
  confirm: (confirmationToken: string) => call<{ booking: ConfirmedBooking; traceId: string }>("/api/bookings/confirm", { json: { confirmationToken } }),
  slotTaken: () => call<{ slotRef: string; label: string }>("/api/demo/slot-taken", { json: {} }),
  cases: () => call<{ cases: CaseView[] }>("/api/cases"),
  resolveCase: (caseId: string, outcome: string, resolution: string) => call<unknown>(`/api/cases/${encodeURIComponent(caseId)}/resolve`, { json: { outcome, resolution } }),
};

// ── Corridas de demo recordadas en este navegador (solo para cambiar de persona; la sesión real es la cookie) ──

const RUNS_KEY = "vc.demoRuns";

export function loadRuns(): DemoRun[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    return raw ? (JSON.parse(raw) as DemoRun[]) : [];
  } catch {
    return [];
  }
}

export function saveRun(run: DemoRun): void {
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify([run, ...loadRuns().filter((r) => r.runId !== run.runId)].slice(0, 8)));
  } catch {
    /* almacenamiento no disponible: la demo sigue funcionando con la cookie */
  }
}

function readRunsRaw(): string {
  try {
    return localStorage.getItem(RUNS_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function subscribeRuns(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** Corridas recordadas, leídas sin efectos (se hidrata con "[]" y luego toma el valor del navegador). */
export function useRuns(): DemoRun[] {
  const raw = useSyncExternalStore(subscribeRuns, readRunsRaw, () => "[]");
  return useMemo(() => {
    try {
      return JSON.parse(raw) as DemoRun[];
    } catch {
      return [];
    }
  }, [raw]);
}
