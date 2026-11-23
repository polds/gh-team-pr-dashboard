# PR Review Radar design

This document explains the design of PR Review Radar and answers the open questions in the [project brief](./brief.txt). Read the [spike](./spike.md) first. It says why the tool exists and what GitHub already covers.

## What the system does

Radar shows every open pull request in one GitHub organization on one shared board. For each pull request it derives one state and the people who need to act. The board updates in every open browser within seconds of a GitHub event.

Radar never reviews, comments, approves, or merges. The one write to GitHub is a re-request of review that the pull request author starts.

## Two shapes considered

| | Shape A: apply webhook payloads | Shape B: webhook as a hint |
|---|---|---|
| Flow | Each webhook payload mutates a stored pull request record. A reconcile job repairs drift. | Each webhook marks one pull request dirty. The server refetches that pull request with one GraphQL query and derives its state from the result. |
| Code paths that build state | Two. The webhook mapper and the reconcile mapper must agree. | One. The webhook path and the reconcile path call the same fetch and the same `derive`. |
| Out-of-order or duplicate delivery | Needs ordering and deduplication logic. | Harmless. A refetch reads the current truth. |
| Data the payload lacks | `reviewDecision`, `mergeStateStatus`, and thread resolution are not in most payloads, so extra fetches are needed anyway. | Not a problem. |
| Storage | A database of pull request records. | An in-memory map that the reconcile sweep rebuilds on start. |
| API cost | Lowest. | One GraphQL request per pull request per burst of events. |

Radar uses shape B. Each piece of state has one owner. GitHub owns pull request facts. `derive` owns the state. The server owns only what GitHub cannot tell it, which is listed in [What the server stores](#what-the-server-stores).

## Architecture

```
GitHub ──webhook──▶ /webhooks/github ──▶ dirty queue (debounce per PR)
   ▲                                        │
   │ GraphQL (installation token)           ▼
   └──────────────── fetch snapshot ◀── refresher ◀── reconcile sweep (every 5 min, and on start)
                                            │
                                            ▼
                                derive(snapshot, context)  pure function
                                            │
                                            ▼
                                 board (in-memory cards) ──diff──▶ SSE hub ──▶ browsers
                                                                       ▲
                               presence (in-memory, opt-in) ───────────┘
```

The repository has three packages.

- `packages/core` holds the domain. It has no dependencies and no I/O. It contains the snapshot types, `derive`, the card ordering, the Mine filter, the help-wanted rule, and the notification rules.
- `packages/server` holds the GitHub App client, the webhook receiver, the reconcile sweep, the SSE hub, the session and OAuth code, presence, and a demo source.
- `packages/web` holds the React board.

### Ingest

The webhook receiver verifies the `X-Hub-Signature-256` header, then maps the event to pull request references.

| Event | How it maps to a pull request |
|---|---|
| `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` | The payload names the repository and the pull request number. |
| `check_suite`, `check_run` | The payload lists `pull_requests`. For a fork the list is empty, so the receiver falls back to the head SHA. |
| `status` | The payload has a commit SHA. The board keeps an index from head SHA to pull request. |

An event that maps to no known pull request is dropped. The reconcile sweep covers the loss.

The refresher waits 1.5 seconds after the last hint for a pull request, and never more than 5 seconds after the first, then fetches. A burst of 30 `check_run` events costs one request.

The reconcile sweep pages through every repository in the installation and lists its open pull requests with a few cheap fields: `updatedAt`, the head commit, the draft flag, the review decision, mergeability, the merge state, the review request count, and the check rollup. Together they form a fingerprint. The sweep fetches the full snapshot, with the same GraphQL fragment as the refresher, only for a pull request that is new or whose fingerprint moved. Every twelfth sweep (`RADAR_FULL_SWEEP_EVERY`) fetches every open pull request, which catches any change the cheap fields do not show. A pull request that the board holds and the sweep did not see gets one direct refetch, which finds it merged or closed. Running the sweep twice gives the same board, and the second run fetches nothing.

### Push to browsers

The server pushes over Server-Sent Events. The browser needs server-to-client push only. Its few writes are plain `POST` requests. SSE reconnects on its own and passes through the GKE ingress without WebSocket settings.

The browser loads `GET /api/board`, then applies `card` and `remove` events from `GET /api/events`. After a reconnect the browser loads the board again, so a missed event cannot leave the page stale.

## The state engine

`derive(snapshot, context)` is a pure function. The snapshot is one pull request as GitHub describes it now. The context holds team membership and the author signal described in [Author confirm and nudge](#author-confirm-and-nudge).

### Step 1: one status per reviewer

Radar first gives each human reviewer one status. A reviewer is anyone with a pending review request, a submitted review, or a review thread. The pull request author and bots are never reviewers.

| Reviewer status | Rule, first match wins | Ball is with |
|---|---|---|
| `requested` | The reviewer has a pending review request. A re-request after an earlier review also lands here. | Reviewer |
| `approval_dismissed` | The reviewer's latest decisive review is `DISMISSED`. | Reviewer |
| `approved` | The reviewer's latest decisive review is `APPROVED`. | Nobody |
| `feedback_outstanding` | The reviewer has feedback that the author has not addressed. See below. | Author |
| `feedback_addressed` | The reviewer gave feedback, and the heuristic says that the author addressed it. | Reviewer |
| `commented` | The reviewer left a comment-only review and started no thread. | Reviewer |

A decisive review is `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED`.

A reviewer has feedback when the latest decisive review is `CHANGES_REQUESTED`, or when the reviewer started at least one review thread and has not approved. The second case matters because many reviewers leave comments and never click **Request changes**. GitHub's `reviewDecision` ignores that flow.

A thread is addressed when it is resolved, or when the pull request author wrote its last comment. A thread that is unresolved and outdated counts as addressed at reduced confidence, and only while nobody has commented on it since the head commit. A reviewer who replies on an outdated thread after the push reopens it.

The feedback from one reviewer is addressed when both of these hold:

- Every thread that the reviewer started is addressed.
- The author did something after the review. For a `CHANGES_REQUESTED` review, the head commit differs from the commit that the review was submitted on. For comment-only feedback, a new commit or a reply is enough, and so is every thread being resolved.

### Step 2: fold reviewer statuses into one state

The first matching row wins.

| # | Condition | State | Court |
|---|---|---|---|
| 1 | Merged | `merged` | Nobody |
| 2 | Closed without merge | `closed` | Nobody |
| 3 | Draft | `draft` | Author |
| 4 | Any reviewer has a `CHANGES_REQUESTED` review that is `feedback_outstanding`, or `reviewDecision` is `CHANGES_REQUESTED` and no reviewer's change request is in the data | `changes_requested` | Author |
| 5 | Row 4 does not match, `reviewDecision` is `CHANGES_REQUESTED`, and every such reviewer is `feedback_addressed` or `requested` | `likely_ready_for_rereview` if any is `feedback_addressed`, otherwise `in_review` | Reviewers |
| 6 | The pull request is approved and has no merge blocker | `ready_to_merge` | Author, or CI when the pull request is in the merge queue |
| 7 | The pull request is approved and has a merge blocker | `approved_blocked` | From the blocker table |
| 8 | At least one approval exists, and `reviewDecision` is `REVIEW_REQUIRED` | `approved_blocked` | Reviewers |
| 9 | Any reviewer is `feedback_outstanding` from comment threads | `changes_requested` | Author |
| 10 | Any reviewer is `feedback_addressed` | `likely_ready_for_rereview` | Reviewers |
| 11 | Any reviewer has reviewed or commented | `in_review` | Reviewers |
| 12 | Otherwise | `needs_review` | Reviewers |

A pull request is approved when `reviewDecision` is `APPROVED`. When the base branch requires no review, `reviewDecision` is null, and one approval with no outstanding feedback counts as approved.

Row 8 covers a dismissed approval and a second required approval that is still missing. Its blocker is `approval_dismissed` when a reviewer's approval was dismissed, and `review_missing` otherwise.

Merge blockers for rows 6 and 7:

| Blocker | Signal | Court |
|---|---|---|
| `conflicts` | `mergeable` is `CONFLICTING` | Author |
| `ci_failing` | A required check failed. When Radar cannot tell which checks are required, any failed check counts. | Author |
| `behind` | `mergeStateStatus` is `BEHIND` | Author |
| `threads_unresolved` | `mergeStateStatus` is `BLOCKED`, no other blocker or running required check explains it, and unresolved threads exist | Author |
| `blocked_other` | `mergeStateStatus` is `BLOCKED` and neither a blocker above nor a running required check explains it | Author |
| `ci_pending` | A required check is still running, and no other blocker exists | CI |

### Who needs to act

Each derived state carries a list of actors. An actor is a login, a role, and the route by which the pull request reached that person.

- In an author court, the actor is the author. A reviewer or a team with a pending review request stays an actor as well, so a request never drops out of that person's Mine because someone else requested changes first.
- In a reviewer court, the actors are the reviewers whose status puts the ball with them.
- A team request makes every member of the team an actor with the route `team`.
- In a CI court, the list holds only reviewers and teams with a pending request.
- A draft asks nothing of reviewers. Its only actor is the author.

Mine is this list filtered to the signed-in user. Mine has no data model of its own.

### Explaining the state

`derive` returns a list of typed reasons with every state. The card renders them as sentences, for example "octocat requested changes 2 days ago", "3 commits since that review", and "4 of 4 threads resolved or answered". A `likely_ready_for_rereview` card always shows its reasons, a **Heuristic** label, and a confidence. Confidence is `high` when every thread is resolved or answered. Confidence is `medium` when the change request had no threads, or when a thread counts only because it is outdated.

### Author confirm and nudge

The author of a pull request can send one of two signals from the card.

- **Ready for another look.** When the GitHub App has the write permission, Radar calls GitHub's re-request endpoint with the author's own user token. GitHub then reports a pending request, and the state becomes `in_review` with no heuristic. Without the write permission, Radar stores the signal and shows the card as `likely_ready_for_rereview` with the reason "the author says it is ready".
- **Not ready yet.** Radar stores the signal against the current head SHA. The card returns to `changes_requested`. The next push clears the signal.

A stored "ready" signal carries the time the author sent it. It stops covering a reviewer who requests changes again or comments on a thread after that time, so the card returns to the author. The author can send the signal again.

### Time in state

`derive` estimates when the pull request entered its state from GitHub timestamps: the review time, the head commit time, the last author reply, the check completion time, and the ready-for-review time. An estimate needs no stored history, so a restart loses nothing.

GitHub does not timestamp everything. It does not say when a thread was resolved or when a conflict appeared. When the running server sees a pull request change state, it records the time it saw the change and uses that time in place of the estimate.

## What the server stores

The server writes one small JSON file on a persistent volume.

- The author signals, keyed by pull request and head SHA.
- The observed state-entry time for each open pull request.
- Two counters for the heuristic: confirmed and rejected.
- For each pull request, the head SHA at which its one heuristic outcome was counted. A card counts at most once per head, across restarts. The record goes when the head moves or the pull request leaves the board.

The file holds no per-person history. Sessions live in an encrypted cookie. Notification rules and the presence switch live in the browser's local storage. Losing the file costs the author signals and makes time-in-state fall back to the estimate.

The server runs as one replica, because the board lives in memory. A second replica would need a shared event bus. A team-sized tool does not need one.

## Board rules

**Lanes.** The board has one lane per open state. Drafts and bot pull requests sit in two collapsed groups. A merged or closed pull request stays visible for 15 minutes, then leaves.

**Order within a lane.** Two rules, in this order:

1. A pull request with a priority label comes first. The label list is configuration. The default is `priority`, `urgent`, and `hotfix`.
2. The pull request that has waited longest in its state comes next.

**Help wanted.** A pull request appears in the help-wanted lane when it has waited on reviewers for more than one business day and is not a draft or a bot pull request. The lane suggests up to three people who can help. The suggestions come from people who reviewed earlier pull requests that touched the same paths in the same repository, and from the members of a requested team. The lane shows names only. It shows no counts.

**Celebrate.** When a review moves a pull request out of a reviewer court, every open board shows a short "unblocked" notice. Radar does not store it.

**What Radar leaves out on purpose.** No per-person totals, no review-time ranking, no list of pull requests grouped by the person who is "blocking". The server keeps no state history, so nobody can build such a report from Radar's data later.

## Presence

Presence is off until the user turns it on. When it is on, the browser sends a heartbeat every 20 seconds with the pull request whose details are open, if any. The server holds presence in memory and drops an entry 45 seconds after the last heartbeat. When presence is off, the browser sends nothing, and the server knows nothing about that user's viewing.

## Notifications

Notifications are off until the user turns them on, and the browser asks for permission only at that moment. The open tab raises them with the browser Notification API when a pull request enters the user's court. Radar uses no push service, so a notification needs an open tab. Web Push would deliver with the tab closed, but it routes through the browser vendor's push service and needs stored subscriptions. That is deferred.

The rules are a pure function in `packages/core`.

- Notify only when the pull request newly waits on me.
- Team requests notify only when the user opts in.
- Heuristic states notify only when the user opts in.
- Quiet hours hold notifications and deliver one summary when quiet hours end.
- Digest mode batches notifications and delivers one summary per interval.

## Answers to the open questions

1. **GitHub App permissions.** The read-only set is Metadata read, Pull requests read, Checks read, Commit statuses read, and organization Members read. Radar needs no Contents permission, because it never reads code or `CODEOWNERS`. It needs no Administration permission, because `reviewDecision`, `mergeStateStatus`, and the required flag on each check already carry the branch protection result. The optional re-request needs Pull requests write. Ask the admins for the read-only set first. Add the write permission only if the team wants the one-click re-request. Without it the card links to GitHub.
2. **Auth.** Sign-in uses the GitHub App's own OAuth flow, so there is one credential set and no separate OAuth app. After sign-in the server checks organization membership with the installation token. A non-member gets a 403 page. The check runs at sign-in only, and a session lasts at most 8 hours, so a person who leaves the organization loses access within 8 hours. The session keeps the user's GitHub token only when the one-click re-request is on, because nothing else needs it.
3. **Hosting.** One Deployment with one replica on the existing GKE cluster, a 1 GiB volume, and an ingress that accepts `/webhooks/github` from GitHub's hook addresses. Manifests are in `deploy/k8s`.
4. **Repository scope.** The scope is the set of repositories that the installation covers. Start with the whole organization, because the monorepo and the small repositories have the same problem. `RADAR_REPO_DENYLIST` removes noisy repositories. Archived repositories are skipped.
5. **Team and CODEOWNERS requests.** A team request shows for every member of the team in a separate "Requested of your team" list in Mine, below the direct requests. It does not notify unless the user opts in. When any member reviews, GitHub drops the team request and the entry leaves everyone's list. A code owner request carries a badge.
6. **Priority.** The two ordering rules above. A newcomer can say them in one breath: labelled first, then oldest first.
7. **History and time.** Radar keeps the current state and its entry time only. It keeps no history. The card shows calendar time. The help-wanted threshold counts business hours, Monday to Friday, in the configured time zone.
8. **Heuristic accuracy.** The target is 90 percent precision. Precision is the share of `likely_ready_for_rereview` cards that end in a re-review or an author confirmation, as opposed to an author "not ready yet". The server counts both outcomes in aggregate with no names. Until the count shows 90 percent over at least 50 cards, heuristic states stay out of notifications by default. They always show in Mine with the **Heuristic** label.

## What the adversarial review changed

Two reviewers tried to break the first build and had to prove each finding with a run. They proved 14 distinct failures. Each one is fixed. The 13 code fixes each have a test or an end-to-end check that failed first. The TLS fix is a manifest and runbook change with no automated test.

- Opt-outs now hold across tabs. Turning presence or notifications off in one tab stops every tab, because every tab reads the stored setting before it acts.
- An event stream ends when its session expires, and a tab whose stream is refused shows the sign-in screen.
- A demo session cannot open the real board. The cookie key is derived from the secret and the mode together.
- The webhook receiver refuses a body over 25 MB before it reads it, and drops any event for a repository outside the organization.
- Every connection that feeds the state is paged to its end: review threads, reviews, review requests, check contexts, and team members. A snapshot is never built from a truncated connection.
- A reviewer's newer feedback overrides the author's stored "ready" signal. A reply on an outdated thread after the push reopens it. A pending review request keeps its reviewer in Mine while another reviewer's change request waits on the author.
- A queued notification is dropped at delivery when the user has since opted out of its kind.
- The heuristic totals count one outcome for each pull request and head commit.
- Both ingresses serve HTTPS.

## What stays unproven

- Radar has not run against the Atum organization, or against GitHub at all. The nine GraphQL queries are validated against GitHub's public schema, and the pipeline is verified against a simulated source and a fake GitHub in tests. The first run against a real installation will show whether a GitHub App with only the listed permissions can read every selected field.
- The Kubernetes manifests parse, and the image runs as a non-root user with a read-only root file system and a 512 MiB limit. Nobody has applied the manifests to a GKE cluster.
- The heuristic's precision is unmeasured until the team uses it.
- The GraphQL cost of a sweep is an estimate from GitHub's cost formula, not a measurement.
- The "Slack gets quieter" outcome in the brief needs a baseline count of review-request messages in the channel before rollout.
