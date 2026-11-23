import { LANES } from "@radar/core";
import type { Card, layoutBoard } from "@radar/core";
import { formatAgo } from "../format.ts";
import { COURT_TEXT, STATE_LABEL } from "../labels.ts";
import { CardView } from "./CardView.tsx";
import { CardList } from "./Mine.tsx";
import { useRadar } from "./context.ts";
import { ClosedIcon, MergedIcon } from "./icons.tsx";

type Layout = ReturnType<typeof layoutBoard>;

export function Board({ layout }: { layout: Layout }) {
	return (
		<>
			<HelpWanted cards={layout.helpWanted} />
			<div className="lanes" role="region" aria-label="Lanes" tabIndex={0}>
				{LANES.map((lane) => {
					const cards = layout.lanes[lane.id];
					const id = `lane-${lane.id}-title`;
					return (
						<section key={lane.id} className={`lane court-${lane.court}`} data-testid={`lane-${lane.id}`} aria-labelledby={id}>
							<header className="lane-head">
								<h3 id={id} className="lane-title">
									{lane.title}
									<span className="count" aria-label={`${cards.length} pull requests`}>
										{cards.length}
									</span>
								</h3>
								<p className="lane-subtitle">
									<span className="court-dot" aria-hidden="true" />
									{COURT_TEXT[lane.court].waiting}
								</p>
							</header>
							<CardList cards={cards} variant="lane" empty="Nothing in this lane." />
						</section>
					);
				})}
			</div>
			<div className="groups">
				<Group title="Drafts" testId="group-drafts" cards={layout.drafts} empty="No drafts open." />
				<Group title="Bots" testId="group-bots" cards={layout.bots} empty="No bot pull requests open." />
			</div>
			<Done cards={layout.done} />
		</>
	);
}

function HelpWanted({ cards }: { cards: Card[] }) {
	if (cards.length === 0) return null;
	return (
		<section className="help-wanted" data-testid="help-wanted" aria-labelledby="help-wanted-title">
			<header className="help-head">
				<h3 id="help-wanted-title">
					Help wanted
					<span className="count">{cards.length}</span>
				</h3>
				<p>These have waited a while. Can you pick one up?</p>
			</header>
			<ul className="help-cards" role="list">
				{cards.map((card) => (
					<li key={card.id}>
						<CardView card={card} variant="help" />
					</li>
				))}
			</ul>
		</section>
	);
}

function Group({ title, testId, cards, empty }: { title: string; testId: string; cards: Card[]; empty: string }) {
	return (
		<details className="group" data-testid={testId}>
			<summary>
				<span className="group-title">{title}</span>
				<span className="count">{cards.length}</span>
			</summary>
			<div className="group-body">
				<CardList cards={cards} variant="list" empty={empty} />
			</div>
		</details>
	);
}

function Done({ cards }: { cards: Card[] }) {
	const { now } = useRadar();
	return (
		<section className="done" data-testid="done" aria-labelledby="done-title">
			<h3 id="done-title" className="done-title">
				Recently merged or closed
			</h3>
			{cards.length === 0 ? (
				<p className="empty">Nothing merged or closed in the last little while.</p>
			) : (
				<ul className="done-list" role="list">
					{cards.map((card) => (
						<li
							key={card.id}
							className={`done-item state-${card.derived.state}`}
							data-testid="card"
							data-pr={`${card.repo}#${card.number}`}
							data-state={card.derived.state}
							data-court={card.derived.court}
						>
							{card.derived.state === "merged" ? <MergedIcon size={14} label="Merged" /> : <ClosedIcon size={14} label="Closed" />}
							<a href={card.url} target="_blank" rel="noopener noreferrer">
								<span className="card-ref">
									{card.repo}#{card.number}
								</span>{" "}
								{card.title}
							</a>
							<span className="done-when">
								{STATE_LABEL[card.derived.state].toLowerCase()} {formatAgo(card.since, now)}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
