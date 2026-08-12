-- Production baseline for Toolkin.
-- It is intentionally idempotent so installations that were originally
-- bootstrapped with `prisma migrate dev` on the server can adopt the checked-in
-- migration history without destructive table recreation.

CREATE TABLE IF NOT EXISTS "Account" (
    "id" TEXT NOT NULL,
    "appUserId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "welcomeGranted" BOOLEAN NOT NULL DEFAULT false,
    "premiumUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- Older Toolkin databases used a different free-generation flag. Existing
-- accounts must not receive welcome credits a second time. New rows still
-- default to false and are granted exactly once by the credit service.
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "welcomeGranted" BOOLEAN;
UPDATE "Account" SET "welcomeGranted" = true WHERE "welcomeGranted" IS NULL;
ALTER TABLE "Account" ALTER COLUMN "welcomeGranted" SET DEFAULT false;
ALTER TABLE "Account" ALTER COLUMN "welcomeGranted" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "Ledger" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "eventId" TEXT,
    "meta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ledger_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Ledger" ADD COLUMN IF NOT EXISTS "meta" TEXT;

CREATE TABLE IF NOT EXISTS "SpecCache" (
    "hash" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "kind" TEXT,
    "spec" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SpecCache_pkey" PRIMARY KEY ("hash")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Account_appUserId_key" ON "Account"("appUserId");
CREATE INDEX IF NOT EXISTS "Account_premiumUntil_idx" ON "Account"("premiumUntil");
CREATE UNIQUE INDEX IF NOT EXISTS "Ledger_eventId_key" ON "Ledger"("eventId");
CREATE INDEX IF NOT EXISTS "Ledger_accountId_createdAt_idx" ON "Ledger"("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "SpecCache_usedAt_idx" ON "SpecCache"("usedAt");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Ledger_accountId_fkey'
    ) THEN
        ALTER TABLE "Ledger"
            ADD CONSTRAINT "Ledger_accountId_fkey"
            FOREIGN KEY ("accountId") REFERENCES "Account"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
