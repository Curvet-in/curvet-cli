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

# Bump (optional). The version commit and its tag are both made here.
if [ -n "${BUMP}" ]; then
  echo "==> Bumping ${BUMP}..."

  # File the "Unreleased" notes under the version they are about to become,
  # BEFORE npm version commits — so the release commit carries a changelog that
  # matches what shipped.
  #
  # This did not happen for 0.10.1 or 0.10.2: both went out with their entries
  # still headed "Unreleased", and the next change added a SECOND "Unreleased"
  # above them. Every release quietly made the file less true, and every fix was
  # a manual reshuffle after the fact.
  # Computed, not asked for: `npm version --no-git-tag-version` would tell us,
  # but it does it by WRITING package.json and trusting a later checkout to put
  # it back. A release script should not leave a half-bumped manifest behind if
  # it exits between those two steps.
  NEXT="$(BUMP="${BUMP}" node -p "
    const [a,b,c] = require('./package.json').version.split('.').map(Number);
    ({ major: [a+1,0,0], minor: [a,b+1,0], patch: [a,b,c+1] }[process.env.BUMP] || []).join('.')
  ")"
  if [ -n "${NEXT}" ] && grep -q '^## Unreleased' CHANGELOG.md; then
    # Only the FIRST occurrence, and only when there is something under it.
    awk -v ver="## ${NEXT}" '
      !done && /^## Unreleased$/ { print ver; done=1; next }
      { print }
    ' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
    echo "==> Filed CHANGELOG 'Unreleased' under ${NEXT}"
  fi

  # --no-git-tag-version, then commit it all ourselves.
  #
  # `npm version` refuses to run on a dirty tree, and a STAGED file is dirty as
  # far as it is concerned — so rewriting the changelog first and letting npm
  # commit is not an option, however tidy it looks. That was a real bug: the
  # script edited CHANGELOG.md, npm version saw the change and aborted, and the
  # release stopped with the working tree modified.
  #
  # Bumping without committing and then making the commit here keeps the whole
  # release as ONE commit — manifest, lockfile and changelog together — which is
  # also what you want when reading `git log` later. The tag is applied by the
  # existing tag-if-untagged step below.
  npm version "${BUMP}" --no-git-tag-version >/dev/null
  git add package.json package-lock.json CHANGELOG.md
  git commit -m "release: v$(node -p "require('./package.json').version")"
fi

VERSION="v$(node -p "require('./package.json').version")"

# Tag the current version if it isn't tagged yet (e.g. no-bump release).
if ! git rev-parse "${VERSION}" >/dev/null 2>&1; then
  git tag -a "${VERSION}" -m "release ${VERSION}"
fi

# Publish. npm will prompt for passkey/2FA authorization in your browser.
echo "==> Publishing @curvet/cli@${VERSION#v} to npm..."
echo "    (npm will ask you to authorize with your passkey -- approve it to continue.)"
# --ignore-scripts skips prepublishOnly, which is the same typecheck/test/build
# already run above -- without it every release validates twice. Safe precisely
# because that validation ran, on this exact tree, minutes ago.
npm publish --ignore-scripts

# Only reached after a successful publish.
echo "==> Pushing ${VERSION} to GitHub..."
git push --follow-tags origin main

echo "OK: published @curvet/cli@${VERSION#v} and pushed ${VERSION}."
