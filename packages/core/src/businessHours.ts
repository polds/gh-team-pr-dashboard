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

/** The local calendar date of `instant`, as the UTC midnight of that date. */
function localDate(instant: number, timeZone: string): number {
	const wall = wallClockAsUtc(instant, timeZone);
	return wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS);
}

/** The first instant of the local calendar date `date`, given as the UTC midnight of that date. */
function startOfLocalDate(date: number, timeZone: string): number {
	const guess = date - offsetAt(date, timeZone);
	return date - offsetAt(guess, timeZone);
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
