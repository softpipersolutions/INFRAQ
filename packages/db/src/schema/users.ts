import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { userRoleEnum } from "./enums";

/** Application users, keyed by Firebase Auth uid. */
export const users = pgTable("users", {
  firebaseUid: text("firebase_uid").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  role: userRoleEnum("role").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
