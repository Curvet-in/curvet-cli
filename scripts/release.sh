#!/usr/bin/env bash
#
# Release @curvet/cli to npm from your machine (no CI, no token).
# 'npm publish' will prompt you to authorize with your passkey -- approve it.
#
# Usage:
#   ./scripts/release.sh            # publish the CURRENT package.json version
#   ./scripts/release.sh patch      # bump patch, then publish   (0.1.0 -> 0.1.1)
#   ./scripts/release.sh minor      # bump minor, then publish   (0.1.0 -> 0.2.0)
#   ./scripts/release.sh major      # bump major, then publish   (0.1.0 -> 1.0.0)
#
# Order is deliberate: validate -> bump+tag (local) -> publish -> push.
# If publish is cancelled/fails, nothing is pushed to GitHub; just fix and
# re-run 'npm publish && git push --follow-tags origin main' to finish.
set -euo pipefail

BUMP="${1:-}"
if [ -n "${BUMP}" ] && [ "${BUMP}" != "patch" ] && [ "${BUMP}" != "minor" ] && [ "${BUMP}" != "major" ]; then
  echo "Usage: ./scripts/release.sh [patch|minor|major]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Guardrails
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "${branch}" != "main" ]; then
  echo "Releases must be cut from 'main' (currently on '${branch}')." >&2
  exit 1
fi
if [ -n "$(git status --porcelain | grep -v '^??')" ]; then
  echo "Working tree has uncommitted changes. Commit or stash first." >&2
  exit 1
fi

# Validate before bumping so we never tag a broken version.
echo "==> Validating (install, typecheck, test, build)..."
npm ci
npm run typecheck
npm test
npm run build

# Sanity-check the built binary before it ships.
echo "==> Smoke testing dist/index.js..."
node dist/index.js --version >/dev/null

# Bump (optional). npm version commits and creates the vX.Y.Z tag.
if [ -n "${BUMP}" ]; then
  echo "==> Bumping ${BUMP}..."
  npm version "${BUMP}" -m "release: v%s"
fi

VERSION="v$(node -p "require('./package.json').version")"

# Tag the current version if it isn't tagged yet (e.g. no-bump release).
if ! git rev-parse "${VERSION}" >/dev/null 2>&1; then
  git tag -a "${VERSION}" -m "release ${VERSION}"
fi

# Publish. npm will prompt for passkey/2FA authorization in your browser.
echo "==> Publishing @curvet/cli@${VERSION#v} to npm..."
echo "    (npm will ask you to authorize with your passkey -- approve it to continue.)"
npm publish

# Only reached after a successful publish.
echo "==> Pushing ${VERSION} to GitHub..."
git push --follow-tags origin main

echo "OK: published @curvet/cli@${VERSION#v} and pushed ${VERSION}."
