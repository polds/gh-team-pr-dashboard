const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timeZone);
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
}

/** The wall-clock reading at `instant`, as if that reading were UTC. */
function wallClockAsUtc(instant: number, timeZone: string): number {
	const parts = formatterFor(timeZone).formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
	return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

function offsetAt(instant: number, timeZone: string): number {
	return wallClockAsUtc(instant, timeZone) - Math.floor(instant / 1000) * 1000;
}

function localDate(instant: number, timeZone: string): number {
	const wall = wallClockAsUtc(instant, timeZone);
	return wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS);
}

/**
 * Midnight can occur twice when clocks fall back across it, or never when they spring forward
 * across it, so each candidate is checked against the offset in force at that instant.
 */
function startOfLocalDate(date: number, timeZone: string): number {
	const before = offsetAt(date - DAY_MS, timeZone);
	const after = offsetAt(date + DAY_MS, timeZone);
	if (before === after) return date - before;
	const candidates = [date - before, date - after].filter((instant) => offsetAt(instant, timeZone) === date - instant);
	return candidates.length === 0 ? date - before : Math.min(...candidates);
}

function isWeekday(date: number): boolean {
	const day = new Date(date).getUTCDay();
	return day >= 1 && day <= 5;
}

/** Elapsed hours between `from` and `to` that fall on Monday to Friday in `timeZone`. */
export function businessHoursBetween(from: Date, to: Date, timeZone: string): number {
	const end = to.getTime();
	let start = from.getTime();
	let date = localDate(start, timeZone);
	let total = 0;
	while (start < end) {
		const nextDate = date + DAY_MS;
		const next = Math.min(startOfLocalDate(nextDate, timeZone), end);
		if (isWeekday(date)) total += next - start;
		start = next;
		date = nextDate;
	}
	return total / HOUR_MS;
}
