import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Menu, ChevronDown } from "lucide-react";
import { Logo } from "./Logo";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useIndustries } from "@/lib/industries";
import { useRole } from "@/lib/roles";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export function AppHeader() {
  const { industries: INDUSTRIES } = useIndustries();
  const { user } = useRouteContext({ from: "/_authenticated" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { role } = useRole();

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Logo to="/library" />
        <div className="flex items-center gap-3">
          <nav aria-label="Main navigation">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label="Open navigation menu">
                  <Menu />
                  <span className="hidden sm:inline">Menu</span>
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 max-w-[90vw]">
                <DropdownMenuItem asChild>
                  <Link to="/library">Library</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/chat">AI Search</Link>
                </DropdownMenuItem>
                {role === "admin" && (
                  <DropdownMenuItem asChild>
                    <Link to="/insights">Insights</Link>
                  </DropdownMenuItem>
                )}
                {role === "admin" && (
                  <DropdownMenuItem asChild>
                    <Link to="/admin">Admin dashboard</Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Industries</DropdownMenuLabel>
                {INDUSTRIES.map((i) => (
                  <DropdownMenuItem key={i.slug} asChild>
                    <Link to="/industry/$slug" params={{ slug: i.slug }}>
                      {i.name}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>
          <Badge variant="secondary">{role === "admin" ? "Admin" : "Member"}</Badge>
          <span className="hidden text-xs text-muted-foreground md:inline">{user.email}</span>
          <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
            <LogOut />
          </Button>
        </div>
      </div>
    </header>
  );
}
