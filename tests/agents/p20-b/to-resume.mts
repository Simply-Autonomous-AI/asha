// p20-b's recorded run 1 (at 2d94dc1, when its member was A8's teams/resume-tasks/supervisor) rewritten for its move
// into teams/resume/ as `tasker` (docs/plans/patterns-phase-5.md R13): exactly these substitutions, nothing else —
// the identity main/resume-tasks/supervisor → main/resume/tasker; the relaunch's stdout, which printed the one member's
// handle, now the team's three before the replies; and each command's arguments as the page's block gives them (the
// tasks to tasker-1 as alice, the launch team=resume). tests/unit/p20-checker.test.ts asserts that this script's output
// is the committed recorded-run-1.json.
//
//   node --experimental-strip-types tests/agents/p20-b/to-resume.mts > tests/agents/p20-b/recorded-run-1.json
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The recorded run's shape, read as JSON: only the fields this rewrite touches are typed; everything else rides
// through the spreads below untouched.
interface DaemonLogEntry {
  identity: string;
}

interface RecordedCommand {
  label: string;
  args: string[];
  stdout: string;
}

interface RecordedRun {
  source?: Record<string, unknown>;
  daemonLog: DaemonLogEntry[];
  commands: RecordedCommand[];
}

export function toResume(original: unknown): unknown {
  const f = JSON.parse(JSON.stringify(original)) as RecordedRun;
  f.source = {
    ...f.source,
    rewritten:
      "by to-resume.mts for patterns-phase-5 R13: identity main/resume/tasker, the relaunch's three handles, the block's arguments",
  };
  f.daemonLog = f.daemonLog.map((x) =>
    x.identity === 'main/resume-tasks/supervisor' ? { ...x, identity: 'main/resume/tasker' } : x,
  );
  f.commands = f.commands.map((c) => {
    if (c.label === 'relaunch')
      return {
        ...c,
        args: ['--launch', 'team=resume'],
        stdout: c.stdout.replace(/^supervisor-1\n/, 'supervisor-1\nworker-1\ntasker-1\n'),
      };
    const i = /^task-(\d)$/.exec(c.label)?.[1];
    return { ...c, args: ['--verbose', 'to=tasker-1', 'user=alice', `message=do task ${String(i)}`] };
  });
  return f;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const original: unknown = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'recorded-run-1-resume-tasks.json'), 'utf8'),
  );
  process.stdout.write(`${JSON.stringify(toResume(original), null, 1)}\n`);
}
