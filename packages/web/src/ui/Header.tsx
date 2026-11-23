import type { ReactNode } from "react";
import type { Person, Viewer } from "@radar/core";
import { COURTS, COURT_TEXT } from "../labels.ts";
import type { Connection } from "../state.ts";
import { Avatar, AvatarStack } from "./Avatar.tsx";
import { RadarMark } from "./icons.tsx";
import { Switch } from "./Switch.tsx";

export function Header({
	org,
	demo,
	viewer,
	connection,
	presenceOn,
	onPresence,
	people,
	notifications,
	onSignOut,
}: {
	org: string;
	demo: boolean;
	viewer: Viewer;
	connection: Connection;
	presenceOn: boolean;
	onPresence(on: boolean): void;
	people: Person[];
	notifications: ReactNode;
	onSignOut(): void;
}) {
	return (
		<header className="topbar">
			<div className="topbar-row">
				<span className="brand">
					<RadarMark />
					<span className="brand-name">PR Review Radar</span>
					<span className="brand-org">{org}</span>
					{demo && <span className="demo-badge">Demo data</span>}
				</span>
				<span className={`connection connection-${connection}`} role="status">
					<span className="connection-dot" aria-hidden="true" />
					{connection === "live" ? "Live" : "Reconnecting"}
				</span>
				<span className="topbar-spacer" />
				{notifications}
				<span className="viewer">
					<Avatar person={viewer} size={26} alt={`Signed in as ${viewer.login}`} />
					<button type="button" className="button button-quiet" onClick={onSignOut}>
						Sign out
					</button>
				</span>
			</div>
			<div className="topbar-row topbar-sub">
				<ul className="legend" aria-label="Card edge colors show whose move it is">
					{COURTS.map((court) => (
						<li key={court} className={`court-${court}`}>
							<span className="legend-swatch" aria-hidden="true" />
							{COURT_TEXT[court].legend}
						</li>
					))}
				</ul>
				<span className="topbar-spacer" />
				<div className="presence" data-testid="presence">
					{presenceOn && (
						<span className="presence-people">
							{people.length === 0 ? (
								<span className="presence-alone">Nobody else here yet</span>
							) : (
								<AvatarStack people={people} max={6} size={22} label={`On the board now: ${people.map((p) => p.login).join(", ")}`} />
							)}
						</span>
					)}
					<Switch checked={presenceOn} onChange={onPresence} label="Presence" testId="presence-toggle" describedBy="presence-hint" />
					<span id="presence-hint" className="presence-hint">
						{presenceOn ? "Others see your avatar and the pull request you have open." : "Off. When on, others see your avatar and the pull request you have open."}
					</span>
				</div>
			</div>
		</header>
	);
}
