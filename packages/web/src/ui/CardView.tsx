import type { MouseEvent } from "react";
import type { Card } from "@radar/core";
import { explain } from "../explain.ts";
import { formatDuration, formatDurationLong, shortRepo } from "../format.ts";
import { CONFIDENCE_TEXT, COURT_TEXT, STATE_LABEL, reviewerStatusText, signalMessage } from "../labels.ts";
import { Avatar, AvatarStack } from "./Avatar.tsx";
import { useRadar } from "./context.ts";
import { CheckIcon, ChevronRightIcon, CrossIcon, DashIcon, EyeIcon, FlagIcon, PendingIcon, ReviewerMark, SparkIcon } from "./icons.tsx";

export type CardVariant = "lane" | "list" | "team" | "help";

export function CardView({ card, variant = "lane" }: { card: Card; variant?: CardVariant }) {
	const env = useRadar();
	const { derived } = card;
	const ref = `${card.repo}#${card.number}`;
	const shortRef = `${shortRepo(card.repo, env.config.org)}#${card.number}`;
	const route = derived.actors.find((actor) => actor.login === env.viewer.login)?.via.kind;
	const yours = route === "author" || route === "direct";
	const turnText = yours ? "Your move" : route === "team" ? "Your team's move" : COURT_TEXT[derived.court].card;
	const waitedMs = env.now.getTime() - Date.parse(card.since);
	const showState = variant !== "lane";

	const open = (event: MouseEvent<HTMLElement>) => {
		if (event.target instanceof Element && event.target.closest("a, button, input, select, summary")) return;
		if ((window.getSelection()?.toString() ?? "") !== "") return;
		env.openDetail(card.id);
	};

	return (
		<article
			className={`card court-${derived.court}${yours ? " is-yours" : ""}`}
			data-variant={variant}
			data-testid="card"
			data-pr={ref}
			data-state={derived.state}
			data-court={derived.court}
			onClick={open}
		>
			<div className="card-head">
				<a className="card-title" href={card.url} target="_blank" rel="noopener noreferrer">
					{card.priority && (
						<span className="priority" title="Has a priority label">
							<FlagIcon size={12} label="Priority" />
						</span>
					)}
					{card.title}
				</a>
				<button type="button" className="icon-button card-open" aria-label={`Details for ${shortRef}`} onClick={() => env.openDetail(card.id)}>
					<ChevronRightIcon size={14} />
				</button>
			</div>

			<div className="card-meta">
				<span className="card-ref">{shortRef}</span>
				<span className="card-author">
					<Avatar person={card.author} size={16} alt={`Author ${card.author.login}`} />
					<span className="card-author-name">{card.author.login}</span>
				</span>
				<ChecksBadge checks={card.checks} />
			</div>

			{showState && <div className={`state-chip court-${derived.court}`}>{STATE_LABEL[derived.state]}</div>}

			{card.labels.length > 0 && (
				<ul className="labels" aria-label="Labels">
					{card.labels.slice(0, 4).map((label) => (
						<li key={label} className="label">
							{label}
						</li>
					))}
					{card.labels.length > 4 && <li className="label label-more">+{card.labels.length - 4}</li>}
				</ul>
			)}

			{derived.state === "likely_ready_for_rereview" && <Heuristic card={card} />}

			{variant === "help" && card.helpWanted !== null && card.helpWanted.suggested.length > 0 && (
				<div className="helpers">
					<span className="helpers-label">Could help</span>
					<AvatarStack people={card.helpWanted.suggested} max={3} size={20} label="Could help" />
					<span className="helpers-names">{card.helpWanted.suggested.map((p) => p.login).join(", ")}</span>
				</div>
			)}

			<div className="card-foot">
				<Reviewers card={card} />
				<Watchers card={card} />
				<span className={`turn${yours ? " turn-yours" : ""}`}>
					<span className="court-dot" aria-hidden="true" />
					{turnText}
					<span className="turn-sep" aria-hidden="true">
						·
					</span>
					<time dateTime={card.since} title={`In this state for ${formatDurationLong(waitedMs)}`}>
						<span className="sr-only">waiting </span>
						{formatDuration(waitedMs)}
					</time>
				</span>
			</div>

			<AuthorSignal card={card} />
		</article>
	);
}

export function ChecksBadge({ checks }: { checks: Card["checks"] }) {
	switch (checks.verdict) {
		case "passing":
			return (
				<span className="checks checks-passing" title={`${checks.total} checks passing`}>
					<CheckIcon size={13} />
					<span>Checks</span>
				</span>
			);
		case "failing":
			return (
				<span className="checks checks-failing" title={`Failing: ${checks.failing.join(", ")}`}>
					<CrossIcon size={13} />
					<span>{checks.failing.length} failing</span>
					<span className="sr-only">: {checks.failing.join(", ")}</span>
				</span>
			);
		case "pending":
			return (
				<span className="checks checks-pending" title={`Running: ${checks.pending.join(", ")}`}>
					<PendingIcon size={13} />
					<span>Running</span>
				</span>
			);
		case "none":
			return (
				<span className="checks checks-none" title="No checks reported">
					<DashIcon size={13} />
					<span>No checks</span>
				</span>
			);
		default: {
			const _exhaustive: never = checks.verdict;
			return null;
		}
	}
}

function Reviewers({ card }: { card: Card }) {
	const { reviewers } = card.derived;
	if (reviewers.length === 0 && card.requestedTeams.length === 0) return null;
	const shown = reviewers.slice(0, 4);
	return (
		<ul className="reviewers" aria-label="Reviewers">
			{shown.map((status) => {
				const text = `${status.reviewer.login}: ${reviewerStatusText(status)}`;
				return (
					<li key={status.reviewer.login}>
						<Avatar person={status.reviewer} size={20} alt={text}>
							<span className={`mark mark-${status.kind}`} aria-hidden="true">
								<ReviewerMark kind={status.kind} />
							</span>
						</Avatar>
					</li>
				);
			})}
			{reviewers.length > shown.length && <li className="avatar-more">+{reviewers.length - shown.length}</li>}
			{card.requestedTeams.map((team) => (
				<li key={team.slug} className="team-chip" title={`Review requested of ${team.name}`}>
					{team.name}
				</li>
			))}
		</ul>
	);
}

function Watchers({ card }: { card: Card }) {
	const env = useRadar();
	const watchers = env.watchersOf(card.id);
	if (watchers.length === 0) return null;
	const names = watchers.map((p) => p.login).join(", ");
	return (
		<span className="watchers" title={`Looking at this now: ${names}`}>
			<EyeIcon size={13} />
			<AvatarStack people={watchers} max={3} size={16} label={`Looking at this now: ${names}`} />
		</span>
	);
}

function Heuristic({ card }: { card: Card }) {
	const env = useRadar();
	const confidence = card.derived.confidence;
	return (
		<div className="heuristic">
			<span className="heuristic-badge">
				<SparkIcon size={12} />
				Likely, heuristic
				{confidence !== null && <span className="heuristic-confidence">{CONFIDENCE_TEXT[confidence]}</span>}
			</span>
			<ul className="reasons">
				{card.derived.reasons.map((reason, index) => (
					<li key={index}>{explain(reason, env.now)}</li>
				))}
			</ul>
		</div>
	);
}

export function AuthorSignal({ card }: { card: Card }) {
	const env = useRadar();
	const { state } = card.derived;
	if (card.author.login !== env.viewer.login) return null;
	const status = env.signalOf(card.id);
	const sending = status !== undefined && status.result === null;
	const message = status === undefined || status.result === null ? null : signalMessage(status.kind, status.result);
	const canSignal = state === "likely_ready_for_rereview" || state === "changes_requested";
	if (!canSignal && message === null) return null;
	return (
		<div className="signal">
			{canSignal && (
				<div className="signal-buttons">
					<button type="button" className="button button-primary" data-testid="signal-ready" disabled={sending} onClick={() => env.sendSignal(card.id, "ready")}>
						{sending && status.kind === "ready" ? "Sending…" : env.config.rerequestEnabled ? "Re-request review on GitHub" : "Ready for another look"}
					</button>
					{state === "likely_ready_for_rereview" && (
						<button type="button" className="button" data-testid="signal-not-ready" disabled={sending} onClick={() => env.sendSignal(card.id, "not_ready")}>
							{sending && status.kind === "not_ready" ? "Sending…" : "Not ready yet"}
						</button>
					)}
				</div>
			)}
			<p className={`signal-result${message === null ? "" : ` tone-${message.tone}`}`} role="status">
				{message?.text}
			</p>
		</div>
	);
}
