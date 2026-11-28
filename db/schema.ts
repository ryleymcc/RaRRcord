import { sqliteTable as table, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const users = table("users", {
  id: text().primaryKey(), username: text().notNull().unique(), name: text().notNull(),
  role: text().notNull().default("member"), state: text().notNull().default("pending"),
  status: text().notNull().default("online"), seen: integer().notNull().default(0),
  avatar: text(), prefs: text().notNull().default("{}"), epoch: integer().notNull().default(0),
});
export const sessions = table("sessions", {
  token: text().primaryKey(), uid: text().notNull(), epoch: integer().notNull(), expires: integer().notNull(),
}, t => [index("sessions_expiry").on(t.uid, t.expires)]);
export const servers = table("servers", { id: text().primaryKey(), name: text().notNull(), icon: text(), picture: text() });
export const members = table("members", { server: text().notNull(), uid: text().notNull(), role: text().notNull().default("member"),
  // Timed out until this time (ms since the epoch); 0 when not timed out.
  timeout: integer().notNull().default(0) },
  t => [primaryKey({columns:[t.server,t.uid]})]);
export const roles = table("roles", { server:text().notNull(), name:text().notNull() }, t=>[primaryKey({columns:[t.server,t.name]})]);
export const channels = table("channels", {
  id: text().primaryKey(), server: text(), name: text().notNull(), kind: text().notNull(),
  category: text().notNull().default(""), description: text().notNull().default(""),
  permission: text().notNull().default(""), position: integer().notNull().default(0),
});
export const channelMembers = table("channel_members", { channel: text().notNull(), uid: text().notNull() },
  t => [primaryKey({columns:[t.channel,t.uid]})]);
export const messages = table("messages", {
  id: integer().primaryKey({autoIncrement:true}), channel:text().notNull(), uid:text().notNull(),
  body:text().notNull(), attachment:text(), filename:text(), reply:integer(),
  created:integer().notNull(), edited:integer(), deleted:integer().notNull().default(0), pinned:integer().notNull().default(0),
}, t => [index("message_history").on(t.channel,t.id),index("message_attachment").on(t.attachment)]);
export const reactions = table("reactions", { mid:integer().notNull(), uid:text().notNull(), emoji:text().notNull() },
  t=>[primaryKey({columns:[t.mid,t.uid,t.emoji]})]);
export const events = table("events", { id:integer().primaryKey({autoIncrement:true}), channel:text().notNull(), mid:integer().notNull(), time:integer().notNull() },
  t=>[index("event_channel").on(t.channel,t.id),index("event_expiry").on(t.time)]);
export const reads = table("reads", { channel:text().notNull(), uid:text().notNull(), mid:integer().notNull() },
  t=>[primaryKey({columns:[t.channel,t.uid]})]);
export const typing = table("typing", { channel:text().notNull(), uid:text().notNull(), expires:integer().notNull() },
  t=>[primaryKey({columns:[t.channel,t.uid]})]);
export const voice = table("voice", { uid:text().primaryKey(), channel:text().notNull(), peer:text().notNull().unique(),
  expires:integer().notNull(), cam:integer().notNull().default(0), screen:integer().notNull().default(0),
  joined:integer().notNull().default(0) },
  t=>[index("voice_room").on(t.channel,t.expires)]);
export const signals = table("signals", { id:integer().primaryKey({autoIncrement:true}), channel:text().notNull(),
  sender:text().notNull(), recipient:text().notNull(), data:text().notNull(), expires:integer().notNull() },
  t=>[index("signal_mailbox").on(t.recipient,t.id),index("signal_expiry").on(t.expires)]);
export const invites = table("invites", { token:text().primaryKey(), server:text(), expires:integer().notNull(), claimed:text() });
export const audit = table("audit", { id:integer().primaryKey({autoIncrement:true}), uid:text().notNull(), action:text().notNull(), detail:text().notNull(), time:integer().notNull() });
export const settings = table("settings", { key:text().primaryKey(), value:text().notNull() });
export const rate = table("rate", { uid:text().notNull(), bucket:text().notNull(), minute:integer().notNull(), hits:integer().notNull() }, t=>[uniqueIndex("rate_bucket").on(t.uid,t.bucket)]);
export const blocks = table("blocks", { uid:text().notNull(), blocked:text().notNull() }, t=>[primaryKey({columns:[t.uid,t.blocked]})]);
