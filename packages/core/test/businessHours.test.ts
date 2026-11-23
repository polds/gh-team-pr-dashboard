import { describe, expect, it } from "vitest";
import { businessHoursBetween } from "../src/index.ts";

const LA = "America/Los_Angeles";
const between = (from: string, to: string, timeZone = LA) => businessHoursBetween(new Date(from), new Date(to), timeZone);

describe("businessHoursBetween", () => {
	it("counts elapsed hours inside one weekday", () => {
		expect(between("2026-11-02T17:00:00Z", "2026-11-03T01:00:00Z")).toBe(8);
	});

	it("counts a whole weekday as 24 hours", () => {
		expect(between("2026-11-03T08:00:00Z", "2026-11-04T08:00:00Z")).toBe(24);
	});

	it("skips Saturday and Sunday in the configured time zone", () => {
		expect(between("2026-11-06T20:00:00Z", "2026-11-09T20:00:00Z")).toBe(24);
	});

	it("uses local midnight, not UTC midnight, to decide the weekday", () => {
		expect(between("2026-11-07T06:00:00Z", "2026-11-07T08:00:00Z")).toBe(2);
		expect(between("2026-11-07T06:00:00Z", "2026-11-07T08:00:00Z", "UTC")).toBe(0);
	});

	it("stays exact across the spring-forward weekend in Los Angeles", () => {
		expect(between("2026-03-06T20:00:00Z", "2026-03-09T19:00:00Z")).toBe(24);
	});

	it("stays exact across the fall-back weekend in Los Angeles", () => {
		expect(between("2026-10-30T19:00:00Z", "2026-11-02T20:00:00Z")).toBe(24);
	});

	it("counts a 23-hour weekday when a zone skips midnight on a Friday", () => {
		expect(between("2026-04-23T10:00:00Z", "2026-04-25T09:00:00Z", "Africa/Cairo")).toBe(35);
	});

	it("keeps a whole Friday when a zone east of UTC skips Saturday midnight", () => {
		expect(between("2020-03-19T20:30:00Z", "2020-03-21T19:30:00Z", "Asia/Tehran")).toBe(24);
	});

	it("starts Saturday at the first of two midnights when clocks fall back across it", () => {
		expect(between("2020-10-23T09:00:00Z", "2020-10-24T10:00:00Z", "Asia/Gaza")).toBe(12);
	});

	it("is zero when the range is empty or reversed", () => {
		expect(between("2026-11-02T17:00:00Z", "2026-11-02T17:00:00Z")).toBe(0);
		expect(between("2026-11-03T17:00:00Z", "2026-11-02T17:00:00Z")).toBe(0);
	});
});
