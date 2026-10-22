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

WITH RECURSIVE
active AS (
  SELECT uuid, version, name, formula_text, inputs
  FROM current_formulas_aggregate
  WHERE status = 'ACTIVE'
),
deps AS (
  SELECT a.uuid, a.name, jt.input_name AS dependency
  FROM active AS a
  JOIN JSON_TABLE(
    CAST(a.inputs AS JSON),
    '$[*]' COLUMNS (
      input_name VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PATH '$'
    )
  ) AS jt ON TRUE
  JOIN active AS d ON d.name = jt.input_name
),
roots AS (
  SELECT a.uuid, a.name, 0 AS depth
  FROM active AS a
  WHERE NOT EXISTS (
    SELECT 1 FROM deps AS d WHERE d.uuid = a.uuid
  )
),
tree AS (
  SELECT r.uuid, r.name, r.depth
  FROM roots AS r
  UNION ALL
  SELECT a.uuid, a.name, t.depth + 1
  FROM tree AS t
  JOIN deps AS d ON d.dependency = t.name
  JOIN active AS a ON a.uuid = d.uuid
),
ordered AS (
  SELECT uuid, name, MAX(depth) AS depth
  FROM tree
  GROUP BY uuid, name
)
SELECT
  ROW_NUMBER() OVER (ORDER BY o.depth ASC, o.name ASC) AS execution_order,
  o.depth,
  a.uuid,
  a.version,
  a.name,
  a.formula_text,
  a.inputs
FROM ordered AS o
JOIN active AS a ON a.uuid = o.uuid
ORDER BY o.depth ASC, o.name ASC;

SELECT
  c.uuid,
  c.name,
  c.version AS current_version,
  COUNT(*) AS version_count
FROM current_formulas_aggregate AS c
JOIN formulas AS f ON f.uuid = c.uuid
GROUP BY c.uuid, c.name, c.version
ORDER BY c.name ASC;

SELECT
  r.formula_uuid,
  c.name,
  COUNT(*) AS total_runs,
  SUM(r.status = 'FAILED') AS failures,
  SUM(r.status = 'SKIPPED') AS skipped,
  ROUND(100.0 * SUM(r.status = 'FAILED') / NULLIF(COUNT(*), 0), 2) AS failure_percentage
FROM formula_runs AS r
JOIN current_formulas_aggregate AS c ON c.uuid = r.formula_uuid
WHERE r.inserted_at >= NOW() - INTERVAL 7 DAY
GROUP BY r.formula_uuid, c.name
ORDER BY failure_percentage DESC, failures DESC, c.name ASC;
