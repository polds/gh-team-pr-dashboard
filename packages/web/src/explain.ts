import type { Blocker, Reason } from "@radar/core";
import { formatAgo, listOf, plural } from "./format.ts";

export function explain(reason: Reason, now: Date): string {
	switch (reason.kind) {
		case "draft":
			return "Still a draft, so the author is working on it";
		case "no_reviewer_requested":
			return "No reviewer has been requested yet";
		case "review_requested": {
			const asked = [...reason.from, ...reason.teams.map(teamName)];
			return asked.length === 0 ? "Review requested" : `Review requested from ${listOf(asked)}`;
		}
		case "rerequested":
			return reason.from.length === 0
				? "Review requested again"
				: `Review requested again from ${listOf(reason.from)}`;
		case "changes_requested_by":
			return `${reason.reviewer} requested changes ${formatAgo(reason.at, now)}`;
		case "open_threads":
			return `${reason.awaitingAuthor} of ${plural(reason.total, "thread")} from ${reason.reviewer} still open`;
		case "new_commits_since_review":
			return `New commits since ${reason.reviewer}'s review`;
		case "threads_addressed": {
			const addressed = reason.resolved + reason.answered + reason.outdatedOnly;
			const base = `${addressed} of ${plural(reason.total, "thread")} from ${reason.reviewer} resolved or answered`;
			if (reason.outdatedOnly === 0) return base;
			return `${base}, ${reason.outdatedOnly} only because the code under ${reason.outdatedOnly === 1 ? "it" : "them"} changed`;
		}
		case "no_threads_on_change_request":
			return `${reason.reviewer} requested changes without leaving threads, so this guess is less certain`;
		case "author_says_ready":
			return "The author says it is ready for another look";
		case "author_says_not_ready":
			return "The author says it is not ready yet";
		case "commented_by":
			return `${reason.reviewer} commented ${formatAgo(reason.at, now)}`;
		case "approved_by":
			return reason.reviewers.length === 0 ? "Approved" : `Approved by ${listOf(reason.reviewers)}`;
		case "blocked":
			return explainBlocker(reason.blocker, reason.checks);
		case "in_merge_queue":
			return "In the merge queue";
		case "auto_merge_enabled":
			return "Auto-merge is on, so it merges once it can";
		default: {
			const _exhaustive: never = reason;
			return "Radar has another reason this page does not know how to describe yet";
		}
	}
}

export function explainBlocker(blocker: Blocker, checks: readonly string[]): string {
	const named = checks.length === 0 ? "" : ` (${checks.join(", ")})`;
	switch (blocker) {
		case "conflicts":
			return "Blocked: conflicts with the base branch";
		case "ci_failing":
			return `Blocked: a required check is failing${named}`;
		case "behind":
			return "Blocked: the branch is behind the base branch";
		case "threads_unresolved":
			return "Blocked: some review threads are unresolved";
		case "blocked_other":
			return "Blocked: a branch rule is not met yet";
		case "ci_pending":
			return `Waiting for required checks to finish${named}`;
		case "review_missing":
			return "Blocked: another required approval is missing";
		case "approval_dismissed":
			return "Blocked: an approval was dismissed";
		default: {
			const _exhaustive: never = blocker;
			return "Blocked: a merge rule this page cannot describe yet";
		}
	}
}

function teamName(name: string): string {
	return /team$/i.test(name) ? `the ${name}` : `the ${name} team`;
}
