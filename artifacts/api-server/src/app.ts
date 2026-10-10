import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import wellKnownRouter from "./routes/well-known";
import { logger } from "./lib/logger";
import { byIp, rateLimit, sendError } from "./lib/http";

const app: Express = express();

// Behind Replit's proxy: use X-Forwarded-For for req.ip (rate limiting).
app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Bearer-token auth only (no cookies), so any origin may call the API.
app.use(cors());
app.use(express.json({ limit: "16kb" }));

app.use("/.well-known", wellKnownRouter);
app.use("/api", rateLimit({ name: "api-ip", limit: 300, windowMs: 60_000, key: byIp }), router);

app.use("/api", (_req: Request, res: Response): void => {
  sendError(res, 404, "not_found", "No such endpoint.");
});

// Last-resort handler: log the details, never leak them.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const status = (err as { status?: number })?.status;
  if (status === 400 || status === 413) {
    sendError(res, status, "bad_request", status === 413 ? "Request too large." : "Malformed request.");
    return;
  }
  req.log.error({ err }, "Unhandled error");
  sendError(res, 500, "internal", "Something went wrong on our side.");
});

export default app;
