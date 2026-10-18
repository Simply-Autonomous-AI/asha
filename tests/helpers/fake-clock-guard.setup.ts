// The unit and integration suites' second setup file: a timed-out test cannot move the next test's fake clock.
import { installFakeClockGuard } from './fake-clock-guard.js';

installFakeClockGuard();
