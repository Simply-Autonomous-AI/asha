// Registers ts-hooks.mjs before a demo tool or the "decisions" script runs: `node --import ./tools/demos/register.mjs`
// (--experimental-transform-types for a demo tool, --experimental-strip-types for "decisions"). build.mts and
// pack.mts instead call register() directly, since their one need for the hook is a dynamic import partway through
// their own code, after which --import would be too late.
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);
