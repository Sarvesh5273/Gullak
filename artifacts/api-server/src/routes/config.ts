import { Router, type IRouter } from "express";
import { GetConfigResponse, GetFxRatesResponse } from "@workspace/api-zod";
import {
  AUSD_ADDRESS,
  AUSD_DECIMALS,
  AUSD_SYMBOL,
  CHAIN_ID,
  EXPLORER_URL,
  LIMITS,
  gullakChain,
} from "@workspace/gullak-core";
import { getSponsorStatus } from "../lib/chain";
import { FX_SOURCE_INFO, getFxRates } from "../lib/fx";
import { sendError } from "../lib/http";

const router: IRouter = Router();

router.get("/config", async (_req, res): Promise<void> => {
  const sponsor = await getSponsorStatus();
  res.json(
    GetConfigResponse.parse({
      chainId: CHAIN_ID,
      chainName: gullakChain.name,
      explorerUrl: EXPLORER_URL,
      token: { symbol: AUSD_SYMBOL, address: AUSD_ADDRESS, decimals: AUSD_DECIMALS },
      sponsor,
      limits: {
        maxSend: LIMITS.maxSendUnits.toString(),
        dailySend: LIMITS.dailySendUnits.toString(),
        maxDeposit: LIMITS.maxDepositUnits.toString(),
        dailyDeposit: LIMITS.dailyDepositUnits.toString(),
      },
    }),
  );
});

router.get("/fx", async (_req, res): Promise<void> => {
  const snapshot = await getFxRates();
  if (!snapshot) {
    sendError(res, 503, "fx_unavailable", "Exchange rates are not available right now.");
    return;
  }
  res.set("Cache-Control", "public, max-age=600");
  res.json(
    GetFxRatesResponse.parse({
      base: "USD",
      asOf: snapshot.asOf.toISOString(),
      ...FX_SOURCE_INFO,
      rates: [...snapshot.rates].map(([currency, rate]) => ({ currency, rate })),
    }),
  );
});

export default router;
