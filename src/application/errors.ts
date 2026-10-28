/** Errores de negocio esperados de los casos de uso. Los bugs lanzan excepciones. */
export type AppErrorCode =
  | "UNAUTHORIZED"
  | "VEHICLE_NOT_FOUND"
  | "EVALUATION_NOT_FOUND"
  | "POLICY_MISSING"
  | "AMBIGUOUS_PLAN";

export interface AppError {
  code: AppErrorCode;
  detail?: string;
}

export const appError = (code: AppErrorCode, detail?: string): AppError => (detail ? { code, detail } : { code });
