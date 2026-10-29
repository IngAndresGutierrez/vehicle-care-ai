import type { ReactNode } from "react";
import type { Tone } from "./labels";

const TONE: Record<Tone, string> = {
  ok: "bg-oil-soft text-oil border-oil/30",
  warn: "bg-amber-soft text-[#8a5a12] border-amber/40",
  danger: "bg-brake-soft text-brake border-brake/30",
  neutral: "bg-paper text-muted border-line",
  ink: "bg-ink/8 text-ink border-ink/20",
};

export function Badge({ tone = "neutral", children, className = "", ...rest }: { tone?: Tone; children: ReactNode; className?: string; "data-testid"?: string }) {
  return <span {...rest} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[13px] font-semibold leading-5 ${TONE[tone]} ${className}`}>{children}</span>;
}

/**
 * Sello de «simulado»: borde punteado, como un timbre de caucho sobre la libreta. Marca todo dato sintético,
 * sistema MOCK o respuesta del ScriptedLlm. Nunca se omite cuando el dato es simulado.
 */
export function SimStamp({ children = "Simulado", title }: { children?: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex -rotate-1 items-center rounded-sm border-2 border-dashed border-ink/45 px-1.5 text-[12px] font-semibold leading-5 tracking-wide text-ink/80">
      {children}
    </span>
  );
}

export function Panel({ children, className = "", as: Tag = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" | "aside"; "aria-labelledby"?: string; "aria-label"?: string }) {
  return (
    <Tag className={`rounded-xl border border-line bg-card ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const v = {
    primary: "bg-ink text-white hover:bg-ink-soft disabled:bg-ink/40",
    secondary: "border border-ink/30 bg-card text-ink hover:border-ink disabled:opacity-50",
    ghost: "text-ink underline-offset-4 hover:underline disabled:opacity-50",
    danger: "bg-brake text-white hover:bg-brake/90 disabled:opacity-50",
  }[variant];
  return (
    <button type="button" className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-semibold transition-colors disabled:cursor-not-allowed ${v} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted">
      <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
      {label}
    </span>
  );
}

export function ErrorNote({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-brake/30 bg-brake-soft px-4 py-3 text-sm text-brake">
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 text-graphite">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Lista definición compacta: etiqueta tenue a la izquierda, valor a la derecha. */
export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right font-medium text-graphite">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
