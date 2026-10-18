// The repository's root, which the pattern tests resolve their files from. The plan's specification of the demos is
// read by pattern-plan.ts, which stays with the plans in the internal repository (docs/plans/oss-release.md R2, R12).

import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
