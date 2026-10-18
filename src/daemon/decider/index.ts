// The decision model (docs/plans/decider-tool.md): its contract and the one real adapter, where its parts live, the
// install and removal the CLI runs, the in-use files and their sweep, and how a recipe's decisions become a request and
// an answer. Consumers import this index, never a file inside (PRINCIPLES §10).

export * from './contract.js';
export * from './layout.js';
export * from './install.js';
export * from './in-use.js';
export * from './strands.js';
