# Spike: does GitHub already close the gap?

Checked on 2026-11-23 against GitHub's documentation and changelog. Every fact below links to the page that states it. Nothing here was measured inside the Atum organization. This session has no access to it.

## Verdict

Build it, with a narrower claim than the brief makes.

GitHub closed part of the gap in 2026. The redesigned [pull requests dashboard](https://github.blog/changelog/2026-07-09-new-pull-requests-dashboard-is-now-generally-available) is generally available since 2026-07-09. It gives each user a cross-repository inbox with "Needs your review", team review requests, "Needs fixing", "Ready to merge", "Your drafts", and "Waiting for review". The brief's "people miss that they have been requested" and "miss that comments landed" are mostly a matter of people using that inbox and turning on [personal scheduled reminders](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-your-scheduled-reminders).

Two gaps remain, and nothing GitHub ships covers either one.

1. **Re-review without a re-request.** GitHub's search documentation says: "Requested reviewers are no longer listed in the search results after they review a pull request." Once a reviewer submits a review, the pull request leaves that reviewer's "Needs your review" list. It returns only when the author clicks re-request. A [change request stays in force](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews) until the same reviewer reviews again, and [stale-review dismissal](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) applies to approvals only. So the pull request sits in a state where the author thinks the reviewer has it, and the reviewer's inbox says nothing. This is the Slack loop in the brief, and it is structural.
2. **A shared team view of whose turn it is.** The dashboard is per user. Its [documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/viewing-all-of-your-issues-and-pull-requests) describes saved views on "your" dashboard and says nothing about sharing one. No GitHub view shows how long a pull request has waited in its current state, and none shows the team which reviews nobody has picked up.

Radar is worth building for those two gaps. A version of Radar that only repeats the per-user inbox would be a prettier github.com/pulls, and the brief says not to build that.

## Do this today, whatever happens to Radar

These cost nothing and close the part of the problem that GitHub already solves.

- Each person opens [github.com/pulls](https://github.com/pulls) and keeps the inbox sections.
- Each person saves a view with `review-involves:@me is:open`. The [`review-involves` qualifier](https://github.blog/changelog/2026-07-09-new-pull-requests-dashboard-is-now-generally-available) keeps a pull request listed after the review, which softens gap 1 for people who check the view.
- Each person turns on personal scheduled reminders with real-time alerts in Slack. The reminders arrive as direct messages, so they do not add to the channel.

## What each GitHub feature covers

| Capability | github.com/pulls | Search qualifiers | Scheduled reminders | Slack app subscriptions | Projects |
|---|---|---|---|---|---|
| Every repository in the organization | Yes | Yes | Partial. At most 5 repositories per reminder. | Partial. One subscription per repository. | Partial. One repository per auto-add workflow. |
| Shared team view | No | Partial. A shared URL. | Partial. A channel digest. | Partial. A channel. | Yes |
| "My turn" for each user | Yes | Partial | Yes | Partial. Mentions. | No |
| Re-review without a re-request | No | No | No | No | No |
| Time in state | No | Partial. `updated:` | Partial. Age and staleness filters. | No | No |
| Live updates | Not documented | No | Partial. Real-time alerts. | Yes | Yes |
| Presence | No | No | No | No | Partial |

Sources: the [dashboard changelog posts](https://github.blog/changelog/2026-03-26-new-pull-requests-dashboard-is-in-public-preview/), the [search qualifier reference](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests), the [team reminder documentation](https://docs.github.com/en/organizations/organizing-members-into-teams/managing-scheduled-reminders-for-your-team), the [Slack integration README](https://github.com/integrations/slack), and the [Projects auto-add documentation](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically).

### github.com/pulls

The inbox derives per-user sections and works across repositories and organizations. It has no section for "the author addressed your feedback". The nearest signal is "new comments" under "Needs fixing", and that section is for the author.

### Search qualifiers

`review-requested:`, `user-review-requested:@me`, `team-review-requested:`, `reviewed-by:`, `review:`, `draft:`, and `status:` exist. No qualifier means "commits pushed since my review" or "threads resolved since my review".

### Scheduled reminders

Team reminders post a digest to one Slack channel. Filters cover drafts, approvals, age, staleness, and labels. A reminder tracks at most 5 repositories and lists the 20 oldest pull requests in each. The option "remind authors after reviews" is the closest feature to gap 1, and it reminds the author, not the reviewer. Team reminders also post in a channel, which is the place the brief wants to quiet down.

### Slack app subscriptions

`/github subscribe owner/repo reviews comments` posts review events to a channel, one repository at a time. It reports events. It does not say whose turn it is.

### Projects

A project can be shared and updates live. Auto-add takes one repository per workflow and cannot filter on review state, and the "Reviewers" field lists reviewers without their review state. A project cannot derive whose turn it is.

## The strongest argument against building

A GitHub Actions workflow of about 30 lines could re-request review from every reviewer who requested changes, each time the author pushes. That would repair gap 1 inside GitHub, and the native inbox and reminders would then be correct.

Radar does not take that path, for three reasons.

- A push is not "I addressed your feedback". Work-in-progress commits and merges from the base branch would ping reviewers too early, and reviewers would learn to ignore the request.
- It writes to GitHub with no person behind the action. The brief allows one write, and the author must start it.
- It does nothing for reviewers who comment without clicking **Request changes**, and nothing for gap 2.

If Radar's heuristic turns out to be imprecise, this workflow with a "threads resolved or answered" condition is the fallback. Radar's `derive` function already computes that condition.

## What the spike changes in the design

- Mine has to be at least as good as the GitHub inbox, because that is now the baseline people compare against. The re-review entries are the reason to open Radar.
- The state engine treats comment-only feedback like a change request. Search qualifiers and `reviewDecision` both ignore that flow.
- The `review-involves` saved view goes into the runbook as the fallback when Radar is down.

## What stays unproven

- How often Atum authors forget to re-request. The brief says "routinely". A count of pull requests with `review:changes_requested` and a push after the review, in the Atum organization, would put a number on it.
- Whether the team will keep a Radar tab open. The brief's own test is that the team lives in it.
- The list of real-time alert types in personal reminders. GitHub's documentation does not list them.
