export type Timer = ReturnType<typeof setTimeout>;

export interface Clock {
	now(): Date;
	setTimeout(callback: () => void, ms: number): Timer;
	clearTimeout(timer: Timer): void;
	setInterval(callback: () => void, ms: number): Timer;
	clearInterval(timer: Timer): void;
}

/** Reads the globals at call time, so fake timers installed by a test take effect. */
export const systemClock: Clock = {
	now: () => new Date(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (timer) => clearTimeout(timer),
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (timer) => clearInterval(timer),
};
