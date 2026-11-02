import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Briefcase,
  Building2,
  Check,
  ChevronDown,
  Globe,
  Link2,
  Search,
  UserRound,
  X,
} from "lucide-react";
import {
  PERSONAS,
  SECTORS,
  isValidWebsite,
  normaliseWebsite,
  type ChatContext,
} from "@/lib/chat/scope";
import { FOCUS } from "./theme";

type ListKey = "clients" | "personas" | "industries" | "sectors";
type ListOption = { value: string; label: string };

/**
 * The context fields as one slim row docked to the top of the composer: four
 * multi-select pills followed by the website field, which stretches into the
 * space left over. Everything is visible at all times — there is no expand step
 * — so the row is a single flex line that scrolls rather than wrapping, and
 * each pill opens a small multi-select popover above itself.
 *
 * Popovers are portalled and positioned from the trigger's rect because the row
 * scrolls horizontally and would otherwise clip them.
 */
export function ContextToolbar({
  value,
  onChange,
  onReset,
  clients,
  industries,
  summary,
}: {
  value: ChatContext;
  onChange: <K extends keyof ChatContext>(key: K, next: ChatContext[K]) => void;
  onReset: () => void;
  /** Customer names from the library. */
  clients: string[];
  industries: { slug: string; name: string }[];
  /** Human-readable list of what is set, read out with the row. */
  summary: string[];
}) {
  const [openKey, setOpenKey] = useState<ListKey | null>(null);
  // The open pill's element drives the portalled popover's placement.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const triggers = useRef<Partial<Record<ListKey, HTMLButtonElement | null>>>({});

  const hasAny =
    value.clients.length > 0 ||
    value.personas.length > 0 ||
    value.industries.length > 0 ||
    value.sectors.length > 0 ||
    value.website.length > 0;

  const closeAndFocus = (key: ListKey) => {
    setOpenKey(null);
    triggers.current[key]?.focus();
  };

  const togglePopover = (key: ListKey) => (element: HTMLButtonElement) => {
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    setAnchor(element);
    setOpenKey(key);
  };

  /** Adds the value when it is missing, drops it when it is already picked. */
  const toggleValue = (key: ListKey, next: string) => {
    const current = value[key];
    onChange(key, current.includes(next) ? current.filter((v) => v !== next) : [...current, next]);
  };

  const clientOptions = useMemo<ListOption[]>(
    () => clients.map((name) => ({ value: name, label: name })),
    [clients],
  );
  const industryOptions = useMemo<ListOption[]>(
    () => industries.map((industry) => ({ value: industry.slug, label: industry.name })),
    [industries],
  );
  const personaOptions = useMemo<ListOption[]>(
    () => PERSONAS.map((p) => ({ value: p, label: p })),
    [],
  );
  const sectorOptions = useMemo<ListOption[]>(
    () => SECTORS.map((s) => ({ value: s, label: s })),
    [],
  );

  const industryName = (slug: string) =>
    industries.find((industry) => industry.slug === slug)?.name ?? slug;

  return (
    <div
      role="group"
      aria-label={summary.length ? `Search context: ${summary.join(", ")}` : "Search context"}
      className="flex items-center gap-1.5 border-b border-border px-2.5 py-2"
    >
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Pill
          icon={<Building2 size={13} />}
          label="Client"
          selected={value.clients}
          open={openKey === "clients"}
          triggerRef={(element) => {
            triggers.current.clients = element;
          }}
          onToggle={togglePopover("clients")}
        >
          <Popover anchor={anchor} onOutsideClose={() => setOpenKey(null)}>
            <SelectList
              title="Client"
              options={clientOptions}
              selected={value.clients}
              searchable
              searchPlaceholder="Search clients"
              onToggle={(next) => toggleValue("clients", next)}
              onClose={() => closeAndFocus("clients")}
            />
          </Popover>
        </Pill>

        <Pill
          icon={<UserRound size={13} />}
          label="Persona"
          selected={value.personas}
          open={openKey === "personas"}
          triggerRef={(element) => {
            triggers.current.personas = element;
          }}
          onToggle={togglePopover("personas")}
        >
          <Popover anchor={anchor} onOutsideClose={() => setOpenKey(null)}>
            <SelectList
              title="Persona"
              options={personaOptions}
              selected={value.personas}
              onToggle={(next) => toggleValue("personas", next)}
              onClose={() => closeAndFocus("personas")}
            />
          </Popover>
        </Pill>

        <Pill
          icon={<Briefcase size={13} />}
          label="Industry"
          selected={value.industries.map(industryName)}
          open={openKey === "industries"}
          triggerRef={(element) => {
            triggers.current.industries = element;
          }}
          onToggle={togglePopover("industries")}
        >
          <Popover anchor={anchor} onOutsideClose={() => setOpenKey(null)}>
            <SelectList
              title="Industry"
              options={industryOptions}
              selected={value.industries}
              searchable
              searchPlaceholder="Search industries"
              onToggle={(next) => toggleValue("industries", next)}
              onClose={() => closeAndFocus("industries")}
            />
          </Popover>
        </Pill>

        <Pill
          icon={<Globe size={13} />}
          label="Sector"
          selected={value.sectors}
          open={openKey === "sectors"}
          triggerRef={(element) => {
            triggers.current.sectors = element;
          }}
          onToggle={togglePopover("sectors")}
        >
          <Popover anchor={anchor} onOutsideClose={() => setOpenKey(null)}>
            <SelectList
              title="Sector"
              options={sectorOptions}
              selected={value.sectors}
              onToggle={(next) => toggleValue("sectors", next)}
              onClose={() => closeAndFocus("sectors")}
            />
          </Popover>
        </Pill>

        <WebsiteInput value={value.website} onChange={(next) => onChange("website", next)} />
      </div>

      {hasAny && (
        <button
          type="button"
          onClick={onReset}
          className={`${FOCUS} shrink-0 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground`}
        >
          Clear all
        </button>
      )}
    </div>
  );
}

/**
 * Compact pill: muted with its field name when empty, primary-tinted with the
 * selection when set — one value, or "First +N" with the rest in the title.
 */
function Pill({
  icon,
  label,
  selected,
  open,
  onToggle,
  triggerRef,
  children,
}: {
  icon: ReactNode;
  label: string;
  /** Resolved display names of the current selection. */
  selected: string[];
  open: boolean;
  onToggle: (element: HTMLButtonElement) => void;
  triggerRef: (element: HTMLButtonElement | null) => void;
  children: ReactNode;
}) {
  const set = selected.length > 0;
  const full = selected.join(", ");
  const pillLabel = !set
    ? label
    : selected.length === 1
      ? (selected[0] ?? label)
      : `${selected[0]} +${selected.length - 1}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => onToggle(event.currentTarget)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={set ? `${label}: ${full}` : `${label} — not set`}
        title={set ? full : label}
        className={`${FOCUS} inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors duration-150 ${
          set
            ? "border-primary/20 bg-primary/10 font-medium text-primary hover:bg-primary/15"
            : "border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground"
        }`}
      >
        <span className={`shrink-0 ${set ? "text-primary" : "text-muted-foreground"}`}>{icon}</span>
        <span className="max-w-[140px] truncate">{pillLabel}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 ${set ? "text-primary" : "text-muted-foreground"}`}
        />
      </button>
      {open && children}
    </>
  );
}

/**
 * Fixed-position popover above its trigger, portalled to the body so the pill
 * row's horizontal scroll cannot clip it.
 */
function Popover({
  anchor,
  width = 264,
  onOutsideClose,
  children,
}: {
  anchor: HTMLElement | null;
  width?: number;
  onOutsideClose: () => void;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number } | null>(
    null,
  );
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const nextWidth = Math.min(width, Math.max(180, window.innerWidth - 16));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - nextWidth - 8));
      // Anchored to the trigger's top edge, growing upward: the composer sits
      // at the bottom of the viewport.
      setPosition({ left, bottom: window.innerHeight - rect.top + 8, width: nextWidth });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, width]);

  // Dismissed on click, not mousedown: clicks inside the panel (toggling an
  // option, typing a search) must leave it open so several items can be picked
  // in one go. Containment is read from the dispatch-time path rather than
  // `contains`, because ticking a check box removes the clicked node mid-dispatch.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const path = event.composedPath();
      if (panelRef.current && path.includes(panelRef.current)) return;
      if (anchor && path.includes(anchor)) return;
      onOutsideClose();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [anchor, onOutsideClose]);

  if (!position) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[60] overflow-hidden rounded-2xl border border-border bg-popover p-1.5 shadow-card"
      style={{ left: position.left, bottom: position.bottom, width: position.width }}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * Multi-select listbox: rows are toggles with a check box, clicking a selected
 * row unselects it, and the popover stays open. Arrow keys move, Enter toggles,
 * Escape closes just this popover, and tabbing off the last control closes it.
 */
function SelectList({
  title,
  options,
  selected,
  onToggle,
  onClose,
  searchable = false,
  searchPlaceholder = "Search",
}: {
  title: string;
  options: ListOption[];
  selected: string[];
  onToggle: (next: string) => void;
  onClose: () => void;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Snapshot of the selection when the popover opened: picked rows sort to the
  // top once and then hold that place, so the list never jumps under the cursor.
  const [pickedAtOpen] = useState(() => new Set(selected));
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ordered = useMemo(() => {
    const rank = (option: ListOption) => (pickedAtOpen.has(option.value) ? 0 : 1);
    // `sort` is stable, so unpicked rows keep their source order.
    return [...options].sort((a, b) => rank(a) - rank(b));
  }, [options, pickedAtOpen]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? ordered.filter((option) => option.label.toLowerCase().includes(term)) : ordered;
  }, [ordered, query]);

  useEffect(() => {
    if (searchable) inputRef.current?.focus();
    else rootRef.current?.focus();
    // Focus belongs to the field on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const inSearch = event.target === inputRef.current;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (visible.length ? (index + 1) % visible.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (visible.length ? (index - 1 + visible.length) % visible.length : 0));
    } else if (event.key === "Enter" || (event.key === " " && !inSearch)) {
      event.preventDefault();
      const item = visible[active];
      if (item) onToggle(item.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      // Tabbing past the popover's edge dismisses it; moving between controls
      // inside leaves it open.
      const focusables = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>("button, input") ?? [],
      );
      const edge = event.shiftKey ? focusables[0] : focusables[focusables.length - 1];
      if (event.target === edge) onClose();
    }
  };

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="outline-none">
      <div className="flex items-center justify-between gap-2 px-1.5 pb-1 pt-0.5">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
          className={`${FOCUS} grid h-6 w-6 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground`}
        >
          <X size={13} />
        </button>
      </div>

      {searchable && (
        <div className="relative mb-1 px-0.5">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            className={`${FOCUS} w-full rounded-xl border border-border bg-card py-2 pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary`}
          />
        </div>
      )}

      <ul
        ref={listRef}
        role="listbox"
        aria-label={title}
        aria-multiselectable="true"
        className="max-h-56 overflow-y-auto"
      >
        {visible.length === 0 && (
          <li className="px-2.5 py-2 text-xs text-muted-foreground">No matches</li>
        )}
        {visible.map((item, index) => {
          const isSelected = selected.includes(item.value);
          const isActive = index === active;
          return (
            <li
              key={item.value}
              role="option"
              aria-selected={isSelected}
              onMouseEnter={() => setActive(index)}
              onClick={() => onToggle(item.value)}
              className={`flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-xs transition-colors duration-100 ${
                isActive ? "bg-secondary text-foreground" : "text-muted-foreground"
              } ${isSelected ? "font-medium" : ""}`}
            >
              <span
                aria-hidden
                className={`grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border transition-colors duration-100 ${
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-transparent"
                }`}
              >
                {isSelected && <Check size={11} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Website as a real inline field: a pill-shaped input that fills the row's free
 * space. It updates the context as you type, normalises on blur or Enter, and
 * flags an implausible value with a quiet rose ring — never by blocking send.
 */
function WebsiteInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const set = value.length > 0;
  const invalid = set && !isValidWebsite(value);

  const commit = () => {
    const normalised = normaliseWebsite(value);
    if (normalised !== value) onChange(normalised);
  };

  return (
    <>
      <div
        title={invalid ? "Check this address — for example acme.com" : undefined}
        className={`flex h-8 min-w-[180px] shrink grow basis-[220px] items-center gap-1.5 rounded-full border px-2.5 transition-colors duration-150 ${
          invalid
            ? "border-destructive/50 bg-card focus-within:border-destructive focus-within:ring-4 focus-within:ring-destructive/10"
            : set
              ? "border-primary/25 bg-primary/5"
              : "border-border bg-card"
        }`}
      >
        <Link2
          size={13}
          className={`shrink-0 ${invalid ? "text-destructive" : set ? "text-primary" : "text-muted-foreground"}`}
        />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Enter saves the field; it must never reach the composer's send.
            event.preventDefault();
            event.stopPropagation();
            commit();
          }}
          placeholder="Paste the client's website"
          autoComplete="url"
          inputMode="url"
          aria-label="Client website"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? "ctx-website-hint" : undefined}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground focus:outline-none placeholder:text-muted-foreground"
        />
        {set && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear website"
            className={`${FOCUS} -mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground`}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <span id="ctx-website-hint" className="sr-only">
        Enter a website address, for example acme.com
      </span>
    </>
  );
}
