#!/usr/bin/env bash
# Seeds a demo PostHog project with activity for the emails in scripts/seed-people.txt.
# Reads POSTHOG_HOST and POSTHOG_PROJECT_API_KEY from .env at the repo root.
# Usage: scripts/seed-posthog.sh [--dry-run]   (--dry-run prints the batch body without the key)
#
# Timestamps are relative to SEED_ANCHOR (default: today 00:00 UTC) and every event uuid is derived
# from (anchor, email, event index), so reruns with the same anchor send identical events.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PEOPLE_FILE="$ROOT/scripts/seed-people.txt"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

for cmd in curl jq; do
  command -v "$cmd" >/dev/null || { echo "missing dependency: $cmd" >&2; exit 1; }
done

if [[ -f "$ROOT/.env" ]]; then
  set -a; . "$ROOT/.env"; set +a
fi
: "${POSTHOG_HOST:?POSTHOG_HOST missing from .env}"
: "${POSTHOG_PROJECT_API_KEY:?POSTHOG_PROJECT_API_KEY missing from .env}"

# Capture goes to the ingestion host, not the app host.
case "${POSTHOG_HOST%/}" in
  https://us.posthog.com|https://app.posthog.com) CAPTURE_HOST=https://us.i.posthog.com ;;
  https://eu.posthog.com) CAPTURE_HOST=https://eu.i.posthog.com ;;
  *) CAPTURE_HOST=${POSTHOG_HOST%/} ;;   # self-hosted: app and capture share a host
esac

if command -v sha256sum >/dev/null; then sha() { sha256sum | cut -c1-32; }
else sha() { shasum -a 256 | cut -c1-32; }; fi

# Deterministic UUID v4 layout from a seed string.
uuid() {
  local h; h=$(printf '%s' "$1" | sha)
  printf '%s-%s-4%s-%x%s-%s' "${h:0:8}" "${h:8:4}" "${h:13:3}" \
    $(( (16#${h:16:1} & 3) | 8 )) "${h:17:3}" "${h:20:12}"
}

NOW=$(date -u +%s)
ANCHOR=${SEED_ANCHOR:-$(( NOW - NOW % 86400 ))}
SITE=https://demo.posthog-activity.example
DAY=86400
HOUR=3600

events='[]'
i=0
# add <distinct_id> <event> <seconds before anchor> <path or ""> [extra properties JSON]
add() {
  local id=$1 event=$2 ago=$3 path=$4 extra=${5:-'{}'} n=$(( ${#seq[@]} ))
  seq+=(x)
  events=$(jq -c --arg id "$id" --arg event "$event" --argjson ts $(( ANCHOR - ago )) \
    --arg url "${path:+$SITE$path}" --argjson extra "$extra" \
    --arg uuid "$(uuid "seed|$ANCHOR|$email|$n")" \
    '. + [{ uuid: $uuid, event: $event, distinct_id: $id, timestamp: ($ts | todate),
            properties: ((if $url == "" then {} else { "$current_url": $url } end) + $extra) }]' \
    <<<"$events")
}

while IFS= read -r line || [[ -n "$line" ]]; do
  email=$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  [[ -z "$email" || "$email" == \#* ]] && continue
  seq=()
  anon="seed-anon-$(printf '%s' "$email" | sha | cut -c1-12)"
  signup=$(( (21 + i) * DAY - 9 * HOUR ))   # 21+i days before anchor, 09:00 UTC

  # Anonymous visit, then identify and signup, all inside the trailing 30 days.
  add "$anon" '$pageview' $(( signup + 600 )) /
  add "$anon" '$pageview' $(( signup + 420 )) /pricing
  add "$email" '$identify' $(( signup + 300 )) "" \
    "$(jq -nc --arg anon "$anon" --arg email "$email" '{ "$anon_distinct_id": $anon, "$set": { email: $email } }')"
  add "$email" signup_completed $(( signup + 240 )) /signup
  # Identified pageviews spread over 40 days; two are older than 30 days.
  add "$email" '$pageview' $(( 38 * DAY )) /blog/launch
  add "$email" '$pageview' $(( 33 * DAY )) /docs/getting-started
  add "$email" '$pageview' $(( (10 + i) * DAY )) /docs/api
  add "$email" '$pageview' $(( (3 + i) * DAY )) /pricing
  add "$email" '$pageview' $(( (2 * i + 1) * HOUR )) /app/dashboard
  # A later custom event, so last seen differs from the latest pageview.
  add "$email" report_exported $(( (2 * i + 1) * HOUR - 600 )) ""
  i=$(( i + 1 ))
done <"$PEOPLE_FILE"

[[ $i -gt 0 ]] || { echo "no emails in $PEOPLE_FILE" >&2; exit 1; }

if $DRY_RUN; then
  jq '{ batch: . }' <<<"$events"
  exit 0
fi

# Body goes through stdin so the key never appears in the process list.
status=$(jq -c --arg key "$POSTHOG_PROJECT_API_KEY" '{ api_key: $key, batch: . }' <<<"$events" \
  | curl -sS -o /dev/null -w '%{http_code}' -X POST "$CAPTURE_HOST/batch/" \
      -H 'Content-Type: application/json' --data-binary @-)
if [[ "$status" != 200 ]]; then
  echo "capture failed: HTTP $status" >&2
  exit 1
fi
echo "sent $(jq length <<<"$events") events for $i people to $CAPTURE_HOST (anchor $(jq -nr --argjson a "$ANCHOR" '$a | todate'))"
