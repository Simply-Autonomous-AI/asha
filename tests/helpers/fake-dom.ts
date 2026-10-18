// A minimal DOM for unit tests of the portal's browser modules (src/portal/), which the coverage run cannot measure in
// Chromium: elements with attributes, children and text, text nodes, a document that makes them, and the scroll
// metrics a test sets by hand (there is no layout). Only what the modules use: a method this lacks fails as a
// TypeError, so a module that grows a new DOM use grows this with it. A node moved into a parent leaves its old one,
// and inserting before a node that is not a child throws, as the DOM does.

/** A text node. */
export class FakeText {
  parentNode: FakeElement | null = null;

  constructor(readonly data: string) {}

  get textContent(): string {
    return this.data;
  }
}

type FakeNode = FakeElement | FakeText;

/** An element. */
export class FakeElement {
  readonly tagName: string;
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  hidden = false;
  /** Scroll metrics, set by a test: nothing lays the page out. */
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  private readonly attributes = new Map<string, string>();

  constructor(
    readonly ownerDocument: FakeDocument,
    tag: string,
  ) {
    this.tagName = tag.toUpperCase();
  }

  /** The element children, in order. */
  get children(): FakeElement[] {
    return this.childNodes.filter((c) => c instanceof FakeElement);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(text: string) {
    this.replaceChildren(text);
  }

  get className(): string {
    return this.getAttribute('class') ?? '';
  }

  /** The class list's one query the modules make. */
  get classList(): { contains: (name: string) => boolean } {
    return { contains: (name) => this.className.split(/\s+/).includes(name) };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: readonly (FakeNode | string)[]): void {
    for (const node of nodes) this.adopt(node, this.childNodes.length);
  }

  insertBefore(node: FakeNode, reference: FakeNode | null): FakeNode {
    if (reference === null) {
      this.append(node);
      return node;
    }
    if (reference.parentNode !== this) throw new Error('insertBefore: the reference node is not a child of this node');
    detach(node);
    this.adopt(node, this.childNodes.indexOf(reference));
    return node;
  }

  replaceChildren(...nodes: readonly (FakeNode | string)[]): void {
    for (const child of this.childNodes.splice(0)) child.parentNode = null;
    this.append(...nodes);
  }

  /** Every descendant element, depth first, in document order. */
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  private adopt(node: FakeNode | string, at: number): void {
    const child = typeof node === 'string' ? new FakeText(node) : node;
    detach(child);
    this.childNodes.splice(Math.min(at, this.childNodes.length), 0, child);
    child.parentNode = this;
  }
}

/** Takes `node` out of its parent, if it has one. */
function detach(node: FakeNode): void {
  const parent = node.parentNode;
  if (parent === null) return;
  parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
  node.parentNode = null;
}

/** The document: it makes elements and text nodes. */
export class FakeDocument {
  readonly body = new FakeElement(this, 'body');

  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }

  createTextNode(data: string): FakeText {
    return new FakeText(data);
  }

  /** As the DOM's own type, for a module's constructor. */
  asDocument(): Document {
    return this as unknown as Document;
  }
}

/** A fake element as the DOM's own type, for a module's constructor. */
export const asElement = (node: FakeElement): HTMLElement => node as unknown as HTMLElement;
