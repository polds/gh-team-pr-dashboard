import { describe, expect, test } from "vitest";
import { formatAgo, formatDuration, formatDurationLong, listOf } from "../src/format.ts";
import { NOW, hoursAgo } from "./fixtures.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
	test.each([
		[0, "<1m"],
		[59_999, "<1m"],
		[MINUTE, "1m"],
		[12 * MINUTE + 30_000, "12m"],
		[59 * MINUTE, "59m"],
		[HOUR, "1h"],
		[5 * HOUR + 59 * MINUTE, "5h"],
		[DAY, "1d"],
		[2 * DAY + 4 * HOUR + 10 * MINUTE, "2d 4h"],
		[40 * DAY, "40d"],
	])("%i ms reads %s", (ms, text) => {
		expect(formatDuration(ms)).toBe(text);
	});

	test("a span from a clock that runs ahead reads as zero, not negative", () => {
		expect(formatDuration(-5 * MINUTE)).toBe("<1m");
	});

	test("the long form spells the same span out", () => {
		expect(formatDurationLong(2 * DAY + 4 * HOUR)).toBe("2 days 4 hours");
		expect(formatDurationLong(DAY + HOUR)).toBe("1 day 1 hour");
		expect(formatDurationLong(3 * MINUTE)).toBe("3 minutes");
	});
});

describe("formatAgo", () => {
	test("counts back from now in the largest whole unit", () => {
		expect(formatAgo(hoursAgo(0), NOW)).toBe("just now");
		expect(formatAgo(hoursAgo(0.5), NOW)).toBe("30 minutes ago");
		expect(formatAgo(hoursAgo(1), NOW)).toBe("1 hour ago");
		expect(formatAgo(hoursAgo(49), NOW)).toBe("2 days ago");
	});
});

describe("listOf", () => {
	test("joins names the way a sentence does", () => {
		expect(listOf(["ken"])).toBe("ken");
		expect(listOf(["ken", "ana"])).toBe("ken and ana");
		expect(listOf(["ken", "ana", "li"])).toBe("ken, ana, and li");
	});
});
