import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DefinitionError,
  Definitions,
  ToolSelectionInvalid,
  UnknownImage,
  UnknownRecipe,
  parseCatalogueEntry,
  parseRecipe,
  resolveTools,
} from '../../src/daemon/definitions/index.js';
import { SAVE_FACTS, SAVE_PROCEDURES } from '../../images/memory/src/memory/extract.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import {
  COMMON_TOOL_NAMES,
  ImageManifestInvalid,
  ModuleToolNameInvalid,
  moduleToolWireName,
  parseImageManifest,
  type ImageManifest,
} from '../../src/shared/tools.js';

/** hello-world's one image tool (docs/plans/patterns-phase-2.md R7), as its image.json declares it. */
const HOLD_DECLARATION = {
  name: 'hold',
  description: 'Hold the question: this call waits until it is stopped and returns no result.',
  parameters: { type: 'object', properties: {} },
  class: 'files',
  timeoutMs: 60_000,
};

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const validRecipe = {
  id: 'hello-world',
  image: 'hello-world',
  description: 'Says things.',
  prompt: 'you say things.',
  model: 'm-1',
  startupTimeoutMs: 1000,
  messageTimeoutMs: 2000,
  chat: { temperature: 0 },
  tools: [] as string[],
};

const validEntry = (): {
  kind: string;
  id: string;
  repo: string;
  revision: string;
  weights: string;
  files: { path: string; size: number; sha256: string }[];
  license: { id: string; source: string; verified: string };
  serve: { contextSize: number };
  chat: { [key: string]: unknown };
  toolCallStart?: string;
} => ({
  kind: 'chat',
  id: 'm-1',
  repo: 'Org/Model-GGUF',
  revision: 'a'.repeat(40),
  weights: 'model.gguf',
  files: [
    { path: 'model.gguf', size: 10, sha256: 'b'.repeat(64) },
    { path: 'LICENSE', size: 2, sha256: 'c'.repeat(64) },
  ],
  license: { id: 'apache-2.0', source: 'https://example/LICENSE', verified: '2026-09-26' },
  serve: { contextSize: 2048 },
  chat: { temperature: 0.7 },
  toolCallStart: '<tool_call>\n',
});

describe('parseRecipe', () => {
  it('returns every field of a valid recipe; with no embeddingModel, it has none', () => {
    expect(parseRecipe(validRecipe, 'r.json')).toEqual({
      ...validRecipe,
      persist: [],
      embeddingModel: null,
      documents: [],
      modules: [],
      roots: [],
    });
  });

  it('reads an embeddingModel, and refuses one that is not an id', () => {
    expect(parseRecipe({ ...validRecipe, embeddingModel: 'emb-1' }, 'r.json').embeddingModel).toBe('emb-1');
    expect(() => parseRecipe({ ...validRecipe, embeddingModel: 'Not An Id' }, 'r.json')).toThrow(DefinitionError);
  });

  it.each([
    ['unknown field', { ...validRecipe, extra: 1 }, 'r.json: unknown field extra'],
    [
      'missing field',
      { id: 'x', image: 'y', description: 'd', prompt: 'p', model: 'z', startupTimeoutMs: 1, chat: {} },
      'r.json: missing field messageTimeoutMs',
    ],
    // collaborating-agents R1: the recipe carries the agent's system prompt; no image does.
    [
      'a recipe with no prompt',
      Object.fromEntries(Object.entries(validRecipe).filter(([key]) => key !== 'prompt')),
      'r.json: missing field prompt',
    ],
    ['a recipe with an empty prompt', { ...validRecipe, prompt: '' }, 'r.json: prompt must be a non-empty string'],
    [
      'a recipe with no image',
      { id: 'x', description: 'd', model: 'z', startupTimeoutMs: 1, messageTimeoutMs: 1, chat: {} },
      'r.json: missing field image',
    ],
    [
      'a recipe with no description',
      { id: 'x', image: 'y', model: 'z', startupTimeoutMs: 1, messageTimeoutMs: 1, chat: {} },
      'r.json: missing field description',
    ],
    [
      'a recipe with no chat block',
      { id: 'x', image: 'y', description: 'd', prompt: 'p', model: 'z', startupTimeoutMs: 1, messageTimeoutMs: 1 },
      'r.json: missing field chat',
    ],
    [
      'a chat block setting stream',
      { ...validRecipe, chat: { stream: true } },
      'r.json: chat.stream is set by the harness',
    ],
    // prompt-prefix R9: the per-request fields that change prompt caching or slot choice (llama.cpp 7fe450e19).
    [
      'a chat block setting cache_prompt',
      { ...validRecipe, chat: { cache_prompt: false } },
      "r.json: chat.cache_prompt changes the model server's prompt caching or slot choice",
    ],
    [
      'a chat block setting n_cache_reuse',
      { ...validRecipe, chat: { n_cache_reuse: 256 } },
      "r.json: chat.n_cache_reuse changes the model server's prompt caching or slot choice",
    ],
    [
      'a chat block setting id_slot',
      { ...validRecipe, chat: { id_slot: 0 } },
      "r.json: chat.id_slot changes the model server's prompt caching or slot choice",
    ],
    [
      'a chat block setting message_delimiters',
      { ...validRecipe, chat: { message_delimiters: [] } },
      "r.json: chat.message_delimiters changes the model server's prompt caching or slot choice",
    ],
    ['a chat block that is not an object', { ...validRecipe, chat: [] }, 'r.json: chat must be an object'],
    ['id with a path separator', { ...validRecipe, id: '../x' }, 'r.json: id "../x" does not match'],
    ['an image with a path separator', { ...validRecipe, image: 'a/b' }, 'r.json: image "a/b" does not match'],
    ['zero timeout', { ...validRecipe, startupTimeoutMs: 0 }, 'r.json: startupTimeoutMs must be a positive integer'],
    [
      'fractional timeout',
      { ...validRecipe, messageTimeoutMs: 1.5 },
      'r.json: messageTimeoutMs must be a positive integer',
    ],
    ['not an object', [], 'r.json: top level must be an object'],
  ])('rejects %s', (_, raw, message) => {
    expect(() => parseRecipe(raw, 'r.json')).toThrow(DefinitionError);
    expect(() => parseRecipe(raw, 'r.json')).toThrow(message);
  });
});

const validEmbedding = () => ({
  kind: 'embedding',
  id: 'emb-1',
  repo: 'Org/Emb-GGUF',
  revision: 'a'.repeat(40),
  weights: 'emb.gguf',
  files: [
    { path: 'emb.gguf', size: 10, sha256: 'b'.repeat(64) },
    { path: 'README.md', size: 2, sha256: 'c'.repeat(64) },
  ],
  license: { id: 'apache-2.0', source: 'https://example/blob/rev/README.md', verified: '2026-09-26' },
  serve: { contextSize: 8192, pooling: 'last' },
  embed: { dimensions: 1024, queryTemplate: 'Instruct: find\nQuery:{text}' },
});

describe('parseCatalogueEntry, embedding models', () => {
  it('returns every field of a valid embedding entry', () => {
    expect(parseCatalogueEntry(validEmbedding(), 'e.json')).toEqual(validEmbedding());
  });

  it.each([
    [
      'no kind',
      Object.fromEntries(Object.entries(validEmbedding()).filter(([key]) => key !== 'kind')),
      'e.json: kind must be "chat", "embedding", "decider" or "decider-base"',
    ],
    [
      'an unknown kind',
      { ...validEmbedding(), kind: 'rerank' },
      'kind must be "chat", "embedding", "decider" or "decider-base"',
    ],
    ['chat settings on an embedding model', { ...validEmbedding(), chat: {} }, 'unknown field chat'],
    [
      'a toolCallStart on an embedding model',
      { ...validEmbedding(), toolCallStart: '<tool_call>\n' },
      'unknown field toolCallStart',
    ],
    [
      'an unknown pooling',
      { ...validEmbedding(), serve: { contextSize: 1, pooling: 'max' } },
      'serve.pooling must be "last", "mean" or "cls"',
    ],
    [
      'a query template without {text}',
      { ...validEmbedding(), embed: { dimensions: 1, queryTemplate: 'Query:' } },
      'embed.queryTemplate must contain {text}',
    ],
    ['no dimensions', { ...validEmbedding(), embed: { queryTemplate: '{text}' } }, 'missing field embed.dimensions'],
  ])('rejects %s', (_, raw, message) => {
    expect(() => parseCatalogueEntry(raw, 'e.json')).toThrow(message);
  });
});

describe('parseCatalogueEntry', () => {
  it('returns every field of a valid entry', () => {
    expect(parseCatalogueEntry(validEntry(), 'c.json')).toEqual(validEntry());
  });

  const mutate = (f: (e: ReturnType<typeof validEntry>) => unknown) => {
    const e = validEntry();
    return f(e) ?? e;
  };

  it.each([
    [
      'a branch name as revision',
      mutate((e) => {
        e.revision = 'main';
      }),
      'revision "main" does not match',
    ],
    [
      'a short sha256',
      mutate((e) => {
        present(e.files[0], 'e.files[0]').sha256 = 'abc';
      }),
      'files[0].sha256 "abc" does not match',
    ],
    [
      'a pickle weights file',
      mutate((e) => {
        present(e.files[1], 'e.files[1]').path = 'pytorch_model.bin';
      }),
      'is a pickle format',
    ],
    [
      'a path escaping the repo',
      mutate((e) => {
        present(e.files[1], 'e.files[1]').path = '../etc/passwd';
      }),
      'must be a relative path inside the repo',
    ],
    [
      'an absolute path',
      mutate((e) => {
        present(e.files[1], 'e.files[1]').path = '/etc/passwd';
      }),
      'must be a relative path inside the repo',
    ],
    [
      'weights not among the files',
      mutate((e) => {
        e.weights = 'other.gguf';
      }),
      'weights "other.gguf" is not listed in files',
    ],
    [
      'a duplicate file path',
      mutate((e) => {
        present(e.files[1], 'e.files[1]').path = 'model.gguf';
      }),
      'files contains a duplicate path',
    ],
    [
      'no files',
      mutate((e) => {
        e.files = [];
      }),
      'files must be a non-empty array',
    ],
    [
      'chat setting max_tokens',
      mutate((e) => {
        e.chat = { max_tokens: 5 };
      }),
      'chat.max_tokens is set by the harness',
    ],
    [
      'chat setting model',
      mutate((e) => {
        e.chat = { model: 'x' };
      }),
      'chat.model is set by the harness',
    ],
    [
      'an unknown license field',
      mutate((e) => {
        Object.assign(e.license, { note: 1 });
      }),
      'unknown field license.note',
    ],
    [
      'a malformed verified date',
      mutate((e) => {
        e.license.verified = 'yesterday';
      }),
      'license.verified "yesterday" does not match',
    ],
    [
      'a zero context size',
      mutate((e) => {
        e.serve.contextSize = 0;
      }),
      'serve.contextSize must be a positive integer',
    ],
    [
      'no toolCallStart',
      mutate((e) => {
        delete e.toolCallStart;
      }),
      'missing field toolCallStart',
    ],
    [
      'an empty toolCallStart',
      mutate((e) => {
        e.toolCallStart = '';
      }),
      'toolCallStart must be a non-empty string',
    ],
  ])('rejects %s', (_, raw, message) => {
    expect(() => parseCatalogueEntry(raw, 'c.json')).toThrow(DefinitionError);
    expect(() => parseCatalogueEntry(raw, 'c.json')).toThrow(message);
  });
});

describe('Definitions', () => {
  it('loads the checked-in hello-world recipe, its image and its model', async () => {
    const definitions = new Definitions(REPO_ROOT);
    const recipe = await definitions.recipe('hello-world');
    expect(recipe).toEqual({
      id: 'hello-world',
      image: 'hello-world',
      description: 'Says whatever it is asked to say.',
      prompt:
        'you say what you are asked to say, word for word. That is the only work you do: you cannot translate, write, summarise or look anything up.',
      // The owner moved hello-world to Pico-V2 on 2026-10-12 (8671911); memory stays on qwen3-8b-q4_k_m.
      model: 'pico-v2-q8_0',
      startupTimeoutMs: 60000,
      messageTimeoutMs: 60000,
      chat: { temperature: 0 },
      embeddingModel: null,
      tools: ['list_files', 'read_file', 'write_file', 'append_file', 'blackboard_read', 'blackboard_post'],
      documents: [],
      persist: [],
      modules: [],
      roots: [],
    });
    expect(await definitions.image(recipe.image)).toEqual({
      name: 'hello-world',
      dir: join(REPO_ROOT, 'images', 'hello-world'),
      repository: 'asha-image-hello-world',
      // hello-world's one tool, hold (docs/plans/patterns-phase-2.md R7); no recipe but the watchdog's stuck selects it.
      manifest: { tools: [HOLD_DECLARATION], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
    });
    const model = await definitions.chatModel(recipe.model);
    expect(model.repo).toBe('OculusMindAI/OculusMind-ToolCall-8B-v2');
    expect(model.revision).toBe('3a3d1b36fbfd397e67545786057b0e335a8efffc');
    expect(model.weights).toBe('gguf/Q8_0/model-q8_0.gguf');
    expect(model.chat).toEqual({ temperature: 0 });
    expect(model.toolCallStart).toBe('[TOOL_CALLS]');
  });

  it('reports a missing recipe as UnknownRecipe', async () => {
    await expect(new Definitions(REPO_ROOT).recipe('no-such-recipe')).rejects.toThrow(UnknownRecipe);
  });

  it('reports an image with no Dockerfile as UnknownImage', async () => {
    await expect(new Definitions(REPO_ROOT).image('no-such-image')).rejects.toThrow(UnknownImage);
  });

  it('refuses names that could escape their directory without touching the filesystem', async () => {
    await expect(new Definitions('/nonexistent').recipe('../catalogue/x')).rejects.toThrow(UnknownRecipe);
    await expect(new Definitions('/nonexistent').image('..')).rejects.toThrow(UnknownImage);
  });

  it('rejects a recipe whose id does not match its file name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asha-defs-'));
    await mkdir(join(root, 'recipes'), { recursive: true });
    await writeFile(join(root, 'recipes', 'alpha.json'), JSON.stringify({ ...validRecipe, id: 'beta' }));
    await expect(new Definitions(root).recipe('alpha')).rejects.toThrow(
      'id "beta" does not match its file name "alpha"',
    );
  });

  it('names the file when it is not valid JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asha-defs-'));
    await mkdir(join(root, 'catalogue'), { recursive: true });
    await writeFile(join(root, 'catalogue', 'm-1.json'), '{ not json');
    await expect(new Definitions(root).model('m-1')).rejects.toThrow(/m-1\.json: not valid JSON/);
  });

  it('reports a missing catalogue entry as a DefinitionError naming the id', async () => {
    await expect(new Definitions(REPO_ROOT).model('no-such-model')).rejects.toThrow(
      'catalogue entry "no-such-model" does not exist',
    );
  });

  it('loads the checked-in memory recipe, whose embedding model is the pinned Qwen3-Embedding-0.6B', async () => {
    const definitions = new Definitions(REPO_ROOT);
    const recipe = await definitions.recipe('memory');
    expect([recipe.image, recipe.model, recipe.embeddingModel]).toEqual([
      'memory',
      'qwen3-8b-q4_k_m',
      'qwen3-embedding-0.6b-q8_0',
    ]);
    const embedding = await definitions.embeddingModel(present(recipe.embeddingModel, 'recipe.embeddingModel'));
    expect(embedding.revision).toBe('370f27d7550e0def9b39c1f16d3fbaa13aa67728');
    expect(embedding.files.find((f) => f.path === embedding.weights)?.sha256).toBe(
      '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',
    );
    // No LICENSE file is published: the licence record is the pinned model card (the owner's decision, 2026-09-26).
    expect(embedding.license).toEqual({
      id: 'apache-2.0',
      source: expect.stringMatching(/\/blob\/370f27d7550e0def9b39c1f16d3fbaa13aa67728\/README\.md$/) as string,
      verified: '2026-09-26',
    });
    expect(embedding.files.map((f) => f.path)).toContain('README.md');
    expect(embedding.embed.dimensions).toBe(1024);
    expect(embedding.serve.pooling).toBe('last');
  });

  it('refuses a chat model where an embedding model is needed, and the reverse', async () => {
    const definitions = new Definitions(REPO_ROOT);
    await expect(definitions.embeddingModel('qwen3-8b-q4_k_m')).rejects.toThrow(
      '"qwen3-8b-q4_k_m" is a chat model, not an embedding model',
    );
    await expect(definitions.chatModel('qwen3-embedding-0.6b-q8_0')).rejects.toThrow(
      '"qwen3-embedding-0.6b-q8_0" is an embedding model, not a chat model',
    );
  });
});

/** A manifest entry of a `files` tool, with fields overridden. */
const imageTool = (over: Record<string, unknown> = {}) => ({
  name: 'count_words',
  description: 'Counts the words in a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  class: 'files',
  timeoutMs: 5_000,
  ...over,
});

/** A repo root holding one image with `manifest` (raw) as its image.json, or none when undefined. */
async function imageRoot(manifest: unknown, raw?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'asha-img-'));
  await mkdir(join(root, 'images', 'demo'), { recursive: true });
  await writeFile(join(root, 'images', 'demo', 'Dockerfile'), 'FROM scratch\n');
  if (raw !== undefined) await writeFile(join(root, 'images', 'demo', 'image.json'), raw);
  else if (manifest !== undefined)
    await writeFile(join(root, 'images', 'demo', 'image.json'), JSON.stringify(manifest));
  return root;
}

describe('image manifests (agent-tools R1, R5, R12)', () => {
  it('loads an image with its declared tools', async () => {
    const root = await imageRoot({ tools: [imageTool(), imageTool({ name: 'summarise', timeoutMs: 60_000 })] });
    const image = await new Definitions(root).image('demo');
    expect(image.manifest.tools.map((t) => [t.name, t.class, t.timeoutMs])).toEqual([
      ['count_words', 'files', 5_000],
      ['summarise', 'files', 60_000],
    ]);
  });

  it.each([
    ['missing', undefined, undefined, 'image.json: missing: every image declares its tools here'],
    ['not JSON', undefined, '{ nope', 'image.json: not valid JSON'],
    ['with an unknown top-level key', { tools: [], extra: 1 }, undefined, 'image.json: unknown field extra'],
    ['with no tools list', {}, undefined, 'image.json: missing field tools'],
    [
      'with a services key (R12: none until a plan adds harness services)',
      { tools: [], services: [] },
      undefined,
      'image.json: unknown field services',
    ],
    [
      'with an unknown key on a tool',
      { tools: [imageTool({ command: 'ls' })] },
      undefined,
      'image.json: unknown field tools[0].command',
    ],
    [
      'with a tool missing its timeoutMs',
      { tools: [{ ...imageTool(), timeoutMs: undefined }] },
      undefined,
      'image.json: missing field tools[0].timeoutMs',
    ],
    [
      'with a timeoutMs over 60 s (R5)',
      { tools: [imageTool({ timeoutMs: 60_001 })] },
      undefined,
      'image.json: tools[0].timeoutMs must be an integer in 1..60000',
    ],
    [
      'with an unknown class',
      { tools: [imageTool({ class: 'shell' })] },
      undefined,
      'image.json: tools[0].class must be "files", "command" or "network"',
    ],
    [
      'with a bad tool name',
      { tools: [imageTool({ name: 'count words' })] },
      undefined,
      'image.json: tools[0].name must match',
    ],
    [
      'with a tool declared twice',
      { tools: [imageTool(), imageTool()] },
      undefined,
      'image.json: tools[1].name "count_words" is declared twice',
    ],
    [
      'with a schema keyword outside the subset',
      { tools: [imageTool({ parameters: { type: 'object', properties: {}, additionalProperties: true } })] },
      undefined,
      'image.json: tools[0].unknown field parameters.additionalProperties',
    ],
  ])('fails loading a manifest %s, naming the file and the key (A1, A18)', async (_, manifest, raw, message) => {
    const root = await imageRoot(manifest, raw);
    const error = await new Definitions(root).image('demo').catch((e: unknown) => e);
    expect(error instanceof ImageManifestInvalid || error instanceof DefinitionError).toBe(true);
    expect((error as Error).message).toContain(join(root, 'images', 'demo', 'image.json'));
    expect((error as Error).message).toContain(message);
  });

  it('parses the manifests of every checked-in image', () => {
    const images = readdirSync(join(REPO_ROOT, 'images'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    // suite-erase-fails (agent-persistence A17) and suite-files (agent-files A3, A6, A11, A12) are the agent suite's
    // test-only images, never shipped (tools/release/pack.mts).
    expect(images.toSorted(byCodeUnit)).toEqual(['hello-world', 'memory', 'suite-erase-fails', 'suite-files']);
    for (const name of images) {
      const file = join(REPO_ROOT, 'images', name, 'image.json');
      // Each image's own tools: hello-world's hold (patterns-phase-2 R7), and none for memory.
      expect(parseImageManifest(JSON.parse(readFileSync(file, 'utf8')), file).tools, name).toEqual(
        name === 'hello-world' ? [HOLD_DECLARATION] : [],
      );
    }
    // The memory image's extraction tools are its answer tools, exactly the names its code sends.
    const memory = parseImageManifest(
      JSON.parse(readFileSync(join(REPO_ROOT, 'images', 'memory', 'image.json'), 'utf8')),
      'memory',
    );
    expect(memory.answerTools).toEqual([SAVE_FACTS.function.name, SAVE_PROCEDURES.function.name]);
  });

  it.each([
    ['not a list', { tools: [], answerTools: 'save_facts' }, 'answerTools must be a list of tool names'],
    ['a bad name', { tools: [], answerTools: ['save facts'] }, 'answerTools[0] must match'],
    [
      'a name also a declared tool',
      { tools: [imageTool({ name: 'save_facts' })], answerTools: ['save_facts'] },
      'answerTools[0] "save_facts" is declared twice',
    ],
  ])('refuses answerTools that are %s', async (_, manifest, message) => {
    await expect(new Definitions(await imageRoot(manifest)).image('demo')).rejects.toThrow(message);
  });
});

describe('recipe tools (agent-tools R1, R2, R8, R13)', () => {
  const manifest = (tools: unknown[]): ImageManifest => parseImageManifest({ tools }, 'images/demo/image.json');
  const image = (tools: unknown[] = [imageTool(), imageTool({ name: 'summarise' })]) => ({
    name: 'demo',
    manifest: manifest(tools),
  });
  const resolve = (selected: string[], tools?: unknown[], granted: { module: string; command: string }[] = []) =>
    resolveTools({ recipe: 'demo', selected, image: image(tools), granted });
  const refusal = (run: () => unknown): ToolSelectionInvalid => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolSelectionInvalid);
      return error as ToolSelectionInvalid;
    }
    throw new Error('expected a ToolSelectionInvalid');
  };

  it('selects one of two image tools and read_file; the gateway allows exactly the channel tools and those two (A1)', () => {
    const selection = resolve(['count_words', 'read_file']);
    expect(selection.selected).toEqual(['count_words', 'read_file']);
    expect(selection.granted).toEqual([]);
    expect([...selection.allowed].sort(byCodeUnit)).toEqual([
      'consult',
      'count_words',
      'list_agents',
      'pass',
      'read_file',
      'reply',
      'send_message',
    ]);
  });

  it("admits the image's answer tools at the gateway, never as a selection, and never under another source's name", () => {
    const withAnswers = (answerTools: string[], selected: string[]) =>
      resolveTools({
        recipe: 'demo',
        selected,
        image: {
          name: 'demo',
          manifest: { tools: [], answerTools, keepsMemory: false, eraseUser: false, stateSchema: null },
        },
        granted: [],
      });
    expect([...withAnswers(['save_facts'], ['read_file']).allowed].sort(byCodeUnit)).toEqual([
      'consult',
      'list_agents',
      'pass',
      'read_file',
      'reply',
      'save_facts',
      'send_message',
    ]);
    expect(() => withAnswers(['save_facts'], ['save_facts'])).toThrow('selects tool "save_facts", which neither');
    expect(() => withAnswers(['read_file'], [])).toThrow(
      'tool "read_file" is declared by both the common tools (the agent SDK) and image "demo"\'s answer tools',
    );
  });

  it('refuses a selected name no source declares, naming it (A1)', () => {
    const error = refusal(() => resolve(['read_file', 'launch_rockets']));
    expect(error.problem).toBe('unknown_tool');
    expect(error.message).toBe(
      'recipes/demo.json: selects tool "launch_rockets", which neither image "demo" (images/demo/image.json), the common tools, the selectable channel tools nor the decide tool declare',
    );
  });

  it('selects reply_with_files as it selects a common tool, the gateway admitting it; an image may not declare it (agent-files R12)', () => {
    const selection = resolve(['reply_with_files', 'read_file']);
    expect(selection.selected).toEqual(['reply_with_files', 'read_file']);
    expect([...selection.allowed].sort(byCodeUnit)).toEqual([
      'consult',
      'list_agents',
      'pass',
      'read_file',
      'reply',
      'reply_with_files',
      'send_message',
    ]);
    // Unselected, the gateway refuses it as any unselected tool.
    expect(resolve(['read_file']).allowed.has('reply_with_files')).toBe(false);
    const error = refusal(() => resolve([], [imageTool({ name: 'reply_with_files' })]));
    expect(error.message).toBe(
      'recipes/demo.json: tool "reply_with_files" is declared by both the selectable channel tools (the agent SDK) and image "demo" (images/demo/image.json)',
    );
  });

  it('refuses an image tool named like a common tool or a channel tool, naming both sources (A1)', () => {
    for (const [name, other] of [
      ['read_file', 'the common tools (the agent SDK)'],
      ['reply', 'the channel tools'],
    ] as const) {
      const error = refusal(() => resolve([], [imageTool({ name })]));
      expect(error.problem).toBe('name_conflict');
      expect(error.message).toBe(
        `recipes/demo.json: tool "${name}" is declared by both ${other} and image "demo" (images/demo/image.json)`,
      );
    }
  });

  it('refuses a module grant whose wire name another source already has, naming both', () => {
    const error = refusal(() =>
      resolve([], [imageTool({ name: 'web__search' })], [{ module: 'web', command: 'search' }]),
    );
    expect(error.message).toBe(
      'recipes/demo.json: tool "web__search" is declared by both image "demo" (images/demo/image.json) and module grant web/search',
    );
  });

  it.each(['command', 'network'])(
    'refuses a selected image tool of class %s, naming the tool and the plugin form (A12)',
    (toolClass) => {
      const error = refusal(() => resolve(['run_it'], [imageTool({ name: 'run_it', class: toolClass })]));
      expect(error.problem).toBe('class_forbidden');
      expect(error.message).toContain(
        `selects tool "run_it", which image "demo" (images/demo/image.json) declares with class "${toolClass}"`,
      );
      expect(error.message).toContain('make it a harness plugin module (docs/plans/extension-modules.md R28–R33)');
    },
  );

  it('counts selected and granted tools against 11, naming each count and the limit (A2)', () => {
    const imageTools = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'].map((name) => imageTool({ name }));
    const ten = [...COMMON_TOOL_NAMES.slice(0, 2), ...imageTools.map((t) => t.name)];
    const grants = [
      { module: 'web', command: 'search' },
      { module: 'web', command: 'fetch' },
      { module: 'aws', command: 's3_list' },
    ];
    const error = refusal(() => resolve(ten, imageTools, grants));
    expect(error.problem).toBe('too_many_tools');
    expect(error.message).toBe(
      'recipes/demo.json: selects 10 tools and grants 3 module tools: 13, over the limit of 11 (16 per model request, less 5 reserved for the 5 channel tools)',
    );
    // 8 selected and 3 granted is exactly the limit: allowed, the module tools by their wire names.
    const fits = resolve(ten.slice(0, 8), imageTools, grants);
    expect(fits.granted).toEqual(['web__search', 'web__fetch', 'aws__s3_list']);
    expect(fits.allowed.size).toBe(5 + 8 + 3);
  });

  it('names a module command whose wire name would pass 64 characters, or does not match the pattern (A2)', () => {
    expect(moduleToolWireName('web', 'search')).toBe('web__search');
    const module = 'm'.repeat(30);
    const command = 'c'.repeat(33); // 30 + 2 + 33 = 65
    expect(() => resolve([], [], [{ module, command }])).toThrow(ModuleToolNameInvalid);
    expect(() => resolve([], [], [{ module, command }])).toThrow(
      `module tool ${module}/${command}: its wire name ${module}__${command} is 65 characters, over 64`,
    );
    expect(moduleToolWireName(module, 'c'.repeat(32))).toHaveLength(64);
    expect(() => moduleToolWireName('Web', 'search')).toThrow('the module name must match');
    expect(() => moduleToolWireName('web', 'se/arch')).toThrow('the command name must match');
  });

  it('refuses a recipe tools list that is missing, not a list of names, or names a tool twice', () => {
    const noTools = Object.fromEntries(Object.entries(validRecipe).filter(([key]) => key !== 'tools'));
    expect(() => parseRecipe(noTools, 'r.json')).toThrow('r.json: missing field tools');
    expect(() => parseRecipe({ ...validRecipe, tools: 'read_file' }, 'r.json')).toThrow(
      'r.json: tools must be a list of tool names',
    );
    expect(() => parseRecipe({ ...validRecipe, tools: ['read file'] }, 'r.json')).toThrow(
      'r.json: tools must be a list of tool names',
    );
    expect(() => parseRecipe({ ...validRecipe, tools: ['read_file', 'read_file'] }, 'r.json')).toThrow(
      'r.json: tools names "read_file" twice',
    );
  });

  it('both existing recipes, and hello-router, select all six common tools, which their images serve (R8)', async () => {
    const definitions = new Definitions(REPO_ROOT);
    for (const id of ['hello-world', 'memory', 'hello-router']) {
      const recipe = await definitions.recipe(id);
      expect(recipe.tools, id).toEqual([...COMMON_TOOL_NAMES]);
      const selection = resolveTools({
        recipe: id,
        selected: recipe.tools,
        image: await definitions.image(recipe.image),
        granted: [],
      });
      expect(selection.selected).toEqual([...COMMON_TOOL_NAMES]);
    }
  });
});

describe('the catalogue guard (agent-tools A9)', () => {
  it('every checked-in catalogue entry parses, and its id is its file name', () => {
    for (const file of readdirSync(join(REPO_ROOT, 'catalogue')).filter((f) => f.endsWith('.json'))) {
      const entry = parseCatalogueEntry(JSON.parse(readFileSync(join(REPO_ROOT, 'catalogue', file), 'utf8')), file);
      expect(`${entry.id}.json`).toBe(file);
    }
  });
});

describe('the decision model in the catalogue (docs/plans/decider-tool.md R1, A1)', () => {
  const ADAPTER_ID = 'strands-decider-2b-hobson-v19';
  const BASE_ID = 'qwen3.5-2b-base';
  const adapterRaw = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(REPO_ROOT, 'catalogue', `${ADAPTER_ID}.json`), 'utf8')) as Record<string, unknown>;
  const baseRaw = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(REPO_ROOT, 'catalogue', `${BASE_ID}.json`), 'utf8')) as Record<string, unknown>;

  /** A catalogue folder holding the given entries, by id. */
  async function catalogue(entries: Record<string, unknown>): Promise<Definitions> {
    const root = await mkdtemp(join(tmpdir(), 'asha-decider-catalogue-'));
    await mkdir(join(root, 'catalogue'));
    for (const [id, entry] of Object.entries(entries))
      await writeFile(join(root, 'catalogue', `${id}.json`), JSON.stringify(entry));
    return new Definitions(root);
  }

  it('the two checked-in entries parse, pinned exactly as R1 gives them, and the adapter names its base', async () => {
    const { adapter, base } = await new Definitions(REPO_ROOT).decider(ADAPTER_ID);
    expect(adapter.kind).toBe('decider');
    expect([adapter.repo, adapter.revision, adapter.base]).toEqual([
      'StrandsAgents/strands-decider-2B-hobson-v19',
      'bb282d786bc251fd4e3068de3ada9ddbb38127cd',
      BASE_ID,
    ]);
    expect(adapter.files.map((f) => f.path)).toEqual([
      'hobson_config.json',
      'head.safetensors',
      'lora/adapter_config.json',
      'lora/adapter_model.safetensors',
      'tokenizer.json',
      'tokenizer_config.json',
      'LICENSE.md',
      'README.md',
    ]);
    expect(adapter.license).toEqual({
      id: 'apache-2.0',
      source:
        'https://huggingface.co/StrandsAgents/strands-decider-2B-hobson-v19/blob/bb282d786bc251fd4e3068de3ada9ddbb38127cd/LICENSE.md',
      verified: '2026-10-03',
    });
    expect(base.kind).toBe('decider-base');
    expect([base.repo, base.revision]).toEqual(['Qwen/Qwen3.5-2B-Base', 'b1485b2fa6dfa1287294f269f5fb618e03d52d7c']);
    expect(base.files.map((f) => f.path)).toEqual([
      'config.json',
      'model.safetensors-00001-of-00001.safetensors',
      'model.safetensors.index.json',
      'LICENSE',
      'README.md',
    ]);
    expect(base.license).toEqual({
      id: 'apache-2.0',
      source: 'https://huggingface.co/Qwen/Qwen3.5-2B-Base/blob/b1485b2fa6dfa1287294f269f5fb618e03d52d7c/LICENSE',
      verified: '2026-10-03',
    });
    // The probes' pinned weights (P0): the Hub's sha256 for each LFS file at its revision. Each digest is written
    // before its file's name, so no file name (`tokenizer.json`) reads to a secret scanner as a key naming a value
    // (docs/plans/oss-release.md R6: the test's values are built so no rule matches, never allowed by a list).
    expect(
      [...adapter.files, ...base.files]
        .filter((f) => f.size > 1_000_000)
        .map((f) => ({ sha256: f.sha256, path: f.path }))
        .sort((x, y) => byCodeUnit(x.path, y.path)),
    ).toEqual([
      { sha256: 'daad0727152b6185447cee36f78230c144312feb7b19f02749b19645238b5287', path: 'head.safetensors' },
      {
        sha256: '701bdb895887097f7954ec7eb06f7937d3b790035b5462195eb26abd80a4aebc',
        path: 'lora/adapter_model.safetensors',
      },
      {
        sha256: '928acbf11878c32185bbd863514d191769285065ab9ea14fbfe431303f5fdf2d',
        path: 'model.safetensors-00001-of-00001.safetensors',
      },
      { sha256: 'a2cdd2e108566b09079afa8d266e9e65e7c280f27b771218237a06de5ba9cd86', path: 'tokenizer.json' },
    ]);
  });

  it('a decider whose base names no entry, or an entry of another kind, fails loading, naming both', async () => {
    const missing = await catalogue({ [ADAPTER_ID]: adapterRaw() });
    await expect(missing.decider(ADAPTER_ID)).rejects.toThrow(
      `catalogue/${ADAPTER_ID}.json: decider "${ADAPTER_ID}" names base "${BASE_ID}", which is no decider-base entry:`,
    );
    const chat = await catalogue({ [ADAPTER_ID]: adapterRaw(), [BASE_ID]: { ...validEntry(), id: BASE_ID } });
    await expect(chat.decider(ADAPTER_ID)).rejects.toThrow(
      `catalogue/${ADAPTER_ID}.json: decider "${ADAPTER_ID}" names base "${BASE_ID}", which is a chat entry, not a decider-base entry`,
    );
    const both = await catalogue({ [ADAPTER_ID]: adapterRaw(), [BASE_ID]: baseRaw() });
    await expect(both.decider(ADAPTER_ID)).resolves.toMatchObject({
      adapter: { id: ADAPTER_ID },
      base: { id: BASE_ID },
    });
  });

  it('a file without its sha256, and a pickle file, each fail naming the file and the field', () => {
    const noSha = adapterRaw();
    (noSha['files'] as Record<string, unknown>[])[1] = { path: 'head.safetensors', size: 4213224 };
    expect(() => parseCatalogueEntry(noSha, 'd.json')).toThrow('d.json: missing field files[1].sha256');
    const pickle = baseRaw();
    (pickle['files'] as Record<string, unknown>[])[1] = { path: 'pytorch_model.bin', size: 1, sha256: 'a'.repeat(64) };
    expect(() => parseCatalogueEntry(pickle, 'b.json')).toThrow(
      'b.json: files[1].path "pytorch_model.bin" is a pickle format; only GGUF or safetensors weights are allowed',
    );
    expect(() => parseCatalogueEntry({ ...adapterRaw(), base: 'Not An Id' }, 'd.json')).toThrow(
      'd.json: base "Not An Id" does not match',
    );
    const noBase = Object.fromEntries(Object.entries(adapterRaw()).filter(([key]) => key !== 'base'));
    expect(() => parseCatalogueEntry(noBase, 'd.json')).toThrow('d.json: missing field base');
    expect(() => parseCatalogueEntry({ ...baseRaw(), base: BASE_ID }, 'b.json')).toThrow('b.json: unknown field base');
  });

  it('chatModel and embeddingModel refuse both kinds, naming the kind, so llama-server is never given one', async () => {
    const definitions = new Definitions(REPO_ROOT);
    await expect(definitions.chatModel(ADAPTER_ID)).rejects.toThrow(
      `catalogue/${ADAPTER_ID}.json: "${ADAPTER_ID}" is a decider model, not a chat model`,
    );
    await expect(definitions.chatModel(BASE_ID)).rejects.toThrow(
      `catalogue/${BASE_ID}.json: "${BASE_ID}" is a decider-base model, not a chat model`,
    );
    await expect(definitions.embeddingModel(ADAPTER_ID)).rejects.toThrow(
      `catalogue/${ADAPTER_ID}.json: "${ADAPTER_ID}" is a decider model, not an embedding model`,
    );
    await expect(definitions.embeddingModel(BASE_ID)).rejects.toThrow(
      `catalogue/${BASE_ID}.json: "${BASE_ID}" is a decider-base model, not an embedding model`,
    );
    await expect(definitions.decider('qwen3-8b-q4_k_m')).rejects.toThrow(
      'catalogue/qwen3-8b-q4_k_m.json: "qwen3-8b-q4_k_m" is a chat model, not a decider',
    );
  });
});

describe("a recipe's decisions (docs/plans/decider-tool.md R10, A10)", () => {
  const choice = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'choice',
    question: 'Which desk?',
    options: { billing: 'money', technical: 'bugs' },
    minConfidence: 0.5,
    ...extra,
  });
  const checks = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'checks',
    checks: { day: { question: 'A day?', yes: 'names a day', no: 'names none' } },
    yesAt: 0.5,
    ...extra,
  });
  const deciding = (decisions: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...validRecipe,
    tools: ['decide'],
    messageTimeoutMs: 155_000,
    decisions,
    ...extra,
  });
  const parse = (raw: Record<string, unknown>) => parseRecipe(raw, 'teams/t/triage.json');
  const refused = (raw: Record<string, unknown>, message: string) => {
    expect(() => parse(raw), message).toThrow(`teams/t/triage.json: ${message}`);
  };
  const names = (n: number, prefix = 'o'): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${String(i)}`, 'm']));
  const decisionsOf = (recipe: ReturnType<typeof parse>): Readonly<Record<string, unknown>> =>
    present(recipe.decisions, 'recipe.decisions');

  it('parses a choice and a set of checks, kept in the recipe order', () => {
    const recipe = parse(deciding({ specialist: choice(), complete: checks() }));
    expect(recipe.decisions).toEqual({
      specialist: {
        kind: 'choice',
        question: 'Which desk?',
        options: { billing: 'money', technical: 'bugs' },
        minConfidence: 0.5,
      },
      complete: {
        kind: 'checks',
        checks: { day: { question: 'A day?', yes: 'names a day', no: 'names none' } },
        yesAt: 0.5,
      },
    });
    expect(Object.keys(decisionsOf(recipe))).toEqual(['specialist', 'complete']);
    expect(parse({ ...validRecipe }).decisions).toBeUndefined();
  });

  it('crosses every limit at its edge: one past it fails, naming the recipe file and the field', () => {
    // 1 and 8 decisions pass; 0 and 9 fail.
    expect(Object.keys(decisionsOf(parse(deciding({ d: choice() }))))).toEqual(['d']);
    expect(
      Object.keys(
        decisionsOf(
          parse(deciding(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`d${String(i)}`, choice()])))),
        ),
      ),
    ).toHaveLength(8);
    refused(deciding({}), 'decisions must hold 1 to 8 decisions, not 0');
    refused(
      deciding(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`d${String(i)}`, choice()]))),
      'decisions must hold 1 to 8 decisions, not 9',
    );
    // Names: 32 characters pass, 33 and a capital fail.
    expect(Object.keys(decisionsOf(parse(deciding({ [`a${'b'.repeat(31)}`]: choice() }))))).toEqual([
      `a${'b'.repeat(31)}`,
    ]);
    refused(deciding({ [`a${'b'.repeat(32)}`]: choice() }), `decisions.a${'b'.repeat(32)}: the name must match`);
    refused(deciding({ Billing: choice() }), 'decisions.Billing: the name must match');
    // A question of 300 passes, 301 fails.
    expect(decisionsOf(parse(deciding({ d: choice({ question: 'q'.repeat(300) }) })))['d']).toMatchObject({
      question: 'q'.repeat(300),
    });
    refused(
      deciding({ d: choice({ question: 'q'.repeat(301) }) }),
      'decisions.d.question must be a string of 1 to 300 characters',
    );
    // 2 and 24 options pass; 1 and 25 fail.
    expect(
      Object.keys(
        (decisionsOf(parse(deciding({ d: choice({ options: names(2) }) })))['d'] as { options: object }).options,
      ),
    ).toHaveLength(2);
    expect(
      Object.keys(
        (decisionsOf(parse(deciding({ d: choice({ options: names(24) }) })))['d'] as { options: object }).options,
      ),
    ).toHaveLength(24);
    refused(deciding({ d: choice({ options: names(1) }) }), 'decisions.d.options must hold 2 to 24 options, not 1');
    refused(deciding({ d: choice({ options: names(25) }) }), 'decisions.d.options must hold 2 to 24 options, not 25');
    // A meaning of 200 passes, 201 fails; an option named unsure fails.
    expect(decisionsOf(parse(deciding({ d: choice({ options: { a: 'm'.repeat(200), b: 'n' } }) })))['d']).toMatchObject(
      { options: { a: 'm'.repeat(200) } },
    );
    refused(
      deciding({ d: choice({ options: { a: 'm'.repeat(201), b: 'n' } }) }),
      'decisions.d.options.a must be a string of 1 to 200 characters',
    );
    refused(
      deciding({ d: choice({ options: { unsure: 'm', b: 'n' } }) }),
      'decisions.d.options names "unsure", the answer reserved for a choice below its minConfidence',
    );
    // minConfidence and yesAt: 0 and 1 pass, −0.1 and 1.1 fail.
    for (const v of [0, 1]) {
      expect(decisionsOf(parse(deciding({ d: choice({ minConfidence: v }) })))['d']).toMatchObject({
        minConfidence: v,
      });
      expect(decisionsOf(parse(deciding({ d: checks({ yesAt: v }) })))['d']).toMatchObject({ yesAt: v });
    }
    for (const v of [-0.1, 1.1]) {
      refused(deciding({ d: choice({ minConfidence: v }) }), 'decisions.d.minConfidence must be a number from 0 to 1');
      refused(deciding({ d: checks({ yesAt: v }) }), 'decisions.d.yesAt must be a number from 0 to 1');
    }
    // 1 and 8 checks pass; 0 and 9 fail.
    const check = { question: 'q?', yes: 'y', no: 'n' };
    const someChecks = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${String(i)}`, check]));
    expect(
      Object.keys(
        (decisionsOf(parse(deciding({ d: checks({ checks: someChecks(1) }) })))['d'] as { checks: object }).checks,
      ),
    ).toHaveLength(1);
    expect(
      Object.keys(
        (decisionsOf(parse(deciding({ d: checks({ checks: someChecks(8) }) })))['d'] as { checks: object }).checks,
      ),
    ).toHaveLength(8);
    refused(deciding({ d: checks({ checks: {} }) }), 'decisions.d.checks must hold 1 to 8 checks, not 0');
    refused(deciding({ d: checks({ checks: someChecks(9) }) }), 'decisions.d.checks must hold 1 to 8 checks, not 9');
    // A check's question, yes and no: 300 pass, 301 fail.
    for (const field of ['question', 'yes', 'no'] as const) {
      expect(
        decisionsOf(parse(deciding({ d: checks({ checks: { c: { ...check, [field]: 'x'.repeat(300) } } }) })))['d'],
      ).toMatchObject({ checks: { c: { [field]: 'x'.repeat(300) } } });
      refused(
        deciding({ d: checks({ checks: { c: { ...check, [field]: 'x'.repeat(301) } } }) }),
        `decisions.d.checks.c.${field} must be a string of 1 to 300 characters`,
      );
    }
  });

  it('decide and decisions come together, a closed schema, and messageTimeoutMs of at least 155,000 ms', () => {
    refused(
      { ...validRecipe, tools: ['decide'], messageTimeoutMs: 155_000 },
      'tools names decide, so decisions must declare what it may decide',
    );
    refused({ ...validRecipe, decisions: { d: choice() } }, 'decisions is declared, so tools must name decide');
    refused(
      deciding({ d: choice() }, { messageTimeoutMs: 154_999 }),
      'messageTimeoutMs 154999 is under 155000: a recipe selecting decide needs its 30,000 ms call bound plus 125,000 ms for the turn around it',
    );
    expect(parse(deciding({ d: choice() }, { messageTimeoutMs: 155_000 })).messageTimeoutMs).toBe(155_000);
    refused(deciding({ d: choice({ extra: 1 }) }), 'unknown field decisions.d.extra');
    refused(
      deciding({ d: { kind: 'choice', question: 'q', options: { a: 'm', b: 'n' } } }),
      'missing field decisions.d.minConfidence',
    );
    refused(deciding({ d: { kind: 'score' } }), 'decisions.d.kind must be "choice" or "checks"');
    refused(
      deciding({ d: checks({ checks: { c: { question: 'q', yes: 'y' } } }) }),
      'missing field decisions.d.checks.c.no',
    );
    refused(deciding([choice()]), 'decisions must be an object');
  });

  it('decide is a selectable tool, counted with the others (agent-tools R2)', () => {
    const image = {
      name: 'hello-world',
      manifest: {
        tools: [],
        answerTools: [],
        keepsMemory: false,
        eraseUser: false,
        stateSchema: null,
      } as ImageManifest,
    };
    const selection = resolveTools({ recipe: 'triage', selected: ['read_file', 'decide'], image, granted: [] });
    expect(selection.selected).toEqual(['read_file', 'decide']);
    expect(selection.allowed.has('decide')).toBe(true);
    expect(() =>
      resolveTools({
        recipe: 'triage',
        selected: ['decide'],
        image: { ...image, manifest: { ...image.manifest, tools: [{ ...HOLD_DECLARATION, name: 'decide' } as never] } },
        granted: [],
      }),
    ).toThrow('tool "decide" is declared by both');
  });
});
