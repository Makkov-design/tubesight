#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGeminiAnalyzer } from "./analyzer.js";
import { CachedAnalyzer } from "./cache.js";
import { loadConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel, undefined, [config.apiKey]);
  const analyzer = new CachedAnalyzer(createGeminiAnalyzer(config, logger), { ttlMs: config.cacheTtlMs });
  const server = createServer({ analyzer, logger });

  await server.connect(new StdioServerTransport());
  logger.info(`ytlens ${VERSION} ready`, { model: config.model });
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[ytlens] ERROR ${message}\n`);
  process.exit(1);
});
