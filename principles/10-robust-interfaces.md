# 10. Robust interfaces — depend on contracts, keep implementations clean behind them

**Every cross-cutting capability is an interface; its implementations are
interchangeable adapters injected at one composition root.** Consumers never
know which one they got — code depends on a `ModelClient` contract, never on a
vendor SDK.

- One responsibility per module, in its own folder whose index is its public
  surface; consumers import the index, never an internal file. Export only what
  callers need.
- Depend on the abstract type, not the concrete class.
- **No global state:** no module-level mutable variables, no singletons beyond
  a tested container at the composition root. Request-scoped values (a user id,
  a principal, a token) are parameters — never fields, never captured at
  construction.
- Inputs are one `readonly` props interface. Optional means a documented,
  correct default; no optional flag quietly changes behavior.
- Validate at boundaries only — user input, env vars, external data.
- A published surface (an exported name, an API field, a URL) is a promise;
  weigh the blast radius before renaming it.
- Code that straddles two capabilities belongs in a third, or in the other one —
  escalate rather than couple them silently.

The test: you can replace an implementation without touching a consumer. An
interface earns its place with a real second implementation or test seam (§7).
