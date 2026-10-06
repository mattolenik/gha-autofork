import * as core from '@actions/core';

export interface Logger {
  info(msg: string): void;
  warning(msg: string): void;
  debug(msg: string): void;
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export const coreLogger: Logger = {
  // Agent/commit text is data, including strings resembling Actions workflow commands.
  info: (m) => m.split(/\r?\n/).forEach(line => core.info(`[autopatch] ${line}`)),
  warning: (m) => core.warning(m),
  debug: (m) => core.debug(m),
  group: (name, fn) => core.group(name, fn),
};

export const silentLogger: Logger = {
  info: () => {},
  warning: () => {},
  debug: () => {},
  group: (_name, fn) => fn(),
};

export function collectingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info: ${m}`),
    warning: (m) => lines.push(`warning: ${m}`),
    debug: (m) => lines.push(`debug: ${m}`),
    group: (_name, fn) => fn(),
  };
}
