#!/usr/bin/env bash
# Pushes a packaged chart to an OCI registry and proves that the tag is there.
#
#   scripts/push-chart.sh <chart.tgz> <oci://registry/path>
#
# Helm pushes the manifest by digest and then reads it back to tag it. GHCR can answer 404 for a manifest
# that it accepted a moment before, most often on the first push to a new package. The push then fails with
# 'failed to perform "Tag" on destination: ... not found', and leaves the manifest in the registry with no
# tag. Pushing again is safe: the blobs and the manifest are already there, so the retry only adds the tag.
#
# HELM names the helm binary, and PUSH_RETRY_SECONDS the first wait. Tests set both.
set -euo pipefail

package="$1"
registry="$2"
helm="${HELM:-helm}"
wait_seconds="${PUSH_RETRY_SECONDS:-5}"
attempts=5

file="$(basename "$package" .tgz)"
version="$(printf '%s' "$file" | sed -E 's/^.*-([0-9]+\.[0-9]+\.[0-9]+.*)$/\1/')"
name="${file%-"$version"}"

for attempt in $(seq 1 "$attempts"); do
	if "$helm" push "$package" "$registry"; then
		break
	fi
	if [ "$attempt" -eq "$attempts" ]; then
		echo "push-chart: the push failed $attempts times" >&2
		exit 1
	fi
	echo "push-chart: attempt $attempt failed, trying again in ${wait_seconds}s" >&2
	sleep "$wait_seconds"
	wait_seconds=$((wait_seconds * 2))
done

# A push that reports success is not proof either. Pull the tag back and compare it with what was built.
pulled="$(mktemp -d)"
trap 'rm -rf "$pulled"' EXIT
"$helm" pull "$registry/$name" --version "$version" --destination "$pulled"
if ! cmp -s "$package" "$pulled/$file.tgz"; then
	echo "push-chart: $registry/$name:$version does not match $package" >&2
	exit 1
fi
echo "push-chart: $registry/$name:$version is published and matches the package"
