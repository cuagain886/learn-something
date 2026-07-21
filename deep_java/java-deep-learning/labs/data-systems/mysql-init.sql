CREATE TABLE task_run (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL,
  payload VARCHAR(512) NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  KEY ix_task_claim (tenant_id, status, created_at, id)
) ENGINE=InnoDB;

INSERT INTO task_run(tenant_id,status,created_at,payload)
WITH RECURSIVE seq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000
)
SELECT 1, IF(MOD(n,10)=0,'QUEUED','DONE'),
       TIMESTAMP('2026-01-01 00:00:00') + INTERVAL n SECOND,
       REPEAT(CHAR(64 + MOD(n,26)), 100)
FROM seq;

-- Run after startup and save actual/estimated rows and loops.
EXPLAIN ANALYZE
SELECT id, created_at
FROM task_run
WHERE tenant_id=1 AND status='QUEUED'
ORDER BY created_at, id
LIMIT 20;
