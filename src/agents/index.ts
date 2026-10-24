import type { Inputs } from '../inputs.js';
import type { Logger } from '../log.js';
import { ClaudeBackend, CLAUDE_VERSION } from './claude.js';
import { CodexBackend, CODEX_VERSION } from './codex.js';
import { FakeBackend } from './fake.js';
import type { AgentBackend } from './types.js';

/** Claude Code pointed at DeepSeek, per https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code */
export const DEEPSEEK_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
  CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
  CLAUDE_CODE_EFFORT_LEVEL: 'max',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
} as const;

export function createBackend(name: Inputs['worker']['backend'], inputs: Inputs, log: Logger): AgentBackend {
  switch (name) {
    case 'deepseek':
    case 'claude':
      return new ClaudeBackend({ name, log, sandbox: inputs.sandbox ?? false, installVersion: inputs.claudeVersion ?? CLAUDE_VERSION });
    case 'codex':
      return new CodexBackend({ log, sandbox: inputs.sandbox ?? false, installVersion: inputs.codexVersion ?? CODEX_VERSION });
    case 'fake':
      return new FakeBackend(inputs.fakeScript);
  }
}

/** Environment variables a backend needs, drawn from the inputs. Returned keys are the only extras passed. */
export function backendEnv(name: Inputs['worker']['backend'], inputs: Inputs): Record<string, string> {
  switch (name) {
    case 'deepseek': {
      const key = inputs.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY;
      return key ? { ...DEEPSEEK_ENV, ANTHROPIC_AUTH_TOKEN: key } : {};
    }
    case 'claude':
      return inputs.anthropicApiKey ? { ANTHROPIC_API_KEY: inputs.anthropicApiKey } : {};
    case 'codex':
      return inputs.openaiApiKey ? { OPENAI_API_KEY: inputs.openaiApiKey } : {};
    case 'fake':
      return {};
  }
}
