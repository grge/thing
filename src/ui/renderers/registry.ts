/**
 * Renderer registry (§4.7, FINDINGS F11).
 *
 * A renderer claims **format patterns**, not object types. `:type` says
 * `text/markdown; variant=todo`; a todo renderer claims that exact string, and
 * a markdown renderer claims `text/markdown`. A client lacking the first still
 * matches the second, so the object stays readable rather than failing.
 *
 * Selection walks the degradation chain most-specific-first (see mime.ts), so
 * nothing here needs to know about fallbacks — it only declares what it handles.
 */
import type { Component } from 'svelte';
import { degradations } from '../../app/mime.js';

export interface RendererProps {
  bytes: Uint8Array;
  /** The object's effective type, so a renderer can read its parameters. */
  type: string | null;
  name: string | null;
}

export interface Renderer {
  readonly id: string;
  /** Exact type strings this renderer claims, e.g. `['image/png', 'image/*']`. */
  readonly claims: readonly string[];
  readonly component: Component<RendererProps>;
  /**
   * Should the canvas fetch this eagerly? §6.1 makes fetching lazy, but a
   * canvas of unfetched images renders as grey rectangles. Per-type because
   * the right answer differs by how much a thumbnail is worth.
   */
  readonly prefetch: boolean;
  /**
   * True if the renderer manages its own scrolling and wants the full pane —
   * a PDF viewer, later a canvas. The preview drops its padding and overflow
   * so the renderer is not scrolled inside a scroller.
   */
  readonly fills?: boolean;
}

const registry: Renderer[] = [];

export function register(r: Renderer): void {
  registry.push(r);
}

/**
 * The renderer for a type, or null.
 *
 * Walks the degradation chain in order, so `application/vnd.thing.board+json`
 * tries the board renderer, then a JSON one, then `application/*`.
 */
export function rendererFor(type: string | null): Renderer | null {
  for (const candidate of degradations(type)) {
    const found = registry.find((r) => r.claims.includes(candidate));
    if (found !== undefined) return found;
  }
  return null;
}

export function shouldPrefetch(type: string | null): boolean {
  return rendererFor(type)?.prefetch ?? false;
}

/** For tests and the debug view. */
export function registered(): readonly Renderer[] {
  return registry;
}
