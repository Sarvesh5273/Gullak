import { Router, type IRouter } from "express";
import healthRouter from "./health";
import configRouter from "./config";
import membersRouter from "./members";
import moneyRouter from "./money";
import cashoutsRouter from "./cashouts";
import downloadsRouter from "./downloads";
import devDownloadsRouter from "./dev-downloads";

const router: IRouter = Router();

router.use(healthRouter);
router.use(configRouter);
router.use(membersRouter);
router.use(moneyRouter);
router.use(cashoutsRouter);
router.use(downloadsRouter);
if (process.env["NODE_ENV"] !== "production") {
  router.use(devDownloadsRouter);
}

export default router;
