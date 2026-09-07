export class AppError extends Error {
  constructor(public code: string, message: string, public statusCode = 400, public details?: unknown) { super(message); }
}
export function invariant(condition: unknown, code: string, message: string, status = 400, details?: unknown): asserts condition {
  if (!condition) throw new AppError(code, message, status, details);
}
