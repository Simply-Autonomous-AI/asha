// The dependency guard (docs/plans/otel-traces.md R8, A5): the harness's only
// runtime dependencies are the four OpenTelemetry packages the owner approved
// (2026-09-27), and every package they bring is pinned, hashed, free of
// install scripts, permissively licensed, and has its licence on record in
// the durable docs. The agent images never run npm or reach the network.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';

const REPO = resolve(import.meta.dirname, '..', '..');

/** R8: exactly these direct dependencies, at these versions. */
const APPROVED: Readonly<Record<string, string>> = {
  '@opentelemetry/api': '1.9.1',
  '@opentelemetry/core': '2.11.0',
  '@opentelemetry/exporter-trace-otlp-http': '0.222.0',
  '@opentelemetry/sdk-trace': '2.11.0',
};

/** The permissive licences the owner set for modules (extension-modules R26). */
const PERMISSIVE = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD'];

/** Where each package's licence is recorded: a table row on the Architecture page's logs section. */
const LICENCE_PAGE = 'docs/architecture/index.md';
const LICENCE_ROW =
  /^\| `(@[a-z0-9-]+\/[a-z0-9.-]+|[a-z0-9.-]+)` \| (\S+) \| (\S+) \| \[LICENSE\]\((https:\/\/\S+)\) \| (\d{4}-\d{2}-\d{2}) \|.*$/gm;

interface LockEntry {
  version?: string;
  integrity?: string;
  license?: string;
  dev?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
}

interface Inputs {
  readonly manifest: { dependencies?: Record<string, string> };
  readonly lock: { packages: Record<string, LockEntry> };
  readonly licencePage: string;
  readonly dockerfiles: Readonly<Record<string, string>>;
}

function readInputs(): Inputs {
  const images = readdirSync(join(REPO, 'images'), { withFileTypes: true }).filter((d) => d.isDirectory());
  return {
    manifest: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Inputs['manifest'],
    lock: JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as Inputs['lock'],
    licencePage: readFileSync(join(REPO, LICENCE_PAGE), 'utf8'),
    dockerfiles: Object.fromEntries(
      images.map((d) => [
        `images/${d.name}/Dockerfile`,
        readFileSync(join(REPO, 'images', d.name, 'Dockerfile'), 'utf8'),
      ]),
    ),
  };
}

/** The direct dependencies: none unapproved, and every approved one pinned exactly. */
function directDependencyProblems(manifest: Inputs['manifest']): string[] {
  const problems: string[] = [];
  const direct = manifest.dependencies ?? {};
  for (const name of Object.keys(direct))
    if (!(name in APPROVED)) problems.push(`${name}: a dependency R8 does not approve`);
  for (const [name, version] of Object.entries(APPROVED)) {
    if (direct[name] !== version)
      problems.push(`${name}: package.json must pin exactly ${version}, not ${JSON.stringify(direct[name])}`);
  }
  return problems;
}

/**
 * The closure: every package under node_modules/@opentelemetry/, and everything those reach through dependencies;
 * and the one problem the walk itself finds, a dependency missing from package-lock.json.
 */
function expandClosure(packages: Record<string, LockEntry>): { closure: Set<string>; problems: string[] } {
  const problems: string[] = [];
  const closure = new Set(Object.keys(packages).filter((p) => p.startsWith('node_modules/@opentelemetry/')));
  for (const path of [...closure]) {
    for (const name of Object.keys(present(packages[path], path).dependencies ?? {})) {
      const nested = `${path}/node_modules/${name}`;
      const found = packages[nested] !== undefined ? nested : `node_modules/${name}`;
      if (packages[found] === undefined) problems.push(`${name}: needed by ${path} but not in package-lock.json`);
      else closure.add(found);
    }
  }
  return { closure, problems };
}

/** Every licence row of the Architecture page's logs section, by `<name>@<version>`. */
function licenceRows(licencePage: string): Map<string, { version: string; licence: string; url: string }> {
  const rows = new Map<string, { version: string; licence: string; url: string }>();
  for (const m of licencePage.matchAll(LICENCE_ROW)) {
    const name = present(m[1], 'the licence row name');
    const version = present(m[2], 'the licence row version');
    const licence = present(m[3], 'the licence row licence');
    const url = present(m[4], 'the licence row URL');
    rows.set(`${name}@${version}`, { version, licence, url });
  }
  return rows;
}

/** The problems of one closure member: an inexact version, a missing hash, an install script, dev, licence, or its row. */
function closureEntryProblems(
  path: string,
  packages: Record<string, LockEntry>,
  rows: Map<string, { version: string; licence: string; url: string }>,
): string[] {
  const problems: string[] = [];
  const entry = present(packages[path], path);
  const name = path.replace(/^.*node_modules\//, '');
  const id = `${name}@${String(entry.version)}`;
  if (!/^\d+\.\d+\.\d+$/.test(entry.version ?? ''))
    problems.push(`${name}: version ${JSON.stringify(entry.version)} in package-lock.json is not exact`);
  if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-'))
    problems.push(`${id}: no sha512 integrity hash in package-lock.json`);
  if (entry.hasInstallScript === true) problems.push(`${id}: has an install script`);
  if (entry.dev === true) problems.push(`${id}: marked dev, but it is in the agents' production closure`);
  if (!PERMISSIVE.includes(entry.license ?? ''))
    problems.push(`${id}: licence ${JSON.stringify(entry.license)} is not on the permissive list`);
  const row = rows.get(id);
  if (row === undefined) problems.push(`${id}: no licence row on ${LICENCE_PAGE}`);
  else if (row.licence !== entry.license)
    problems.push(`${id}: ${LICENCE_PAGE} records ${row.licence}, package-lock.json ${String(entry.license)}`);
  return problems;
}

/** Every build that runs npm or reaches the network. */
function dockerfileProblems(dockerfiles: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(dockerfiles)) {
    for (const line of text.split('\n')) {
      if (/^RUN.*\b(npm|npx|curl|wget)\b/.test(line))
        problems.push(`${file}: an image build must not run npm or reach the network: ${line}`);
    }
  }
  return problems;
}

/** Every rule of the guard; each problem names the package or file. */
function dependencyProblems(inputs: Inputs): string[] {
  const packages = inputs.lock.packages;
  const { closure, problems: closureWalkProblems } = expandClosure(packages);
  const rows = licenceRows(inputs.licencePage);
  return [
    ...directDependencyProblems(inputs.manifest),
    ...closureWalkProblems,
    ...[...closure].sort(byCodeUnit).flatMap((path) => closureEntryProblems(path, packages, rows)),
    ...dockerfileProblems(inputs.dockerfiles),
  ];
}

describe('the dependency guard (R8)', () => {
  it('finds no problem in this repo', () => {
    expect(dependencyProblems(readInputs())).toEqual([]);
  });

  it("covers exactly the eleven installed packages of the plan's Justification table", () => {
    const { lock } = readInputs();
    expect(
      Object.keys(lock.packages)
        .filter((p) => p.startsWith('node_modules/@opentelemetry/'))
        .sort(byCodeUnit),
    ).toEqual(
      [
        'api',
        'api-logs',
        'core',
        'exporter-trace-otlp-http',
        'otlp-exporter-base',
        'otlp-transformer',
        'resources',
        'sdk-logs',
        'sdk-metrics',
        'sdk-trace',
        'semantic-conventions',
      ].map((n) => `node_modules/@opentelemetry/${n}`),
    );
    expect(Object.keys(lock.packages)).not.toContain('node_modules/@opentelemetry/sdk-trace-base');
  });

  // Each way the guard must fail, run against a copy of the real inputs with one thing broken (PRINCIPLES §3).
  const broken = (change: (inputs: Inputs) => unknown): string[] => {
    const inputs = structuredClone(readInputs());
    change(inputs);
    return dependencyProblems(inputs);
  };

  it.each([
    [
      'a range on a direct dependency',
      (i: Inputs): unknown =>
        (present(i.manifest.dependencies, 'manifest.dependencies')['@opentelemetry/sdk-trace'] = '^2.11.0'),
      '@opentelemetry/sdk-trace: package.json must pin exactly 2.11.0, not "^2.11.0"',
    ],
    [
      'a missing integrity',
      (i: Inputs): unknown =>
        delete present(
          i.lock.packages['node_modules/@opentelemetry/resources'],
          'node_modules/@opentelemetry/resources',
        ).integrity,
      '@opentelemetry/resources@2.11.0: no sha512 integrity hash',
    ],
    [
      'an install script',
      (i: Inputs): unknown =>
        (present(
          i.lock.packages['node_modules/@opentelemetry/otlp-transformer'],
          'node_modules/@opentelemetry/otlp-transformer',
        ).hasInstallScript = true),
      '@opentelemetry/otlp-transformer@0.222.0: has an install script',
    ],
    [
      'a GPL licence',
      (i: Inputs): unknown =>
        (present(
          i.lock.packages['node_modules/@opentelemetry/sdk-logs'],
          'node_modules/@opentelemetry/sdk-logs',
        ).license = 'GPL-3.0'),
      '@opentelemetry/sdk-logs@0.222.0: licence "GPL-3.0" is not on the permissive list',
    ],
    [
      'a deleted licence row',
      (i: Inputs): unknown =>
        ((i as { licencePage: string }).licencePage = i.licencePage.replace(/^\| `@opentelemetry\/api-logs` .*$/m, '')),
      '@opentelemetry/api-logs@0.222.0: no licence row',
    ],
    [
      'a range in the lockfile',
      (i: Inputs): unknown =>
        (present(i.lock.packages['node_modules/@opentelemetry/core'], 'node_modules/@opentelemetry/core').version =
          '^2.11.0'),
      '@opentelemetry/core: version "^2.11.0" in package-lock.json is not exact',
    ],
    [
      'a dev entry in the closure',
      (i: Inputs): unknown =>
        (present(
          i.lock.packages['node_modules/@opentelemetry/semantic-conventions'],
          'node_modules/@opentelemetry/semantic-conventions',
        ).dev = true),
      '@opentelemetry/semantic-conventions@1.43.0: marked dev',
    ],
    [
      'an unapproved dependency',
      (i: Inputs): unknown => (present(i.manifest.dependencies, 'manifest.dependencies')['left-pad'] = '1.3.0'),
      'left-pad: a dependency R8 does not approve',
    ],
    [
      'a licence row that disagrees',
      (i: Inputs): unknown =>
        ((i as { licencePage: string }).licencePage = i.licencePage.replace(
          /^(\| `@opentelemetry\/core` \| 2\.11\.0 \| )Apache-2\.0/m,
          '$1MIT',
        )),
      '@opentelemetry/core@2.11.0: docs/architecture/index.md records MIT, package-lock.json Apache-2.0',
    ],
    [
      'an image that runs npm',
      (i: Inputs): unknown => {
        const dockerfiles = i.dockerfiles as Record<string, string>;
        dockerfiles['images/hello-world/Dockerfile'] =
          `${present(dockerfiles['images/hello-world/Dockerfile'], 'images/hello-world/Dockerfile')}RUN npm install\n`;
        return undefined;
      },
      'images/hello-world/Dockerfile: an image build must not run npm or reach the network: RUN npm install',
    ],
  ] as const)('fails on %s, naming the package or file', (_, change, problem) => {
    const problems = broken(change);
    expect(
      problems.filter((p) => p.startsWith(problem)),
      problems.join('\n'),
    ).toHaveLength(1);
  });
});
