const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A short span for a card: "<1m", "12m", "5h", "2d 4h". Negative spans read as zero. */
export function formatDuration(ms: number): string {
	const span = Math.max(0, ms);
	if (span < MINUTE_MS) return "<1m";
	if (span < HOUR_MS) return `${Math.floor(span / MINUTE_MS)}m`;
	if (span < DAY_MS) return `${Math.floor(span / HOUR_MS)}h`;
	const days = Math.floor(span / DAY_MS);
	const hours = Math.floor((span % DAY_MS) / HOUR_MS);
	return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** The same span in words, for screen readers and tooltips: "2 days 4 hours". */
export function formatDurationLong(ms: number): string {
	const span = Math.max(0, ms);
	if (span < MINUTE_MS) return "less than a minute";
	if (span < HOUR_MS) return plural(Math.floor(span / MINUTE_MS), "minute");
	if (span < DAY_MS) return plural(Math.floor(span / HOUR_MS), "hour");
	const days = Math.floor(span / DAY_MS);
	const hours = Math.floor((span % DAY_MS) / HOUR_MS);
	return hours === 0 ? plural(days, "day") : `${plural(days, "day")} ${plural(hours, "hour")}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function formatAgo(at: string, now: Date): string {
	const span = now.getTime() - Date.parse(at);
	if (Number.isNaN(span) || span < MINUTE_MS) return "just now";
	if (span < HOUR_MS) return `${plural(Math.floor(span / MINUTE_MS), "minute")} ago`;
	if (span < DAY_MS) return `${plural(Math.floor(span / HOUR_MS), "hour")} ago`;
	return `${plural(Math.floor(span / DAY_MS), "day")} ago`;
}

export function plural(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** "ken", "ken and ana", "ken, ana, and li". */
export function listOf(items: readonly string[]): string {
	if (items.length <= 2) return items.join(" and ");
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** "acme/web" reads as "web" on a board that is all one organization. */
export function shortRepo(repo: string, org: string): string {
	const prefix = `${org}/`;
	return repo.toLowerCase().startsWith(prefix.toLowerCase()) ? repo.slice(prefix.length) : repo;
}

/** Minutes since local midnight, for quiet hours. */
export function minuteOfDay(date: Date): number {
	return date.getHours() * 60 + date.getMinutes();
}
