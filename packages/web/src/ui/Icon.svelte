<script lang="ts">
  import { icons, type IconName } from './icons.js';

  interface Props {
    name: IconName;
    /** Pixel size. Defaults to the interface text size so icons sit on the line. */
    size?: number;
  }

  let { name, size = 14 }: Props = $props();
</script>

<!--
  aria-hidden throughout: every icon in this app sits beside a text label or on a
  control with an aria-label, so announcing it would only duplicate.
-->
<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false">{@html icons[name]}</svg>
