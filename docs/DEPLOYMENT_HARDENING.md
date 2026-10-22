# Deployment Hardening

This document lists what to configure, beyond the defaults, to run a self-hosted OpenReplay safely on the internet. It covers both install methods: Kubernetes/Helm (`scripts/helmcharts`) and Docker Compose (`scripts/docker-compose`).

Work through [Before go-live](#before-go-live) for every installation. [Recommended](#recommended) items matter most on shared clusters, AWS, or when the instance holds sensitive recordings.

## Secure defaults

The following are now part of the default install and need no action on a new installation. Existing installations pick them up as described in [Upgrading an existing installation](#upgrading-an-existing-installation).

| Area | Helm | Docker Compose |
| ---- | ---- | -------------- |
| ClickHouse password | Generated (`clickhouse.password` in `vars.yaml`) | Generated (`COMMON_CH_PASSWORD`) |
| Redis/Valkey password | Generated (`redis.password`, shared with the services through `redis.redisPassword`) | Generated (`COMMON_REDIS_PASSWORD`) |
| ClickHouse backup API (port 7171) | Requires the ClickHouse credentials | n/a |
| Object storage admin console | n/a | Disabled and not published (was `9001:9001`) |
| HTTPS | Ingress redirects HTTP to HTTPS and sends HSTS | Caddy redirects to HTTPS and sends HSTS (public certificates only, not `Caddyfile.private`) |
| Secret files | `vars.yaml` and kubeconfigs readable only by the installing user | n/a |
| New secrets on upgrade | n/a | `upgrade.sh` generates secrets added in the new release instead of keeping `change_me_*` placeholders |
| Assist tracker sockets | Authenticated with `TOKEN_SECRET` (see [Assist Session Authentication](ASSIST_SESSION_AUTH.md)) | Same |

Application-level protections enabled by default:

- **Integration credentials:** only owners and admins can view or change third-party integrations, webhooks, and Slack/Teams channels. Members can still share to Slack/Teams and create issues.
- **Failed logins:** login for an email is blocked for 15 minutes after 10 failed attempts. This is configurable with `LOGIN_MAX_FAILED_ATTEMPTS` and `LOGIN_FAILED_ATTEMPTS_WINDOW_S` on the `chalice` service. The same limit applies to password-reset emails.
- **Passwords:** new passwords must have at least 8 characters with an uppercase letter, a lowercase letter, a digit and a special character.
- **MCP sign-in:** the user must enter a confirmation code shown by their MCP client. MCP tokens are revoked when the user's password changes or is reset.

## Before go-live

### 1. Install with the official scripts and check that all secrets were generated

Install only through `scripts/helmcharts/init.sh` (Helm) or `scripts/docker-compose/install.sh` (Docker Compose). They replace every placeholder in `vars.yaml` / `common.env` with random values.

Running `helm install -f vars.yaml` by hand without `init.sh` deploys the literal placeholder text as every secret. If you install that way, replace each `{{ randAlphaNum 20 }}` with a random value first (`openssl rand -hex 20`), or use the `existingSecret` options (`global.orAppSecrets.existingSecret`, `global.postgresql.existingSecret`, `global.s3.existingSecret`) with secrets you create.

After installing, and after every upgrade, both commands must print nothing:

```bash
# Helm
grep -nE '\{\{|change_me' /var/lib/openreplay/vars.yaml
# Docker Compose (from scripts/docker-compose)
grep -n change_me common.env docker-envs/*.env
```

### 2. Create the admin account immediately

Until the first account exists, anyone who can reach the instance can sign up and becomes its owner. Create the admin account right after the install finishes, or keep the instance reachable only from your network (security group or firewall) until you have.

### 3. Expose only ports 80 and 443

Allow inbound traffic only on 443, plus 80 for the HTTP-to-HTTPS redirect and ACME certificate challenges. On AWS, set this in the instance or load balancer security group.

On Docker, published ports bypass host firewalls such as `ufw`, so don't rely on the host firewall alone.

### 4. Tell the proxy which client IP to trust

By default, the ingress and the Docker nginx trust `X-Forwarded-For` from any source, so clients can choose the IP address that OpenReplay records for them.

**Helm:** set the address range of the load balancer in front of the ingress (for example your VPC CIDR) in `vars.yaml`:

```yaml
ingress-nginx:
  controller:
    config:
      entries:
        set-real-ip-from: "10.0.0.0/16"
```

If nothing sits in front of the ingress, set `enable-real-ip: "false"` instead.

**Docker Compose:** in `nginx.conf`, replace `set_real_ip_from 0.0.0.0/0;` with the Docker network range of the Caddy container. Also change the `$real_ip` map so it uses `$remote_addr` instead of the first `X-Forwarded-For` entry.

### 5. Rate-limit per client IP at the ingress

The API limits failed logins per account. It can't limit per client IP, because behind the ingress it only sees the proxy's address. Add a per-IP limit on the API and ingest ingresses, sized to your traffic:

```yaml
chalice:
  ingress:
    annotations:
      nginx.ingress.kubernetes.io/limit-rps: "20"
      nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"
http:
  ingress:
    annotations:
      nginx.ingress.kubernetes.io/limit-rps: "50"
```

Session start (`/ingest/v1/web/start`) needs no authentication beyond the public project key, so make sure the ingest limit stays well above what your real visitors generate. Watch for `503` responses after enabling it.

### 6. Restrict CORS to your domain

The API and Assist ingresses reflect any `Origin`. Set them to your OpenReplay domain:

```yaml
api:
  ingress:
    cors:
      allowOrigin: "https://openreplay.example.com"
assist:
  ingress:
    cors:
      allowOrigin: "https://openreplay.example.com"
```

On Docker Compose, change the `Access-Control-Allow-Origin` header for `/v2/api` in `nginx.conf` the same way.

### 7. Configure the tracker for privacy

The tracker masks password fields and, by default, the values of other inputs. Review what else your pages expose, and start from this configuration:

```js
new Tracker({
  projectKey: PROJECT_KEY,
  ingestPoint: 'https://openreplay.example.com/ingest', // always set: the default is OpenReplay's cloud
  defaultInputMode: 1, // obscured; 2 = hidden
  obscureTextNumbers: true,
  obscureTextEmails: true,
  // Rich-text editors (contenteditable) are not masked by default.
  domSanitizer: (node) => (node.isContentEditable ? 1 : 0),
  network: {
    capturePayload: false,
    ignoreHeaders: ['cookie', 'set-cookie', 'authorization', 'x-api-key', 'x-auth-token', 'x-csrf-token'],
    // Do not set axiosInstances: the default network capture already records axios with header filtering.
  },
  urls: {
    // The default URL sanitizer only knows a few parameter names; strip query and fragment.
    urlSanitizer: (url) => url.split(/[?#]/)[0],
  },
})
```

- **Assist:** set `requestConfirm: true` in `@openreplay/tracker-assist` if end users must approve before an agent can view their session. If you don't want the call widget loaded from OpenReplay's CDN, host it yourself and set `callUITemplate`.
- **Cross-domain iframes:** set `crossdomain.parentDomain` in the child to the parent page's exact origin. Set `crossdomain.childDomains` on the parent if the page embeds third-party iframes.
- **State plugins** (Redux, Vuex, Pinia, Zustand, MobX, NgRx) and GraphQL send full state and payloads unless you pass a sanitizer or transformer.

### 8. Limit who gets an account

The Community Edition has two permission levels:
- **Owners and admins** manage projects, members and integrations.
- **Members** can see every project and session, and use features such as alerts, dashboards, notes and conditions in every project.

Invite only people who should see all recordings.

### 9. Protect the install host (Helm on a single VM)

`init.sh` now restricts `vars.yaml` and the kubeconfig to the installing user. Also:

- Treat SSH access to the host as access to every secret and every recording.
- Give the host no other users.
- Back up `/var/lib/openreplay/vars.yaml` somewhere encrypted. Without it, an upgrade can't keep the existing secrets.

On Docker Compose, restrict the env files after installing, and treat membership of the `docker` group as root:

```bash
chmod 600 common.env docker-envs/*.env
```

## Recommended

### Isolate the databases (Kubernetes)

No NetworkPolicies are installed, so any pod in the cluster can connect to Postgres, ClickHouse, Redis and object storage. Allow only the OpenReplay namespace to reach the `db` namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-allow-app-only
  namespace: db
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: app
        - podSelector: {}
```

The ingress controller runs in `app` and serves the object storage paths, so it is covered by the `app` rule. The `podSelector: {}` rule keeps traffic inside `db` working (backup jobs, migrations). Your cluster's network plugin must support NetworkPolicies; on EKS, that means enabling network policy support in the VPC CNI.

### Use a dedicated cluster, and IMDSv2 on AWS

- **Dedicated cluster:** run OpenReplay on its own cluster or node group. The bundled ingress controller has snippets enabled (`enableSnippets: true`), which OpenReplay needs, and it watches all namespaces. Anyone who can create an Ingress anywhere in the cluster can then inject nginx configuration. If the cluster is shared, limit the controller to the `app` namespace (`ingress-nginx.controller.watchNamespace: app`), and restrict who can create Ingress resources.
- **IMDSv2:** on AWS, require IMDSv2 with a hop limit of 1 on the nodes, so pods can't read the node's IAM credentials from the instance metadata service.

### Use AWS S3 instead of the bundled object storage

The bundled MinIO/RustFS is reachable through the public ingress, and every service shares its root credentials. On AWS, prefer S3:

- Set `minio.enabled: false`, then set `global.s3` to your buckets and region, leaving `accessKey`/`secretKey` empty.
- Grant access with IAM roles for service accounts (IRSA), scoped to the buckets each service needs.
- Enable default encryption and Block Public Access on all buckets. `sessions-assets` (cached CSS, fonts and images of recorded pages) is the only bucket the player needs to read publicly; serve it through CloudFront or a bucket policy if required.
- Lower `PRESIGNED_URL_EXPIRATION` on `chalice` (default `3600` seconds) to the shortest value that works for your users.

If you keep the bundled storage, keep its console disabled. That is now the default on Docker. On Kubernetes, never expose the MinIO service outside the cluster.

### Add browser security headers

The dashboard sends no Content-Security-Policy or clickjacking protection. Add at least:

```yaml
ingress-nginx:
  controller:
    config:
      entries:
        server-snippets: |
          add_header X-Frame-Options "DENY" always;
```

This replaces the default `server-snippets` from `scripts/helmcharts/openreplay/values.yaml`, so copy its existing headers (`X-XSS-Protection`, `X-Content-Type-Options`, `Referrer-Policy`) into your value too. On Docker Compose, add the same header in `nginx.conf`.

A full Content-Security-Policy needs the exact list of origins your replays load from: test it in `Content-Security-Policy-Report-Only` mode first. Test the replay player and Assist calls (WebRTC) after any header change.

### Reduce supply-chain exposure

- **Migrations:** set `offlineMigration.enabled: true`, so the migration job uses the scripts baked into the image instead of cloning GitHub at run time.
- **Versions:** pin `OR_VERSION` to a release tag when using `openreplay-cli`; the default is `main`. Pin the `caddy` and `nginx` image tags in `docker-compose.yaml`; they currently use `latest`.
- **Image signatures:** enforce them by setting the Kyverno policy in `toolings` to `Enforce` with `failurePolicy: Fail`. The public key is `scripts/helmcharts/openreplay-container-sign.pub`.
- **Installer:** `init.sh` installs k3s with `curl … | sh`. On a managed cluster (EKS), skip `init.sh` and install the charts with your own pipeline, following [step 1](#1-install-with-the-official-scripts-and-check-that-all-secrets-were-generated).

### Disable what you don't use

- **MCP:** the MCP integration is enabled when `JWT_MCP_SECRET` is set on the `api` service. If nobody uses an MCP client, remove `jwtMcpSecret` from `vars.yaml`; the Go API then rejects all MCP tokens.
- **Telemetry:** the owner's email and organization name are sent to `api.openreplay.com` at signup and then daily. There is no setting in the dashboard; as an owner or admin, opt out through the API:

  ```bash
  curl -X POST https://openreplay.example.com/api/account \
    -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{"optOut": true}'
  ```

  The signup report is sent before you can opt out.
- **Heap dumps:** never set `heapdump=1` on Assist in production.

### Internal traffic

Connections between services and to Postgres, ClickHouse and Redis are not encrypted (`sslmode=disable`, no TLS). That is acceptable inside a dedicated cluster with the NetworkPolicy above. If your requirements call for encryption in transit, use managed services with TLS (RDS, ElastiCache, ClickHouse Cloud) and the existing TLS options (`global.redis.tls`, `clickhouse.use_tls`, the `CLICKHOUSE_TLS_*` variables, see [ClickHouse TLS Configuration](CLICKHOUSE_TLS_CONFIG.md)).

## Upgrading an existing installation

### Helm

`openreplay-cli` upgrades keep your existing `vars.yaml` values, so existing installs stay on their current (empty) ClickHouse and Redis passwords. To switch to passwords:

1. In `/var/lib/openreplay/vars.yaml`, set `clickhouse.password`, and set `redis.usePassword: true` with the same random value in `redis.password` and `redis.redisPassword`.
2. Upgrade the `databases` chart and the `openreplay` chart in the same maintenance window, since services can't connect to Redis or ClickHouse while only one side has the password. Redis holds only caches and queues, which are rebuilt. ClickHouse keeps its data; its password is read from the environment on every start.
3. Check that all pods in `app` are running and that new sessions appear.

The HTTPS redirect also takes effect on upgrade. If TLS terminates at a load balancer that forwards plain HTTP to the ingress, make sure the load balancer sends `X-Forwarded-Proto: https` (`use-forwarded-headers` is already enabled), or users will hit a redirect loop.

### Docker Compose

Run `upgrade.sh` as usual. It generates `COMMON_CH_PASSWORD` and `COMMON_REDIS_PASSWORD` and recreates the containers. ClickHouse picks up the new password on start, and Redis only holds caches.

### Users and clients

- **Assist tracker:** see the rollout steps in [Assist Session Authentication](ASSIST_SESSION_AUTH.md).
- **MCP clients:** update to a version that shows a confirmation code. Older clients can no longer complete the browser sign-in.
- **Members:** members lose access to the integration settings pages; owners and admins manage integrations.
- **Existing passwords:** they keep working. The password policy applies the next time a password is set.

## Verification

After deploying, check from outside the cluster or host:

```bash
DOMAIN=openreplay.example.com

# HTTP redirects to HTTPS, and HSTS is sent
curl -sI http://$DOMAIN | grep -i '^location: https'
curl -sI https://$DOMAIN | grep -i strict-transport-security

# Nothing but 80/443 is reachable (run from a machine outside your network)
nmap -Pn -p 1-65535 $DOMAIN

# Signup is closed once the admin account exists
curl -s https://$DOMAIN/api/signup | grep '"tenants":true'
```

And from inside the cluster or Docker network, Redis and ClickHouse must reject unauthenticated connections:

```bash
# Kubernetes
kubectl -n db exec sts/redis-master -- redis-cli ping           # expect NOAUTH
kubectl -n db exec "$(kubectl -n db get pod -l app.kubernetes.io/name=clickhouse -o name | head -1)" \
  -c clickhouse -- clickhouse-client --query 'SELECT 1'         # expect an authentication error
# Docker Compose
docker exec redis redis-cli ping                                # expect NOAUTH
docker exec clickhouse clickhouse-client --query 'SELECT 1'     # expect an authentication error
```
