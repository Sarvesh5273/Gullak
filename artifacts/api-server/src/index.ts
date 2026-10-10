import app from "./app";
import { logger } from "./lib/logger";
import { getFxRates } from "./lib/fx";
import { startReconciler } from "./lib/settlement";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void getFxRates(); // warm the exchange-rate cache so the first receipt has a rate
  startReconciler(); // finish money movements a restart or timeout interrupted
});
