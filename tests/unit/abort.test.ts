// withTimeout (src/shared/abort.ts): a signal bounded by a timeout and by other signals keeps its bound across a
// garbage collection, which AbortSignal.any([AbortSignal.timeout(ms), …]) does not on Node 22 — its sources are held
// weakly, so a collection takes the timeout signal and its timer, and the composite never aborts.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { withTimeout } from '../../src/shared/abort.js';
import { collectGarbage } from '../helpers/gc.js';

/** Whether `signal` aborts within `ms`, and its reason's name. */
function outcome(signal: AbortSignal, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(`not aborted within ${String(ms)} ms`);
    }, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(`aborted: ${(signal.reason as Error).name}`);
      },
      { once: true },
    );
  });
}

describe('withTimeout', () => {
  it('aborts at its timeout with a TimeoutError across garbage collections, with another signal beside it', async () => {
    const signal = withTimeout(30, new AbortController().signal);
    const result = outcome(signal, 1_000);
    await collectGarbage();
    expect(await result).toBe('aborted: TimeoutError');
  });

  it("aborts with the other signal's reason when that comes first", () => {
    const other = new AbortController();
    const signal = withTimeout(60_000, other.signal);
    other.abort(new Error('the agent left'));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe('the agent left');
  });

  it('keeps its bound when a caller passes it through AbortSignal.any again, across collections (the review of 049eb99, finding 1)', async () => {
    const signal = AbortSignal.any([withTimeout(30, new AbortController().signal)]);
    const result = outcome(signal, 1_000);
    await collectGarbage();
    expect(await result).toBe('aborted: TimeoutError');
  });

  it('with no other signal is the timeout alone, and keeps its bound across a collection', async () => {
    const signal = withTimeout(30);
    const result = outcome(signal, 1_000);
    await collectGarbage();
    expect(await result).toBe('aborted: TimeoutError');
  });
});

/**
 * Each `AbortSignal.any(…)` call in `source` that combines a timeout signal by hand: its argument list, read to its
 * closing parenthesis, holds `AbortSignal.timeout(` or a name the file assigns from it (`const t = AbortSignal.timeout(…)`).
 */
function hazards(source: string): string[] {
  const timeoutNames = [...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*AbortSignal\.timeout\(/g)].map((m) =>
    present(m[1], 'AbortSignal.timeout(...) assignment target name'),
  );
  const found: string[] = [];
  for (const m of source.matchAll(/AbortSignal\.any\(/g)) {
    let depth = 1;
    let end = m.index + m[0].length;
    while (end < source.length && depth > 0) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') depth -= 1;
      end += 1;
    }
    const args = source.slice(m.index + m[0].length, end - 1);
    if (/AbortSignal\.timeout\(/.test(args) || timeoutNames.some((name) => new RegExp(`\\b${name}\\b`).test(args)))
      found.push(args.replace(/\s+/g, ' ').trim());
  }
  return found;
}

describe('no shipped code combines a timeout signal with AbortSignal.any by hand', () => {
  const root = resolve(import.meta.dirname, '..', '..');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.isDirectory()) return files(join(dir, e.name));
      return e.name.endsWith('.ts') ? [join(dir, e.name)] : [];
    });

  it('src/ and images/*/src/ hold none, inline or through a name: withTimeout is the one way', () => {
    const roots = [
      join(root, 'src'),
      ...readdirSync(join(root, 'images')).map((image) => join(root, 'images', image, 'src')),
    ].filter((dir) => existsSync(dir));
    const found = roots
      .flatMap(files)
      .filter((file) => file !== join(root, 'src', 'shared', 'abort.ts'))
      .flatMap((file) =>
        hazards(readFileSync(file, 'utf8')).map((args) => `${relative(root, file)}: AbortSignal.any(${args})`),
      );
    expect(found).toEqual([]);
  });

  it('finds every such call of the tree before withTimeout (049eb99~1), the variable-held one in callSignal included', () => {
    // The files as they stood at 049eb99~1, copied under tests/fixtures/ (its README), since a published clone holds
    // no internal history (docs/plans/oss-release.md R12).
    const before = (path: string): string =>
      readFileSync(join(root, 'tests', 'fixtures', 'source-before-withTimeout', `${path}.txt`), 'utf8');
    expect(
      Object.fromEntries(
        [
          'src/agent-sdk/index.ts',
          'src/cli/commands.ts',
          'src/cli/files.ts',
          'src/daemon/files/index.ts',
          'src/daemon/model-gateway/index.ts',
        ].map((path) => [path, hazards(before(path)).length]),
      ),
    ).toEqual({
      'src/agent-sdk/index.ts': 2,
      'src/cli/commands.ts': 1,
      'src/cli/files.ts': 1,
      'src/daemon/files/index.ts': 1,
      'src/daemon/model-gateway/index.ts': 2,
    });
  });
});
