CREATE TABLE IF NOT EXISTS "GenerationJob" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "prompt" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "features" TEXT NOT NULL DEFAULT '[]',
    "customFeatures" TEXT NOT NULL DEFAULT '[]',
    "planToken" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resultSpec" TEXT,
    "resultMeta" TEXT,
    "error" TEXT,
    "errorDetail" TEXT,
    "lockedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GenerationJob_accountId_createdAt_idx" ON "GenerationJob"("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "GenerationJob_status_createdAt_idx" ON "GenerationJob"("status", "createdAt");

DO $$ BEGIN
  ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
