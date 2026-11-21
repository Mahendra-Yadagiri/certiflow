# Certiflow Production Deployment Plan

## Target and assumptions

This plan targets 100,000 registered users, 10,000 daily active users, and results-day traffic that issues 30,000 certificates and delivers 30,000 WhatsApp notifications in one hour. Public verification traffic is bursty and can be much higher than authenticated dashboard traffic. The workload and costs below are planning estimates; load tests and AWS pricing for the selected region must be used before committing a budget.

## Architecture

```text
 Candidates / Centres / Reviewers                 Public verifiers
              |                                         |
       CloudFront + WAF                         CloudFront + WAF
       (web assets / PDFs)                    (verify API caching rules)
              |                                         |
    React web app (S3)                           ALB / API Gateway
              |                                         |
              +--------------------+--------------------+
                                   |
                     ECS Fargate API service
                    (stateless Express instances)
                       |          |          \
                       |          |           \ Redis Pub/Sub
                       |          |             -> SSE clients
                       |          |
                       v          v
             RDS PostgreSQL     ElastiCache Redis
             Multi-AZ writer    Cluster mode / replicas
             + read replicas    cache, BullMQ, Pub/Sub
             + PgBouncer              |
                       ^               v
                       |        ECS Fargate workers
                       |        PDF + WhatsApp queues
                       |          |           |
                       |          v           v
                       |       S3 PDFs    WhatsApp provider
                       |                    + callbacks
                       +---- audit / status updates

     CloudWatch metrics/logs/alarms + Prometheus-compatible telemetry
```

## Hosting and data services

- **API and workers:** Containerize the stateless Express API and BullMQ workers on separate AWS ECS Fargate services behind an Application Load Balancer. Separate task definitions and scaling policies let public reads, review writes, PDF work, and notifications scale independently.
- **Database:** Use Amazon RDS for PostgreSQL with Multi-AZ failover, encrypted storage, automated backups, point-in-time recovery, and a connection pooler such as PgBouncer. Use read replicas for public verification and read-heavy dashboard queries; keep approval transactions and writes on the primary.
- **Redis:** Use Amazon ElastiCache for Redis with cluster mode, replicas, encryption in transit/at rest, and Multi-AZ failover. BullMQ queues and the short-lived verification cache share the service initially, but should use distinct key prefixes and capacity alarms; isolate queue/cache clusters if contention or blast radius warrants the extra cost.
- **Certificate files:** Generate PDFs in workers and store them in a private S3 bucket with server-side encryption and blocked public access. Serve downloads through CloudFront signed URLs with short expirations and an authenticated issuance/download path. Never expose a public object ACL or predictable permanent URL.
- **Frontend and edge:** Put the static React build on private S3 behind CloudFront. Add AWS WAF rate-based rules and bot controls for public verification. Cache only safe static assets at the edge; certificate verification responses must be short-lived and must not be cached in a way that defeats revocation.
- **Secrets and networking:** Keep database, Redis, signing, and provider credentials in Secrets Manager or Parameter Store. Place tasks and databases in private subnets, expose only the load balancer, use least-privilege task roles, and restrict security groups to required service-to-service paths.

## Capacity, scaling, and throughput

Thirty thousand issuance jobs in an hour is:

```text
30,000 jobs / 3,600 seconds = 8.33 issuance jobs per second
```

Each issuance job produces one PDF and one WhatsApp delivery, giving 30,000 of each per hour. If a measured worker safely sustains around 1 job/second including both operations and retries, 10–15 worker tasks provide 10–15 jobs/second of nominal capacity and can clear 30,000 jobs within the hour with headroom. The real target must be set from benchmarked p95 processing time, retry rate, and provider rate limits; do not infer capacity from CPU alone. Maintain a queue-age alarm and scale on queue depth and oldest-job age, not just CPU.

Suggested initial autoscaling:

- API: minimum 2 Fargate tasks across availability zones; scale on ALB request count/target latency and CPU/memory, with a higher results-day minimum.
- PDF workers: minimum 2; scale to 10–15 or more based on issuance queue age/depth. Give PDF generation its own queue so heavy rendering cannot starve notifications.
- WhatsApp workers: scale separately using provider limits and backlog age. Apply per-provider throttles and avoid exceeding agreed throughput.
- SSE/API connections: size task memory and ALB idle timeouts for long-lived connections; use heartbeats, reconnect jitter, and load tests to measure concurrent connections. Consider API Gateway or a dedicated fan-out service at very high connection counts.
- Public verification: use CloudFront/WAF, Redis cache-aside for short-lived positive and negative lookups, and read replicas for misses. Revocation must invalidate cache entries immediately; keep TTL short as a safety net.

## Reliability and failure handling

- **Worker crash/restart:** BullMQ locks act as visibility timeouts; stalled-job recovery makes in-progress work eligible for retry after a worker stops renewing its lock. Keep jobs idempotent, set a suitable lock duration for PDF rendering, and monitor stalled counts and repeated failures.
- **Retries and dead letters:** Use exponential backoff with jitter where supported and a bounded retry count. Route exhausted jobs to a dead-letter queue with the original payload, error, and correlation ID; alert operators and provide a safe replay procedure.
- **Redis persistence:** Enable ElastiCache Multi-AZ failover and Redis AOF persistence where supported by the selected engine/configuration, and validate recovery behavior with failover tests. BullMQ remains durable only to the extent that Redis persistence and failover retain its data. Back up or export operationally important queue/dead-letter data as needed.
- **WhatsApp outage:** Retain delivery state in PostgreSQL, retry transient provider failures with exponential backoff, honor `Retry-After`, throttle globally, and open a circuit breaker during sustained failure. Keep exhausted deliveries in a DLQ for operator replay; do not block certificate creation on messaging availability.
- **Slow or unavailable database:** Use PgBouncer to cap connection fan-out, tune indexes and query plans, apply bounded timeouts, and serve eligible reads from replicas/cache. Writes, revocation, and approval state transitions must remain authoritative on the primary. Alert on replica lag and do not serve stale verification results beyond the documented cache window.
- **S3 and signing:** Keep buckets private, require TLS, use narrowly scoped task roles and KMS encryption, log access, and use short-expiry CloudFront signed URLs. Support retention and deletion policies and avoid embedding personal information in object keys.
- **Pub/Sub and SSE:** Pub/Sub is ephemeral, so the UI must refresh authoritative state on reconnect and not treat an event as a durable record. Add event IDs/replay storage only if clients require lossless delivery.

## Monitoring and operations

Use CloudWatch Logs, metrics, dashboards, and alarms, with Prometheus-compatible application and queue metrics where useful. Alert on API 5xx and p95/p99 latency, RDS CPU/connection saturation/locks/replica lag, Redis memory/evictions/failover, queue age and DLQ growth, worker restarts/stalled jobs, PDF error rate, WhatsApp error/throttle rate, and verification hit ratio. Include structured request/job IDs and batch/certificate IDs, while excluding phone numbers, certificate contents, and credentials from logs. Define on-call runbooks for provider outage, backlog drain, replay, and database failover.

## Monthly cost estimate and trade-offs

Illustrative US-region on-demand budget for a modest production baseline with Multi-AZ managed data services and burst-capable workers:

| Area | Planning range / month |
|---|---:|
| ECS Fargate API and baseline workers, excluding burst-heavy sustained use | $700–$1,800 |
| RDS PostgreSQL Multi-AZ, storage, backups, and read replica | $900–$2,200 |
| ElastiCache Redis cluster with replicas | $500–$1,300 |
| ALB, NAT gateways, CloudFront, WAF, S3 storage/requests, and data transfer | $400–$1,500 |
| CloudWatch logs/metrics, alarms, and KMS/secrets | $200–$700 |
| **Estimated AWS subtotal** | **$2,700–$7,500 / month** |

This estimate excludes taxes, support plans, inter-region recovery, and third-party WhatsApp/PDF services. It assumes workers scale up for results-day peaks rather than run at peak size continuously; sustained 10–15 worker capacity, high public egress, extensive logs, or large PDF retention can materially increase cost. Validate with the AWS Pricing Calculator for the chosen region, instance sizes, data transfer, and expected duty cycle.

Trade-offs: Fargate reduces operational overhead but costs more per unit than well-utilized EC2; RDS Multi-AZ and Redis replicas buy recovery time and availability but are significant baseline expenses; read replicas and caching improve burst read throughput but can return stale data if invalidation/lag controls fail; CloudFront reduces origin load but signed URLs and revocation semantics add complexity. Begin with managed services and conservative autoscaling, then use measured load tests and utilization to right-size or move stable workloads to EC2 reservations/Savings Plans.
