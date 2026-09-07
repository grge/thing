/**
 * Which component draws which type.
 *
 * **A renderer claims format patterns, not object types.** `:kind` says
 * `text/markdown; variant=todo`; a todo renderer claims that exact string and a
 * markdown renderer claims `text/markdown`. A client lacking the first still
 * matches the second, so an object stays readable rather than failing.
 *
 * Selection walks the degradation chain most-specific-first (`degradations` in
 * the engine), so nothing here needs to know about fallbacks — a renderer only
 * declares what it handles.
 */
import { degradations } from '@thing/engine';
import type { Component } from 'svelte';

export interface RendererProps {
  bytes: Uint8Array;
  /** The object's type, so a renderer can read its parameters. */
  type: string | null;
  name: string | null;
}

export interface Renderer {
  readonly id: string;
  /** Exact type strings this claims, e.g. `['image/png', 'image/*']`. */
  readonly claims: readonly string[];
  readonly component: Component<RendererProps>;
  /**
   * Whether this renderer manages its own scrolling and wants the whole pane.
   *
   * A PDF viewer does; a paragraph of text does not. The preview drops its
   * padding for one that does, so the renderer is not scrolled inside a
   * scroller.
   */
  readonly fills?: boolean;
}

const registry: Renderer[] = [];

export function register(r: Renderer): void {
  registry.push(r);
}

/** The renderer for a type, or null if nothing claims it or anything it degrades to. */
export function rendererFor(type: string | null): Renderer | null {
  for (const candidate of degradations(type)) {
    const found = registry.find((r) => r.claims.includes(candidate));
    if (found !== undefined) return found;
  }
  return null;
}

/** For tests and the debug view. */
export function registered(): readonly Renderer[] {
  return registry;
}
