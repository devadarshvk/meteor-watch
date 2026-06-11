#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${ZAP_BASE_URL:-http://localhost:3000}"
CREATE_TASK_BODY="${1:-$(dirname "$0")/create-task.json}"
TURN_BODY="${2:-$(dirname "$0")/create-turn.json}"

usage() {
  cat <<'EOF'
Create a ZAP v2 task, then post a turn using the returned task id.

Usage:
  create-task-and-turn.sh [create-task-body.json] [turn-body.json]

Environment:
  ZAP_TOKEN      Bearer JWT (required)
  ZAP_BASE_URL   API base URL (default: http://localhost:3000)

Example:
  export ZAP_TOKEN="eyJ..."
  ./create-task-and-turn.sh ./create-task.json ./create-turn.json
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${ZAP_TOKEN:-}" ]]; then
  echo "error: ZAP_TOKEN is required (Auth0 bearer JWT)" >&2
  exit 1
fi

if [[ ! -f "$CREATE_TASK_BODY" ]]; then
  echo "error: create-task body file not found: $CREATE_TASK_BODY" >&2
  exit 1
fi

if [[ ! -f "$TURN_BODY" ]]; then
  echo "error: turn body file not found: $TURN_BODY" >&2
  exit 1
fi

auth_header=(-H "Authorization: Bearer ${ZAP_TOKEN}")

echo "POST ${BASE_URL}/zap/api/v2/tasks/"
create_response="$(
  curl -sS -X POST "${BASE_URL}/zap/api/v2/tasks/" \
    -H "Content-Type: application/json" \
    "${auth_header[@]}" \
    -d @"${CREATE_TASK_BODY}"
)"

task_id="$(
  printf '%s' "$create_response" | python3 -c '
import json, sys
data = json.load(sys.stdin)
task_id = data.get("id")
if not task_id:
    sys.stderr.write(json.dumps(data, indent=2) + "\n")
    sys.exit(1)
print(task_id)
' 2>/dev/null
)" || {
  echo "error: failed to create task" >&2
  printf '%s\n' "$create_response" >&2
  exit 1
}

echo "Created task id: ${task_id}"
echo
echo "POST ${BASE_URL}/zap/api/v2/tasks/${task_id}/turns"
turn_response="$(
  curl -sS -X POST "${BASE_URL}/zap/api/v2/tasks/${task_id}/turns" \
    -H "Content-Type: application/json" \
    "${auth_header[@]}" \
    -d @"${TURN_BODY}"
)"

printf '%s\n' "$turn_response" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$turn_response"
