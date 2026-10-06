import { AutopatchError } from './errors.js';

/** Run-wide cost accounting across every agent call. */
export class Budget {
  spentUsd = 0;
  calls = 0;
  /** Calls whose backend reported no cost; time limits are the backstop for those. */
  unpricedCalls = 0;

  constructor(readonly maxUsd: number) {}

  record(costUsd: number | null): void {
    this.calls += 1;
    if (costUsd === null) {
      this.unpricedCalls += 1;
      return;
    }
    this.spentUsd += costUsd;
    if (this.spentUsd > this.maxUsd) {
      throw new AutopatchError(
        'FAILED_BUDGET',
        `agent spend $${this.spentUsd.toFixed(2)} exceeded max_cost_usd=$${this.maxUsd.toFixed(2)} after ${this.calls} calls`,
      );
    }
  }
}
