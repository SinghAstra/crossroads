SET @formula_uuid = '00000000-0000-4000-8000-000000000031';

SELECT
  version,
  id,
  uuid,
  name,
  formula_text,
  status,
  created_by,
  first_created_at,
  inserted_at,
  inputs
FROM formulas
WHERE uuid = @formula_uuid
ORDER BY version ASC;
