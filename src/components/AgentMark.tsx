import solutionHubIcon from "@/assets/solution-hub-icon.png";

/**
 * The assistant's mark: the Solution Hub icon, used for the agent in the
 * sidebar brand row and beside every assistant message so the identity is
 * consistent wherever the AI appears.
 */
export function AgentMark({ className }: { className?: string }) {
  return (
    <img
      src={solutionHubIcon}
      alt=""
      aria-hidden
      className={`shrink-0 object-contain ${className ?? ""}`}
    />
  );
}
