/**
 * Environment for child processes that run untrusted or semi-trusted work (agents, verify command).
 * Only an explicit allowlist is passed through. INPUT_*, GITHUB_*, ACTIONS_*, RUNNER_* never are.
 */
const PASSTHROUGH = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL'] as const;

export function buildChildEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASSTHROUGH) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.TERM = 'dumb';
  env.CI = '1';
  env.NO_COLOR = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_EDITOR = 'true';
  env.GIT_PAGER = 'cat';
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== '') env[k] = v;
  }
  return env;
}

const FORBIDDEN = /^(INPUT_|GITHUB_|ACTIONS_|RUNNER_)/;

/** Keys that must never reach a child. Exposed so tests can assert the invariant. */
export function forbiddenKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((k) => FORBIDDEN.test(k));
}
