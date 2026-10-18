// The page's DOM helpers. Every text from the daemon reaches the page only as text — `textContent`, a text node, or
// an attribute set by `setAttribute` — never as markup (docs/plans/portal.md R13).

/** An element with its attributes (by setAttribute) and children (text as text nodes). */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attributes: Readonly<Record<string, string>> = {},
  ...children: readonly (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  for (const child of children) node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  return node;
}

/** The element with this id, of this kind: the page's own markup, so a missing one is a defect. */
export function byId<T extends HTMLElement>(doc: Document, id: string, kind: { new (): T; readonly prototype: T }): T {
  const node = doc.getElementById(id);
  if (!(node instanceof kind)) throw new Error(`the page has no ${kind.name} #${id}`);
  return node;
}

/** Appends text to an element as a text node, and keeps a scrolled-down log scrolled down. */
export function appendText(node: HTMLElement, text: string): void {
  const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 4;
  node.append(node.ownerDocument.createTextNode(text));
  if (atEnd) node.scrollTop = node.scrollHeight;
}

/** Empties an element. */
export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/** Shows or hides an element. */
export function show(node: HTMLElement, shown: boolean): void {
  node.hidden = !shown;
}
