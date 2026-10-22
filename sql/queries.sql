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
  FROM current_formulas_window
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
FROM current_formulas_window AS c
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
JOIN current_formulas_window AS c ON c.uuid = r.formula_uuid
WHERE r.inserted_at >= NOW() - INTERVAL 7 DAY
GROUP BY r.formula_uuid, c.name
ORDER BY failure_percentage DESC, failures DESC, c.name ASC;

WITH failures AS (
  SELECT
    r.formula_uuid,
    r.error,
    r.inserted_at,
    ROW_NUMBER() OVER (
      PARTITION BY r.formula_uuid
      ORDER BY r.inserted_at DESC, r.id DESC
    ) AS recency_rank,
    COUNT(*) OVER (PARTITION BY r.formula_uuid) AS failure_count
  FROM formula_runs AS r
  WHERE r.status = 'FAILED'
    AND r.inserted_at >= NOW() - INTERVAL 7 DAY
)
SELECT
  f.formula_uuid,
  c.name,
  f.failure_count,
  f.inserted_at AS last_failure_at,
  f.error AS latest_error
FROM failures AS f
JOIN current_formulas_window AS c ON c.uuid = f.formula_uuid
WHERE f.recency_rank = 1
ORDER BY f.failure_count DESC, f.inserted_at DESC, c.name ASC
LIMIT 5;

WITH first_deactivation AS (
  SELECT uuid, MIN(id) AS first_inactive_id
  FROM formulas
  WHERE status = 'INACTIVE'
  GROUP BY uuid
),
first_inactive AS (
  SELECT
    d.uuid,
    d.first_inactive_id,
    f.version AS first_inactive_version,
    f.inserted_at AS first_inactive_at
  FROM first_deactivation AS d
  JOIN formulas AS f ON f.id = d.first_inactive_id
)
SELECT
  c.name,
  c.uuid,
  c.version AS current_version,
  c.inserted_at AS current_inserted_at,
  fi.first_inactive_version,
  fi.first_inactive_at
FROM current_formulas_window AS c
JOIN first_inactive AS fi ON fi.uuid = c.uuid
WHERE c.status = 'INACTIVE'
  AND NOT EXISTS (
    SELECT 1
    FROM formulas AS a
    WHERE a.uuid = c.uuid
      AND a.status = 'ACTIVE'
      AND a.id > fi.first_inactive_id
  )
ORDER BY c.name ASC;

WITH version_gaps AS (
  SELECT
    f.uuid,
    f.version,
    f.inserted_at,
    TIMESTAMPDIFF(
      SECOND,
      LAG(f.inserted_at) OVER (PARTITION BY f.uuid ORDER BY f.version),
      f.inserted_at
    ) AS gap_seconds
  FROM formulas AS f
)
SELECT
  c.name,
  v.uuid,
  v.version,
  v.inserted_at,
  v.gap_seconds,
  ROUND(v.gap_seconds / 86400, 2) AS gap_days,
  ROUND(AVG(v.gap_seconds) OVER (PARTITION BY v.uuid), 2) AS average_gap_seconds,
  ROUND(AVG(v.gap_seconds) OVER (PARTITION BY v.uuid) / 86400, 2) AS average_gap_days
FROM version_gaps AS v
JOIN current_formulas_window AS c ON c.uuid = v.uuid
ORDER BY c.name ASC, v.version ASC;
