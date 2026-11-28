ALTER TABLE `servers` ADD `background` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `background_fill` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `background_dim` integer DEFAULT 60 NOT NULL;