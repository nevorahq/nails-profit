CREATE TYPE "public"."commission_type" AS ENUM('percentage', 'fixed', 'percentage_after_materials');--> statement-breakpoint
CREATE TYPE "public"."cooperation_type" AS ENUM('commission', 'rent', 'staff');--> statement-breakpoint
CREATE TABLE "add_on" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"price_delta_minor" bigint DEFAULT 0 NOT NULL,
	"duration_delta_minutes" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"specialist_id" uuid NOT NULL,
	"service_id" uuid,
	"type" "commission_type" NOT NULL,
	"basis_points" integer,
	"fixed_amount_minor" bigint,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_to" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rule_shape" CHECK (("commission_rule"."type" = 'fixed' and "commission_rule"."fixed_amount_minor" is not null and "commission_rule"."basis_points" is null)
        or ("commission_rule"."type" <> 'fixed' and "commission_rule"."basis_points" is not null and "commission_rule"."fixed_amount_minor" is null)),
	CONSTRAINT "commission_rule_non_negative" CHECK (("commission_rule"."basis_points" is null or "commission_rule"."basis_points" >= 0)
        and ("commission_rule"."fixed_amount_minor" is null or "commission_rule"."fixed_amount_minor" >= 0))
);
--> statement-breakpoint
CREATE TABLE "recipe_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"normative_quantity_milli_units" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_item_quantity_positive" CHECK ("recipe_item"."normative_quantity_milli_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "recipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid,
	"add_on_id" uuid,
	"recipe_version" integer DEFAULT 1 NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_single_target" CHECK (("recipe"."service_id" is not null and "recipe"."add_on_id" is null)
        or ("recipe"."service_id" is null and "recipe"."add_on_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "service_add_on" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"add_on_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"cooperation_type" "cooperation_type" DEFAULT 'commission' NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "material" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "material" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "material" ADD COLUMN "supplier" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "price_minor" bigint;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "currency" "currency";--> statement-breakpoint
ALTER TABLE "add_on" ADD CONSTRAINT "add_on_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "add_on" ADD CONSTRAINT "add_on_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "add_on" ADD CONSTRAINT "add_on_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_specialist_id_specialist_id_fk" FOREIGN KEY ("specialist_id") REFERENCES "public"."specialist"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_item" ADD CONSTRAINT "recipe_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_item" ADD CONSTRAINT "recipe_item_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_item" ADD CONSTRAINT "recipe_item_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_item" ADD CONSTRAINT "recipe_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_item" ADD CONSTRAINT "recipe_item_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_add_on_id_add_on_id_fk" FOREIGN KEY ("add_on_id") REFERENCES "public"."add_on"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_add_on" ADD CONSTRAINT "service_add_on_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_add_on" ADD CONSTRAINT "service_add_on_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_add_on" ADD CONSTRAINT "service_add_on_add_on_id_add_on_id_fk" FOREIGN KEY ("add_on_id") REFERENCES "public"."add_on"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist" ADD CONSTRAINT "specialist_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist" ADD CONSTRAINT "specialist_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist" ADD CONSTRAINT "specialist_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist" ADD CONSTRAINT "specialist_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "add_on_org_idx" ON "add_on" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "commission_rule_lookup_idx" ON "commission_rule" USING btree ("organization_id","specialist_id","active_from");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_item_material_idx" ON "recipe_item" USING btree ("recipe_id","material_id");--> statement-breakpoint
CREATE INDEX "recipe_service_idx" ON "recipe" USING btree ("organization_id","service_id","active_from");--> statement-breakpoint
CREATE INDEX "recipe_add_on_idx" ON "recipe" USING btree ("organization_id","add_on_id","active_from");--> statement-breakpoint
CREATE UNIQUE INDEX "service_add_on_idx" ON "service_add_on" USING btree ("service_id","add_on_id");--> statement-breakpoint
CREATE INDEX "service_category_org_idx" ON "service_category" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "specialist_org_idx" ON "specialist" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "specialist_user_idx" ON "specialist" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_category_id_service_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_price_non_negative" CHECK ("service"."price_minor" is null or "service"."price_minor" >= 0);--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_duration_positive" CHECK ("service"."duration_minutes" is null or "service"."duration_minutes" > 0);
--> statement-breakpoint
-- RLS is hand-written: Drizzle does not generate it. Every tenant-owned table
-- added in this migration gets the same policy as migration 0000.
--> statement-breakpoint
ALTER TABLE "service_category" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_category" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_category_tenant_isolation" ON "service_category"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "add_on" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "add_on" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "add_on_tenant_isolation" ON "add_on"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "service_add_on" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_add_on" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_add_on_tenant_isolation" ON "service_add_on"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "specialist" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "specialist" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "specialist_tenant_isolation" ON "specialist"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "commission_rule" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commission_rule" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "commission_rule_tenant_isolation" ON "commission_rule"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "recipe" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "recipe" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "recipe_tenant_isolation" ON "recipe"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "recipe_item" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "recipe_item" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "recipe_item_tenant_isolation" ON "recipe_item"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);
