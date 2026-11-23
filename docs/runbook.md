# Run PR Review Radar

This guide takes you from nothing to a running board. You need to be an owner of the GitHub organization, or have one available, and you need deploy access to the GKE cluster.

## Try it without GitHub

Run the board against a simulated organization. You need no GitHub App and no secrets.

```
npm install
npm run build
RADAR_DEMO=1 npm start
```

Open `http://localhost:8080`. Pick any demo user. A scripted story plays one step every 8 seconds and starts over after the last step.

To step by hand, set `RADAR_DEMO_INTERVAL_SECONDS=0`, then run `curl -X POST localhost:8080/demo/step` for the next step or `curl -X POST localhost:8080/demo/reset` to start over. The demo keeps nothing on disk and makes a new session secret at each start. It simulates the one-click re-request, so `RADAR_REREQUEST_ENABLED` defaults to `true` in the demo.

## Create the GitHub App

1. In the organization, open **Settings**, then **Developer settings**, then **GitHub Apps**, then **New GitHub App**.
2. Enter the values from `deploy/github-app-manifest.json`. Replace both example hosts with your own.
3. Set these permissions and no others.

	| Permission | Access | Why Radar needs it |
	|---|---|---|
	| Repository: Metadata | Read | Required by GitHub for every app. |
	| Repository: Pull requests | Read | Pull request, review, and thread data, and their webhooks. |
	| Repository: Checks | Read | Check runs and their webhooks. |
	| Repository: Commit statuses | Read | Commit statuses and the `status` webhook. |
	| Organization: Members | Read | Team membership for team review requests, and the sign-in membership check. |

4. Subscribe to these events: `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `check_suite`, `check_run`, and `status`.
5. Set a webhook secret. Generate it with `openssl rand -hex 32`.
6. Under **Where can this GitHub App be installed?**, select **Only on this account**.
7. Create the app. Generate a private key and a client secret.
8. Install the app on the organization. Select **All repositories**, or select the repositories that you want on the board.

Radar does not ask for Contents or Administration access. It cannot read code.

### Turn on the one-click re-request

The one-click re-request is optional. To use it, change **Pull requests** to **Read and write** and set `RADAR_REREQUEST_ENABLED=true`. Radar then calls `POST /repos/{owner}/{repo}/pulls/{number}/requested_reviewers` with the signed-in author's own token, so GitHub shows the author as the person who re-requested. Radar makes no other write.

Without that permission, the card's button stores the author's signal in Radar and links to the pull request on GitHub.

## Install with Helm

The chart is `deploy/helm/pr-review-radar`. Each release publishes it to `oci://ghcr.io/polds/charts/pr-review-radar`, next to the image `ghcr.io/polds/gh-team-pr-dashboard`. See [Release](#release).

### Try the chart with no GitHub App

```
helm install radar oci://ghcr.io/polds/charts/pr-review-radar --set demo=true --set ingress.enabled=false
kubectl port-forward svc/radar-pr-review-radar 8080:80
```

Open `http://localhost:8080` and pick a person.

### Install for your organization

1. Write a values file. Two values are required.

	```yaml
	org: atum
	host: radar.internal.example.com
	```

2. Install, and pass the GitHub App credentials on the command line so that they stay out of files.

	```
	helm upgrade --install radar oci://ghcr.io/polds/charts/pr-review-radar \
		--namespace pr-review-radar --create-namespace \
		--values values.yaml \
		--set github.appId=123456 \
		--set github.clientId=Iv1.example \
		--set-file github.clientSecret=client-secret.txt \
		--set-file github.privateKey=private-key.pem \
		--set-file github.webhookSecret=webhook-secret.txt
	```

	The command prints the board URL, the OAuth callback URL, and the webhook URL. Set the last two in the GitHub App's settings.

3. Run `helm test radar --namespace pr-review-radar`. The test asks the running board for `/healthz`.

A render with a missing value fails and names every value that is missing.

To keep the credentials in a Secret that you manage, create it with the five keys `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`, and set `existingSecret` to its name. The chart then needs no `github` values.

The chart generates the key that encrypts session cookies and keeps it across upgrades. Set `sessionSecret` yourself when a tool renders the chart without access to the cluster, such as Argo CD. Otherwise every sync signs everyone out.

The Deployment runs one replica with the `Recreate` strategy, and the replica count is not a value. The board lives in the memory of one process.

### Pull the image from a private registry

A package that GitHub Actions publishes to GHCR starts out private. Either make the two packages visible to your cluster in the package settings on GitHub, or create a pull secret and name it.

```
kubectl -n pr-review-radar create secret docker-registry ghcr \
	--docker-server=ghcr.io --docker-username=YOUR_LOGIN --docker-password=A_TOKEN_WITH_read:packages
```

```yaml
imagePullSecrets:
  - name: ghcr
```

A private chart needs `helm registry login ghcr.io` before `helm install`.

### Settings

`values.yaml` in the chart lists every value with a comment. Settings of the server itself go under `env`, and the server's default applies to anything you leave out.

```yaml
env:
  RADAR_TIME_ZONE: America/Los_Angeles
  RADAR_REREQUEST_ENABLED: true
```

| Variable | Default | Meaning |
|---|---|---|
| `RADAR_ORG` | none | The organization login. |
| `RADAR_BASE_URL` | none | The URL that people open. The OAuth callback is `RADAR_BASE_URL/auth/callback`. |
| `RADAR_TIME_ZONE` | `UTC` | The time zone for the business-hours count in the help-wanted rule. |
| `RADAR_PRIORITY_LABELS` | `priority,urgent,hotfix` | Labels that put a pull request first in its lane. |
| `RADAR_BOT_LOGINS` | `renovate,dependabot,github-actions` | Authors whose pull requests go in the bot group. |
| `RADAR_REPO_DENYLIST` | empty | Repository names to leave off the board. |
| `RADAR_HELP_WANTED_AFTER_HOURS` | `24` | Business hours that a pull request waits on reviewers before it enters the help-wanted lane. |
| `RADAR_RECONCILE_SECONDS` | `300` | Seconds between reconcile sweeps. |
| `RADAR_FULL_SWEEP_EVERY` | `12` | Every this many sweeps, refetch every open pull request, not only the ones whose listing changed. |
| `RADAR_REREQUEST_ENABLED` | `false` | Set to `true` only with the write permission above. |
| `RADAR_DATA_DIR` | `./data` | Directory for the state file. |
| `RADAR_WEB_DIST` | `packages/web/dist` | Directory of the web build. The image sets it. |
| `GITHUB_INSTALLATION_ID` | looked up | The app installation's ID. When it is unset, Radar looks up the organization's installation. |
| `RADAR_DEMO` | empty | `1` runs against the simulated organization. No GitHub variable is needed. |
| `RADAR_DEMO_INTERVAL_SECONDS` | `8` | Seconds between demo steps. `0` turns autoplay off. |
| `PORT` | `8080` | Listen port. |

The chart sets `RADAR_ORG` from `org`, `RADAR_BASE_URL` from `host`, `RADAR_DEMO` from `demo`, and `RADAR_DATA_DIR` itself.

### TLS

The board must be served over HTTPS. Sign-in fails over plain HTTP, because the browser does not send the `Secure` session cookie back.

- Set `ingress.tlsSecretName` to a TLS Secret for `host`, or leave it empty when your ingress controller or an annotation such as cert-manager's supplies the certificate.
- The live board holds one long response open for each tab. Raise your ingress controller's read timeout to an hour. For ingress-nginx, set the annotation `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` under `ingress.annotations`.

### GKE

```yaml
org: atum
host: radar.internal.example.com
ingress:
  className: gce-internal
  tlsSecretName: radar-internal-tls
  annotations:
    kubernetes.io/ingress.allow-http: "false"
webhookIngress:
  enabled: true
  host: radar-hooks.example.com
  className: gce
gke:
  backendConfig: true
  managedCertificate: true
```

- `gke.backendConfig` raises the load balancer's backend timeout to an hour for the live board.
- An internal HTTPS load balancer needs a proxy-only subnet in the cluster's region, and a certificate from your internal certificate authority in the `radar-internal-tls` Secret.
- `gke.managedCertificate` issues a Google-managed certificate for the webhook host. Point the host's DNS record at the ingress address first. Google issues the certificate after the record resolves, which can take up to an hour.

### Webhook exposure

GitHub must reach `/webhooks/github` from the internet. When the board itself is internal, set `webhookIngress.enabled` and `webhookIngress.host`. That second ingress exposes the one path and nothing else. Attach a policy that allows only the `hooks` address ranges from `https://api.github.com/meta`.

If your network allows no inbound traffic from GitHub, leave `webhookIngress` off and set `env.RADAR_RECONCILE_SECONDS` to `60`. The board then follows GitHub with a delay of up to a minute.

## Release

One workflow, `.github/workflows/ci.yml`, tests, builds, and publishes. A second, `.github/workflows/release.yml`, creates the tag that starts a release.

| Event | What it publishes |
|---|---|
| Pull request | Nothing. It runs the tests, checks the chart, installs the chart on a kind cluster with the image built from the commit, and builds the image for `linux/amd64` and `linux/arm64`. |
| Push to `main` | The image as `:edge` and `:sha-<commit>`, and the chart as version `0.0.0-edge`. |
| Tag `vX.Y.Z` | The image as `:X.Y.Z`, `:X.Y`, and `:latest`. The chart as version `X.Y.Z`, which installs image `:X.Y.Z` by default. A GitHub release with the chart attached. |

Publishing runs only after every check passes.

### Cut a release

Run the `release` workflow on `main`. Open **Actions**, pick **release**, and choose **Run workflow**. Or use the command line.

```
gh workflow run release.yml -f bump=minor
```

| Input | Meaning |
|---|---|
| `bump` | `patch`, `minor`, or `major`. The workflow raises that part of the latest release. With no release yet, the latest release counts as `0.0.0`. |
| `version` | An exact version such as `1.4.0`. It overrides `bump`. The workflow refuses a version that exists or that is older than the latest release. |
| `dry_run` | Works out the version and stops. Nothing is tagged. |

The workflow does three things.

1. It checks that the pipeline passed on the current commit of `main`. If the run is red or still going, the workflow stops and tags nothing.
2. It creates the tag `vX.Y.Z` on that commit.
3. It starts the pipeline on the tag. The pipeline runs every gate again and then publishes.

The workflow starts the pipeline itself because GitHub starts no workflow for a tag that another workflow pushed. It needs no personal token and no extra secret.

If step 3 fails, the tag exists and nothing was published. Start the pipeline by hand with `gh workflow run ci.yml --ref vX.Y.Z`.

You can still push a tag yourself. A tag that a person pushes starts the pipeline through its `push` trigger.

```
git tag v1.0.0
git push origin v1.0.0
```

To upgrade a cluster, run the install command again with `--version 1.0.0`.

To check the chart on your machine, install `helm` and `kubeconform`, then run `npm run verify:chart`. To check the version rules and the chart push, run `scripts/verify-release.sh`.

## Check that it works

1. Open `RADAR_BASE_URL/healthz`. It returns `{"ok":true,"lastSweepAt":...}`. `lastSweepAt` is null until the first sweep finishes.
2. Sign in. A member of the organization sees the board. A non-member sees a 403 page.
3. In the GitHub App settings, open **Advanced** and look at **Recent Deliveries**. Each delivery shows a `202` response.
4. Open a draft pull request in any covered repository. The card appears in the drafts group within a few seconds.

## When something is wrong

| Symptom | Cause and fix |
|---|---|
| The pod exits at start and logs `config.invalid` | A variable is missing or malformed. The log line names each one. |
| Deliveries show `401` | The webhook secret in GitHub does not match `GITHUB_WEBHOOK_SECRET`. |
| The board is empty after start | The first sweep is still running, or the app is not installed on any repository. Check the logs for `reconcile`. |
| Cards update only every few minutes | Webhooks do not arrive. Check **Recent Deliveries** and the webhook ingress. |
| Team requests do not show in Mine | The app lacks the organization Members permission, or an organization owner has not approved a permission change. |
| The live connection drops every 30 or 60 seconds | The ingress or load balancer cuts long responses. On GKE set `gke.backendConfig`. Elsewhere raise the controller's read timeout. See TLS above. |
| The `publish` job fails with `failed to perform "Tag" on destination ... not found` | GHCR answered 404 for a manifest that it had just accepted. `scripts/push-chart.sh` retries that case five times. If all five fail, run the job again. The push is safe to repeat. |
| The pod cannot pull the image | The GHCR package is private. See "Pull the image from a private registry". |
| The re-request button reports that GitHub refused | The app lacks Pull requests write, or the author no longer has access to the repository. |

## When Radar is down

Each person can fall back to a saved view on `github.com/pulls` with the query `review-involves:@me is:open`. That view keeps a pull request listed after you review it.

## Rotate a secret

Generate the new value in the GitHub App settings, then run the install command again with the new value. The pod restarts by itself, because the chart stamps the pod with a checksum of the credentials. With `existingSecret`, update that Secret and run `kubectl -n pr-review-radar rollout restart deployment/radar-pr-review-radar`.

To sign everyone out, set a new `sessionSecret`.
