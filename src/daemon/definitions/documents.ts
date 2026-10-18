// A recipe's documents (docs/plans/collaborating-agents.md R2, R3, R12): read
// from the recipe's own folder when its agent is launched, checked before any
// container starts, and then placed in the agent's /workspace by the container
// runtime. A document that is missing, lies outside the folder (through a
// link), or would put the recipe over a bound fails the launch with a typed
// error naming the recipe and the document.

import { realpath, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { FULL_TEXT_MAX_BYTES, WORKSPACE_MAX_BYTES, WORKSPACE_MAX_FILES } from '../../shared/tools.js';
import type { Recipe } from './index.js';

/** A document as the launch carries it: where it goes under /workspace, whether it is full-text, and its bytes. */
export interface LoadedDocument {
  readonly path: string;
  readonly fullText: boolean;
  readonly content: Buffer;
}

/** A full-text document, as the agent's welcome carries it into its system prompt. */
export interface GuidanceText {
  readonly path: string;
  readonly text: string;
}

/** A named document does not exist in the recipe's folder (R2). */
export class DocumentMissing extends Error {
  constructor(
    readonly file: string,
    readonly path: string,
  ) {
    super(`${file}: document "${path}" does not exist in the recipe's folder`);
    this.name = 'DocumentMissing';
  }
}

/** A named document resolves, through a link, to a file outside the recipe's folder, or is not a regular file (R2, R5). */
export class DocumentOutsideFolder extends Error {
  constructor(
    readonly file: string,
    readonly path: string,
    detail: string,
  ) {
    super(`${file}: document "${path}" ${detail}; every document must be a file inside the recipe's folder`);
    this.name = 'DocumentOutsideFolder';
  }
}

/** The recipe's full-text documents together are over FULL_TEXT_MAX_BYTES (R12). */
export class DocumentsTooLarge extends Error {
  constructor(
    readonly recipe: string,
    readonly total: number,
    readonly limit: number,
  ) {
    super(
      `recipe ${recipe}: its full-text documents total ${String(total)} bytes, over the limit of ${String(limit)} bytes`,
    );
    this.name = 'DocumentsTooLarge';
  }
}

/** The recipe's documents alone are over /workspace's bound of files or bytes (R2; agent-tools R9). */
export class DocumentsOverWorkspace extends Error {
  constructor(
    readonly recipe: string,
    readonly files: number,
    readonly bytes: number,
  ) {
    super(
      `recipe ${recipe}: its ${String(files)} documents of ${String(bytes)} bytes are over /workspace's bound of ${String(WORKSPACE_MAX_FILES)} files and ${String(WORKSPACE_MAX_BYTES)} bytes`,
    );
    this.name = 'DocumentsOverWorkspace';
  }
}

/** A full-text document is not UTF-8 text, so it cannot go into the system prompt. */
export class DocumentNotText extends Error {
  constructor(
    readonly file: string,
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`${file}: full-text document "${path}" is not UTF-8 text`, options);
    this.name = 'DocumentNotText';
  }
}

export interface LoadDocumentsProps {
  readonly recipe: Recipe;
  /** The recipe file, named in every error. */
  readonly file: string;
  /** The recipe's folder: every document's path is relative to it, and every document must resolve inside it. */
  readonly folder: string;
}

/** Reads and checks every document the recipe names, in its order. Nothing is started here. */
export async function loadDocuments(props: LoadDocumentsProps): Promise<LoadedDocument[]> {
  const { recipe, file } = props;
  if (recipe.documents.length === 0) return [];
  const folder = await realpath(props.folder);
  const found = [];
  for (const document of recipe.documents) {
    let real: string;
    try {
      real = await realpath(resolve(props.folder, document.path));
    } catch (error) {
      // ENOTDIR: a part of the path is a file, so the document cannot exist there either.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new DocumentMissing(file, document.path);
      throw error;
    }
    const inside = relative(folder, real);
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new DocumentOutsideFolder(file, document.path, `resolves to ${real}, outside ${folder}`);
    }
    const info = await stat(real);
    if (!info.isFile()) throw new DocumentOutsideFolder(file, document.path, 'is not a regular file');
    found.push({ document, real, size: info.size });
  }
  const bytes = found.reduce((n, f) => n + f.size, 0);
  if (found.length > WORKSPACE_MAX_FILES || bytes > WORKSPACE_MAX_BYTES)
    throw new DocumentsOverWorkspace(recipe.id, found.length, bytes);
  const fullText = found.filter((f) => f.document.fullText).reduce((n, f) => n + f.size, 0);
  if (fullText > FULL_TEXT_MAX_BYTES) throw new DocumentsTooLarge(recipe.id, fullText, FULL_TEXT_MAX_BYTES);
  const loaded = [];
  for (const f of found)
    loaded.push({ path: f.document.path, fullText: f.document.fullText, content: await readFile(f.real) });
  return loaded;
}

/** The full-text documents' text, in the recipe's order: what the agent's system prompt carries (R2). */
export function guidanceOf(file: string, documents: readonly LoadedDocument[]): GuidanceText[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return documents
    .filter((d) => d.fullText)
    .map((d) => {
      try {
        return { path: d.path, text: decoder.decode(d.content) };
      } catch (error) {
        throw new DocumentNotText(file, d.path, { cause: error });
      }
    });
}
