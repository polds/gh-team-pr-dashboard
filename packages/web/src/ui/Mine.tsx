import type { ReactNode } from "react";
import type { Card, Mine as MineLists } from "@radar/core";
import { Avatar } from "./Avatar.tsx";
import { CardView } from "./CardView.tsx";
import type { CardVariant } from "./CardView.tsx";
import { useRadar } from "./context.ts";

export function Mine({ mine }: { mine: MineLists }) {
	const { viewer } = useRadar();
	const needsYou = mine.needsMyReview.length + mine.myTurn.length;
	return (
		<section className="mine" data-testid="mine" aria-labelledby="mine-title">
			<header className="mine-head">
				<Avatar person={viewer} size={28} alt={viewer.login} />
				<div>
					<h2 id="mine-title">Mine</h2>
					<p className="mine-summary">
						{needsYou === 0 ? "Nothing needs you right now." : `${needsYou} ${needsYou === 1 ? "pull request needs" : "pull requests need"} you.`}
					</p>
				</div>
			</header>
			<div className="mine-columns">
				<MineColumn title="Waiting on you" cards={mine.needsMyReview} testId="mine-needs-review" empty="No reviews are waiting on you." emphasis>
					<MineList title="Requested of your team" cards={mine.teamRequests} testId="mine-team" variant="team" empty="No open team requests." />
				</MineColumn>
				<MineColumn title="Your pull requests: your move" cards={mine.myTurn} testId="mine-my-turn" empty="None of your pull requests need you." emphasis />
				<MineColumn title="Your pull requests: waiting on others" cards={mine.waitingOnOthers} testId="mine-waiting" empty="Nothing of yours is waiting on others." />
			</div>
		</section>
	);
}

function MineColumn({
	title,
	cards,
	testId,
	empty,
	emphasis = false,
	children,
}: {
	title: string;
	cards: Card[];
	testId: string;
	empty: string;
	emphasis?: boolean;
	children?: ReactNode;
}) {
	const id = `${testId}-title`;
	return (
		<section className={`mine-column${emphasis && cards.length > 0 ? " has-items" : ""}`} aria-labelledby={id}>
			<div data-testid={testId}>
				<h3 id={id} className="mine-column-title">
					{title}
					<span className="count" aria-label={`${cards.length} pull requests`}>
						{cards.length}
					</span>
				</h3>
				<CardList cards={cards} variant="list" empty={empty} />
			</div>
			{children}
		</section>
	);
}

function MineList({ title, cards, testId, variant, empty }: { title: string; cards: Card[]; testId: string; variant: CardVariant; empty: string }) {
	const id = `${testId}-title`;
	return (
		<section className="mine-sublist" data-testid={testId} aria-labelledby={id}>
			<h4 id={id} className="mine-sublist-title">
				{title}
				<span className="count count-quiet" aria-label={`${cards.length} pull requests`}>
					{cards.length}
				</span>
			</h4>
			<CardList cards={cards} variant={variant} empty={empty} />
		</section>
	);
}

export function CardList({ cards, variant, empty }: { cards: readonly Card[]; variant: CardVariant; empty: string }) {
	if (cards.length === 0) return <p className="empty">{empty}</p>;
	return (
		<ul className="card-list" role="list">
			{cards.map((card) => (
				<li key={card.id}>
					<CardView card={card} variant={variant} />
				</li>
			))}
		</ul>
	);
}
