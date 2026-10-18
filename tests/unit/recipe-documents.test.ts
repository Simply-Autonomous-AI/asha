// A recipe's documents (docs/plans/collaborating-agents.md R2, R3, R12; A1, A10):
// the schema, the checks made when its agent is launched, and the system
// message they become.

import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  GUIDANCE_PRECEDENCE,
  channelInstructions,
  channelTurn,
  callInstructions,
  withGuidance,
} from '../../src/agent-sdk/index.js';
import {
  DefinitionError,
  DocumentMissing,
  DocumentNotText,
  DocumentOutsideFolder,
  DocumentsNeedFileTools,
  DocumentsOverWorkspace,
  DocumentsTooLarge,
  guidanceOf,
  loadDocuments,
  parseRecipe,
  type Recipe,
} from '../../src/daemon/definitions/index.js';
import { present } from '../../src/shared/assert-present.js';
import type { ConversationMessage } from '../../src/shared/protocol.js';

const FILE_TOOLS = ['list_files', 'read_file', 'write_file', 'append_file'];
const base = {
  id: 'guided',
  image: 'hello-world',
  description: 'Follows its guidance.',
  prompt: 'you follow your guidance.',
  model: 'm-1',
  startupTimeoutMs: 1000,
  messageTimeoutMs: 2000,
  chat: { temperature: 0 },
  tools: FILE_TOOLS,
};

describe('a recipe names documents (R2, R3)', () => {
  it('parses each document with its path and whether it is full-text, in order', () => {
    const recipe = parseRecipe(
      {
        ...base,
        documents: [
          { path: 'guidance.md', fullText: true },
          { path: 'flows/steps.md', fullText: false },
        ],
      },
      'r.json',
    );
    expect(recipe.documents).toEqual([
      { path: 'guidance.md', fullText: true },
      { path: 'flows/steps.md', fullText: false },
    ]);
  });

  it('a path of exactly 100 bytes is accepted (101 is refused, below)', () => {
    const path = `${'x'.repeat(97)}.md`;
    expect(Buffer.byteLength(path)).toBe(100);
    expect(parseRecipe({ ...base, documents: [{ path, fullText: false }] }, 'r.json').documents).toEqual([
      { path, fullText: false },
    ]);
  });

  it('a recipe without documents has none, and needs no file tools', () => {
    expect(parseRecipe({ ...base, tools: [] }, 'r.json').documents).toEqual([]);
    expect(parseRecipe({ ...base, tools: [], documents: [] }, 'r.json').documents).toEqual([]);
  });

  it.each([
    ['all four missing', [], 'list_files, read_file, write_file, append_file'],
    ['append_file missing', ['list_files', 'read_file', 'write_file'], 'append_file'],
    ['only the blackboard', ['blackboard_read'], 'list_files, read_file, write_file, append_file'],
  ])(
    'names documents without the four file tools (%s): DocumentsNeedFileTools naming the recipe and each missing tool',
    (_, tools, missing) => {
      const raw = { ...base, tools, documents: [{ path: 'guidance.md', fullText: true }] };
      expect(() => parseRecipe(raw, 'teams/t/guided.json')).toThrow(DocumentsNeedFileTools);
      expect(() => parseRecipe(raw, 'teams/t/guided.json')).toThrow(
        `teams/t/guided.json: recipe guided names documents, so it must select the four file tools; it does not select ${missing}`,
      );
    },
  );

  it.each([
    '../outside.md',
    '/etc/motd.md',
    '.hidden.md',
    'a/.hidden.md',
    'notes.txt',
    'a//b.md',
    'a/../b.md',
    `${'x'.repeat(98)}.md`,
    'sp ace.md',
  ])('refuses the path "%s"', (path) => {
    expect(() => parseRecipe({ ...base, documents: [{ path, fullText: false }] }, 'r.json')).toThrow(
      `r.json: documents[0].path "${path}" must be a relative path to a .md file inside the recipe's folder`,
    );
  });

  it.each([
    [
      'not a list',
      { path: 'a.md', fullText: true },
      'r.json: documents must be a list of {"path", "fullText"} (omit it for none)',
    ],
    [
      'fullText not a boolean',
      [{ path: 'a.md', fullText: 'yes' }],
      'r.json: documents[0].fullText must be true or false',
    ],
    ['a missing fullText', [{ path: 'a.md' }], 'r.json: missing field documents[0].fullText'],
    ['an unknown field', [{ path: 'a.md', fullText: true, mode: 1 }], 'r.json: unknown field documents[0].mode'],
    [
      'one path twice',
      [
        { path: 'a.md', fullText: true },
        { path: 'a.md', fullText: false },
      ],
      'r.json: documents names "a.md" twice',
    ],
  ])('refuses %s', (_, documents, message) => {
    expect(() => parseRecipe({ ...base, documents }, 'r.json')).toThrow(DefinitionError);
    expect(() => parseRecipe({ ...base, documents }, 'r.json')).toThrow(message);
  });
});

describe('loadDocuments: read and checked at launch, before any container starts (R2, R12)', () => {
  let folder: string;
  const recipe = (documents: Recipe['documents']): Recipe =>
    parseRecipe({ ...base, documents }, join(folder, 'guided.json'));
  const load = (documents: Recipe['documents']) =>
    loadDocuments({ recipe: recipe(documents), file: join(folder, 'guided.json'), folder });
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'asha-docs-'));
    await mkdir(join(folder, 'flows'));
    await writeFile(join(folder, 'guidance.md'), '1. Reply with the words.\n');
    await writeFile(join(folder, 'flows', 'steps.md'), 'Step one.\n');
  });

  it("reads every document from the recipe's folder, in the recipe's order, with its path under /workspace", async () => {
    expect(
      await load([
        { path: 'flows/steps.md', fullText: false },
        { path: 'guidance.md', fullText: true },
      ]),
    ).toEqual([
      { path: 'flows/steps.md', fullText: false, content: Buffer.from('Step one.\n') },
      { path: 'guidance.md', fullText: true, content: Buffer.from('1. Reply with the words.\n') },
    ]);
  });

  it('a missing document: DocumentMissing naming the recipe file and the document', async () => {
    const error = await load([{ path: 'gone.md', fullText: true }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentMissing);
    expect((error as Error).message).toBe(
      `${join(folder, 'guided.json')}: document "gone.md" does not exist in the recipe's folder`,
    );
  });

  it("a link to a file outside the recipe's folder: DocumentOutsideFolder", async () => {
    const outside = await mkdtemp(join(tmpdir(), 'asha-outside-'));
    await writeFile(join(outside, 'secret.md'), 'not yours\n');
    await symlink(join(outside, 'secret.md'), join(folder, 'linked.md'));
    const error = await load([{ path: 'linked.md', fullText: true }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentOutsideFolder);
    expect((error as Error).message).toContain(`document "linked.md" resolves to `);
    expect((error as Error).message).toContain('outside');
  });

  it('a link inside the folder is read through', async () => {
    await symlink(join(folder, 'guidance.md'), join(folder, 'alias.md'));
    expect(await load([{ path: 'alias.md', fullText: false }])).toEqual([
      { path: 'alias.md', fullText: false, content: Buffer.from('1. Reply with the words.\n') },
    ]);
  });

  it('a directory named like a document is not a document', async () => {
    await mkdir(join(folder, 'dir.md'));
    await expect(load([{ path: 'dir.md', fullText: false }])).rejects.toThrow(
      `document "dir.md" is not a regular file`,
    );
  });

  it('full-text documents of exactly 8,192 bytes together load; 8,193 fail with DocumentsTooLarge naming the recipe, the total and the limit (A10)', async () => {
    await writeFile(join(folder, 'a.md'), 'a'.repeat(4096));
    await writeFile(join(folder, 'b.md'), 'b'.repeat(4096));
    expect(
      await load([
        { path: 'a.md', fullText: true },
        { path: 'b.md', fullText: true },
      ]),
    ).toHaveLength(2);
    await writeFile(join(folder, 'b.md'), 'b'.repeat(4097));
    const error = await load([
      { path: 'a.md', fullText: true },
      { path: 'b.md', fullText: true },
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentsTooLarge);
    expect(error).toMatchObject({ recipe: 'guided', total: 8193, limit: 8192 });
    expect((error as Error).message).toBe(
      'recipe guided: its full-text documents total 8193 bytes, over the limit of 8192 bytes',
    );
  });

  it('a large document that is not full-text does not count toward the 8 KiB', async () => {
    await writeFile(join(folder, 'big.md'), 'x'.repeat(100_000));
    expect(
      (
        await load([
          { path: 'big.md', fullText: false },
          { path: 'guidance.md', fullText: true },
        ])
      ).map((d) => d.content.byteLength),
    ).toEqual([100_000, 25]);
  });

  it('a path whose parent is a file, not a folder: DocumentMissing (ENOTDIR), naming it', async () => {
    const error = await load([{ path: 'guidance.md/inner.md', fullText: false }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentMissing);
    expect((error as Error).message).toBe(
      `${join(folder, 'guided.json')}: document "guidance.md/inner.md" does not exist in the recipe's folder`,
    );
  });

  it("exactly /workspace's 256 files load; exactly 16 MiB loads, one byte more fails with DocumentsOverWorkspace", async () => {
    const many = Array.from({ length: 256 }, (_, i) => ({ path: `d${String(i)}.md`, fullText: false }));
    for (const d of many) await writeFile(join(folder, d.path), 'x');
    expect(await load(many)).toHaveLength(256);
    await writeFile(join(folder, 'huge.md'), Buffer.alloc(16 * 1024 * 1024 - 25, 0x78));
    const full = [
      { path: 'huge.md', fullText: false },
      { path: 'guidance.md', fullText: false },
    ];
    expect((await load(full)).reduce((n, d) => n + d.content.byteLength, 0)).toBe(16 * 1024 * 1024);
    await writeFile(join(folder, 'huge.md'), Buffer.alloc(16 * 1024 * 1024 - 24, 0x78));
    const error = await load(full).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentsOverWorkspace);
    expect((error as Error).message).toBe(
      "recipe guided: its 2 documents of 16777217 bytes are over /workspace's bound of 256 files and 16777216 bytes",
    );
  });

  it("more documents than /workspace's 256 files: DocumentsOverWorkspace", async () => {
    const many = Array.from({ length: 257 }, (_, i) => ({ path: `d${String(i)}.md`, fullText: false }));
    for (const d of many) await writeFile(join(folder, d.path), 'x');
    const error = await load(many).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentsOverWorkspace);
    expect((error as Error).message).toBe(
      "recipe guided: its 257 documents of 257 bytes are over /workspace's bound of 256 files and 16777216 bytes",
    );
  });

  it('guidanceOf: the full-text documents as text, in order; one that is not UTF-8 fails naming it', async () => {
    const loaded = await load([
      { path: 'flows/steps.md', fullText: false },
      { path: 'guidance.md', fullText: true },
    ]);
    expect(guidanceOf('guided.json', loaded)).toEqual([{ path: 'guidance.md', text: '1. Reply with the words.\n' }]);
    await writeFile(join(folder, 'bad.md'), Buffer.from([0x66, 0xff, 0xfe]));
    const bad = await load([{ path: 'bad.md', fullText: true }]);
    expect(() => guidanceOf('guided.json', bad)).toThrow(DocumentNotText);
    expect(() => guidanceOf('guided.json', bad)).toThrow('guided.json: full-text document "bad.md" is not UTF-8 text');
  });
});

describe('the system message: the instructions, then each full-text document (R2, A1)', () => {
  const guidance = [
    { path: 'guidance.md', text: '1. Call consult.\n2. Reply.\n' },
    { path: 'flows/b.md', text: 'B.' },
  ];
  const message = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
    id: 'm1',
    channel: 'main',
    conversation: 'm1',
    user: 'user-1',
    from: 'user-1',
    to: 'lead-1',
    kind: 'input',
    text: 'Go.',
    at: '2026-09-29T00:00:00.000Z',
    ...over,
  });

  it('holds the prompt in the instructions, then each document under a line naming it, in order', () => {
    const turn = channelTurn({
      handle: 'lead-1',
      others: ['worker-1'],
      persona: { role: 'you lead.', guidance, tools: [] },
      message: message(),
      maxTokens: 64,
      memory: '',
    });
    const system = present(turn.messages[0], 'turn.messages[0]').content;
    expect(system).toBe(
      `${channelInstructions('lead-1', ['worker-1'], 'you lead.')}\n\n${GUIDANCE_PRECEDENCE}\n\nYour guidance, from guidance.md in your workspace:\n1. Call consult.\n2. Reply.\n\n\nYour guidance, from flows/b.md in your workspace:\nB.`,
    );
    // The guidance wins over the general lines, said once, before the first document (patterns-phase-1 R7, A6).
    expect(GUIDANCE_PRECEDENCE).toBe(
      'Your guidance below comes from your recipe: where it says what to do, do that, even where the general lines above say otherwise.',
    );
    expect(system.indexOf(GUIDANCE_PRECEDENCE)).toBeGreaterThan(system.indexOf('Your role: you lead.'));
    expect(system.indexOf(GUIDANCE_PRECEDENCE)).toBeLessThan(system.indexOf('Your guidance, from guidance.md'));
    expect(system.split(GUIDANCE_PRECEDENCE)).toHaveLength(2);
    expect(system.indexOf('Your role: you lead.')).toBeLessThan(system.indexOf('1. Call consult.'));
    expect(system.indexOf('1. Call consult.')).toBeLessThan(system.indexOf('B.'));
  });

  it("a call's question carries the guidance too, after the call instructions", () => {
    const turn = channelTurn({
      handle: 'worker-1',
      others: ['lead-1'],
      persona: { role: 'you work.', guidance, tools: [] },
      message: message({ from: 'lead-1', to: 'worker-1', kind: 'internal', call: { id: 'k', role: 'question' } }),
      maxTokens: 64,
      memory: '',
    });
    expect(present(turn.messages[0], 'turn.messages[0]').content).toBe(
      withGuidance(callInstructions('lead-1', 'you work.'), guidance),
    );
    expect(present(turn.messages[0], 'turn.messages[0]').content).toContain(
      'Your guidance, from guidance.md in your workspace:\n1. Call consult.',
    );
  });

  it('with no documents it is the instructions alone, byte for byte (so a recipe without documents is unchanged)', () => {
    expect(withGuidance('I.', [])).toBe('I.');
    expect(withGuidance(channelInstructions('hewo-1', ['hewo-2'], 'you say things.'), [])).toBe(
      channelInstructions('hewo-1', ['hewo-2'], 'you say things.'),
    );
  });
});
