/**
 * Shared chat-surface classes. The chat page keeps its own shell, but colours,
 * radii, focus treatment and shadows come from the app palette so it reads as
 * the same product as the library and sign-in pages.
 */

export const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Row shared by the sidebar's rail and expanded states: 40px icon cell + label. */
export const rowCls =
  "group flex w-full items-center rounded-xl transition-colors duration-150 outline-none";

export const rowHoverCls = "hover:bg-secondary/70";

export const rowIconCls = "grid h-10 w-10 shrink-0 place-items-center";

export const rowLabelCls = "block truncate text-left text-sm";

/** The label column collapses to nothing when the rail is closed. */
export const labelColCls = (expanded: boolean) =>
  expanded
    ? "min-w-0 flex-1 overflow-hidden pr-2 opacity-100 transition-opacity duration-150"
    : "min-w-0 flex-1 overflow-hidden opacity-0 pointer-events-none";

export const dividerCls = "mx-3 my-1 h-px shrink-0 bg-border";

/**
 * The small pill used by the wizard chips, the scope row and the composer
 * hints. One token so the three never drift apart.
 */
export const chipCls =
  `${FOCUS} inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 ` +
  "text-[11px] text-foreground transition-colors duration-150 hover:bg-secondary";

/** The wizard's opening options: the same pill, one comfortable size up. */
export const chipLargeCls = "gap-2 px-3.5 py-1.5 text-xs";

/** Selected chip: the accent colour, not a second surface. */
export const chipSelectedCls =
  "border-primary/60 bg-primary/10 font-medium text-primary hover:bg-primary/15";

export const menuItemCls =
  `${FOCUS} flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm ` +
  "text-muted-foreground transition-colors duration-150 hover:bg-secondary/70 hover:text-foreground";
