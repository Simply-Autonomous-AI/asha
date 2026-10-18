// A canvas, its 2D context and a window for unit tests of the portal's scene renderer (src/portal/scene-draw.ts), which
// the coverage run cannot measure in Chromium. The context records every call and every property it is given, in order,
// so a test asserts exactly what was drawn; measureText answers a fixed width per code point, as the scene's own tests
// measure. The window answers performance.now from a clock the test moves, and portal.css's custom properties from a
// table the test gives.

/** One thing done to the context: a method call `[name, ...args]`, or a property set `['=', name, value]`. */
export type DrawCall = readonly [string, ...unknown[]];

/** A recording 2D context: every method records its call; every property set records itself and is read back. */
export function recordingContext(measure: (text: string) => number = (text) => 7 * Array.from(text).length): {
  readonly ctx: CanvasRenderingContext2D;
  readonly calls: DrawCall[];
} {
  const calls: DrawCall[] = [];
  const state = new Map<string, unknown>();
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      if (state.has(name)) return state.get(name);
      if (name === 'measureText')
        return (text: string) => {
          calls.push(['measureText', text]);
          return { width: measure(text) };
        };
      return (...args: unknown[]) => {
        calls.push([name, ...args]);
      };
    },
    set(_, name, value) {
      if (typeof name !== 'string') return false;
      state.set(name, value);
      calls.push(['=', name, value]);
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** A pointer event's position, as the renderer reads it. */
export interface FakePointer {
  readonly offsetX: number;
  readonly offsetY: number;
}

/** A canvas: its size, its listeners, its attributes and its context (or none). */
export class FakeCanvas {
  width = 0;
  height = 0;
  private readonly listeners = new Map<string, ((event: FakePointer) => void)[]>();
  private readonly attributes = new Map<string, string>();

  constructor(
    private readonly context: CanvasRenderingContext2D | null,
    private readonly rect: { readonly width: number; readonly height: number },
  ) {}

  getContext(kind: string): CanvasRenderingContext2D | null {
    return kind === '2d' ? this.context : null;
  }

  addEventListener(type: string, listener: (event: FakePointer) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Delivers `event` to every listener of `type`. */
  dispatch(type: string, event: FakePointer = { offsetX: 0, offsetY: 0 }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  getBoundingClientRect(): { readonly width: number; readonly height: number } {
    return this.rect;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  /** As the DOM's own type, for the renderer's constructor. */
  asCanvas(): HTMLCanvasElement {
    return this as unknown as HTMLCanvasElement;
  }
}

/** A window whose clock is `clock.now` and whose stylesheet defines `tokens`, and no other custom property. */
export function fakeWindow(clock: { now: number }, tokens: Readonly<Record<string, string>>): Window {
  const root = {};
  const win = {
    performance: { now: () => clock.now },
    document: { documentElement: root },
    getComputedStyle: (node: unknown) => {
      if (node !== root) throw new Error('getComputedStyle: only the document element is styled here');
      return { getPropertyValue: (name: string) => (Object.hasOwn(tokens, name) ? ` ${String(tokens[name])}` : '') };
    },
  };
  return win as unknown as Window;
}
