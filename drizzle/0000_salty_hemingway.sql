CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text NOT NULL,
	`action` text NOT NULL,
	`detail` text NOT NULL,
	`time` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blocks` (
	`uid` text NOT NULL,
	`blocked` text NOT NULL,
	PRIMARY KEY(`uid`, `blocked`)
);
--> statement-breakpoint
CREATE TABLE `channel_members` (
	`channel` text NOT NULL,
	`uid` text NOT NULL,
	PRIMARY KEY(`channel`, `uid`)
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`server` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`permission` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`mid` integer NOT NULL,
	`time` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_channel` ON `events` (`channel`,`id`);--> statement-breakpoint
CREATE INDEX `event_expiry` ON `events` (`time`);--> statement-breakpoint
CREATE TABLE `invites` (
	`token` text PRIMARY KEY NOT NULL,
	`server` text,
	`expires` integer NOT NULL,
	`claimed` text
);
--> statement-breakpoint
CREATE TABLE `members` (
	`server` text NOT NULL,
	`uid` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	PRIMARY KEY(`server`, `uid`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`uid` text NOT NULL,
	`body` text NOT NULL,
	`attachment` text,
	`filename` text,
	`reply` integer,
	`created` integer NOT NULL,
	`edited` integer,
	`deleted` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_history` ON `messages` (`channel`,`id`);--> statement-breakpoint
CREATE TABLE `rate` (
	`uid` text NOT NULL,
	`bucket` text NOT NULL,
	`minute` integer NOT NULL,
	`hits` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_bucket` ON `rate` (`uid`,`bucket`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`mid` integer NOT NULL,
	`uid` text NOT NULL,
	`emoji` text NOT NULL,
	PRIMARY KEY(`mid`, `uid`, `emoji`)
);
--> statement-breakpoint
CREATE TABLE `reads` (
	`channel` text NOT NULL,
	`uid` text NOT NULL,
	`mid` integer NOT NULL,
	PRIMARY KEY(`channel`, `uid`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`server` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`server`, `name`)
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`uid` text NOT NULL,
	`epoch` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`uid`,`expires`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`data` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signal_mailbox` ON `signals` (`recipient`,`id`);--> statement-breakpoint
CREATE INDEX `signal_expiry` ON `signals` (`expires`);--> statement-breakpoint
CREATE TABLE `typing` (
	`channel` text NOT NULL,
	`uid` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`channel`, `uid`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	`avatar` text,
	`prefs` text DEFAULT '{}' NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `voice` (
	`uid` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`peer` text NOT NULL,
	`expires` integer NOT NULL,
	`cam` integer DEFAULT 0 NOT NULL,
	`screen` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_peer_unique` ON `voice` (`peer`);--> statement-breakpoint
CREATE INDEX `voice_room` ON `voice` (`channel`,`expires`);