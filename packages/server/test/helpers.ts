import { isIsoTime } from "@radar/core";
import type { IsoTime } from "@radar/core";
import type { LogFields, Logger } from "../src/log.ts";

/** A logger that keeps what it was told, so tests can assert on events and check that no secret was written. */
export function recordingLogger() {
	const lines: { level: string; event: string; fields: LogFields }[] = [];
	const at = (level: string) => (event: string, fields: LogFields = {}) => {
		lines.push({ level, event, fields });
	};
	const log: Logger = { info: at("info"), warn: at("warn"), error: at("error") };
	return { log, lines, events: () => lines.map((line) => line.event) };
}

export function iso(value: string): IsoTime {
	if (!isIsoTime(value)) throw new Error(`not a time: ${value}`);
	return value;
}

/** Reads one of the app's own JSON responses as the protocol type the app built it from. Tests assert on the fields, so a wrong shape fails there. */
export async function jsonOf<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}
