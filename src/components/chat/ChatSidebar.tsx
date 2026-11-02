import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronUp, LayoutDashboard, LogOut, Plus, Sparkles, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  FOCUS,
  dividerCls,
  labelColCls,
  menuItemCls,
  rowCls,
  rowHoverCls,
  rowIconCls,
  rowLabelCls,
} from "./theme";

export type ChatSummary = { id: string; title: string };

/**
 * The chat route's sidebar. It rests as a 64px icon rail and expands when the
 * shell decides to (hover, keyboard focus inside it, an open popover, or a tap
 * on a touch device). The shell owns the width; this component owns contents.
 *
 * Every row is built from the same grid — a 40px icon cell then a label column
 * — so labels share one left edge and nothing moves horizontally mid-animation.
 */
export function ChatSidebar({
  expanded,
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onNavigate,
  onOverlayOpenChange,
  showCloseButton = false,
}: {
  expanded: boolean;
  chats: ChatSummary[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  /** Supplied by the mobile drawer: dismiss it after a jump. */
  onNavigate?: () => void;
  /** Told whenever a popover inside the sidebar opens, so it stays expanded. */
  onOverlayOpenChange?: (open: boolean) => void;
  showCloseButton?: boolean;
}) {
  const { user } = useRouteContext({ from: "/_authenticated" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [accountOpen, setAccountOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onOverlayOpenChange?.(accountOpen);
  }, [accountOpen, onOverlayOpenChange]);

  // Account menu: Escape and outside click. Escape is claimed here so the mobile
  // drawer behind it does not close at the same moment.
  useEffect(() => {
    if (!accountOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setAccountOpen(false);
      triggerRef.current?.focus();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setAccountOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [accountOpen]);

  const email = user.email ?? "Account";
  const name =
    (user.user_metadata?.["full_name"] as string | undefined)?.trim() ||
    email.split("@")[0] ||
    "Account";
  const initials = useMemo(() => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1)
      return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
    return name.trim().slice(0, 2).toUpperCase() || "A";
  }, [name]);

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    void navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* brand header (the drawer adds a close button) */}
      <div className="flex h-16 shrink-0 items-center px-3">
        <span className={rowIconCls}>
          <span className="grid h-6 w-6 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles size={15} />
          </span>
        </span>
        <span className={labelColCls(expanded)}>
          <span className={`${rowLabelCls} font-display text-sm font-semibold text-foreground`}>
            Solution Hub
          </span>
          <span className={`${rowLabelCls} text-xs text-muted-foreground`}>AI Search</span>
        </span>
        {showCloseButton && (
          <button
            type="button"
            onClick={onNavigate}
            aria-label="Close navigation"
            className={`${FOCUS} ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground`}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <Divider />

      <nav aria-label="New chat" className="shrink-0 px-3">
        <Row
          expanded={expanded}
          icon={
            <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-primary-foreground">
              <Plus size={14} strokeWidth={2.6} />
            </span>
          }
          label="New chat"
          textCls="font-semibold text-primary"
          onClick={() => {
            onNewChat();
            onNavigate?.();
          }}
        />
      </nav>

      <Divider />

      <nav
        aria-label="Recent conversations"
        className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3"
      >
        {expanded && (
          <ul className="flex flex-col gap-0.5">
            {chats.length === 0 && (
              <li className="px-2 py-2 text-xs text-muted-foreground">No conversations yet.</li>
            )}
            {chats.map((chat) => {
              const active = chat.id === activeChatId;
              return (
                <li key={chat.id}>
                  <Row
                    expanded={expanded}
                    active={active}
                    icon={<ChatDot active={active} />}
                    label={chat.title}
                    textCls={active ? "font-medium text-foreground" : "text-muted-foreground"}
                    onClick={() => {
                      onSelectChat(chat.id);
                      onNavigate?.();
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <nav aria-label="Library" className="shrink-0 px-3">
        <Row
          expanded={expanded}
          icon={<LayoutDashboard size={18} className="text-muted-foreground" />}
          label="Library"
          textCls="text-foreground"
          href="/library"
          onClick={onNavigate}
        />
      </nav>

      <Divider />

      <div className="shrink-0 px-3 pb-3">
        <div className="relative">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setAccountOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            aria-label="Account"
            title={expanded ? undefined : "Account"}
            className={`${rowCls} h-10 ${accountOpen ? "bg-secondary/70" : rowHoverCls}`}
          >
            <span className={rowIconCls}>
              <Avatar initials={initials} />
            </span>
            <span className={labelColCls(expanded)}>
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className={`${rowLabelCls} text-sm font-medium text-foreground`}>
                    {name}
                  </span>
                </span>
                <ChevronUp size={15} className="shrink-0 text-muted-foreground" />
              </span>
            </span>
          </button>

          {accountOpen && (
            <div
              ref={menuRef}
              role="menu"
              aria-label="Account"
              className={`absolute z-40 overflow-hidden rounded-2xl border border-border bg-popover p-1.5 shadow-card ${
                expanded
                  ? "bottom-[calc(100%+0.5rem)] left-0 right-0"
                  : "bottom-0 left-[calc(100%+0.5rem)] w-64"
              }`}
            >
              <div className="flex items-center gap-2.5 rounded-xl px-2 py-2">
                <Avatar initials={initials} />
                <span className="min-w-0">
                  <span className={`${rowLabelCls} text-sm font-medium text-foreground`}>
                    {name}
                  </span>
                  <span className={`${rowLabelCls} text-xs text-muted-foreground`}>{email}</span>
                </span>
              </div>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                onClick={() => void signOut()}
                className={menuItemCls}
              >
                <LogOut size={15} className="shrink-0" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return <div aria-hidden className={dividerCls} />;
}

/** The chat bullet: a hollow dot, filled with the primary colour while current. */
function ChatDot({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={`h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px] ${
        active ? "border-primary bg-primary" : "border-muted-foreground/40 bg-transparent"
      }`}
    />
  );
}

/**
 * One sidebar row in both widths. `active` marks the open chat, which keeps its
 * tint under the cursor.
 */
function Row({
  expanded,
  icon,
  label,
  textCls,
  active = false,
  onClick,
  href,
}: {
  expanded: boolean;
  icon: ReactNode;
  label: string;
  textCls: string;
  active?: boolean;
  onClick?: (() => void) | undefined;
  href?: string | undefined;
}) {
  const className = `${rowCls} h-9 ${active ? "bg-secondary" : rowHoverCls}`;
  const inner = (
    <>
      <span className={rowIconCls}>{icon}</span>
      <span className={labelColCls(expanded)}>
        <span className={`${rowLabelCls} ${textCls}`}>{label}</span>
      </span>
    </>
  );

  if (href) {
    return (
      <Link to={href} aria-label={label} title={label} onClick={onClick} className={className}>
        {inner}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "true" : undefined}
      title={label}
      className={className}
    >
      {inner}
    </button>
  );
}

function Avatar({ initials }: { initials: string }) {
  return (
    <span
      aria-hidden
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-ink-foreground"
    >
      {initials}
    </span>
  );
}
