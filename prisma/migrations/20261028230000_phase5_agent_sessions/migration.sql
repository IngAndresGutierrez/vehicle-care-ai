-- Fase 5 — Sesiones del agente (ADR-018). Columnas nuevas con valores por defecto: segura sobre datos existentes.
-- AlterTable
ALTER TABLE "ConversationSession" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "serviceCode" TEXT NOT NULL DEFAULT 'ENGINE_OIL_FILTER',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "transcript" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "turnCount" INTEGER NOT NULL DEFAULT 0;


ALTER TABLE "ConversationSession" ADD CONSTRAINT "ConversationSession_turn_count_non_negative" CHECK ("turnCount" >= 0);
ALTER TABLE "ConversationSession" ADD CONSTRAINT "ConversationSession_status_values" CHECK ("status" IN ('ACTIVE', 'CLOSED'));
ALTER TABLE "ConversationSession" ADD CONSTRAINT "ConversationSession_transcript_is_array" CHECK (jsonb_typeof("transcript") = 'array');

-- La transcripción solo crece: cada actualización debe conservar como prefijo exacto la anterior.
CREATE FUNCTION "vc_transcript_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_array_length(NEW."transcript") < jsonb_array_length(OLD."transcript")
     OR (SELECT coalesce(jsonb_agg(e ORDER BY i), '[]'::jsonb)
           FROM jsonb_array_elements(NEW."transcript") WITH ORDINALITY AS t(e, i)
          WHERE i <= jsonb_array_length(OLD."transcript")) <> OLD."transcript" THEN
    RAISE EXCEPTION 'append-only: la transcripción de la sesión % solo admite añadidos', OLD."id"
      USING ERRCODE = 'P0A01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ConversationSession_transcript_append_only" BEFORE UPDATE OF "transcript" ON "ConversationSession"
  FOR EACH ROW EXECUTE FUNCTION "vc_transcript_append_only"();

-- Los mensajes mostrados al usuario son registro de auditoría.
CREATE TRIGGER "ConversationMessage_append_only" BEFORE UPDATE OR DELETE ON "ConversationMessage"
  FOR EACH ROW EXECUTE FUNCTION "vc_forbid_mutation"();
