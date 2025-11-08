#!/usr/bin/env bash
set -euo pipefail

# ctfd_create_user.sh
# Log in to a CTFd instance using admin/teacher credentials, verify the session,
# extract CSRF token, and create a new user via /api/v1/users.
#
# Requirements: curl, grep, sed, awk, mktemp. jq is optional (for nicer output).
#
# Usage (flags):
#   ./scripts/ctfd_create_user.sh \
#     -b https://your-ctfd.example.edu \
#     -u admin_username -p 'admin_password' [-T API_TOKEN] \
#     -n new_user_name -e new_user_email@example.com -w 'new_user_password' \
#     [-t user] [-c cookies.txt]
#
# Or set environment variables (flags override env):
#   BASE, ADMIN_USER, ADMIN_PASS, API_TOKEN, NEW_NAME, NEW_EMAIL, NEW_PASS, TYPE, COOKIES
#
# Example:
#   ./scripts/ctfd_create_user.sh -b "$BASE" -u "$ADMIN_USER" -p "$ADMIN_PASS" \
#     -n debuguser01 -e debuguser01@example.com -w 'Myuser' -t user -c cookies.txt

# Defaults
BASE=${BASE:-}
ADMIN_USER=${ADMIN_USER:-}
ADMIN_PASS=${ADMIN_PASS:-}
API_TOKEN=${API_TOKEN:-}
NEW_NAME=${NEW_NAME:-}
NEW_EMAIL=${NEW_EMAIL:-}
NEW_PASS=${NEW_PASS:-}
TYPE=${TYPE:-user}
COOKIES=${COOKIES:-cookies.txt}

usage() {
  cat <<USAGE
Usage: $0 -b BASE -u ADMIN_USER -p ADMIN_PASS [-T API_TOKEN] -n NEW_NAME -e NEW_EMAIL -w NEW_PASS [-t TYPE] [-c COOKIES]
  -b   Base URL of CTFd (e.g., https://ctfd.example.edu)
  -u   Admin/teacher username
  -p   Admin/teacher password
  -T   Admin API token (bypasses CSRF; if provided, login is optional)
  -n   New user's name (login)
  -e   New user's email
  -w   New user's password
  -t   New user's type (default: user) — typically user, team, etc.
  -c   Cookie jar path (default: cookies.txt)

You can also provide BASE, ADMIN_USER, ADMIN_PASS, API_TOKEN, NEW_NAME, NEW_EMAIL, NEW_PASS, TYPE, COOKIES as env vars.
USAGE
}

# Parse flags
while getopts ':b:u:p:T:n:e:w:t:c:h' opt; do
  case "$opt" in
    b) BASE="$OPTARG" ;;
    u) ADMIN_USER="$OPTARG" ;;
    p) ADMIN_PASS="$OPTARG" ;;
    T) API_TOKEN="$OPTARG" ;;
    n) NEW_NAME="$OPTARG" ;;
    e) NEW_EMAIL="$OPTARG" ;;
    w) NEW_PASS="$OPTARG" ;;
    t) TYPE="$OPTARG" ;;
    c) COOKIES="$OPTARG" ;;
    h) usage; exit 0 ;;
    :) echo "Missing argument for -$OPTARG" >&2; usage; exit 2 ;;
    \?) echo "Unknown option -$OPTARG" >&2; usage; exit 2 ;;
  esac
done

# Validate inputs
if [[ -z "${BASE}" || -z "${NEW_NAME}" || -z "${NEW_EMAIL}" || -z "${NEW_PASS}" ]]; then
  echo "Error: Required inputs missing." >&2
  usage
  exit 2
fi

# Normalize BASE: remove trailing slash
BASE=${BASE%/}
REFERER="$BASE/"
ORIGIN="$BASE"

# Workspace cookie jar absolute path (to keep relative behavior predictable)
COOKIES_DIR=$(dirname "$COOKIES")
if [[ "$COOKIES_DIR" != "." && ! -d "$COOKIES_DIR" ]]; then
  mkdir -p "$COOKIES_DIR"
fi

# Temp files
LOGIN_HTML=$(mktemp -t ctfd_login_XXXX.html)
RESP_BODY=$(mktemp -t ctfd_resp_XXXX.txt)
trap 'rm -f "$LOGIN_HTML" "$RESP_BODY"' EXIT

# Helper: run curl capturing http code and body
curl_capture() {
  local out_file="$1"; shift
  curl -sS -w '%{http_code}' -o "$out_file" "$@"
}

# --- Logging helpers to match UI backend logs ---
cookie_names_json() {
  local jar="$1"
  if [[ ! -f "$jar" ]]; then echo '[]'; return; fi
  awk 'NF>=7 {seen[$6]=1} END {printf("["); first=1; for (n in seen) { if (!first) printf(","); first=0; printf("\"%s\"", n) } printf("]")}' "$jar"
}
csrf_cookie_value() { local jar="$1"; [[ -f "$jar" ]] || { echo ""; return; }; awk '$6=="csrf_token"{print $7}' "$jar" | tail -n1; }
redact_passwords() { sed -E 's/("password"\s*:\s*")[^"]+("\s*)/\1***\2/gI'; }
log_request() {
  local method="$1"; local url="$2"; local auth_mode="$3"; shift 3
  local referer="$1"; local origin="$2"; local auth_header="$3"; local csrf="$4"; local xcsrf="$5"; shift 5
  local jar="$1"; shift 1
  local payload="${1:-}"; local payload_redacted=""; if [[ -n "$payload" ]]; then payload_redacted=$(echo "$payload" | tr -d '\n' | redact_passwords); fi
  # Minimal log for token-mode GET /api/v1/users/me
  if [[ "$auth_mode" == "token" && "$method" == "GET" && "$url" == *"/api/v1/users/me" ]]; then
    local auth_display="null"; if [[ -n "$auth_header" ]]; then auth_display='"Token ******"'; fi
    printf '[CTFd] request: {"method":"%s","url":"%s","headers":{"Authorization":%s}}' \
      "$method" "$url" "$auth_display"
    echo
    return
  fi
  local cookies_json=$(cookie_names_json "$jar")
  local csrf_ck=$(csrf_cookie_value "$jar")
  local auth_display="null"; if [[ -n "$auth_header" ]]; then auth_display='"Token ******"'; fi
  local ref_json="null"; [[ -n "$referer" ]] && ref_json="\"$referer\""
  local ori_json="null"; [[ -n "$origin" ]] && ori_json="\"$origin\""
  local csrf_json="null"; [[ -n "$csrf" ]] && csrf_json="\"$csrf\""
  local xcsrf_json="null"; [[ -n "$xcsrf" ]] && xcsrf_json="\"$xcsrf\""
  local csrf_ck_json="null"; [[ -n "$csrf_ck" ]] && csrf_ck_json="\"$csrf_ck\""
  printf '[CTFd] request: {"method":"%s","url":"%s","auth":"%s","headers":{"Referer":%s,"Origin":%s,"Authorization":%s,"CSRF-Token":%s,"X-CSRF-Token":%s},"cookies":%s,"csrf_cookie":%s' \
    "$method" "$url" "$auth_mode" \
    "$ref_json" "$ori_json" \
    "$auth_display" \
    "$csrf_json" "$xcsrf_json" \
    "$cookies_json" \
    "$csrf_ck_json"
  if [[ -n "$payload_redacted" ]]; then printf ',"json":%s' "$payload_redacted"; fi
  printf '}'
  echo
}
log_response() {
  local status="$1"; local url="$2"; local file="$3"
  local preview_raw=""; if [[ -f "$file" ]]; then preview_raw=$(head -c 300 "$file" | tr -d '\n'); fi
  # Escape backslashes and quotes for JSON-string safe logging
  local preview_esc
  preview_esc=$(printf '%s' "$preview_raw" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '[CTFd] response: {"status":%s,"url":"%s","body":"%s"}' "$status" "$url" "$preview_esc"
  echo
}

# If API token provided, skip login and go straight to creation with Authorization header
if [[ -n "$API_TOKEN" ]]; then
  printf '\n[Token Mode] Validating token via /api/v1/users/me...\n'
  # Log and call /me with Authorization
  REF_HDR=""; ORIGIN_HDR=""; AUTH_HDR="Token $API_TOKEN"; CSRF_VAL=""
  log_request "GET" "$BASE/api/v1/users/me" "token" "$REF_HDR" "$ORIGIN_HDR" "$AUTH_HDR" "$CSRF_VAL" "" "$COOKIES"
  ME_HTTP=$(curl_capture "$RESP_BODY" -X GET "$BASE/api/v1/users/me" \
    -H 'Accept: application/json' \
    -H "Authorization: Token $API_TOKEN")
  log_response "$ME_HTTP" "$BASE/api/v1/users/me" "$RESP_BODY"

  printf '\n[Token Mode] Creating user %s using API token...\n' "$NEW_NAME"
  CREATE_PAYLOAD=$(cat <<JSON
{
  "name": "${NEW_NAME}",
  "email": "${NEW_EMAIL}",
  "password": "${NEW_PASS}",
  "type": "${TYPE}",
  "verified": true
}
JSON
)
  # Log and call POST /users
  REF_HDR=""; ORIGIN_HDR=""; AUTH_HDR="Token $API_TOKEN"; CSRF_VAL=""; DATA_FOR_LOG="$CREATE_PAYLOAD"
  log_request "POST" "$BASE/api/v1/users" "token" "$REF_HDR" "$ORIGIN_HDR" "$AUTH_HDR" "$CSRF_VAL" "" "$COOKIES" "$DATA_FOR_LOG"
  TOKEN_HTTP=$(curl_capture "$RESP_BODY" -X POST "$BASE/api/v1/users" \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Token $API_TOKEN" \
    --data "$CREATE_PAYLOAD")
  log_response "$TOKEN_HTTP" "$BASE/api/v1/users" "$RESP_BODY"
  if [[ "$TOKEN_HTTP" == 2* ]]; then
    echo "User created (token) HTTP $TOKEN_HTTP"
    if command -v jq >/dev/null 2>&1; then
      jq '.' < "$RESP_BODY"
    else
      head -n 50 "$RESP_BODY"
    fi
    exit 0
  else
    echo "User creation (token) failed: HTTP $TOKEN_HTTP" >&2; head -n 80 "$RESP_BODY" >&2; exit 1
  fi
fi

# Step 1: Fetch /login to get initial cookies and CSRF/nonce
printf '\n[1/4] Fetching login page...\n'
REF_HDR=""; ORIGIN_HDR=""; AUTH_HDR=""; CSRF_VAL=""; DATA_FOR_LOG=""
log_request "GET" "$BASE/login" "session" "$REF_HDR" "$ORIGIN_HDR" "$AUTH_HDR" "$CSRF_VAL" "" "$COOKIES" "$DATA_FOR_LOG"
HTTP=$(curl_capture "$LOGIN_HTML" -c "$COOKIES" -b "$COOKIES" "$BASE/login")
log_response "$HTTP" "$BASE/login" "$LOGIN_HTML"
if [[ "$HTTP" != 2* ]]; then
  echo "Failed to fetch login page: HTTP $HTTP" >&2
  exit 1
fi

# Extract token name and value (supports csrf_token or nonce)
TOKEN_NAME=""
TOKEN=""
if grep -Eqo '<input[^>]*name="(csrf_token|nonce)"[^>]*>' "$LOGIN_HTML"; then
  TOKEN_NAME=$(grep -Eo '<input[^>]*name="(csrf_token|nonce)"[^>]*>' "$LOGIN_HTML" | head -n1 | sed -E 's/.*name="([^"]+)".*/\1/')
  TOKEN=$(grep -Eo '<input[^>]*name="(csrf_token|nonce)"[^>]*>' "$LOGIN_HTML" | head -n1 | sed -E 's/.*value="([^"]+)".*/\1/')
else
  # Fallback: meta csrf-token
  if grep -Eqo '<meta[^>]+name="csrf-token"[^>]+content="[^"]+"' "$LOGIN_HTML"; then
    TOKEN_NAME="csrf_token"
    TOKEN=$(grep -Eo '<meta[^>]+name="csrf-token"[^>]+content="[^"]+"' "$LOGIN_HTML" | head -n1 | sed -E 's/.*content="([^"]+)".*/\1/')
  fi
fi

# Fallback 2: use csrf_token from cookie jar if present
CSRF_COOKIE=$(awk '$6=="csrf_token"{print $7}' "$COOKIES" | tail -n1 || true)
if [[ -z "$TOKEN" && -n "$CSRF_COOKIE" ]]; then
  TOKEN_NAME="csrf_token"
  TOKEN="$CSRF_COOKIE"
fi

if [[ -z "$TOKEN" ]]; then
  echo "Warning: Could not extract CSRF/nonce from login page or cookies. Continuing; server may still accept login via cookies." >&2
fi

# Step 2: Submit login
printf '[2/4] Submitting login for user %s...\n' "$ADMIN_USER"
# Build form data; include both name and username for compatibility
REF_HDR="$BASE/login"; ORIGIN_HDR="$BASE"; AUTH_HDR=""; CSRF_VAL="$TOKEN"; DATA_FOR_LOG=$(printf 'name=%s&username=%s&password=***&%s=%s' "$ADMIN_USER" "$ADMIN_USER" "${TOKEN_NAME:-csrf_token}" "$TOKEN")
log_request "POST" "$BASE/login" "session" "$REF_HDR" "$ORIGIN_HDR" "$AUTH_HDR" "$CSRF_VAL" "$CSRF_VAL" "$COOKIES" "$DATA_FOR_LOG"
LOGIN_HTTP=$(curl_capture "$RESP_BODY" -X POST "$BASE/login" \
  -H "Referer: $BASE/login" \
  -H "Origin: $BASE" \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -c "$COOKIES" -b "$COOKIES" \
  --data-urlencode "name=$ADMIN_USER" \
  --data-urlencode "username=$ADMIN_USER" \
  --data-urlencode "password=$ADMIN_PASS" \
  ${TOKEN:+--data-urlencode "$TOKEN_NAME=$TOKEN"} )
log_response "$LOGIN_HTTP" "$BASE/login" "$RESP_BODY"

if [[ "$LOGIN_HTTP" != 2* && "$LOGIN_HTTP" != 3* ]]; then
  echo "Login failed: HTTP $LOGIN_HTTP" >&2
  head -n 20 "$RESP_BODY" >&2 || true
  exit 1
fi

# Step 3: Verify session via /api/v1/users/me
printf '[3/4] Verifying session at /api/v1/users/me...\n'
REF_HDR=""; ORIGIN_HDR=""; AUTH_HDR=""; CSRF_VAL=""; DATA_FOR_LOG=""
log_request "GET" "$BASE/api/v1/users/me" "session" "$REF_HDR" "$ORIGIN_HDR" "$AUTH_HDR" "$CSRF_VAL" "" "$COOKIES" "$DATA_FOR_LOG"
ME_HTTP=$(curl_capture "$RESP_BODY" -H 'Accept: application/json' -b "$COOKIES" "$BASE/api/v1/users/me")
log_response "$ME_HTTP" "$BASE/api/v1/users/me" "$RESP_BODY"
if [[ "$ME_HTTP" != 2* ]]; then
  echo "Session not authenticated: HTTP $ME_HTTP" >&2
  cat "$RESP_BODY" >&2 || true
  exit 1
fi

# Extract id and success quickly (jq if present, else grep)
ME_ID=""
ME_TYPE=""
if command -v jq >/dev/null 2>&1; then
  ME_ID=$(jq -r '(.data.id) // (.data.user.id) // empty' < "$RESP_BODY" || true)
else
  ME_ID=$(grep -Eo '"id"\s*:\s*[0-9]+' "$RESP_BODY" | head -n1 | sed -E 's/[^0-9]//g' || true)
fi

if [[ -z "$ME_ID" ]]; then
  echo "Could not extract current user id from /me response." >&2
  cat "$RESP_BODY" >&2 || true
  exit 1
fi

# Fetch canonical user to learn role/type
REF_HDR=""; ORIGIN_HDR=""; AUTH_HDR=""; CSRF_VAL=""; DATA_FOR_LOG=""
log_request "GET" "$BASE/api/v1/users/$ME_ID" "session" "$REF_HDR" "$ORIGIN_HDR" "$AUTH_HDR" "$CSRF_VAL" "" "$COOKIES" "$DATA_FOR_LOG"
USER_HTTP=$(curl_capture "$RESP_BODY" -H 'Accept: application/json' -b "$COOKIES" "$BASE/api/v1/users/$ME_ID")
log_response "$USER_HTTP" "$BASE/api/v1/users/$ME_ID" "$RESP_BODY"
if [[ "$USER_HTTP" == 2* ]]; then
  if command -v jq >/dev/null 2>&1; then
    ME_TYPE=$(jq -r '.data.type // empty' < "$RESP_BODY" || true)
  else
    ME_TYPE=$(grep -Eo '"type"\s*:\s*"[^"]+"' "$RESP_BODY" | head -n1 | sed -E 's/.*:\s*"([^"]+)"/\1/' || true)
  fi
fi

if [[ -z "$ME_TYPE" ]]; then
  echo "Warning: Could not determine role/type from /users/$ME_ID. Proceeding." >&2
else
  echo "Authenticated as id=$ME_ID type=$ME_TYPE"
  case "$ME_TYPE" in
    admin|teacher) : ;; # ok
    *) echo "Warning: Role '$ME_TYPE' may not have permission to create users." >&2 ;;
  esac
fi

# Step 4: Extract CSRF token (prefer cookie; fallback to login form token)
CSRF=$(awk '$6=="csrf_token"{print $7}' "$COOKIES" | tail -n1 || true)
if [[ -z "${CSRF}" && -n "${TOKEN:-}" ]]; then
  CSRF="$TOKEN"
fi
if [[ -z "$CSRF" ]]; then
  echo "Error: Could not find CSRF token in cookies or login form." >&2
  exit 1
fi

echo "Using CSRF token: ${CSRF:0:6}... (len=${#CSRF})"

# Step 5: Create the new user
printf '[4/4] Creating user %s...\n' "$NEW_NAME"
CREATE_PAYLOAD=$(cat <<JSON
{
  "name": "${NEW_NAME}",
  "email": "${NEW_EMAIL}",
  "password": "${NEW_PASS}",
  "type": "${TYPE}",
  "verified": true
}
JSON
)

CREATE_REF="$BASE/admin/users"
REF_HDR="$CREATE_REF"; ORIGIN_HDR="$ORIGIN"; AUTH_HDR=""; CSRF_VAL="$CSRF"; DATA_FOR_LOG="$CREATE_PAYLOAD"
log_request "POST" "$BASE/api/v1/users" "session" "$REF_HDR" "$ORIGIN_HDR" "$AUTH_HDR" "$CSRF_VAL" "$CSRF_VAL" "$COOKIES" "$DATA_FOR_LOG"
CREATE_HTTP=$(curl_capture "$RESP_BODY" -X POST "$BASE/api/v1/users" \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H "CSRF-Token: $CSRF" \
  -H "X-CSRF-Token: $CSRF" \
  -H "Referer: $CREATE_REF" \
  -H "Origin: $ORIGIN" \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -c "$COOKIES" -b "$COOKIES" \
  --data "$CREATE_PAYLOAD")
log_response "$CREATE_HTTP" "$BASE/api/v1/users" "$RESP_BODY"

# Show result
if [[ "$CREATE_HTTP" == 2* ]]; then
  echo "User creation HTTP $CREATE_HTTP"
  # Print compact success snippet
  if command -v jq >/dev/null 2>&1; then
    jq '.' < "$RESP_BODY" || true
  else
    head -n 50 "$RESP_BODY" || true
  fi
  exit 0
else
  echo "User creation failed: HTTP $CREATE_HTTP" >&2
  # Print response body and first headers
  head -n 50 "$RESP_BODY" >&2 || true
  exit 1
fi
