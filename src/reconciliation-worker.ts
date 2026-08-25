import {
  ConfigurationError,
  loadReconciliationWorkerConfig,
} from "./config.js";
import { createReconciliationWorkerLogger } from "./reconciliation-worker-logger.js";
import { runReconciliationWorker } from "./worker-runtime.js";

const safeErrorCodePattern = /^[A-Za-z0-9_.-]{1,64}$/;

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    safeErrorCodePattern.test(error.code)
  ) {
    return error.code;
  }

  return "unknown";
}

async function main(): Promise<void> {
  const config = loadReconciliationWorkerConfig(process.env);
  const logger = createReconciliationWorkerLogger({
    level: config.logLevel,
    serviceVersion: config.serviceVersion,
  });

  try {
    await runReconciliationWorker({ config, logger });
  } catch (error) {
    logger.fatal(
      { startupErrorCode: safeErrorCode(error) },
      "LOOP reconciliation worker failed to start",
    );
    throw error;
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : "LOOP reconciliation worker startup failed. See structured logs for the error code.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
