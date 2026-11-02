#!/usr/bin/env bash
# Installs (or removes) the cron entry that drains the ingestion queue.
#
#   ./scripts/install-ingest-cron.sh          # install / refresh the entry
#   ./scripts/install-ingest-cron.sh --remove # take it out again
#
# Cron granularity is one minute, so an entry alone would ingest a file two to
# three minutes after upload instead of the intended 120 seconds. Each tick runs
# the worker in --cron mode, which waits until the job's exact due time
# (upload + 120s, stored in ingestion_jobs.not_before) before claiming it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARK="scripts/ingest-worker.ts --cron"

if [[ "${1:-}" == "--remove" ]]; then
  crontab -l 2>/dev/null | grep -vF "$MARK" | crontab - || true
  echo "Removed the ingestion cron entry."
  exit 0
fi

BUN="$(command -v bun || true)"
if [[ -z "$BUN" ]]; then
  echo "bun is not on PATH; install it before scheduling the worker." >&2
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "warning: $ROOT/.env is missing. The worker needs SUPABASE_DB_URL," >&2
  echo "         SUPABASE_URL, a service role or member credential, and TOKENFACTORY_*." >&2
fi

# cron does not source a shell profile, so bun is absolute and the cd is what
# lets bun load .env from the project root.
LINE="* * * * * cd '$ROOT' && '$BUN' scripts/ingest-worker.ts --cron >> '$ROOT/.ingest.log' 2>&1"

{
  crontab -l 2>/dev/null | grep -vF "$MARK" || true
  printf '%s\n' "$LINE"
} | sed '/^$/d' | crontab -

echo "Installed cron entry:"
echo "  $LINE"
echo "Worker output: $ROOT/.ingest.log"
echo "Verify with: crontab -l"
