CREATE TABLE "chair_rent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"specialist_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_to" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chair_rent_amount_non_negative" CHECK ("chair_rent"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "master_payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"specialist_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" "currency" NOT NULL,
	"paid_on" date DEFAULT CURRENT_DATE NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_payout_amount_positive" CHECK ("master_payout"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "visit" ADD COLUMN "master_cooperation" "cooperation_type";--> statement-breakpoint
ALTER TABLE "chair_rent" ADD CONSTRAINT "chair_rent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chair_rent" ADD CONSTRAINT "chair_rent_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chair_rent" ADD CONSTRAINT "chair_rent_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chair_rent" ADD CONSTRAINT "chair_rent_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_payout" ADD CONSTRAINT "master_payout_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_payout" ADD CONSTRAINT "master_payout_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_payout" ADD CONSTRAINT "master_payout_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_payout" ADD CONSTRAINT "master_payout_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chair_rent_lookup_idx" ON "chair_rent" USING btree ("organization_id","specialist_id","active_from");--> statement-breakpoint
CREATE INDEX "master_payout_org_idx" ON "master_payout" USING btree ("organization_id","paid_on");--> statement-breakpoint
CREATE INDEX "master_payout_specialist_idx" ON "master_payout" USING btree ("specialist_id","paid_on");--> statement-breakpoint

-- RLS is hand-written because Drizzle does not generate tenant policies. Stated
-- rather than inherited: Supabase turns RLS on for new tables in `public`, and a
-- migration that stays silent leaves the application locked out of a table its
-- own tests — on a plain PostgreSQL box, where RLS defaults off — say is fine.
ALTER TABLE "chair_rent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chair_rent" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "chair_rent_tenant_isolation" ON "chair_rent"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "master_payout" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "master_payout" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "master_payout_tenant_isolation" ON "master_payout"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- Ownership and grants, stated rather than inherited — see `drizzle/0028`.
DO $grants$
DECLARE
  api_role text;
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY['chair_rent', 'master_payout'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit') THEN
      EXECUTE format('ALTER TABLE %I OWNER TO "nail_profit"', tenant_table);
    END IF;

    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', tenant_table, api_role);
      END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nail_profit_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO "nail_profit_app"', tenant_table);
    END IF;
  END LOOP;
END
$grants$;
