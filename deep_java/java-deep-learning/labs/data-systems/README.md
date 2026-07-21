# Data systems external lab

Pinned services: MySQL 8.4, Redis 8.2, Apache Kafka 4.1.0. The ports bind only to localhost and the MySQL password is disposable lab data.

```powershell
docker compose up -d
docker compose ps
docker exec -it <mysql-container> mysql -uroot -pdeep-java-local-only deep_java
docker exec -it <redis-container> redis-cli
docker exec -it <kafka-container> /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --topic agent-events --partitions 3 --replication-factor 1
```

MySQL locking experiment, in two clients:

```sql
-- A
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
SELECT * FROM task_run WHERE tenant_id=1 AND status='QUEUED'
  AND created_at BETWEEN '2026-01-01 00:00:00' AND '2026-01-01 00:10:00'
  FOR UPDATE;

-- B: expect a wait until A commits/rolls back
INSERT INTO task_run(tenant_id,status,created_at,payload)
VALUES(1,'QUEUED','2026-01-01 00:05:00','gap-probe');
```

While B waits, inspect `performance_schema.data_locks` and `data_lock_waits`, then repeat at READ COMMITTED. Do not infer production behavior from this single-node lab.

Status on 2026-07-20: the Docker client is installed, but the local Docker Desktop Linux daemon was not running, so this lab definition has not been executed. It must not be cited as measured MySQL/Redis/Kafka evidence until outputs are added to `PROGRESS.md`.
