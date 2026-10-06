/** Terminal states of a run. FAILED_* values are also error codes. */
export const STATES = [
  'APPROVED',
  'NOTHING_TO_DO',
  'FAST_FORWARDED',
  'STAGED',
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

export class AutopatchError extends Error {
  readonly state: FailureState;
  readonly details: string[];

  constructor(state: FailureState, message: string, details: string[] = []) {
    super(message);
    this.name = 'AutopatchError';
    this.state = state;
    this.details = details;
  }
}

export function isAutopatchError(err: unknown): err is AutopatchError {
  return err instanceof AutopatchError;
}
