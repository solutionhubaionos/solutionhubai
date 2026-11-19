/**
 * The bundled deck visual kit: the gradient title canvas, the team photograph,
 * and the closing-panel photographs, plus the Aionos wordmark variants. Read
 * once and shared by the renderer; the heavy base64 lives in
 * `aionos-theme-images.ts`.
 */
import { AIONOS_LOGO } from "./aionos-logo";
import { DECK_IMAGES, CLOSING_PHOTOS } from "./aionos-theme-images";

export const DECK_THEME_IMAGES = {
  /** The full-bleed gradient drawn behind the title slide. */
  gradient: DECK_IMAGES.gradient,
  /** The title-slide photograph, contained on the right. */
  teamPhoto: DECK_IMAGES.teamPhoto,
  /** The wordmark for light pages and the dark title canvas. */
  navyLogo: AIONOS_LOGO.navy,
  whiteLogo: AIONOS_LOGO.white,
  logoAspect: AIONOS_LOGO.aspect,
  /** Photographs for the closing panels and image slides, in reading order. */
  closingPhotos: [...CLOSING_PHOTOS],
} as const;
