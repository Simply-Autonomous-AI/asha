// The module manifest's closed schema (docs/plans/extension-modules.md R2, R10 (b), R11, R20, R28, R31; A2, A6, A10,
// A11, A20, A26), RFC 8785 (R12), and the visible escapes (R12 (b)).

import { describe, expect, it } from 'vitest';

import { canonicalJson, NotCanonicalizable } from '../../src/shared/jcs.js';
import {
  hostAllowed,
  hostProblem,
  ManifestInvalid,
  offeredTools,
  parseModuleManifest,
  providerModelIdProblem,
} from '../../src/shared/modules.js';
import { present } from '../../src/shared/assert-present.js';
import { moduleToolWireName } from '../../src/shared/tools.js';
import { hasInvisible, visible } from '../../src/shared/visible.js';
import {
  cloudToolManifest,
  pluginManifest,
  PROVIDER_MODEL,
  providerManifest,
  toolModuleManifest,
} from '../helpers/modules.js';

function refused(raw: unknown): ManifestInvalid {
  try {
    parseModuleManifest(raw, 'module.json');
  } catch (error) {
    if (error instanceof ManifestInvalid) return error;
    throw error;
  }
  throw new Error('the manifest was accepted');
}

describe('module manifest (R2)', () => {
  it('accepts a valid manifest of each kind', () => {
    expect(parseModuleManifest(toolModuleManifest(), 'm').kind).toBe('ToolModule');
    expect(parseModuleManifest(cloudToolManifest(), 'm').kind).toBe('ToolModule');
    expect(parseModuleManifest(providerManifest(), 'm').kind).toBe('ModelProvider');
    expect(parseModuleManifest(pluginManifest(), 'm').kind).toBe('CommandTool');
  });

  for (const field of ['id', 'kind', 'version', 'entry', 'files', 'licence', 'hosts', 'secrets', 'cost', 'tools']) {
    it(`refuses a manifest missing ${field}, naming the module and the field`, () => {
      const raw = toolModuleManifest();
      Reflect.deleteProperty(raw, field);
      const error = refused(raw);
      expect(error.field).toBe(field);
      // Before the id is read the file names the module; after, the id does.
      expect(error.module).toBe(field === 'id' || field === 'kind' ? 'module.json' : 'fixture_tool');
    });
  }

  it('refuses an unknown field, naming it', () => {
    expect(refused(toolModuleManifest({ services: [] })).field).toBe('services');
    expect(refused(toolModuleManifest({ cost: { model: 'free', capUsd: 1 } })).field).toBe('cost.capUsd');
  });

  it('refuses a per-file list that names module.json, or .asha-install.json, or a path beginning with "."', () => {
    const named = (path: string) =>
      refused({
        ...toolModuleManifest(),
        files: { ...(toolModuleManifest()['files'] as object), [path]: 'c'.repeat(64) },
      });
    expect(named('module.json').message).toContain('names module.json');
    expect(named('.asha-install.json').message).toMatch(/never beginning with "\."|installer's own record/);
    expect(named('node_modules/.package-lock.json').field).toBe('files["node_modules/.package-lock.json"]');
    expect(named('../x').field).toBe('files["../x"]');
  });

  it("refuses an id holding '-' (tavily-search), naming the field, and an id whose directory differs", () => {
    const error = refused(toolModuleManifest({ id: 'tavily-search' }));
    expect(error.field).toBe('id');
    expect(error.message).toContain('"tavily-search"');
    expect(() => parseModuleManifest(toolModuleManifest(), 'm', 'other')).toThrow(
      /does not match its directory's name "other"/,
    );
  });

  it('gives each reference module and plugin tool its wire name (R24, R27; finding 1)', () => {
    expect(moduleToolWireName('tavily', 'search')).toBe('tavily__search');
    expect(moduleToolWireName('aws_cli', 'codepipeline_get_state')).toBe('aws_cli__codepipeline_get_state');
    expect(moduleToolWireName('aws_cli', 'codepipeline_retry_stage')).toBe('aws_cli__codepipeline_retry_stage');
    expect(() => moduleToolWireName('tavily-search', 'search')).toThrow(/must match/);
  });
});

describe('tool classes (R11, A11)', () => {
  it('refuses a cloud module whose tool lacks egress, naming the tool', () => {
    const raw = cloudToolManifest();
    present((raw['tools'] as Record<string, unknown>[])[0], 'tools[0]')['classes'] = ['untrusted-input'];
    const error = refused(raw);
    expect(error.field).toBe('tools[0].classes');
    expect(error.message).toContain('tool search');
    expect(error.message).toContain('"egress"');
  });

  it('refuses a class outside the closed set, naming it', () => {
    const raw = toolModuleManifest();
    present((raw['tools'] as Record<string, unknown>[])[0], 'tools[0]')['classes'] = ['dangerous'];
    expect(refused(raw).message).toContain('"dangerous" is not one of untrusted-input, egress, consequential');
  });

  it('refuses a consequential tool of a module that lists no host, naming the tool', () => {
    const raw = toolModuleManifest();
    present((raw['tools'] as Record<string, unknown>[])[0], 'tools[0]')['classes'] = ['consequential'];
    const error = refused(raw);
    expect(error.field).toBe('tools[0].classes');
    expect(error.message).toContain('tool lookup is "consequential" but the module lists no host');
  });
});

describe('descriptions enter the prompt (R10 (b), A10)', () => {
  const withTool = (patch: Record<string, unknown>) => {
    const raw = toolModuleManifest();
    const tool = present((raw['tools'] as Record<string, unknown>[])[0], 'tools[0]');
    (raw['tools'] as Record<string, unknown>[])[0] = { ...tool, ...patch };
    return raw;
  };

  it('refuses a 513-byte tool description and accepts 512', () => {
    expect(refused(withTool({ description: 'a'.repeat(513) })).message).toContain('is 513 bytes, over the 512');
    expect(() => parseModuleManifest(withTool({ description: 'a'.repeat(512) }), 'm')).not.toThrow();
  });

  it('refuses a 201-byte parameter description and accepts 200', () => {
    const params = (d: string) => ({
      parameters: { type: 'object', properties: { word: { type: 'string', description: d } } },
    });
    const error = refused(withTool(params('b'.repeat(201))));
    expect(error.field).toBe('tools[0].parameters.properties.word.description');
    expect(error.message).toContain('201 bytes');
    expect(() => parseModuleManifest(withTool(params('b'.repeat(200))), 'm')).not.toThrow();
  });

  it('refuses a description holding U+202E or U+200B, naming the character', () => {
    expect(refused(withTool({ description: 'Look up\u202e.' })).message).toContain('\\u202e');
    expect(refused(withTool({ description: 'Look\u200bup.' })).message).toContain('\\u200b');
  });
});

describe('hosts (R6 (c), A6)', () => {
  it('refuses *.amazonaws.com and *.com and accepts *.s3.us-east-1.amazonaws.com', () => {
    expect(hostProblem('*.amazonaws.com')).toContain('at least three labels');
    expect(hostProblem('*.com')).toContain('at least three labels');
    expect(hostProblem('*.s3.us-east-1.amazonaws.com')).toBeUndefined();
    expect(refused(cloudToolManifest({ hosts: ['*.amazonaws.com'] })).message).toContain('"*.amazonaws.com"');
  });

  it('matches a wildcard against exactly one more label, and a name exactly', () => {
    const entries = ['*.s3.us-east-1.amazonaws.com', 'api.tavily.com'];
    expect(hostAllowed('bucket.s3.us-east-1.amazonaws.com', entries)).toBe(true);
    expect(hostAllowed('a.b.s3.us-east-1.amazonaws.com', entries)).toBe(false);
    expect(hostAllowed('s3.us-east-1.amazonaws.com', entries)).toBe(false);
    expect(hostAllowed('API.TAVILY.COM', entries)).toBe(true);
    expect(hostAllowed('evil-api.tavily.com', entries)).toBe(false);
  });

  it('refuses an address in place of a name', () => {
    expect(hostProblem('1.1.1.1')).toContain('address');
  });
});

describe('provider models (R20, A20)', () => {
  for (const id of [
    'latest',
    'mistral.latest',
    'us.mistral.ministral-3-8b-instruct',
    'global.x',
    'arn:aws:bedrock:us-east-1::foundation-model/x',
  ]) {
    it(`refuses the id ${id}, naming the field`, () => {
      const error = refused(providerManifest({ models: [{ ...PROVIDER_MODEL, id }] }));
      expect(error.field).toBe('models[0].id');
      expect(error.message).toContain('R20');
    });
  }

  it('accepts mistral.ministral-3-8b-instruct', () => {
    expect(providerModelIdProblem('mistral.ministral-3-8b-instruct')).toBeUndefined();
  });

  for (const field of ['card', 'launched', 'terms', 'retention', 'prices']) {
    it(`refuses a model lacking ${field}`, () => {
      const model: Record<string, unknown> = { ...PROVIDER_MODEL };
      Reflect.deleteProperty(model, field);
      expect(refused(providerManifest({ models: [model] })).field).toBe(`models[0].${field}`);
    });
  }

  it('refuses a model whose terms or retention lacks its date', () => {
    expect(
      refused(providerManifest({ models: [{ ...PROVIDER_MODEL, terms: { url: 'https://x.example/t' } }] })).field,
    ).toBe('models[0].terms.read');
    expect(
      refused(providerManifest({ models: [{ ...PROVIDER_MODEL, retention: { url: 'https://x.example/r' } }] })).field,
    ).toBe('models[0].retention.read');
  });

  it('refuses a chat default outside temperature and top_p', () => {
    expect(refused(providerManifest({ models: [{ ...PROVIDER_MODEL, chat: { top_k: 5 } }] })).field).toBe(
      'models[0].chat.top_k',
    );
  });
});

describe('command plugins (R28, R31, A26)', () => {
  it('refuses a manifest without the archives map, or an entry lacking its URL, sha256 or file name', () => {
    const p = pluginManifest();
    const ex = p['executable'] as Record<string, unknown>;
    const without = (patch: Record<string, unknown>) => refused({ ...p, executable: { ...ex, ...patch } });
    const noArchives = { ...ex };
    delete noArchives['archives'];
    expect(refused({ ...p, executable: noArchives }).field).toBe('executable.archives');
    for (const key of ['url', 'sha256', 'file']) {
      const entry: Record<string, unknown> = { url: 'https://example.test/a', sha256: 'a'.repeat(64), file: 'a.tar' };
      Reflect.deleteProperty(entry, key);
      expect(without({ archives: { aarch64: entry } }).field).toBe(`executable.archives.aarch64.${key}`);
    }
    expect(
      without({ archives: { riscv64: { url: 'https://example.test/a', sha256: 'a'.repeat(64), file: 'a.tar' } } })
        .field,
    ).toBe('executable.archives.riscv64');
  });

  it('refuses a manifest without the signature record', () => {
    const p = pluginManifest();
    const ex = { ...(p['executable'] as Record<string, unknown>) };
    delete ex['signature'];
    expect(refused({ ...p, executable: ex }).field).toBe('executable.signature');
  });

  for (const file of ['../x', 'Dockerfile', 'module.json']) {
    it(`refuses the archive file name ${file}, naming the field`, () => {
      const p = pluginManifest();
      const ex = p['executable'] as Record<string, unknown>;
      const error = refused({
        ...p,
        executable: { ...ex, archives: { aarch64: { url: 'https://example.test/a', sha256: 'a'.repeat(64), file } } },
      });
      expect(error.field).toBe('executable.archives.aarch64.file');
    });
  }

  it('refuses a command without a schema, or with a timeoutMs over 600,000', () => {
    const p = pluginManifest();
    const commands = p['commands'] as Record<string, unknown>[];
    const command0 = present(commands[0], 'commands[0]');
    const noSchema = { ...command0 };
    delete noSchema['arguments'];
    expect(refused({ ...p, commands: [noSchema] }).field).toBe('commands[0].arguments');
    expect(refused({ ...p, commands: [{ ...command0, timeoutMs: 600_001 }] }).field).toBe('commands[0].timeoutMs');
    expect(() => parseModuleManifest({ ...p, commands: [{ ...command0, timeoutMs: 600_000 }] }, 'm')).not.toThrow();
  });

  it('refuses a string pattern that is not anchored or matches a leading "-"', () => {
    const p = pluginManifest();
    const commands = p['commands'] as Record<string, unknown>[];
    const command0 = present(commands[0], 'commands[0]');
    const withPattern = (pattern: string) => ({
      ...p,
      commands: [{ ...command0, arguments: { name: { type: 'string', pattern, description: 'x' } } }],
    });
    expect(refused(withPattern('[a-z]+')).message).toContain('anchored');
    expect(refused(withPattern('^.*$')).message).toContain('beginning with "-"');
  });

  it('refuses a cost model other than external-unmetered', () => {
    expect(refused(pluginManifest({ cost: { model: 'free' } })).field).toBe('cost.model');
  });

  it('offers each command as one tool, its arguments as JSON Schema', () => {
    const tools = offeredTools(parseModuleManifest(pluginManifest(), 'm'));
    expect(tools.map((t) => t.name)).toEqual(['get_state', 'retry_stage']);
    expect(present(tools[1], 'tools[1]').parameters).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The pipeline' },
        stage: { type: 'string', enum: ['build', 'deploy'], description: 'The stage' },
      },
      required: ['name', 'stage'],
    });
  });
});

describe('RFC 8785 (R12)', () => {
  it('sorts members by UTF-16 code units, prints numbers as ECMAScript does, and escapes as JSON', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x\u001b'], '€': 1e21, '😀': 0.1, A: -0 })).toBe(
      '{"A":0,"a":[true,null,"x\\u001b"],"b":1,"€":1e+21,"😀":0.1}',
    );
    expect(canonicalJson({ amount_cents: 1250, to: 'acct-1' })).toBe('{"amount_cents":1250,"to":"acct-1"}');
    // RFC 8785 section 3.2.3's own case: U+1F600 (code units D83D DE00) sorts before U+FB33 (FB33), though its code
    // point is greater — a sort by code point puts them the other way (review of 2026-10-02, B-32).
    expect(canonicalJson({ '\ufb33': 1, '\u{1f600}': 2 })).toBe('{"\u{1f600}":2,"\ufb33":1}');
  });

  it('refuses a lone surrogate and a non-finite number', () => {
    expect(() => canonicalJson('\ud800')).toThrow(NotCanonicalizable);
    expect(() => canonicalJson(Number.NaN)).toThrow(NotCanonicalizable);
  });
});

describe('visible escapes (R12 (b))', () => {
  it('prints every invisible or direction-changing character as its escape, and a letter as itself', () => {
    const raw = '\u001b[2J \u009b \u202e \u200b \u00ad \u2028 \u{e0041} \ufe0f \u3164 \u00a0 \u034f é';
    expect(visible(raw)).toBe(
      '\\u001b[2J \\u009b \\u202e \\u200b \\u00ad \\u2028 \\u{e0041} \\ufe0f \\u3164 \\u00a0 \\u034f é',
    );
    expect(hasInvisible('plain text, accents é ü')).toBe(false);
  });
});

describe('names the host uses, and who may be unmetered (review of 2026-10-02, H1, H4)', () => {
  it('refuses a secret or a fixed variable named PATH, HOME, DOCKER_*, DYLD_*, LD_*, NODE_* or *_PROXY, naming it', () => {
    for (const name of [
      'PATH',
      'HOME',
      'DOCKER_CONFIG',
      'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'HTTPS_PROXY',
      'ASHA_HOME',
    ]) {
      expect(() => parseModuleManifest(cloudToolManifest({ secrets: [name] }), 'm')).toThrow(
        `module fixture_search: secrets.${name}: is a name the host process or the harness sets`,
      );
      const plugin = pluginManifest();
      expect(() =>
        parseModuleManifest(
          { ...plugin, executable: { ...(plugin['executable'] as Record<string, unknown>), env: { [name]: '/x' } } },
          'm',
        ),
      ).toThrow(`executable.env.${name}: is a name the host process or the harness sets`);
    }
    expect(() => parseModuleManifest(cloudToolManifest({ secrets: ['TAVILY_API_KEY'] }), 'm')).not.toThrow();
  });

  it('refuses external-unmetered for a tool module and a provider: only a command plugin is billed outside the meter', () => {
    expect(() => parseModuleManifest(cloudToolManifest({ cost: { model: 'external-unmetered' } }), 'm')).toThrow(
      'only a command plugin is "external-unmetered"',
    );
    expect(() => parseModuleManifest(providerManifest({ cost: { model: 'external-unmetered' } }), 'm')).toThrow(
      'only a command plugin is "external-unmetered"',
    );
  });
});
