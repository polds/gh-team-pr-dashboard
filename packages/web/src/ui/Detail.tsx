import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Card } from "@radar/core";
import { explain, explainBlocker } from "../explain.ts";
import { formatDuration, formatDurationLong, shortRepo } from "../format.ts";
import { CONFIDENCE_TEXT, COURT_TEXT, STATE_LABEL, reviewerStatusText, viaText } from "../labels.ts";
import { Avatar } from "./Avatar.tsx";
import { AuthorSignal, ChecksBadge } from "./CardView.tsx";
import { useRadar } from "./context.ts";
import { CrossIcon, ExternalIcon, ReviewerMark, SparkIcon } from "./icons.tsx";

export function Detail({ card, onClose }: { card: Card | undefined; onClose(): void }) {
	const { config } = useRadar();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const onCloseRef = useRef(onClose);
	const openedFor = useRef(card === undefined ? null : `${card.repo}#${card.number}`);

	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (dialog === null) return;
		const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
		const pr = openedFor.current;
		const returnTo = () => focused ?? (pr === null ? null : document.querySelector<HTMLElement>(`[data-pr="${CSS.escape(pr)}"] .card-open`));
		dialog.showModal();
		const closed = () => onCloseRef.current();
		dialog.addEventListener("close", closed);
		return () => {
			dialog.removeEventListener("close", closed);
			if (dialog.open) dialog.close();
			returnTo()?.focus();
		};
	}, []);

	return (
		<dialog
			ref={dialogRef}
			className="detail"
			data-testid="detail"
			aria-labelledby="detail-title"
			onClick={(event) => {
				if (event.target === dialogRef.current) dialogRef.current.close();
			}}
		>
			<div className="detail-inner">
				<div className="detail-top">
					<span className="detail-ref">{card === undefined ? "Pull request" : `${shortRepo(card.repo, config.org)}#${card.number}`}</span>
					<button type="button" className="icon-button" aria-label="Close details" onClick={() => dialogRef.current?.close()} autoFocus>
						<CrossIcon size={16} />
					</button>
				</div>
				{card === undefined ? (
					<>
						<h2 id="detail-title" className="detail-title">
							This pull request left the board
						</h2>
						<p className="empty">It was merged, closed, or moved out of Radar's scope while this panel was open.</p>
					</>
				) : (
					<DetailBody card={card} />
				)}
			</div>
		</dialog>
	);
}

function DetailBody({ card }: { card: Card }) {
	const env = useRadar();
	const { derived } = card;
	const waitedMs = env.now.getTime() - Date.parse(card.since);
	const watchers = env.watchersOf(card.id);
	const routeOf = (login: string) => derived.actors.find((actor) => actor.login === login)?.via;

	return (
		<>
			<h2 id="detail-title" className="detail-title">
				<a href={card.url} target="_blank" rel="noopener noreferrer">
					{card.title}
					<ExternalIcon size={14} label="opens GitHub in a new tab" />
				</a>
			</h2>
			<p className="detail-byline">
				<Avatar person={card.author} size={18} alt={`Author ${card.author.login}`} />
				<span>{card.author.login}</span>
				<span className="diffstat">
					<span className="add">+{card.additions}</span> <span className="del">−{card.deletions}</span>
				</span>
			</p>

			<div className={`detail-state court-${derived.court}`}>
				<span className="state-chip">{STATE_LABEL[derived.state]}</span>
				<span>
					<span className="court-dot" aria-hidden="true" />
					{COURT_TEXT[derived.court].card}, waiting {formatDuration(waitedMs)}
					<span className="sr-only"> ({formatDurationLong(waitedMs)})</span>
				</span>
			</div>

			<AuthorSignal card={card} />

			<Section title="Why it is here">
				{derived.state === "likely_ready_for_rereview" && (
					<p className="heuristic-badge">
						<SparkIcon size={12} />
						Likely, heuristic
						{derived.confidence !== null && <span className="heuristic-confidence">{CONFIDENCE_TEXT[derived.confidence]}</span>}
					</p>
				)}
				<ul className="reasons reasons-detail">
					{derived.reasons.map((reason, index) => (
						<li key={index}>{explain(reason, env.now)}</li>
					))}
				</ul>
			</Section>

			<Section title="Reviewers">
				{derived.reviewers.length === 0 && card.requestedTeams.length === 0 ? (
					<p className="empty">No reviewers yet.</p>
				) : (
					<ul className="people">
						{derived.reviewers.map((status) => {
							const via = routeOf(status.reviewer.login);
							return (
								<li key={status.reviewer.login}>
									<Avatar person={status.reviewer} size={24} alt={status.reviewer.login}>
										<span className={`mark mark-${status.kind}`} aria-hidden="true">
											<ReviewerMark kind={status.kind} />
										</span>
									</Avatar>
									<span className="person-name">{status.reviewer.login}</span>
									<span className="person-status">
										{reviewerStatusText(status)}
										{via !== undefined && via.kind !== "author" && `, ${viaText(via)}`}
									</span>
								</li>
							);
						})}
						{card.requestedTeams.map((team) => (
							<li key={team.slug}>
								<span className="team-chip">{team.name}</span>
								<span className="person-status">Review requested of the team. Any member can pick it up.</span>
							</li>
						))}
					</ul>
				)}
			</Section>

			{derived.blockers.length > 0 && (
				<Section title="What stops a merge">
					<ul className="reasons reasons-detail">
						{derived.blockers.map((blocker) => (
							<li key={blocker}>{explainBlocker(blocker, blocker === "ci_failing" ? card.checks.failing : blocker === "ci_pending" ? card.checks.pending : [])}</li>
						))}
					</ul>
				</Section>
			)}

			<Section title="Checks">
				<p className="detail-checks">
					<ChecksBadge checks={card.checks} />
					<span>{card.checks.total === 0 ? "No checks reported." : `${card.checks.total} in total.`}</span>
				</p>
				{card.checks.failing.length > 0 && <p className="check-names">Failing: {card.checks.failing.join(", ")}</p>}
				{card.checks.pending.length > 0 && <p className="check-names">Running: {card.checks.pending.join(", ")}</p>}
			</Section>

			{card.areas.length > 0 && (
				<Section title="Areas">
					<ul className="labels">
						{card.areas.map((area) => (
							<li key={area} className="label label-area">
								{area}
							</li>
						))}
					</ul>
				</Section>
			)}

			{card.labels.length > 0 && (
				<Section title="Labels">
					<ul className="labels">
						{card.labels.map((label) => (
							<li key={label} className="label">
								{label}
							</li>
						))}
					</ul>
				</Section>
			)}

			{card.helpWanted !== null && card.helpWanted.suggested.length > 0 && (
				<Section title="Could help">
					<ul className="people">
						{card.helpWanted.suggested.map((person) => (
							<li key={person.login}>
								<Avatar person={person} size={24} alt={person.login} />
								<span className="person-name">{person.login}</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			{watchers.length > 0 && (
				<Section title="Looking at this now">
					<ul className="people">
						{watchers.map((person) => (
							<li key={person.login}>
								<Avatar person={person} size={24} alt={person.login} />
								<span className="person-name">{person.login}</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			<p className="detail-github">
				<a className="button" href={card.url} target="_blank" rel="noopener noreferrer">
					Open on GitHub
					<ExternalIcon size={14} />
				</a>
			</p>
		</>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="detail-section">
			<h3>{title}</h3>
			{children}
		</section>
	);
}
