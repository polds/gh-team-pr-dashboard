#!/usr/bin/env bash
# Checks the release scripts with no registry and no network: scripts/next-version.sh, which decides the
# version that the release workflow tags, and scripts/push-chart.sh, which publishes the chart.
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

# push-chart.sh, driven by a stand-in for helm. The stand-in fails its first FAIL_PUSHES pushes the way GHCR
# does, counts the pushes, and "pulls" whatever file PULL_RETURNS names.
push_chart="$(dirname "$next")/push-chart.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf 'the chart' > "$work/pr-review-radar-1.2.3.tgz"
printf 'the chart' > "$work/pr-review-radar-0.0.0-edge.tgz"
printf 'something else' > "$work/other.tgz"
cat > "$work/helm" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
	push)
		count="$(($(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1))"
		echo "$count" > "$COUNT_FILE"
		if [ "$count" -le "${FAIL_PUSHES:-0}" ]; then
			echo 'Error: failed to perform "Tag" on destination: sha256:b9ee: not found' >&2
			exit 1
		fi
		;;
	pull)
		# helm pull <registry>/<name> --version <version> --destination <dir>
		echo "$2 $4" > "$PULL_FILE"
		cp "$PULL_RETURNS" "$6/$(basename "$2")-$4.tgz"
		;;
esac
FAKE
chmod +x "$work/helm"

# push_case <name> <package> <pushes that fail> <file the pull returns> <expected exit> <expected pushes>
push_case() {
	local name="$1" package="$2" fail="$3" returns="$4" want_exit="$5" want_pushes="$6"
	rm -f "$work/count" "$work/pull"
	HELM="$work/helm" PUSH_RETRY_SECONDS=0 COUNT_FILE="$work/count" PULL_FILE="$work/pull" FAIL_PUSHES="$fail" \
		PULL_RETURNS="$returns" "$push_chart" "$package" oci://registry.test/charts >/tmp/verify-release.out 2>&1
	local got_exit=$? got_pushes
	got_pushes="$(cat "$work/count" 2>/dev/null || echo 0)"
	if [ "$got_exit" = "$want_exit" ] && [ "$got_pushes" = "$want_pushes" ]; then
		passed=$((passed + 1))
		echo "PASS  $name"
	else
		failed=$((failed + 1))
		echo "FAIL  $name: expected exit $want_exit after $want_pushes pushes, got exit $got_exit after $got_pushes"
		sed 's/^/      /' /tmp/verify-release.out
	fi
}

release="$work/pr-review-radar-1.2.3.tgz"
push_case "a chart push that works the first time is pushed once" "$release" 0 "$release" 0 1
push_case "a chart push that GHCR fails twice succeeds on the third attempt" "$release" 2 "$release" 0 3
push_case "a chart push that never works fails after five attempts" "$release" 99 "$release" 1 5
push_case "a pushed chart that pulls back different is a failure" "$release" 0 "$work/other.tgz" 1 1
push_case "an edge chart is pulled back by its pre-release version" "$work/pr-review-radar-0.0.0-edge.tgz" 0 "$work/pr-review-radar-0.0.0-edge.tgz" 0 1
if [ "$(cat "$work/pull" 2>/dev/null)" = "oci://registry.test/charts/pr-review-radar 0.0.0-edge" ]; then
	passed=$((passed + 1))
	echo "PASS  the pull-back asks for the chart by name and version"
else
	failed=$((failed + 1))
	echo "FAIL  the pull-back asked for: $(cat "$work/pull" 2>/dev/null)"
fi

echo
echo "$passed of $((passed + failed)) checks passed"
[ "$failed" -eq 0 ]
