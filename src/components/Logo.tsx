import { Link } from "@tanstack/react-router";
import solutionHubIcon from "@/assets/solution-hub-icon.png";

export function Logo({ inverted = false, to = "/" }: { inverted?: boolean; to?: "/" | "/library" }) {
  return (
    <Link to={to} className="flex items-center gap-2">
      <img src={solutionHubIcon} alt="" width={40} height={40} className="h-10 w-10 shrink-0 object-contain" />
      <span className={`font-display text-lg font-semibold ${inverted ? "text-ink-foreground" : "text-foreground"}`}>
        Solution Hub
      </span>
    </Link>
  );
}
