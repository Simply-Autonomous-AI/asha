// No command plugin ships with an unverified signature (debt-paydown R6, A6; D50): every module manifest under
// modules/ that declares an `executable` (a command plugin, extension-modules R28) must record, in
// `executable.signature.method`, the GnuPG status line `VALIDSIG <fingerprint>` for its own `fingerprint` with the
// spaces removed — what `gpg --status-fd 1 --verify` prints for a good signature by that key — and its `verifiedBy`
// must name the committed output of the verification run, which must show, for every pinned archive, its sha256 as
// the pin and `VALIDSIG` by that fingerprint, and end `EXIT=0` (the completion review's finding 7: the method text
// alone was not tied to the archives pinned).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

interface Manifest {
  readonly executable?: {
    readonly signature?: { readonly method?: unknown; readonly fingerprint?: unknown; readonly verifiedBy?: unknown };
    readonly archives?: Readonly<Record<string, { readonly sha256: string; readonly file: string }>>;
  };
}

/** Why a manifest's signature record is refused, or undefined when it holds; `read` gives a repo file, or undefined. */
function signatureProblem(
  file: string,
  manifest: Manifest,
  read: (path: string) => string | undefined,
): string | undefined {
  const ex = manifest.executable;
  if (ex === undefined) return undefined;
  const sig = ex.signature ?? {};
  if (typeof sig.fingerprint !== 'string' || typeof sig.method !== 'string' || typeof sig.verifiedBy !== 'string')
    return `${file}: executable.signature has no fingerprint, method or verifiedBy`;
  const fpr = sig.fingerprint.replace(/\s/g, '');
  if (!sig.method.includes(`VALIDSIG ${fpr}`))
    return `${file}: executable.signature.method does not record "VALIDSIG ${fpr}"`;
  const output = /(evals\/\S+\.out\.txt)/.exec(sig.verifiedBy)?.[1];
  if (output === undefined)
    return `${file}: executable.signature.verifiedBy names no verification output (evals/….out.txt)`;
  const text = read(output);
  if (text === undefined) return `${file}: ${output}, which verifiedBy names, is not in the repo`;
  if (!/^EXIT=0$/m.test(text)) return `${file}: ${output} does not end EXIT=0`;
  for (const [arch, a] of Object.entries(ex.archives ?? {})) {
    if (!text.includes(`sha256 ${a.sha256} (pinned ${a.sha256})`))
      return `${file}: ${output} does not show ${arch}'s pinned sha256 ${a.sha256}`;
    if (
      !new RegExp(`^verify ${a.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: exit 0; VALIDSIG ${fpr}\\b`, 'm').test(
        text,
      )
    )
      return `${file}: ${output} does not show VALIDSIG ${fpr} for ${a.file}`;
  }
  return undefined;
}

/**
 * A file of the repository; a probe record its copy under tests/fixtures/probes/ (tests/fixtures/README.md), the
 * copy a published clone holds (docs/plans/oss-release.md R12).
 */
const readRepo = (path: string): string | undefined => {
  const file = join(
    ROOT,
    path.startsWith('evals/probes/') ? `tests/fixtures/probes/${path.slice('evals/probes/'.length)}` : path,
  );
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

/** Every module manifest under modules/: one folder each, holding module.json. */
function manifests(): [string, Manifest][] {
  return readdirSync(join(ROOT, 'modules'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `modules/${e.name}/module.json`)
    .map((file) => [file, JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Manifest]);
}

describe('every command plugin records a verified signature by its own key (debt-paydown R6; D50)', () => {
  it('reads every module, and at least the AWS CLI plugin is a command plugin', () => {
    const plugins = manifests()
      .filter(([, m]) => m.executable !== undefined)
      .map(([f]) => f);
    expect(plugins).toContain('modules/aws_cli/module.json');
  });

  it("each command plugin's record names VALIDSIG by its key and a committed run showing it for every pinned archive", () => {
    expect(
      manifests()
        .map(([f, m]) => signatureProblem(f, m, readRepo))
        .filter((p) => p !== undefined),
    ).toEqual([]);
  });

  it('refuses an unverified method, another key, no output, a missing output, a failed run, an archive pinned since, naming the file', () => {
    const fpr = 'FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C';
    const FPR = fpr.replace(/\s/g, '');
    const archives = { aarch64: { sha256: 'a'.repeat(64), file: 'cli-a.zip' } };
    const out = `sha256 ${'a'.repeat(64)} (pinned ${'a'.repeat(64)})\nverify cli-a.zip: exit 0; VALIDSIG ${FPR} \nEXIT=0\n`;
    const at = (method: string, verifiedBy = 'R6: evals/x/run.out.txt', pins = archives) => ({
      executable: { signature: { method, fingerprint: fpr, verifiedBy }, archives: pins },
    });
    const read = (text: string | undefined) => () => text;
    const ok = `gpg: VALIDSIG ${FPR}`;
    expect(signatureProblem('m.json', at(ok), read(out))).toBeUndefined();
    expect(signatureProblem('m.json', at('not verified'), read(out))).toBe(
      `m.json: executable.signature.method does not record "VALIDSIG ${FPR}"`,
    );
    expect(signatureProblem('m.json', at('gpg: VALIDSIG 0000000000000000000000000000000000000000'), read(out))).toBe(
      `m.json: executable.signature.method does not record "VALIDSIG ${FPR}"`,
    );
    expect(signatureProblem('m.json', at(ok, 'nobody yet'), read(out))).toBe(
      'm.json: executable.signature.verifiedBy names no verification output (evals/….out.txt)',
    );
    expect(signatureProblem('m.json', at(ok), read(undefined))).toBe(
      'm.json: evals/x/run.out.txt, which verifiedBy names, is not in the repo',
    );
    expect(signatureProblem('m.json', at(ok), read(out.replace('EXIT=0', 'EXIT=1')))).toBe(
      'm.json: evals/x/run.out.txt does not end EXIT=0',
    );
    expect(
      signatureProblem(
        'm.json',
        at(ok, undefined, { aarch64: { sha256: 'b'.repeat(64), file: 'cli-a.zip' } }),
        read(out),
      ),
    ).toBe(`m.json: evals/x/run.out.txt does not show aarch64's pinned sha256 ${'b'.repeat(64)}`);
    expect(signatureProblem('m.json', at(ok), read(out.replace(`VALIDSIG ${FPR}`, 'BADSIG A6310ACC4672475C')))).toBe(
      `m.json: evals/x/run.out.txt does not show VALIDSIG ${FPR} for cli-a.zip`,
    );
    expect(signatureProblem('m.json', {}, read(out))).toBeUndefined();
  });
});
