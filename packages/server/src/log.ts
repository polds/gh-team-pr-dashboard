export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, LogValue>;
export type LogLevel = "info" | "warn" | "error";

export interface Logger {
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
}

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
	const emit = (level: LogLevel) => (event: string, fields: LogFields = {}) =>
		write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`);
	return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
