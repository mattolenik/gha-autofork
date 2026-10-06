import { describe, expect, it } from 'vitest';
import { parseInputs, type RawInputs } from '../src/inputs.js';

function raw(overrides: Partial<RawInputs> = {}): RawInputs {
  return {
    upstream: 'acme/widgets',
    upstreamBranch: '',
    branch: '',
    repository: 'matt/widgets',
    token: 'ghp_x',
    worker: 'claude:claude-opus-5-5',
    reviewer: 'codex:gpt-6.1-sol',
    maxRounds: '3',
    verifyCommand: '',
    maxPatches: '200',
    maxCostUsd: '10',
    maxTurns: '60',
    agentTimeoutMinutes: '30',
    keepBackups: '10',
    publish: 'auto',
    installClis: 'true',
    dryRun: 'false',
    anthropicApiKey: '',
    openaiApiKey: '',
    forkRemoteUrl: '',
    fakeScript: '',
    ...overrides,
  };
}

describe('parseInputs', () => {
  it('parses a full set of inputs', () => {
    const i = parseInputs(raw());
    expect(i.worker).toEqual({ backend: 'claude', model: 'claude-opus-5-5' });
    expect(i.reviewer).toEqual({ backend: 'codex', model: 'gpt-6.1-sol' });
    expect(i.upstreamBranch).toBeUndefined();
    expect(i.maxRounds).toBe(3);
    expect(i.maxCostUsd).toBe(10);
    expect(i.installClis).toBe(true);
    expect(i.dryRun).toBe(false);
    expect(i.publish).toBe('auto');
  });

  it('allows the fake backend without a model and an empty reviewer', () => {
    const i = parseInputs(raw({ worker: 'fake', reviewer: '' }));
    expect(i.worker).toEqual({ backend: 'fake', model: '' });
    expect(i.reviewer).toBeUndefined();
  });

  it('rejects unknown backends and missing models with the input name', () => {
    expect(() => parseInputs(raw({ worker: 'gemini:pro' }))).toThrow(/worker: unknown backend "gemini"/);
    expect(() => parseInputs(raw({ worker: 'codex' }))).toThrow(/worker: backend "codex" requires a model/);
  });

  it('rejects malformed numbers and repository names', () => {
    expect(() => parseInputs(raw({ maxRounds: '0' }))).toThrow(/max_rounds/);
    expect(() => parseInputs(raw({ maxCostUsd: 'ten' }))).toThrow(/max_cost_usd/);
    expect(() => parseInputs(raw({ repository: 'nope' }))).toThrow(/repository must be owner\/repo/);
    expect(() => parseInputs(raw({ publish: 'yolo' }))).toThrow(/publish/);
  });
});
