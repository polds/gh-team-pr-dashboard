import { LANES } from "@radar/core";
import { RadarMark } from "./icons.tsx";

export function LoadingScreen() {
	return (
		<div className="app" aria-busy="true">
			<header className="topbar">
				<div className="topbar-row">
					<span className="brand">
						<RadarMark />
						<span className="brand-name">PR Review Radar</span>
					</span>
				</div>
			</header>
			<main className="page">
				<p className="sr-only" role="status">
					Loading the board
				</p>
				<section className="mine mine-skeleton" aria-hidden="true">
					<div className="skeleton skeleton-line" style={{ width: 140 }} />
					<div className="mine-columns">
						{[0, 1, 2].map((column) => (
							<div key={column} className="mine-column">
								<div className="skeleton skeleton-line" style={{ width: "60%" }} />
								<div className="skeleton skeleton-card" />
							</div>
						))}
					</div>
				</section>
				<div className="lanes" aria-hidden="true">
					{LANES.map((lane, index) => (
						<div key={lane.id} className="lane">
							<div className="skeleton skeleton-line" style={{ width: "70%" }} />
							{Array.from({ length: 3 - (index % 3) }, (_, card) => (
								<div key={card} className="skeleton skeleton-card" />
							))}
						</div>
					))}
				</div>
			</main>
		</div>
	);
}

export function SignedOutScreen({ loginUrl }: { loginUrl: string }) {
	return (
		<main className="splash">
			<div className="splash-card">
				<RadarMark size={40} />
				<h1>PR Review Radar</h1>
				<p>See whose turn it is on every open pull request in your organization, and what is waiting on you.</p>
				<a className="button button-primary button-large" href={loginUrl}>
					Sign in with GitHub
				</a>
				<p className="splash-note">Radar only reads from GitHub. Reviews, comments, and merges still happen on GitHub.</p>
			</div>
		</main>
	);
}

export function ErrorScreen({ message, onRetry }: { message: string; onRetry(): void }) {
	return (
		<main className="splash">
			<div className="splash-card" role="alert">
				<RadarMark size={40} />
				<h1>The board did not load</h1>
				<p>{message} This is usually a short server restart, and trying again a moment later works.</p>
				<button type="button" className="button button-primary button-large" onClick={onRetry}>
					Try again
				</button>
				<p className="splash-note">While Radar is down, your GitHub inbox at github.com/pulls still lists the reviews requested of you.</p>
			</div>
		</main>
	);
}
