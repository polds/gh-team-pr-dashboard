#!/usr/bin/env bash
# Checks scripts/next-version.sh, which decides the version that the release workflow tags.
set -uo pipefail

next="$(cd "$(dirname "$0")" && pwd)/next-version.sh"
passed=0
failed=0

# expect <name> <tags separated by spaces> <expected output, or FAIL> <arguments...>
expect() {
	local name="$1" tags="$2" expected="$3"
	shift 3
	local actual
	if actual="$(printf '%s\n' $tags | "$next" "$@" 2>/tmp/verify-release.err)"; then :; else actual=FAIL; fi
	if [ "$actual" = "$expected" ]; then
		passed=$((passed + 1))
		echo "PASS  $name"
	else
		failed=$((failed + 1))
		echo "FAIL  $name: expected $expected, got $actual"
		sed 's/^/      /' /tmp/verify-release.err
	fi
}

expect "the first patch release is 0.0.1" "" 0.0.1 patch
expect "the first minor release is 0.1.0" "" 0.1.0 minor
expect "the first major release is 1.0.0" "" 1.0.0 major
expect "a patch bump raises the last number" "v1.2.3" 1.2.4 patch
expect "a minor bump resets the patch number" "v1.2.3" 1.3.0 minor
expect "a major bump resets minor and patch" "v1.2.3" 2.0.0 major
expect "the latest tag is found by version, not by text order" "v1.9.0 v1.10.0 v1.2.0" 1.10.1 patch
expect "tags that are not releases are ignored" "v1.2.3 nightly v2.0.0-rc.1 v9 edge" 1.2.4 patch
expect "an explicit version is accepted" "v1.2.3" 1.5.0 patch 1.5.0
expect "an explicit version may carry the leading v" "v1.2.3" 1.5.0 patch v1.5.0
expect "an explicit version that is already released is refused" "v1.2.3" FAIL patch 1.2.3
expect "an explicit version older than the latest release is refused" "v1.2.3 v2.0.0" FAIL patch 1.9.0
expect "an explicit version that is not X.Y.Z is refused" "v1.2.3" FAIL patch 1.3
expect "a pre-release version is refused" "v1.2.3" FAIL patch 1.3.0-rc.1
expect "a version with a leading zero is refused" "v1.2.3" FAIL patch 1.03.0
expect "a version that tries to smuggle a command is refused" "v1.2.3" FAIL patch '1.3.0; echo pwned'
expect "an unknown bump is refused" "v1.2.3" FAIL bigger

echo
echo "$passed of $((passed + failed)) checks passed"
[ "$failed" -eq 0 ]
