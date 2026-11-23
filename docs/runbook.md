# Run PR Review Radar

This guide takes you from nothing to a running board. You need to be an owner of the GitHub organization, or have one available, and you need deploy access to the GKE cluster.

## Try it without GitHub

Run the board against a simulated organization. You need no GitHub App and no secrets.

```
npm install
npm run build
RADAR_DEMO=1 npm start
```

Open `http://localhost:8080`. Pick any demo user. The simulated pull requests change state every few seconds.

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

## Configure

Non-secret settings are in `deploy/k8s/config.yaml`.

| Variable | Default | Meaning |
|---|---|---|
| `RADAR_ORG` | none | The organization login. |
| `RADAR_BASE_URL` | none | The URL that people open. The OAuth callback is `RADAR_BASE_URL/auth/callback`. |
| `RADAR_TIME_ZONE` | `UTC` | The time zone for the business-hours count in the help-wanted rule. |
| `RADAR_PRIORITY_LABELS` | `priority,urgent,hotfix` | Labels that put a pull request first in its lane. |
| `RADAR_BOT_LOGINS` | `renovate,dependabot,github-actions` | Authors whose pull requests go in the bot group. |
| `RADAR_REPO_DENYLIST` | empty | Repository names to leave off the board. |
| `RADAR_HELP_WANTED_AFTER_HOURS` | `24` | Business hours that a pull request waits on reviewers before it enters the help-wanted lane. |
| `RADAR_RECONCILE_SECONDS` | `300` | Seconds between full sweeps. |
| `RADAR_REREQUEST_ENABLED` | `false` | Set to `true` only with the write permission above. |
| `RADAR_DATA_DIR` | `./data` | Directory for the state file. |
| `PORT` | `8080` | Listen port. |

Secrets go in a Kubernetes Secret named `radar-secrets`. Do not put them in git.

| Key | Value |
|---|---|
| `GITHUB_APP_ID` | The app's numeric ID. |
| `GITHUB_APP_CLIENT_ID` | The app's client ID. |
| `GITHUB_APP_CLIENT_SECRET` | The client secret. |
| `GITHUB_APP_PRIVATE_KEY` | The private key in PEM format. |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret. |
| `RADAR_SESSION_SECRET` | Output of `openssl rand -hex 32`. It encrypts the session cookie. |

```
kubectl -n pr-review-radar create secret generic radar-secrets \
	--from-literal=GITHUB_APP_ID=123456 \
	--from-literal=GITHUB_APP_CLIENT_ID=Iv1.example \
	--from-literal=GITHUB_APP_CLIENT_SECRET="$(cat client-secret.txt)" \
	--from-file=GITHUB_APP_PRIVATE_KEY=private-key.pem \
	--from-literal=GITHUB_WEBHOOK_SECRET="$(cat webhook-secret.txt)" \
	--from-literal=RADAR_SESSION_SECRET="$(openssl rand -hex 32)"
```

## Deploy

1. Build and push the image.

	```
	docker build -f deploy/Dockerfile -t REGION-docker.pkg.dev/PROJECT/REPOSITORY/pr-review-radar:TAG .
	docker push REGION-docker.pkg.dev/PROJECT/REPOSITORY/pr-review-radar:TAG
	```

2. Set the image in `deploy/k8s/deployment.yaml` and the hosts in the two ingress files and in `config.yaml`.
3. Create the namespace and the secret, then apply.

	```
	kubectl apply -f deploy/k8s/namespace.yaml
	# create radar-secrets as shown above
	kubectl apply -k deploy/k8s
	```

The Deployment runs one replica with the `Recreate` strategy. Do not raise the replica count. The board lives in the memory of one process.

### Webhook exposure

GitHub must reach `/webhooks/github` from the internet. `deploy/k8s/ingress-webhook.yaml` exposes that one path. Attach a Cloud Armor policy that allows only the `hooks` address ranges from `https://api.github.com/meta`.

If your network allows no inbound traffic from GitHub, remove `ingress-webhook.yaml` from `kustomization.yaml` and set `RADAR_RECONCILE_SECONDS` to `60`. The board then follows GitHub with a delay of up to a minute.

## Check that it works

1. Open `RADAR_BASE_URL/healthz`. It returns `ok` and the time of the last sweep.
2. Sign in. A member of the organization sees the board. A non-member sees a 403 page.
3. In the GitHub App settings, open **Advanced** and look at **Recent Deliveries**. Each delivery shows a `202` response.
4. Open a draft pull request in any covered repository. The card appears in the drafts group within a few seconds.

## When something is wrong

| Symptom | Cause and fix |
|---|---|
| Deliveries show `401` | The webhook secret in GitHub does not match `GITHUB_WEBHOOK_SECRET`. |
| The board is empty after start | The first sweep is still running, or the app is not installed on any repository. Check the logs for `reconcile`. |
| Cards update only every few minutes | Webhooks do not arrive. Check **Recent Deliveries** and the webhook ingress. |
| Team requests do not show in Mine | The app lacks the organization Members permission, or an organization owner has not approved a permission change. |
| The live connection drops every 30 seconds | The `BackendConfig` timeout is not applied to the Service. |
| The re-request button reports that GitHub refused | The app lacks Pull requests write, or the author no longer has access to the repository. |

## When Radar is down

Each person can fall back to a saved view on `github.com/pulls` with the query `review-involves:@me is:open`. That view keeps a pull request listed after you review it.

## Rotate a secret

Generate the new value in the GitHub App settings, update `radar-secrets`, and restart the Deployment with `kubectl -n pr-review-radar rollout restart deployment/radar`. A new `RADAR_SESSION_SECRET` signs everyone out.
