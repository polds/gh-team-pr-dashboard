#!/usr/bin/env bash
# Prints the next release version, without the leading "v".
#
#   git tag --list | scripts/next-version.sh <patch|minor|major> [version]
#
# The existing tags come in on standard input, one per line. Tags that are not vX.Y.Z are ignored.
# With a version argument the script checks that version and prints it. Without one it bumps the latest tag.
# With no release yet, the latest version counts as 0.0.0.
set -euo pipefail

bump="${1:-}"
explicit="${2:-}"

fail() {
	echo "next-version: $1" >&2
	exit 1
}

released="$(grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | sort -V || true)"
latest="$(printf '%s\n' "$released" | tail -n 1)"
latest="${latest:-0.0.0}"

if [ -n "$explicit" ]; then
	version="${explicit#v}"
	[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
		fail "\"$explicit\" is not a version like 1.2.3"
	if printf '%s\n' "$released" | grep -qxF "$version"; then
		fail "v$version is already released"
	fi
	newest="$(printf '%s\n%s\n' "$latest" "$version" | sort -V | tail -n 1)"
	[ "$newest" = "$version" ] || fail "v$version is older than the latest release, v$latest"
	echo "$version"
	exit 0
fi

IFS=. read -r major minor patch <<<"$latest"
case "$bump" in
	major) echo "$((major + 1)).0.0" ;;
	minor) echo "$major.$((minor + 1)).0" ;;
	patch) echo "$major.$minor.$((patch + 1))" ;;
	*) fail "the first argument must be patch, minor, or major, not \"$bump\"" ;;
esac
