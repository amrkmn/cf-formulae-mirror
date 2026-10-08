#!/bin/sh
set -e

START_TS=$(date '+%Y-%m-%d %H:%M:%S')
START_SEC=$(date '+%s')
echo "Sync started at ${START_TS}."

# Report the outcome on every exit, including failures that set -e triggers.
finish() {
    exit_code=$?
    DURATION=$(( $(date '+%s') - START_SEC ))
    END_TS=$(date '+%Y-%m-%d %H:%M:%S')
    if [ "${exit_code}" -eq 0 ]; then
        echo "Sync completed at ${END_TS} (${DURATION}s)."
    else
        echo "Sync failed at ${END_TS} (${DURATION}s)." >&2
    fi
}
trap finish EXIT

REPO="Homebrew/formulae.brew.sh"
ARTIFACT_FILE=".version"

# Run from the repository root. This script lives in .forgejo/scripts/.
cd "$(dirname "$0")/../.."

# --- Load GITHUB_TOKEN from .env if not already set ---
if [ -z "${GITHUB_TOKEN:-}" ] && [ -f ".env" ]; then
    GITHUB_TOKEN=$(grep '^GITHUB_TOKEN=' .env | cut -d '=' -f 2- | tr -d '"' | tr -d "'" | tr -d '\r')
    export GITHUB_TOKEN
fi

# --- Check required commands ---
if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: Required command 'gh' not found." >&2
    exit 1
fi

# --- Fetch latest artifact ID (gh reads GH_TOKEN or GITHUB_TOKEN from the environment) ---
LATEST_ID=$(timeout 60 gh api "repos/${REPO}/actions/artifacts?name=github-pages" \
    --jq '[.artifacts[] | select(.workflow_run.head_branch == "main" and .expired == false)] | first | .id')

if [ -z "${LATEST_ID}" ] || [ "${LATEST_ID}" = "null" ]; then
    echo "ERROR: Could not find a valid github-pages artifact on main." >&2
    exit 1
fi

CURRENT_ID=$(cat "${ARTIFACT_FILE}" 2>/dev/null || echo "")

if [ "${LATEST_ID}" = "${CURRENT_ID}" ]; then
    echo "Already up to date: #${LATEST_ID}"
    exit 0
fi

if [ -z "${CURRENT_ID}" ]; then
    CURRENT_LABEL="none"
else
    CURRENT_LABEL="${CURRENT_ID}"
fi
echo "New artifact available: #${LATEST_ID} (current: #${CURRENT_LABEL})"

echo "${LATEST_ID}" > "${ARTIFACT_FILE}"
echo "Updated ${ARTIFACT_FILE} to #${LATEST_ID}."
