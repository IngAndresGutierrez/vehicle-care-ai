/** Fuente única de "ahora". El dominio recibe `now` como argumento; nunca llama a `new Date()`. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(isoInstant: string): Clock {
  const instant = new Date(isoInstant);
  if (Number.isNaN(instant.getTime())) throw new Error(`fixedClock: instante inválido ${isoInstant}`);
  return { now: () => new Date(instant.getTime()) };
}
