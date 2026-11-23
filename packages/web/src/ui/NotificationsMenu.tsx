import { useEffect, useId, useRef, useState } from "react";
import type { NotificationPrefs } from "@radar/core";
import { askPermission, notificationPermission } from "../notifications.ts";
import type { Permission } from "../notifications.ts";
import { DIGEST_CHOICES } from "../prefs.ts";
import { BellIcon, BellOffIcon } from "./icons.tsx";
import { Switch } from "./Switch.tsx";

const DEFAULT_QUIET = { startMinute: 18 * 60, endMinute: 9 * 60 };

const DIGEST_LABEL: Record<(typeof DIGEST_CHOICES)[number], string> = {
	0: "Off: notify right away",
	15: "Every 15 minutes",
	30: "Every 30 minutes",
	60: "Every hour",
};

/** The header button and the prefs panel it opens. Permission is asked only when the switch is turned on. */
export function NotificationsMenu({ prefs, onChange }: { prefs: NotificationPrefs; onChange(prefs: NotificationPrefs): void }) {
	const [open, setOpen] = useState(false);
	const [permission, setPermission] = useState<Permission>(notificationPermission);
	const [asking, setAsking] = useState(false);
	const [declined, setDeclined] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const panelId = useId();
	const on = prefs.enabled && permission === "granted";

	useEffect(() => {
		if (!open) return;
		setPermission(notificationPermission());
		const onPointer = (event: PointerEvent) => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setOpen(false);
			button.current?.focus();
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const toggle = async (next: boolean) => {
		setDeclined(false);
		if (!next) {
			onChange({ ...prefs, enabled: false });
			return;
		}
		let current = notificationPermission();
		if (current === "default") {
			setAsking(true);
			current = await askPermission();
			setAsking(false);
		}
		setPermission(current);
		if (current === "granted") onChange({ ...prefs, enabled: true });
		else setDeclined(current === "default");
	};

	return (
		<div className="menu" ref={root}>
			<button
				ref={button}
				type="button"
				className="button button-quiet"
				aria-expanded={open}
				aria-controls={panelId}
				data-testid="notifications-button"
				onClick={() => setOpen(!open)}
			>
				{on ? <BellIcon /> : <BellOffIcon />}
				<span>Notifications {on ? "on" : "off"}</span>
			</button>
			{open && (
				<div id={panelId} className="menu-panel" role="group" aria-label="Notification settings">
					<div>
						<h2>Desktop notifications</h2>
						<p className="hint">Radar tells you when a pull request starts waiting on you. It needs this tab open.</p>
					</div>
					<Switch checked={on} onChange={toggle} label={asking ? "Asking your browser…" : "Notify me"} testId="notifications-toggle" disabled={asking || permission === "unsupported"} />
					<PermissionNotice permission={permission} declined={declined} />
					<fieldset>
						<legend>Also notify for</legend>
						<label className="check">
							<input type="checkbox" checked={prefs.teamRequests} onChange={(event) => onChange({ ...prefs, teamRequests: event.target.checked })} />
							<span>Team requests</span>
						</label>
						<label className="check">
							<input type="checkbox" checked={prefs.heuristic} onChange={(event) => onChange({ ...prefs, heuristic: event.target.checked })} />
							<span>
								Likely-ready guesses
								<span className="hint"> Radar's re-review guess, before anyone confirms it.</span>
							</span>
						</label>
					</fieldset>
					<fieldset>
						<legend>Quiet hours</legend>
						<label className="check">
							<input
								type="checkbox"
								checked={prefs.quietHours !== null}
								onChange={(event) => onChange({ ...prefs, quietHours: event.target.checked ? DEFAULT_QUIET : null })}
							/>
							<span>Hold notifications, then send one summary when quiet hours end</span>
						</label>
						{prefs.quietHours !== null && (
							<QuietHours value={prefs.quietHours} onChange={(quietHours) => onChange({ ...prefs, quietHours })} />
						)}
					</fieldset>
					<fieldset>
						<legend>Digest</legend>
						<label className="check">
							<select
								value={prefs.digestMinutes}
								onChange={(event) => onChange({ ...prefs, digestMinutes: DIGEST_CHOICES.find((choice) => String(choice) === event.target.value) ?? 0 })}
							>
								{DIGEST_CHOICES.map((choice) => (
									<option key={choice} value={choice}>
										{DIGEST_LABEL[choice]}
									</option>
								))}
							</select>
						</label>
					</fieldset>
				</div>
			)}
		</div>
	);
}

function PermissionNotice({ permission, declined }: { permission: Permission; declined: boolean }) {
	if (permission === "unsupported") return <p className="notice">This browser cannot show desktop notifications.</p>;
	if (permission === "denied") {
		return <p className="notice">Your browser blocks notifications for this site. Allow them in the site settings, then turn this on again.</p>;
	}
	if (declined) return <p className="notice">The browser did not give permission. Turn the switch on to be asked again.</p>;
	return null;
}

function QuietHours({ value, onChange }: { value: { startMinute: number; endMinute: number }; onChange(value: { startMinute: number; endMinute: number }): void }) {
	return (
		<div className="time-range">
			<label>
				<span className="sr-only">Quiet hours start</span>
				<input type="time" value={toClock(value.startMinute)} onChange={(event) => onChange({ ...value, startMinute: fromClock(event.target.value, value.startMinute) })} />
			</label>
			<span aria-hidden="true">to</span>
			<label>
				<span className="sr-only">Quiet hours end</span>
				<input type="time" value={toClock(value.endMinute)} onChange={(event) => onChange({ ...value, endMinute: fromClock(event.target.value, value.endMinute) })} />
			</label>
		</div>
	);
}

function toClock(minute: number): string {
	return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function fromClock(value: string, fallback: number): number {
	const match = /^(\d{2}):(\d{2})/.exec(value);
	if (match === null) return fallback;
	return Number(match[1]) * 60 + Number(match[2]);
}
