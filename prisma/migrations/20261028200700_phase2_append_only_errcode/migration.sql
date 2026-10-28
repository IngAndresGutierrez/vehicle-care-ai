-- El SQLSTATE 23001 (restrict_violation) hacía que Prisma reportara la violación append-only como
-- "Foreign key constraint violated" (P2003). Se usa un código propio de la clase P0 para un error inequívoco.
CREATE OR REPLACE FUNCTION "vc_forbid_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % no permite % (registro %)', TG_TABLE_NAME, TG_OP, OLD."id"
    USING ERRCODE = 'P0A01', HINT = 'Corrija con un registro nuevo que referencie al anterior (supersedesId).';
END;
$$;
