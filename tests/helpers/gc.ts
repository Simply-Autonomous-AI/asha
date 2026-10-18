// A garbage collection on demand, for a test that must show something survives one (tests/unit/abort.test.ts): V8's
// own `gc`, exposed at run time, since the test runner starts Node without --expose-gc.

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;

/** Five full collections, each followed by a turn of the event loop, so a weakly held object and its timer are gone. */
export async function collectGarbage(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}
