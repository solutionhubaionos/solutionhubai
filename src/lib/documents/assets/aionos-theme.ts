/**
 * The bundled deck visual kit: the cover gradient extracted from the Aionos
 * brand guideline, the closing-panel photographs, and the Aionos wordmark
 * variants. Read once and shared by the renderer; the heavy base64 lives in
 * `aionos-theme-images.ts`.
 */
import { AIONOS_LOGO } from "./aionos-logo";
import { DECK_IMAGES, CLOSING_PHOTOS } from "./aionos-theme-images";

export const DECK_THEME_IMAGES = {
  /** The full-bleed cover gradient drawn behind the title slide. */
  gradient: DECK_IMAGES.gradient,
  /** The wordmark for light pages and the dark title canvas. */
  navyLogo: AIONOS_LOGO.navy,
  whiteLogo: AIONOS_LOGO.white,
  logoAspect: AIONOS_LOGO.aspect,
  /** Photographs for the closing panels and image slides, in reading order. */
  closingPhotos: [...CLOSING_PHOTOS],
} as const;
