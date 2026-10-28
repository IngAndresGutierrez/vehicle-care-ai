-- Fase 3: vincula cada caso humano con el journey afectado, para resolverlo con la transición correcta (ADR-015).
-- AlterTable
ALTER TABLE "HumanCase" ADD COLUMN     "journeyId" TEXT;

-- AddForeignKey
ALTER TABLE "HumanCase" ADD CONSTRAINT "HumanCase_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "JourneyInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "HumanCase_journeyId_idx" ON "HumanCase" ("journeyId");
