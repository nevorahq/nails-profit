--> USING clause added by hand: PostgreSQL has no implicit text -> jsonb cast, so
--> the generated statement fails without it. Existing plain names become the
--> Russian translation, matching the organization default locale.
ALTER TABLE "service" ALTER COLUMN "name" SET DATA TYPE jsonb USING jsonb_build_object('ru', "name");--> statement-breakpoint
ALTER TABLE "material" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "material" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "material" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "material" ADD CONSTRAINT "material_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material" ADD CONSTRAINT "material_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;