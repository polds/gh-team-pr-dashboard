import type { ActorVia, Confidence, Court, PrState, ReviewerStatus } from "@radar/core";
import type { SignalResult } from "./api.ts";

export const STATE_LABEL: Record<PrState, string> = {
	draft: "Draft",
	needs_review: "Needs review",
	in_review: "In review",
	changes_requested: "Changes requested",
	likely_ready_for_rereview: "Likely ready for re-review",
	approved_blocked: "Approved but blocked",
	ready_to_merge: "Ready to merge",
	merged: "Merged",
	closed: "Closed",
};

/** Whose move it is, said three ways: as a lane subtitle, on a card, and in the legend. */
export const COURT_TEXT: Record<Court, { waiting: string; card: string; legend: string }> = {
	reviewers: { waiting: "Waiting on reviewers", card: "With reviewers", legend: "Reviewers" },
	author: { waiting: "Waiting on the author", card: "With the author", legend: "Author" },
	ci: { waiting: "Waiting on CI", card: "With CI", legend: "CI" },
	nobody: { waiting: "Nothing to do", card: "Nothing to do", legend: "Nobody" },
};

export const COURTS: readonly Court[] = ["reviewers", "author", "ci", "nobody"];

export function reviewerStatusText(status: ReviewerStatus): string {
	switch (status.kind) {
		case "requested":
			return status.rerequested ? "Asked to review again" : "Review requested";
		case "approval_dismissed":
			return "Approval dismissed";
		case "approved":
			return "Approved";
		case "feedback_outstanding":
			return "Left feedback the author is working on";
		case "feedback_addressed":
			return "Feedback looks addressed";
		case "commented":
			return "Commented";
		default: {
			const _exhaustive: never = status.kind;
			return "Reviewed";
		}
	}
}

export function viaText(via: ActorVia): string {
	switch (via.kind) {
		case "author":
			return "author";
		case "direct":
			return via.asCodeOwner ? "asked directly, as code owner" : "asked directly";
		case "team":
			return via.asCodeOwner ? `through ${via.name}, as code owner` : `through ${via.name}`;
		default: {
			const _exhaustive: never = via;
			return "";
		}
	}
}

/** What happened after the author pressed a signal button, in plain words. */
export function signalMessage(kind: "ready" | "not_ready", result: SignalResult): { tone: "ok" | "problem"; text: string } {
	if (result.ok) {
		if (kind === "not_ready") return { tone: "ok", text: "Marked not ready. It stays with you until your next push." };
		return result.wroteToGitHub
			? { tone: "ok", text: "Review re-requested on GitHub. Reviewers get GitHub's usual notice." }
			: { tone: "ok", text: "Marked ready. Reviewers now see that it is ready for another look." };
	}
	switch (result.error) {
		case "not_author":
			return { tone: "problem", text: "Only the author of this pull request can send this." };
		case "not_found":
			return { tone: "problem", text: "Radar no longer has this pull request. It may have just closed." };
		case "github_refused":
			return { tone: "problem", text: "GitHub turned down the re-request. You can re-request review on GitHub instead." };
		case "nothing_to_rerequest":
			return { tone: "problem", text: "There is nobody to re-request yet. Request a reviewer on GitHub first." };
		case "unreachable":
			return { tone: "problem", text: "Radar did not answer. Try again in a moment." };
		case "signed_out":
			return { tone: "problem", text: "Your session ended. Reload the page to sign in again." };
		default: {
			const _exhaustive: never = result;
			return { tone: "problem", text: "Something went wrong. Try again in a moment." };
		}
	}
}

export const CONFIDENCE_TEXT: Record<Confidence, string> = {
	high: "high confidence",
	medium: "medium confidence",
	confirmed: "confirmed by the author",
};
