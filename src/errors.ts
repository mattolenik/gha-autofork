/** Terminal states of a run. FAILED_* values are also error codes. */
export const STATES = [
  'APPROVED',
  'NOTHING_TO_DO',
  'FAST_FORWARDED',
  'STAGED',
  'PREPARED',
  'VERIFIED',
  'REPORTED',
  'FAILED_PLAN',
  'FAILED_REBASE',
  'FAILED_GATE',
  'FAILED_CONTESTED',
  'FAILED_BUDGET',
  'FAILED_TIMEOUT',
  'FAILED_AGENT',
  'FAILED_TAMPERED',
  'FAILED_PUBLISH',
] as const;
export type State = (typeof STATES)[number];
export type FailureState = Extract<State, `FAILED_${string}`>;

export class AutoforkError extends Error {
  readonly state: FailureState;
  readonly details: string[];

  constructor(state: FailureState, message: string, details: string[] = []) {
    super(message);
    this.name = 'AutoforkError';
    this.state = state;
    this.details = details;
  }
}

export function isAutoforkError(err: unknown): err is AutoforkError {
  return err instanceof AutoforkError;
}
