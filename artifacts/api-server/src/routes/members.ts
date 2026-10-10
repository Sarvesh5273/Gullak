import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, membersTable } from "@workspace/db";
import {
  CheckHandleParams,
  CheckHandleResponse,
  GetMeResponse,
  GetMemberParams,
  GetMemberResponse,
  RegisterMemberBody,
  RegisterMemberResponse,
  UpdateMeBody,
  UpdateMeResponse,
} from "@workspace/api-zod";
import {
  DEFAULT_COUNTRY,
  DISPLAY_NAME_MAX,
  countryByCode,
  handleProblem,
  normalizeDisplayName,
  normalizeHandle,
} from "@workspace/gullak-core";
import { authAddress, requireAuth } from "../lib/auth";
import { byAccount, byIp, isUniqueViolation, rateLimit, sendError } from "../lib/http";

const router: IRouter = Router();

const handleCheckLimit = rateLimit({ name: "handle-check", limit: 30, windowMs: 60_000, key: byIp });
const lookupLimit = rateLimit({ name: "member-lookup", limit: 30, windowMs: 60_000, key: byAccount });
const registerLimit = rateLimit({ name: "register", limit: 10, windowMs: 60 * 60_000, key: byIp });
const settingsLimit = rateLimit({ name: "settings", limit: 20, windowMs: 60 * 60_000, key: byAccount });

function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

router.get("/handles/:handle", handleCheckLimit, async (req, res): Promise<void> => {
  const params = CheckHandleParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 400, "bad_request", params.error.message);
    return;
  }
  const handle = normalizeHandle(params.data.handle);
  const problem = handleProblem(handle);
  if (problem) {
    res.json(CheckHandleResponse.parse({ handle, available: false, reason: problem }));
    return;
  }
  const [existing] = await db
    .select({ address: membersTable.address })
    .from(membersTable)
    .where(eq(membersTable.handle, handle));
  res.json(
    CheckHandleResponse.parse({
      handle,
      available: !existing,
      reason: existing ? "That handle is taken." : null,
    }),
  );
});

router.get("/me", requireAuth, async (_req, res): Promise<void> => {
  const address = authAddress(res);
  const [member] = await db.select().from(membersTable).where(eq(membersTable.address, address));
  if (!member) {
    sendError(res, 404, "not_registered", "This account has no Gullak profile yet.");
    return;
  }
  res.json(GetMeResponse.parse(member));
});

router.post("/members", requireAuth, registerLimit, async (req, res): Promise<void> => {
  const body = RegisterMemberBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 400, "bad_request", body.error.message);
    return;
  }
  const address = authAddress(res);
  const handle = normalizeHandle(body.data.handle);
  const problem = handleProblem(handle);
  if (problem) {
    sendError(res, 400, "bad_handle", problem);
    return;
  }
  const displayName = normalizeDisplayName(body.data.displayName);
  if (!displayName || displayName.length > DISPLAY_NAME_MAX || hasControlChars(displayName)) {
    sendError(res, 400, "bad_name", `Use a name of 1–${DISPLAY_NAME_MAX} characters.`);
    return;
  }
  const country = body.data.country ? countryByCode(body.data.country) : countryByCode(DEFAULT_COUNTRY);
  if (!country) {
    sendError(res, 400, "bad_country", "Gullak doesn't support that country yet.");
    return;
  }

  const [existing] = await db.select().from(membersTable).where(eq(membersTable.address, address));
  if (existing) {
    sendError(res, 409, "already_registered", `This account is already @${existing.handle}.`);
    return;
  }

  try {
    const [member] = await db.insert(membersTable).values({ address, handle, displayName, country: country.code }).returning();
    req.log.info({ handle }, "Member registered");
    res.status(201).json(RegisterMemberResponse.parse(member));
  } catch (err) {
    if (isUniqueViolation(err)) {
      sendError(res, 409, "handle_taken", "That handle is taken.");
      return;
    }
    throw err;
  }
});

router.get("/members/:handle", requireAuth, lookupLimit, async (req, res): Promise<void> => {
  const params = GetMemberParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 400, "bad_request", params.error.message);
    return;
  }
  const handle = normalizeHandle(params.data.handle);
  const [member] = await db.select().from(membersTable).where(eq(membersTable.handle, handle));
  if (!member) {
    sendError(res, 404, "not_found", `No one is called @${handle}.`);
    return;
  }
  res.json(
    GetMemberResponse.parse({
      address: member.address,
      handle: member.handle,
      displayName: member.displayName,
      country: member.country,
    }),
  );
});

router.patch("/me", requireAuth, settingsLimit, async (req, res): Promise<void> => {
  const body = UpdateMeBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 400, "bad_request", body.error.message);
    return;
  }
  const country = countryByCode(body.data.country);
  if (!country) {
    sendError(res, 400, "bad_country", "Gullak doesn't support that country yet.");
    return;
  }
  const [member] = await db
    .update(membersTable)
    .set({ country: country.code })
    .where(eq(membersTable.address, authAddress(res)))
    .returning();
  if (!member) {
    sendError(res, 404, "not_registered", "This account has no Gullak profile yet.");
    return;
  }
  res.json(UpdateMeResponse.parse(member));
});

export default router;
