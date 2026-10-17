#!/usr/bin/env bash
# Curl-based agent test: a short conversation that must end in a valid iFlow proposal.
# Needs a running server (npm run watch:hybrid), curl and jq.
#
#   scripts/test-chat.sh [api-base]      default: http://localhost:4005/api
#
# Read-only on the tenant: the agent only reads and proposes; nothing is approved here.
set -euo pipefail

API="${1:-http://localhost:4005/api}"
MAX_TURNS=4
IFLOW_ID="Pilot_Chat_$(date +%s)"   # unique, so the proposal does not clash with existing iFlows

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1) LLM health"
curl -sS "$API/llm-health" | tee /dev/stderr | jq -e '.ok == true' > /dev/null || { echo "LLM not reachable — fix the NVIDIA_LLM destination / LLM_MODEL first"; exit 1; }

send() { # $1 = session id or "", $2 = message; prints progress to stderr, the finished turn as JSON to stdout
  local body started turn status seen=0
  body=$(jq -n --arg s "$1" --arg m "$2" 'if $s == "" then {message: $m} else {sessionId: $s, message: $m} end')
  started=$(curl -sS -X POST "$API/chat" -H 'Content-Type: application/json' -d "$body")
  echo "$started" | jq -e '.turnId' > /dev/null || { echo "$started"; return; }
  local turn_id session_id
  turn_id=$(echo "$started" | jq -r '.turnId'); session_id=$(echo "$started" | jq -r '.sessionId')
  echo "   turn $turn_id started" >&2
  while :; do                                   # poll GET /api/chat/turns/{id} every 2s
    sleep 2
    turn=$(curl -sS "$API/chat/turns/$turn_id")
    echo "$turn" | jq -r --argjson n "$seen" '.events[$n:][] | "   · \(.label)\(if .detail then " (\(.detail))" else "" end)"' >&2
    seen=$(echo "$turn" | jq '.events | length')
    status=$(echo "$turn" | jq -r '.status')
    [ "$status" != "RUNNING" ] && break
  done
  echo "$turn" | jq --arg s "$session_id" '. + {sessionId: $s} | if .status == "DONE" then . else . + {error: (.error // {message: .status})} end'
}

MESSAGE="Please build an iFlow with id ${IFLOW_ID} and name ${IFLOW_ID} in package PilotReference.
It is called via HTTPS at /pilot/chat-test with a JSON order. It should set the header Source to iFlowPilot,
convert the JSON to XML and POST it to https://httpbin.org/post (externalize that URL as parameter ReceiverURL).
No authentication is needed and errors can simply fail the message."

SESSION=""
for turn in $(seq 1 $MAX_TURNS); do
  say "$((turn + 1))) User: ${MESSAGE}"
  REPLY=$(send "$SESSION" "$MESSAGE")
  if echo "$REPLY" | jq -e '.error and .status != "DONE"' > /dev/null 2>&1; then
    echo "$REPLY" | jq .
    exit 1
  fi
  SESSION=$(echo "$REPLY" | jq -r '.sessionId')
  say "Assistant:"
  echo "$REPLY" | jq -r '.text'

  COUNT=$(echo "$REPLY" | jq '.proposals // [] | length')
  if [ "$COUNT" -gt 0 ]; then
    ID=$(echo "$REPLY" | jq -r '.proposals[-1].ID')
    say "Proposal ${ID} (from GET $API/Proposals/${ID}):"
    curl -sS "$API/Proposals/${ID}" | jq '{ID, kind, status, iflowId, packageId, spec}'
    STATUS=$(curl -sS "$API/Proposals/${ID}" | jq -r '.status')
    [ "$STATUS" = "PENDING" ] || { echo "Unexpected proposal status: $STATUS"; exit 1; }
    say "OK: valid proposal after ${turn} turn(s). Session ${SESSION}"
    echo "Approve:  curl -sS -X POST $API/Proposals/${ID}/approve -H 'Content-Type: application/json' -d '{\"deploy\":false}' | jq"
    echo "Reject:   curl -sS -X POST $API/Proposals/${ID}/reject  -H 'Content-Type: application/json' -d '{\"reason\":\"not needed\"}' | jq"
    echo "Progress: curl -sS $API/Proposals/${ID} | jq '{status, error, steps: .result.steps}'"
    exit 0
  fi
  MESSAGE="Use sensible defaults for anything still open and propose the iFlow now."
done

echo "No proposal after ${MAX_TURNS} turns"
exit 1
