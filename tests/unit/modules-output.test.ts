// What reaches the model and the log from a module or a plugin (docs/plans/extension-modules.md R10 (a), R33, R35;
// A10, A24, A30): src/daemon/modules/redact.ts and cut.ts.

import { describe, expect, it } from 'vitest';

import {
  captureText,
  cutResult,
  MAX_CAPTURE_BYTES,
  MAX_RESULT_JSON_BYTES,
  redact,
  redactValue,
} from '../../src/daemon/modules/index.js';
import { boundedLines } from '../../src/daemon/process/launcher.js';
import { resultBytes } from '../../src/agent-sdk/tools.js';
import { present } from '../../src/shared/assert-present.js';

const SECRET = 'fixture-secret-abcdefghijklmnop';

describe('redact (R33, R35)', () => {
  it('replaces every whole secret value, the longest first', () => {
    expect(redact(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe('a [redacted] b [redacted]');
    expect(redact(`x ${SECRET}-longer y`, [SECRET, `${SECRET}-longer`])).toBe('x [redacted] y');
  });

  it('replaces a trailing fragment that is a prefix of a secret, of at least 4 characters, and no shorter one', () => {
    expect(redact(`cut at ${SECRET.slice(0, 10)}`, [SECRET])).toBe('cut at [redacted]');
    expect(redact(`cut at ${SECRET.slice(0, 4)}`, [SECRET])).toBe('cut at [redacted]');
    expect(redact(`cut at ${SECRET.slice(0, 3)}`, [SECRET])).toBe(`cut at ${SECRET.slice(0, 3)}`);
    // A prefix in the middle is text, not a cut.
    expect(redact(`${SECRET.slice(0, 10)} and more`, [SECRET])).toBe(`${SECRET.slice(0, 10)} and more`);
  });

  it('leaves text with no secret, and ignores an empty secret', () => {
    expect(redact('plain', [SECRET, ''])).toBe('plain');
  });
  it('replaces a leading fragment that is a suffix of a secret, of at least 4 characters: the second half of a split line (B-8)', () => {
    expect(redact(`${SECRET.slice(10)} end`, [SECRET])).toBe('[redacted] end');
    expect(redact(`${SECRET.slice(-4)} end`, [SECRET])).toBe('[redacted] end');
    expect(redact(`${SECRET.slice(-3)} end`, [SECRET])).toBe(`${SECRET.slice(-3)} end`);
  });

  it('redactValue redacts every string at any depth, keys included, and leaves numbers, booleans and null (B-13)', () => {
    expect(redactValue({ a: [`x ${SECRET}`, 1, true, null], [SECRET]: { b: SECRET } }, [SECRET])).toEqual({
      a: ['x [redacted]', 1, true, null],
      '[redacted]': { b: '[redacted]' },
    });
    const value = { a: SECRET };
    expect(redactValue(value, [])).toBe(value);
  });

  it("captureText redacts a secret cut at the capture's end before it adds the cut's marker (B-14)", () => {
    const kept = Buffer.from(`out ${SECRET.slice(0, 8)}`);
    expect(captureText(kept, kept.length + 100, [SECRET])).toBe(
      `out [redacted] [100 bytes past the ${String(MAX_CAPTURE_BYTES)}-byte capture]`,
    );
    expect(captureText(kept, kept.length, [SECRET])).toBe('out [redacted]');
  });
});

describe("boundedLines (a module's stderr; review of 2026-10-02, B-15)", () => {
  it('gives each line whole, across chunks, and ends with what is left', () => {
    const lines: string[] = [];
    const b = boundedLines((l) => lines.push(l), 10);
    b.push('ab');
    b.push('c\r\nde\nf');
    b.end();
    expect(lines).toEqual(['abc', 'de', 'f']);
  });

  it('holds at most max characters of a line with no newline, giving the rest as a count', () => {
    const lines: string[] = [];
    const b = boundedLines((l) => lines.push(l), 10);
    for (let i = 0; i < 1_000; i += 1) b.push('x'.repeat(1_000));
    b.push('\nnext\n');
    expect(lines).toEqual([`${'x'.repeat(10)} [999990 characters past 10 dropped]`, 'next']);
  });
});

describe('cutResult (R10 (a), R33)', () => {
  it('leaves a result whose JSON fits unchanged', () => {
    const value = { ok: 'x'.repeat(100) };
    expect(cutResult(value)).toBe(value);
  });

  it("cuts an object's longest string to fit 8,192 bytes of JSON as the SDK counts it, with the marker", () => {
    const out = cutResult({ exit_code: 0, stdout: 'a'.repeat(40 * 1024), stderr: 'short' }) as {
      stdout: string;
      stderr: string;
      exit_code: number;
    };
    expect(resultBytes(out)).toBeLessThanOrEqual(MAX_RESULT_JSON_BYTES);
    expect(resultBytes(out)).toBeGreaterThan(MAX_RESULT_JSON_BYTES - 200);
    expect(out.stderr).toBe('short');
    expect(out.exit_code).toBe(0);
    const cutMatch = present(/ \[(\d+) bytes cut\]$/.exec(out.stdout), 'the cut marker in out.stdout');
    const cut = Number(present(cutMatch[1], 'the cut marker capture group'));
    expect(out.stdout.length - ` [${String(cut)} bytes cut]`.length + cut).toBe(40 * 1024);
  });

  it('counts JSON escapes: a string of quotes and control characters still fits', () => {
    const out = cutResult({ stdout: '"\u0001'.repeat(10_000) });
    expect(resultBytes(out)).toBeLessThanOrEqual(MAX_RESULT_JSON_BYTES);
  });

  it('never splits a character: multi-byte text is cut on a whole character', () => {
    const out = cutResult({ stdout: 'é🙂'.repeat(5_000) }) as { stdout: string };
    expect(resultBytes(out)).toBeLessThanOrEqual(MAX_RESULT_JSON_BYTES);
    expect(out.stdout.includes('�')).toBe(false);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out.stdout)).toBe(false);
  });

  it('turns anything else too large into {result_cut, partial}', () => {
    const out = cutResult(Array.from({ length: 5_000 }, (_, i) => i)) as { result_cut: string; partial: string };
    expect(resultBytes(out)).toBeLessThanOrEqual(MAX_RESULT_JSON_BYTES);
    expect(out.partial.startsWith('[0,1,2,3')).toBe(true);
    expect(out.result_cut).toMatch(/^\d+ bytes cut$/);
  });
});
