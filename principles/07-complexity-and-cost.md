# 7. Complexity and cost — bias toward simplicity, reuse, and fewer moving parts

**Choose simplifying, reusing or extending over adding moving parts,
infrastructure, services or cost. Every time.** In order:

1. Use what exists, as-is.
2. Extend an existing component — a parameter, a case, an adapter behind an
   existing interface.
3. Simplify something so it covers the new case too.
4. Only then add a component, **justified in writing first:** the closest
   existing thing, the concrete reason it cannot be reused, and its monthly and
   operational cost.

A new part is a permanent obligation; removing one is a first-class win.
**Anything that adds recurring spend** — a service, a paid call per request,
more tokens per turn, longer retention — **needs a written estimate (unit cost ×
volume = monthly) and explicit approval before it is built or bought.** Reach
for the zero-cost design first. "We might need it later" is not a reason.
