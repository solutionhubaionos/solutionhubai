#!/usr/bin/env bash
# Installs (or removes) the cron entry that drains the ingestion queue.
#
#   ./scripts/install-ingest-cron.sh                  # install, 5 workers
#   ./scripts/install-ingest-cron.sh --workers 8      # choose the concurrency
#   ./scripts/install-ingest-cron.sh --remove         # take it out again
#
# Cron granularity is one minute, so an entry alone would ingest a file two to
# three minutes after upload instead of the intended 120 seconds. Each tick runs
# the worker in --cron mode, which waits until the job's exact due time
# (upload + 120s, stored in ingestion_jobs.not_before) before claiming it.
#
# Each tick starts several worker processes. They can never ingest the same file
# twice: worker_claim_job() claims with `for update skip locked`.
#
# Only one tick runs at a time. A tick stays alive while it has work -- it drains
# everything already due, and one large deck can take minutes -- so without a lock
# the next minute's entry starts a second process alongside it. Those pile up, all
# commit into the same HNSW index, and Supabase's statement timeout starts aborting
# writes. `flock -n` makes an overlapping tick exit immediately instead, which caps
# concurrency at exactly --workers.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARK="scripts/ingest-worker.ts --cron"
WORKERS=5

if [[ "${1:-}" == "--remove" ]]; then
  crontab -l 2>/dev/null | grep -vF "$MARK" | crontab - || true
  echo "Removed the ingestion cron entry."
  exit 0
fi

if [[ "${1:-}" == "--workers" ]]; then
  WORKERS="${2:-}"
  if ! [[ "$WORKERS" =~ ^[0-9]+$ ]] || (( WORKERS < 1 || WORKERS > 16 )); then
    echo "--workers needs a whole number from 1 to 16." >&2
    exit 1
  fi
fi

BUN="$(command -v bun || true)"
if [[ -z "$BUN" ]]; then
  echo "bun is not on PATH; install it before scheduling the worker." >&2
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "warning: $ROOT/.env is missing. The worker needs SUPABASE_URL," >&2
  echo "         SUPABASE_PUBLISHABLE_KEY, LIBRARY_USER_EMAIL/PASSWORD, and TOKENFACTORY_*." >&2
  echo "         The account must also be in public.ingestion_worker_users (0017)." >&2
fi

# cron does not source a shell profile, so bun is absolute and the cd is what
# lets bun load .env from the project root.
#
# flock is part of util-linux on Linux; macOS does not ship it. Without it the
# entry still works, it just cannot prevent a slow tick from overlapping.
LOCK="$ROOT/.ingest.lock"
WORKER_CMD="'$BUN' scripts/ingest-worker.ts --cron --workers $WORKERS"
if command -v flock >/dev/null 2>&1; then
  RUN="flock -n '$LOCK' $WORKER_CMD"
  OVERLAP="prevented (flock -n on .ingest.lock)"
else
  RUN="$WORKER_CMD"
  OVERLAP="NOT prevented (flock not found on PATH)"
fi

LINE="* * * * * cd '$ROOT' && $RUN >> '$ROOT/.ingest.log' 2>&1"

{
  crontab -l 2>/dev/null | grep -vF "$MARK" || true
  printf '%s\n' "$LINE"
} | sed '/^$/d' | crontab -

echo "Installed cron entry:"
echo "  $LINE"
echo "Concurrency: $WORKERS worker process(es); each claims a different job."
echo "Overlapping ticks: $OVERLAP"
echo "Worker output: $ROOT/.ingest.log"
echo "Verify with: crontab -l"
