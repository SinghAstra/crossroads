CREATE TABLE IF NOT EXISTS formulas (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version INT UNSIGNED NOT NULL,
  name VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  formula_text TEXT NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(100) NOT NULL DEFAULT 'system',
  first_created_at DATETIME(3) NOT NULL,
  inserted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  inputs JSON NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_formulas_uuid_version (uuid, version),
  KEY idx_formulas_uuid_id (uuid, id),
  KEY idx_formulas_status_name (status, name),
  KEY idx_formulas_name (name),
  CONSTRAINT chk_formulas_version CHECK (version >= 1),
  CONSTRAINT chk_formulas_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT chk_formulas_name CHECK (name REGEXP '^[A-Za-z_][A-Za-z0-9_]{0,63}$'),
  CONSTRAINT chk_formulas_inputs CHECK (JSON_TYPE(inputs) = 'ARRAY')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS formula_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  formula_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  formula_name VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  formula_version INT UNSIGNED NOT NULL,
  record_index INT UNSIGNED NOT NULL DEFAULT 0,
  input_json JSON NOT NULL,
  result JSON NULL,
  calculation_text MEDIUMTEXT NULL,
  error TEXT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  inserted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_formula_runs_version CHECK (formula_version >= 1),
  CONSTRAINT chk_formula_runs_status CHECK (status IN ('SUCCESS', 'FAILED', 'SKIPPED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
