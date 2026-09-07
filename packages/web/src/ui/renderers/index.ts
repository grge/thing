/**
 * The renderers this client ships.
 *
 * Registered here rather than in each file, so the set is one list to read and
 * the order of registration is visible: `rendererFor` takes the first claim it
 * finds along the degradation chain, so a more specific renderer registered
 * later would never be reached.
 */
import ImageView from './ImageView.svelte';
import PdfView from './PdfView.svelte';
import { register } from './registry.js';
import TextView from './TextView.svelte';

register({
  id: 'text',
  claims: ['text/*', 'application/json', 'application/xml'],
  component: TextView,
});

register({
  id: 'image',
  claims: ['image/*'],
  component: ImageView,
});

register({
  id: 'pdf',
  claims: ['application/pdf'],
  component: PdfView,
  fills: true,
});

export { registered, rendererFor, type Renderer, type RendererProps } from './registry.js';
