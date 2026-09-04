/**
 * Renderer registration. Importing this module populates the registry.
 *
 * Each renderer claims format patterns (§4.7); selection walks the degradation
 * chain, so a specialised type falls back to its generic form without any
 * renderer needing to know about the others.
 */
import ImageView from './ImageView.svelte';
import PdfView from './PdfView.svelte';
import TextView from './TextView.svelte';
import { register } from './registry.js';

register({
  id: 'text',
  claims: [
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    'text/css',
    'text/javascript',
    'application/json',
    'text/*',
  ],
  component: TextView,
  prefetch: true, // small, and a canvas card wants the first lines
});

register({
  id: 'image',
  claims: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/*'],
  component: ImageView,
  prefetch: true, // a canvas of unfetched images is a canvas of grey rectangles
});

register({
  id: 'pdf',
  claims: ['application/pdf'],
  component: PdfView,
  // Not prefetched: PDFs are large, and this renderer cannot make a thumbnail
  // anyway, so fetching one eagerly buys the canvas nothing.
  prefetch: false,
  fills: true, // the browser's viewer scrolls itself
});
