#!/usr/bin/env bash
# Checks the Helm chart without a cluster: lint, render every case in ci/, validate the output against the
# Kubernetes schemas, and confirm that bad values fail with a readable message.
# Needs helm and kubeconform on PATH.
set -uo pipefail

chart="$(cd "$(dirname "$0")/.." && pwd)/deploy/helm/pr-review-radar"
kube_version="${KUBE_VERSION:-1.31.0}"
passed=0
failed=0

check() {
	local name="$1"
	shift
	if "$@" >/tmp/verify-chart.out 2>&1; then
		passed=$((passed + 1))
		echo "PASS  $name"
	else
		failed=$((failed + 1))
		echo "FAIL  $name"
		sed 's/^/      /' /tmp/verify-chart.out | head -20
	fi
}

render() {
	helm template radar "$chart" --namespace radar --kube-version "$kube_version" "$@"
}

# True when the render fails and its error mentions the given text.
fails_with() {
	local text="$1"
	shift
	if render "$@" >/tmp/verify-chart.render 2>&1; then
		echo "the render succeeded, but it should have failed"
		return 1
	fi
	grep -qF -- "$text" /tmp/verify-chart.render || {
		echo "the error does not mention: $text"
		cat /tmp/verify-chart.render
		return 1
	}
}

# True when the rendered case contains (or with `!`, lacks) a line matching the pattern.
has() { grep -qE -- "$2" "$1"; }
lacks() { ! grep -qE -- "$2" "$1"; }

for case in demo secret gke; do
	values="$chart/ci/$case-values.yaml"
	out="/tmp/verify-chart.$case.yaml"
	check "$case: lints with no warning" helm lint --strict --quiet "$chart" -f "$values"
	check "$case: renders" bash -c "$(declare -f render); chart='$chart' kube_version='$kube_version' render -f '$values' > '$out'"
	check "$case: every resource matches its Kubernetes $kube_version schema" \
		kubeconform -strict -summary -kubernetes-version "$kube_version" \
		-skip BackendConfig,ManagedCertificate "$out"
	check "$case: runs one replica with the Recreate strategy" bash -c "grep -q 'replicas: 1' '$out' && grep -q 'type: Recreate' '$out'"
	check "$case: the container is non-root with a read-only root file system" \
		bash -c "grep -q 'runAsNonRoot: true' '$out' && grep -q 'readOnlyRootFilesystem: true' '$out' && grep -q 'allowPrivilegeEscalation: false' '$out'"
done

demo=/tmp/verify-chart.demo.yaml
secret=/tmp/verify-chart.secret.yaml
gke=/tmp/verify-chart.gke.yaml

check "demo: needs no Secret and no Ingress" bash -c "! grep -qE '^kind: (Secret|Ingress)' '$demo'"
check "demo: sets RADAR_DEMO and no organization" bash -c "grep -q 'RADAR_DEMO: \"1\"' '$demo' && ! grep -q 'RADAR_ORG' '$demo'"
check "demo: the image tag defaults to the chart's appVersion" has "$demo" 'image: "ghcr.io/polds/gh-team-pr-dashboard:edge"'

check "secret: the chart creates the GitHub Secret and a session Secret" bash -c "[ \$(grep -c '^kind: Secret' '$secret') = 2 ]"
check "secret: the base URL is https on the host" has "$secret" 'RADAR_BASE_URL: "https://radar.example.com"'
check "secret: env values pass through as strings" bash -c "grep -q 'RADAR_REREQUEST_ENABLED: \"true\"' '$secret' && grep -q 'RADAR_RECONCILE_SECONDS: \"120\"' '$secret'"
check "secret: the private key keeps its line breaks" has "$secret" 'BEGIN RSA PRIVATE KEY-----\\nnot-a-real-key\\n-----END'
check "secret: the ingress has TLS for the host" bash -c "grep -q 'secretName: \"radar-tls\"' '$secret' && grep -q 'ingressClassName: \"nginx\"' '$secret'"

printf 'from-a-file\n' > /tmp/verify-chart.secretfile
check "secret: a one-line secret passed with --set-file loses its trailing newline" \
	bash -c "$(declare -f render); chart='$chart' kube_version='$kube_version' render -f '$chart/ci/secret-values.yaml' --set-file github.webhookSecret=/tmp/verify-chart.secretfile | grep -q 'GITHUB_WEBHOOK_SECRET: \"from-a-file\"'"

check "gke: uses the existing Secret and creates no GitHub Secret" bash -c "grep -q 'name: radar-github' '$gke' && ! grep -q 'GITHUB_APP_ID' '$gke'"
check "gke: keeps the given session secret" has "$gke" "RADAR_SESSION_SECRET: \"$(printf '0123456789abcdef0123456789abcdef0123456789abcdef' | base64 -w0)\""
check "gke: the webhook ingress exposes only /webhooks/github" bash -c "grep -A12 'host: \"radar-hooks.example.com\"' '$gke' | grep -q 'pathType: Exact' && grep -q 'path: /webhooks/github' '$gke'"
check "gke: the Service points at the BackendConfig with the one hour timeout" bash -c "grep -q 'cloud.google.com/backend-config' '$gke' && grep -q 'timeoutSec: 3600' '$gke'"
check "gke: the managed certificate covers the webhook host" bash -c "grep -A14 'kind: ManagedCertificate' '$gke' | grep -q 'radar-hooks.example.com'"
check "gke: the image tag and the pull secret are applied" bash -c "grep -q 'gh-team-pr-dashboard:1.2.3' '$gke' && grep -A1 'imagePullSecrets:' '$gke' | grep -q 'name: ghcr'"

check "no values: fails and names every missing value" fails_with "needs these values: org, host, github.appId, github.clientId, github.clientSecret, github.privateKey, github.webhookSecret"
check "an existing Secret: needs only org and host" fails_with "needs these values: org." --set host=radar.example.com --set existingSecret=radar-github
check "a misspelled value is refused by the schema" fails_with "hots" --set demo=true --set hots=radar.example.com
check "an env name that is not an environment variable is refused" fails_with "'time-zone' does not match pattern" --set demo=true --set env.time-zone=UTC
check "a webhook ingress without a host fails with a reason" fails_with "webhookIngress.host is required" --set demo=true --set webhookIngress.enabled=true
check "a short session secret is refused" fails_with "sessionSecret" --set demo=true --set sessionSecret=short

packaged="$(mktemp -d)"
check "the chart packages with a release version" helm package "$chart" --version 1.2.3 --app-version 1.2.3 --destination "$packaged"
check "the package leaves out the ci values" bash -c "! tar -tzf '$packaged/pr-review-radar-1.2.3.tgz' | grep -q '/ci/'"
check "the packaged chart defaults the image tag to the release version" \
	bash -c "helm template radar '$packaged/pr-review-radar-1.2.3.tgz' --set demo=true | grep -q 'gh-team-pr-dashboard:1.2.3'"
rm -rf "$packaged"

echo
echo "$passed of $((passed + failed)) checks passed"
[ "$failed" -eq 0 ]
