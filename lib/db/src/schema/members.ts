import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A Gullak member: a passkey-derived account plus the handle family members
 * use to find it. Deliberately minimal: no email, phone, or legal name.
 */
export const membersTable = pgTable("members", {
  /** EIP-55 checksummed account address. */
  address: text("address").primaryKey(),
  /** Lowercase, unique, exact-match lookup only. */
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  /** ISO 3166-1 alpha-2; picks the local currency shown next to dollar amounts. */
  country: text("country").notNull().default("IN"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMemberSchema = createInsertSchema(membersTable).omit({ createdAt: true });
export type InsertMember = z.infer<typeof insertMemberSchema>;
export type MemberRow = typeof membersTable.$inferSelect;
