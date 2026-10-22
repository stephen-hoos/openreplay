# Installing OpenReplay with the Security Fixes

This guide installs a self-hosted OpenReplay (Community Edition, v1.28) with the security fixes from the `security-fixes` branch. It is written for the engineer who builds and runs the deployment.

- **Code:** https://github.com/stephen-hoos/openreplay/tree/security-fixes
- **What changed:** [Security Fixes](SECURITY_FIXES.md)
- **Hardening to apply:** [Deployment Hardening](DEPLOYMENT_HARDENING.md)
- **Assist rollout:** [Assist Session Authentication](ASSIST_SESSION_AUTH.md)

## Contents

1. [What gets deployed](#1-what-gets-deployed)
2. [Image builds (one-time setup)](#2-image-builds-one-time-setup)
3. [Install on Kubernetes (EKS or k3s)](#3-install-on-kubernetes-eks-or-k3s)
4. [Install with Docker Compose](#4-install-with-docker-compose)
5. [Tracker packages for the web apps](#5-tracker-packages-for-the-web-apps)
6. [After installing](#6-after-installing)
7. [Upgrades and rollback](#7-upgrades-and-rollback)

## 1. What gets deployed

Six images are rebuilt from the branch. Every other service keeps using OpenReplay's published v1.28 images.

| Image | Rebuilt because of | Helm chart | Compose service |
| ----- | ------------------ | ---------- | --------------- |
| `frontend` | Replay player and MCP consent page | `frontend` | `frontend-openreplay` |
| `assist` | Assist authentication and crash fixes | `assist` | `assist-openreplay` |
| `chalice` | Python API: roles, login limits, MCP | `chalice` | `chalice-openreplay` |
| `api` | Go API: roles, MCP token revocation | `api` | `api-openreplay` |
| `images` | Upload size limit | `images` | `images-openreplay` |
| `canvases` | File name limit | `canvases` | `canvases-openreplay` |

**Where they're built:** the GitHub Actions workflow `.github/workflows/security-fixes-images.yaml` builds them on every push to `security-fixes`, and pushes them to Amazon ECR:

```
251387484554.dkr.ecr.us-east-1.amazonaws.com/openreplay/<image>:sf-<first 12 characters of the commit>
251387484554.dkr.ecr.us-east-1.amazonaws.com/openreplay/<image>:security-fixes   # latest build
```

Deploy the `sf-<commit>` tag, not `security-fixes`, so every node runs the same build and you can roll back.

**Configuration:** the Helm charts and Compose files are not images. Use them from the branch: they contain the secure defaults (database passwords, HTTPS, Assist `TOKEN_SECRET`).

**Tracker packages:** the web apps also need the patched npm packages, `@openreplay/tracker` and `@openreplay/tracker-assist`. See [section 5](#5-tracker-packages-for-the-web-apps).

## 2. Image builds (one-time setup)

Run these once, with administrator access to AWS account `251387484554` and to the GitHub repository. GitHub Actions authenticates to AWS through OIDC, so no AWS keys are stored in GitHub.

### 2.1 ECR repositories

```bash
export AWS_PROFILE=AdministratorAccess-251387484554 AWS_REGION=us-east-1
for name in frontend assist chalice api images canvases; do
  aws ecr create-repository --repository-name "openreplay/$name" \
    --image-scanning-configuration scanOnPush=true \
    --image-tag-mutability MUTABLE \
    --encryption-configuration encryptionType=AES256
done
```

`MUTABLE` is only needed for the moving `security-fixes` tag; the `sf-<commit>` tags are never overwritten.

Optional: add a lifecycle policy that keeps, for example, the last 30 images per repository.

### 2.2 GitHub OIDC provider and build role

Skip the first command if the account already has the provider `token.actions.githubusercontent.com` (`aws iam list-open-id-connect-providers`).

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com

cat > trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::251387484554:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:stephen-hoos/openreplay:ref:refs/heads/security-fixes"
      }
    }
  }]
}
EOF

cat > push.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
    {"Effect": "Allow",
     "Action": ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
                "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"],
     "Resource": "arn:aws:ecr:us-east-1:251387484554:repository/openreplay/*"}
  ]
}
EOF

aws iam create-role --role-name github-openreplay-image-build --assume-role-policy-document file://trust.json
aws iam put-role-policy --role-name github-openreplay-image-build --policy-name ecr-push --policy-document file://push.json
```

The trust policy only allows workflows running on the `security-fixes` branch of `stephen-hoos/openreplay`. If the repository moves (for example to a LoanLogics organization), update the `sub` condition.

### 2.3 Connect the workflow

```bash
gh variable set AWS_ROLE_ARN --repo stephen-hoos/openreplay \
  --body arn:aws:iam::251387484554:role/github-openreplay-image-build
gh variable set AWS_REGION --repo stephen-hoos/openreplay --body us-east-1
```

The workflow is skipped while `AWS_ROLE_ARN` is not set.

### 2.4 Run a build

To start a build without pushing anything, open the repository's **Actions** tab, select **Build security-fixes images**, and choose **Run workflow** on `security-fixes`. Or run:

```bash
gh workflow run security-fixes-images.yaml --repo stephen-hoos/openreplay --ref security-fixes
```

Each of the six images builds as its own job. The frontend takes the longest, about 15–25 minutes on a cold cache. The run summary lists the pushed image names. To confirm the images arrived:

```bash
aws ecr describe-images --repository-name openreplay/assist --query 'imageDetails[].imageTags'
```

## 3. Install on Kubernetes (EKS or k3s)

### 3.1 Prerequisites

- **Cluster:**
  - EKS: 1.30 or newer, with at least 3 × `m6i.xlarge` (4 vCPU / 16 GiB).
  - Single VM (k3s): at least 4 vCPU / 16 GiB and 100 GiB disk.
  - Upstream's minimum is 2 vCPU / 8 GiB; that is not enough for real traffic.
- **DNS:** a name such as `openreplay.example.com` pointing at the ingress load balancer (EKS) or the VM.
- **Tools:** `kubectl`, `helm` 3.x, `yq` 4.x, `git`, `openssl`.
- **Pull access to ECR** for the nodes:
  - **EKS:** attach `AmazonEC2ContainerRegistryReadOnly` to the node IAM role, or grant equivalent pull access on `openreplay/*`.
  - **k3s on EC2:** containerd can't use an IAM role directly. Configure the kubelet ECR credential provider. Download `ecr-credential-provider` from https://github.com/kubernetes/cloud-provider-aws/releases to `/var/lib/rancher/credentialprovider/bin/`, create `/var/lib/rancher/credentialprovider/config.yaml`:

    ```yaml
    apiVersion: kubelet.config.k8s.io/v1
    kind: CredentialProviderConfig
    providers:
      - name: ecr-credential-provider
        matchImages: ["*.dkr.ecr.*.amazonaws.com"]
        defaultCacheDuration: "12h"
        apiVersion: credentialprovider.kubelet.k8s.io/v1
    ```

    Then give the instance profile ECR read access. k3s picks the provider up from those default paths.
- **TLS:** either a certificate from Let's Encrypt (cert-manager, below), or TLS terminated at an AWS load balancer with an ACM certificate.

### 3.2 Get the charts

```bash
git clone --branch security-fixes https://github.com/stephen-hoos/openreplay.git
cd openreplay/scripts/helmcharts
```

### 3.3 Configure `vars.yaml`

**1. Generate the secrets.** Every `{{ randAlphaNum 20}}` placeholder must become a random value. `init.sh` does this for you on a single VM. On EKS, run:

```bash
while grep -q 'randAlphaNum' vars.yaml; do
  sed -i "0,/{{ *randAlphaNum 20 *}}/s//$(openssl rand -hex 20)/" vars.yaml
done
grep -nE '\{\{|change_me' vars.yaml   # must print nothing
```

Values that share a YAML anchor (for example the S3 keys and the Redis password) stay identical.

**2. Set the domain:**

```bash
yq e -i '.global.domainName = "openreplay.example.com"' vars.yaml
```

**3. Point the six charts at the patched images.** Add the following to `vars.yaml`, replacing the tag with the one from the build:

```yaml
frontend:
  image:
    registry: 251387484554.dkr.ecr.us-east-1.amazonaws.com/openreplay
    tag: sf-5b2b587e2522
assist:
  image:
    registry: 251387484554.dkr.ecr.us-east-1.amazonaws.com/openreplay
    tag: sf-5b2b587e2522
chalice:
  image:
    registry: 251387484554.dkr.ecr.us-east-1.amazonaws.com/openreplay
    tag: sf-5b2b587e2522
api:
  image:
    registry: 251387484554.dkr.ecr.us-east-1.amazonaws.com/openreplay
    tag: sf-5b2b587e2522
images:
  image:
    registry: 251387484554.dkr.ecr.us-east-1.amazonaws.com/openreplay
    tag: sf-5b2b587e2522
canvases:
  image:
    registry: 251387484554.dkr.ecr.us-east-1.amazonaws.com/openreplay
    tag: sf-5b2b587e2522
```

Each chart name may appear only once in `vars.yaml`. Settings added later (for example the `frontend.ingress` annotations for TLS, the `chalice.ingress` rate limits) go under the same keys.

**4. Before go-live,** apply the settings from [Deployment Hardening → Before go-live](DEPLOYMENT_HARDENING.md#before-go-live):
- trusted client IP range (`set-real-ip-from`);
- per-IP rate limits;
- CORS origin;
- and, on EKS, the S3 and IRSA settings if you use S3 instead of the bundled storage.

**5. Store `vars.yaml` safely.** It now holds every secret of the installation, so keep it encrypted (AWS Secrets Manager or SSM Parameter Store) and never commit it. Upgrades need the same file.

### 3.4 Install

**Single VM (k3s):** `init.sh` installs k3s, Helm and the tools, generates the secrets, and installs everything. Run it after step 3 of 3.3, from `scripts/helmcharts`, as a normal user with `sudo`:

```bash
DOMAIN_NAME=openreplay.example.com bash init.sh
```

**EKS or an existing cluster:** install the three releases in order:

```bash
helm upgrade --install toolings ./toolings -n app --create-namespace --wait -f ./vars.yaml --atomic
helm upgrade --install databases ./databases -n db --create-namespace --wait -f ./vars.yaml --atomic
helm upgrade --install openreplay ./openreplay -n app --create-namespace --wait -f ./vars.yaml --atomic
```

On a multi-node cluster, also set `global.pvcRWXName` to an RWX volume claim (for example on EFS). The default `hostPath` only works on a single node.

### 3.5 TLS

**Let's Encrypt (cert-manager):**

```bash
EMAIL_ADDRESS=devops@example.com bash certmanager.sh
```

Then add the issuer to the frontend ingress in `vars.yaml` and upgrade the `openreplay` release:

```yaml
frontend:
  ingress:
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
```

cert-manager stores the certificate in the `openreplay-ssl` secret, which the ingress already uses.

**AWS load balancer with ACM:** terminate TLS on the load balancer and forward to the ingress. The ingress now redirects HTTP to HTTPS, so the load balancer must send `X-Forwarded-Proto: https`, or every request loops. An ALB does this by default.

### 3.6 Check the deployment

```bash
kubectl get pods -n app
kubectl get pods -n db
kubectl get pods -n app -o jsonpath='{range .items[*]}{.spec.containers[0].image}{"\n"}{end}' | sort -u
```

All pods must be `Running`. The six patched services must show the ECR image with your `sf-` tag.

Then open `https://openreplay.example.com`, **create the admin account immediately**, and work through [section 6](#6-after-installing).

## 4. Install with Docker Compose

For a single host (EC2 instance) without Kubernetes.

**1. Prepare the host.** Use Ubuntu 22.04/24.04 with Docker Engine and the Compose plugin, at least 4 vCPU / 16 GiB, and DNS pointing at the host. Open ports 80 and 443 only.

**2. Give Docker access to ECR.** Attach an instance profile with `AmazonEC2ContainerRegistryReadOnly`, install the ECR credential helper, and enable it:

```bash
sudo apt-get install -y amazon-ecr-credential-helper
mkdir -p ~/.docker
echo '{"credHelpers": {"251387484554.dkr.ecr.us-east-1.amazonaws.com": "ecr-login"}}' > ~/.docker/config.json
```

Do the same for root (`/root/.docker/config.json`) if you run Compose with `sudo`.

**3. Get the files:**

```bash
git clone --branch security-fixes https://github.com/stephen-hoos/openreplay.git
cd openreplay/scripts/docker-compose
```

**4. Point the six services at the patched images.** `install.sh` and `upgrade.sh` reset `docker-compose.yaml` from git, so don't edit it. Put the overrides in `docker-compose.override.yaml`, which Compose loads automatically:

```bash
REG=251387484554.dkr.ecr.us-east-1.amazonaws.com/openreplay
TAG=sf-5b2b587e2522
{
  echo "services:"
  for svc in frontend assist chalice api images canvases; do
    printf '  %s-openreplay:\n    image: %s/%s:%s\n' "$svc" "$REG" "$svc" "$TAG"
  done
} > docker-compose.override.yaml
docker compose config | grep -E "image: .*/openreplay/"
```

The last command should show the six services with your ECR registry and tag.

**5. Install:**

```bash
DOMAIN_NAME=openreplay.example.com bash install.sh
```

`install.sh` generates every secret in `common.env`, including the new ClickHouse and Redis passwords, and starts the stack. Caddy obtains a Let's Encrypt certificate automatically.

**6. Protect the secrets:**

```bash
chmod 600 common.env docker-envs/*.env
grep -n change_me common.env docker-envs/*.env   # must print nothing
```

Then open `https://openreplay.example.com`, create the admin account immediately, and continue with [section 6](#6-after-installing).

## 5. Tracker packages for the web apps

The web applications that send recordings need the patched tracker packages. They're built from the branch as tarballs:

```
openreplay-tracker-19.0.0-beta.0-security-fixes-<commit>.tgz
openreplay-tracker-assist-11.0.21-security-fixes-<commit>.tgz
```

**Build them.** Requires Bun and Node; run from `tracker/`:

```bash
bun install --frozen-lockfile
(cd tracker && bun run build && npm pack)
(cd tracker-assist && bun run build && npm pack)
```

**Install them in an app.** Keep the files in the app repository or an internal artifact store:

```bash
npm install ./vendor/openreplay-tracker-19.0.0-beta.0-security-fixes-<commit>.tgz \
            ./vendor/openreplay-tracker-assist-11.0.21-security-fixes-<commit>.tgz
```

**Configure the tracker:**
- set `ingestPoint` to `https://openreplay.example.com/ingest` (the default sends data to OpenReplay's cloud);
- apply the privacy settings in [Deployment Hardening → step 7](DEPLOYMENT_HARDENING.md#7-configure-the-tracker-for-privacy);
- for Assist, roll out the new `tracker-assist` together with the Assist server, see [Assist Session Authentication](ASSIST_SESSION_AUTH.md#upgrading).

## 6. After installing

Work through [Deployment Hardening → Before go-live](DEPLOYMENT_HARDENING.md#before-go-live). The minimum before real users or real data:

- [ ] Admin account created; signup closed (`curl -s https://<domain>/api/signup` shows `"tenants":true`).
- [ ] Only ports 80/443 reachable from the internet.
- [ ] `http://` redirects to `https://`, and the `Strict-Transport-Security` header is present.
- [ ] Redis and ClickHouse reject connections without a password ([verification commands](DEPLOYMENT_HARDENING.md#verification)).
- [ ] `set-real-ip-from` set to the load balancer / VPC range.
- [ ] Per-IP rate limits and the CORS origin set.
- [ ] Telemetry opted out, if required ([how](DEPLOYMENT_HARDENING.md#disable-what-you-dont-use)).
- [ ] A test session from a web app records and replays. A live session can be opened in Assist.

The QA checklists for each fix are in the team's change summary, and the behaviour changes are listed in [Security Fixes](SECURITY_FIXES.md).

## 7. Upgrades and rollback

**New build of the branch:**
1. Wait for the workflow run to finish.
2. Set the new `sf-<commit>` tag in `vars.yaml` (Kubernetes) or `docker-compose.override.yaml` (Compose).
3. Kubernetes: `helm upgrade openreplay ./openreplay -n app -f ./vars.yaml --atomic`. Docker Compose: `docker compose up -d`.

**Rollback:**
- **Images:** set the previous `sf-<commit>` tag and upgrade again. To return to stock OpenReplay for a service, remove its `image:` override; it then uses the chart's default upstream image from `public.ecr.aws/p1t3u8a3`.
- **Database passwords:** don't roll those back by reverting the charts; the services and databases must keep using the same password.

**Existing OpenReplay installation:** follow [Deployment Hardening → Upgrading an existing installation](DEPLOYMENT_HARDENING.md#upgrading-an-existing-installation) to add the database passwords, then switch the six images as above.

**Upstream releases:** to take a new OpenReplay release, rebase `security-fixes` onto the release, let the workflow build it, and update the tags. Check whether upstream fixed any of the issues in [Security Fixes](SECURITY_FIXES.md) themselves, and drop the duplicated commits.
