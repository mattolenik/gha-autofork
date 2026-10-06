import type { Inputs } from '../inputs.js';
import type { Logger } from '../log.js';
import { ClaudeBackend } from './claude.js';
import { CodexBackend } from './codex.js';
import { FakeBackend } from './fake.js';
import type { AgentBackend } from './types.js';

export function createBackend(name: Inputs['worker']['backend'], inputs: Inputs, log: Logger): AgentBackend {
  switch (name) {
    case 'claude':
      return new ClaudeBackend({ log });
    case 'codex':
      return new CodexBackend({ log });
    case 'fake':
      return new FakeBackend(inputs.fakeScript);
  }
}

/** Environment variables a backend needs, drawn from the inputs. Returned keys are the only extras passed. */
export function backendEnv(name: Inputs['worker']['backend'], inputs: Inputs): Record<string, string> {
  switch (name) {
    case 'claude':
      return inputs.anthropicApiKey ? { ANTHROPIC_API_KEY: inputs.anthropicApiKey } : {};
    case 'codex':
      return inputs.openaiApiKey ? { OPENAI_API_KEY: inputs.openaiApiKey } : {};
    case 'fake':
      return {};
  }
}
