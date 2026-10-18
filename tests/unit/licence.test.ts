// The licence file (docs/project/index.md#licence; docs/plans/oss-release.md R25, R28). LICENSE embeds the PolyForm
// Noncommercial and PolyForm Small Business texts byte for byte, as fetched from the PolyForm project's repository at
// commit 76a278c402bc43b8d2b561da140b0f3e17263015 on 2026-10-11, and carries exactly one line beginning
// `Required Notice:` outside them (each text quotes an example in a `>` block): the copyright, naming the holder that
// package.json's author names, and the indemnity condition both licences' Notices section carries to every recipient
// (the owner's answer of 2026-10-12, record harness-licence-indemnity, option b).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const LICENSE = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
/** The line between the two texts. */
const SEPARATOR = `\n${'-'.repeat(80)}\n\n`;
const NONCOMMERCIAL = {
  title: '# PolyForm Noncommercial License 1.0.0\n',
  sha256: 'c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5',
};
const SMALL_BUSINESS = {
  title: '# PolyForm Small Business License 1.0.0\n',
  sha256: '03eea824bff13316b767424b3e8f49538b46e52d897aecc87d6344343364aa56',
};
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The embedded text from its title line to the separator after it, or to the end of the file. */
function embedded(title: string): string {
  const start = LICENSE.indexOf(title);
  if (start < 0) throw new Error(`LICENSE does not hold the text titled ${JSON.stringify(title.trim())}`);
  const end = LICENSE.indexOf(SEPARATOR, start);
  return end < 0 ? LICENSE.slice(start) : LICENSE.slice(start, end);
}

describe('LICENSE', () => {
  it('embeds the PolyForm Noncommercial License 1.0.0 verbatim', () => {
    expect(
      sha256(embedded(NONCOMMERCIAL.title)),
      'the PolyForm Noncommercial text in LICENSE differs from the one fetched',
    ).toBe(NONCOMMERCIAL.sha256);
  });

  it("embeds the PolyForm Small Business License 1.0.0 verbatim, as the file's tail", () => {
    const text = embedded(SMALL_BUSINESS.title);
    expect(sha256(text), 'the PolyForm Small Business text in LICENSE differs from the one fetched').toBe(
      SMALL_BUSINESS.sha256,
    );
    expect(LICENSE.endsWith(text)).toBe(true);
  });

  it('carries two Required Notice lines, the copyright naming the holder package.json names as author, then the indemnity condition', () => {
    const notices = LICENSE.split('\n').filter((line) => line.startsWith('Required Notice:'));
    expect(notices).toEqual([
      'Required Notice: Copyright © 2026 SimplyAutonomous.AI, LLC (https://simplyautonomous.ai)',
      'Required Notice: It is a condition of your licence, under either licence, that if you distribute the software, or changes or new works based on it, and offer support, a warranty, an indemnity or any other liability obligation with it, you do so only on your own behalf and on your sole responsibility, never on behalf of SimplyAutonomous.AI, LLC, and only if you agree to indemnify, defend and hold SimplyAutonomous.AI, LLC harmless for any liability incurred by it, or claim asserted against it, because you offered that obligation.',
    ]);
    const author = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { author: string }).author;
    expect(author.replace(/ <[^>]+>$/, '')).toBe('SimplyAutonomous.AI, LLC');
    expect(notices[0]).toContain(author.replace(/ <[^>]+>$/, ''));
  });

  it('is named in package.json as a custom licence, since its condition is more than an SPDX expression says', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { license: string };
    expect(pkg.license).toBe('SEE LICENSE IN LICENSE');
  });
});
