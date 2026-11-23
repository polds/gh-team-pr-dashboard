import { serve } from "@hono/node-server";
import { systemClock } from "./clock.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { createLogger } from "./log.ts";
import { createRadar } from "./radar.ts";

const log = createLogger();

function configOrExit(): Config {
	try {
		return loadConfig(process.env);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		log.error("config.invalid", { problems: error.message });
		process.exit(1);
	}
}

const config = configOrExit();
const radar = createRadar({ config, clock: systemClock, log });

const server = serve({ fetch: radar.app.fetch, port: config.port }, (info) => {
	log.info("server.listening", { port: info.port, mode: config.mode, org: config.org, rerequestEnabled: config.rerequestEnabled });
});

await radar.reconciler.sweep();
radar.start();

let stopping = false;
function shutdown(signal: string): void {
	if (stopping) return;
	stopping = true;
	log.info("server.stopping", { signal });
	radar.stop();
	server.close(() => {
		log.info("server.stopped");
		process.exit(0);
	});
	if ("closeAllConnections" in server) server.closeAllConnections();
	setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
