CREATE TYPE "public"."external_id_kind" AS ENUM('external', 'fingerprint');--> statement-breakpoint
CREATE TYPE "public"."import_job_status" AS ENUM('uploaded', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "external_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"local_id" uuid NOT NULL,
	"id_kind" "external_id_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"status" "import_job_status" DEFAULT 'uploaded' NOT NULL,
	"file_name" text NOT NULL,
	"delimiter" text NOT NULL,
	"encoding" text NOT NULL,
	"source_text" text,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "external_reference" ADD CONSTRAINT "external_reference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_reference_identity_idx" ON "external_reference" USING btree ("organization_id","provider","entity_type","external_id");--> statement-breakpoint
CREATE INDEX "external_reference_local_idx" ON "external_reference" USING btree ("organization_id","local_id");--> statement-breakpoint
CREATE INDEX "import_job_org_created_idx" ON "import_job" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "external_reference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_reference" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "external_reference_tenant_isolation" ON "external_reference"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "import_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_job" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "import_job_tenant_isolation" ON "import_job"
  USING ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);