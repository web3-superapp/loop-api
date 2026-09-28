import { buildApp } from "./app.js";
import { ConfigurationError, loadConfig } from "./config.js";
import { configureOutboundKeepAlive } from "./core/http/outbound-keep-alive.js";

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return "unknown";
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // Decision 0088: keep Provider connections warm between page loads.
  configureOutboundKeepAlive();
  const app = await buildApp({ config });
  let shutdownStarted = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    app.log.info({ signal }, "Graceful shutdown started");
    await app.close();
    app.log.info("Graceful shutdown completed");
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      {
        docsEnabled: config.apiDocsEnabled,
        environment: config.nodeEnv,
        publicBaseUrl: config.publicBaseUrl,
      },
      "LOOP API started",
    );
  } catch (error) {
    app.log.fatal(
      { startupErrorCode: safeErrorCode(error) },
      "LOOP API failed to start",
    );
    await app.close();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : "LOOP API startup failed. See structured logs for the error code.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
