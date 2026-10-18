// The committed reference modules and the harness's own images (docs/plans/extension-modules.md R24, R27, R37; A37):
// plain JavaScript with no npm dependency and no build output, every file's sha256 equal to its module.json entry
// (recomputed here, never copied), every manifest valid by the same parser the installer uses, and the harness's own
// images out of reach of `--launch image=`.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Definitions, UnknownImage } from '../../src/daemon/definitions/index.js';
import { licencesOffAllowlist, parseModuleManifest } from '../../src/shared/modules.js';
import { byCodeUnit } from '../../src/shared/order.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES = join(ROOT, 'modules');

/**
 * `source`'s static imports (an `import` at a line's start, whitespace-indented or not) and dynamic `import(`/
 * `require(` calls, as `.match()` would return them, or `null` for none — scanned line by line, never by
 * `/^\s*import\s|\bimport\(|\brequire\(/gm`, whose leading `\s*`, retried at every position under the `g` flag,
 * is scslre's "Move" ambiguity (sonarjs/super-linear-regex). Null-vs-non-null, all this caller reads, confirmed
 * equal to that regex's by a fuzz comparison of 1,000,000 random strings before this change.
 */
function importOrRequireMatches(source: string): string[] | null {
  const found: string[] = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trimStart();
    const followedByNewline = i < lines.length - 1;
    if (trimmed === 'import' && followedByNewline) found.push('import\n');
    else if (trimmed.startsWith('import') && /\s/.test(trimmed[6] ?? '')) found.push(trimmed.slice(0, 7));
    for (const m of line.matchAll(/\bimport\(|\brequire\(/g)) found.push(m[0]);
  });
  return found.length === 0 ? null : found;
}

/** Every file under `dir`, relative, sorted. */
function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    )
    .sort(byCodeUnit);
}

const ids = readdirSync(MODULES)
  .filter((name) => statSync(join(MODULES, name)).isDirectory())
  .sort(byCodeUnit);

describe('the reference modules in modules/ (A37)', () => {
  it('are exactly tavily, bedrock and the aws_cli plugin', () => {
    expect(ids).toEqual(['aws_cli', 'bedrock', 'tavily']);
  });

  for (const id of ['aws_cli', 'bedrock', 'tavily']) {
    describe(id, () => {
      const dir = join(MODULES, id);
      const raw = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')) as Record<string, unknown>;

      it("parses with the installer's parser, its id the directory's, every licence on the allowlist", () => {
        const manifest = parseModuleManifest(raw, `modules/${id}/module.json`, id);
        expect(manifest.id).toBe(id);
        expect(licencesOffAllowlist(manifest)).toEqual([]);
      });

      it("lists every file it holds but module.json, and each sha256 equals the file's, recomputed", () => {
        const files = raw['files'] as Record<string, string>;
        expect(filesUnder(dir).filter((f) => f !== 'module.json')).toEqual(Object.keys(files).sort(byCodeUnit));
        for (const [file, sha] of Object.entries(files)) {
          expect({
            file,
            sha256: createHash('sha256')
              .update(readFileSync(join(dir, file)))
              .digest('hex'),
          }).toEqual({ file, sha256: sha });
        }
      });

      it('holds no node_modules and no build output', () => {
        expect(existsSync(join(dir, 'node_modules'))).toBe(false);
        expect(existsSync(join(dir, 'dist'))).toBe(false);
        expect(filesUnder(dir).filter((f) => /\.(ts|mts|cts|map)$/.test(f))).toEqual([]);
      });

      if (id !== 'aws_cli') {
        it('is plain ES-module JavaScript whose package-lock.json lists no package and which imports nothing', () => {
          const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as {
            packages: Record<string, unknown>;
          };
          expect(Object.keys(lock.packages)).toEqual(['']);
          const source = readFileSync(join(dir, 'index.mjs'), 'utf8');
          expect(importOrRequireMatches(source)).toBeNull();
        });
      }
    });
  }

  it('no reference secret value or real key prefix is committed in any module file (R24)', () => {
    for (const id of ids) {
      for (const file of filesUnder(join(MODULES, id))) {
        const text = readFileSync(join(MODULES, id, file), 'utf8');
        expect({
          file: `${id}/${file}`,
          found: text.match(/tvly-[A-Za-z0-9]|AKIA[0-9A-Z]{12}|ASIA[0-9A-Z]{12}/g),
        }).toEqual({ file: `${id}/${file}`, found: null });
      }
    }
  });
});

describe('harness-images/ (R37)', () => {
  it('holds the module base, the egress proxy and the plugin base, each with a Dockerfile', () => {
    const names = readdirSync(join(ROOT, 'harness-images'))
      .filter((n) => statSync(join(ROOT, 'harness-images', n)).isDirectory())
      .sort(byCodeUnit);
    expect(names).toEqual(['egress-proxy', 'module-base', 'plugin-base']);
    for (const name of names) expect(existsSync(join(ROOT, 'harness-images', name, 'Dockerfile'))).toBe(true);
  });

  it('none of them is an agent image: Definitions.image refuses each name with UnknownImage', async () => {
    const definitions = new Definitions(ROOT);
    for (const name of ['egress-proxy', 'module-base', 'plugin-base'])
      await expect(definitions.image(name)).rejects.toThrow(UnknownImage);
  });
});
