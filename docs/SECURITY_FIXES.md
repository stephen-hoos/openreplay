# Security Fixes

This document describes the security changes on the `security-fixes` branch: what each one changes, what behaves differently for users and operators, which settings are involved, and how to roll it out. It applies to the Community Edition; `ee/` is not changed.

Related documents:

- [Deployment Hardening](DEPLOYMENT_HARDENING.md): configuration to apply before going live.
- [Assist Session Authentication](ASSIST_SESSION_AUTH.md): configuration and rollout of the Assist change.
- [Installing OpenReplay with the Security Fixes](INSTALL_SECURITY_FIXES.md): building the images and installing.

## Overview

| # | Area | Change | Components |
| - | ---- | ------ | ---------- |
| 1 | Replay player | SVG sprite markup from recordings is sanitized instead of being parsed as HTML in the dashboard page | `frontend` |
| 2 | Assist | Tracker sockets must present the session token; session data is relayed only to agents | `assist`, `@openreplay/tracker-assist`, Helm, Compose |
| 3 | Assist | Malformed connections no longer crash the Assist server | `assist` |
| 4 | Mobile image upload | Decompressed upload size is limited | `images` |
| 5 | Canvas upload | Upload file names are length-limited; disk errors no longer stop the service | `canvases`, `images` |
| 6 | Tracker | Textarea contents are masked | `@openreplay/tracker` |
| 7 | Deployment | Database passwords, HTTPS redirect and HSTS, private storage console, backup API authentication, file permissions, secrets on upgrade | Helm, Compose |
| 8 | Dashboard API | Integration credentials are restricted to owners and admins | `chalice`, `api` |
| 9 | Login | Failed-login and reset-link limits; password policy enforced by the server | `chalice` |
| 10 | MCP | Sign-in requires a confirmation code; tokens are revoked when the password changes | `chalice`, `api`, `frontend`, `mcp_app` |
| 11 | Tracker | Selected text and text attributes of masked elements are masked | `@openreplay/tracker` |
| 12 | Tracker | Cross-frame messages are accepted only from child iframes and the parent window | `@openreplay/tracker` |

Every code change has tests that fail without the change.

## 1. Replay player: sprite sanitization

The tracker inlines SVG sprites (`<use href="#icon">`), and the player rebuilds them as `<symbol>` elements. This used to happen with `innerHTML` in the dashboard's own document, outside the sandboxed replay iframe, so markup in a recording could run in the dashboard origin.

`handleSprites` (`player/src/web/MessageManager.ts`) now rebuilds the symbol with `copySanitizedSvgChildren` (`player/src/web/managers/DOM/sanitize.ts`), which keeps only:
- allow-listed SVG elements: shapes, paths, groups, text, gradients, masks, clip paths, patterns, markers, filters, `use`, `image` and `style`;
- attributes that pass `sanitizeAttribute`;
- CSS that has passed through `sanitizeCssText`.

Both recorded replays and live Assist sessions use this path.

**Behavior change:** sprite elements outside the allow-list are dropped, together with their content. That includes links, `foreignObject`, `script`, `title` and SMIL animations (`animate`, `set`, …). Animated sprite icons replay static.

**Tests:** `frontend/tests/unit/spriteSanitize.test.ts`.

## 2. Assist: tracker session authentication

Agent sockets were already authenticated; tracker (`identity=session`) sockets were not. Their events were also relayed to every socket in the room, including the end user's other tabs.

- **Token required:** the Assist server requires the tracker session token, verified with `TOKEN_SECRET` and bound to the session in `peerId` (`assist/utils/sessionToken.js`, `assistHelper.js`).
- **Tracker side:** `@openreplay/tracker-assist` sends the token in the socket `auth` payload.
- **Relay:** session events go only to the session's agents. Server-only event names sent by a tracker socket are dropped.
- **Deployment:** Helm and Compose pass `TOKEN_SECRET` to Assist.

**Behavior change:**
- Trackers without the token can't connect once the server requires it. That includes older `tracker-assist` versions and the mobile SDKs, which live in separate repositories.
- Reconnections are rejected after the session's maximum duration, because the token has expired.

**Settings:** `TOKEN_SECRET` and `ASSIST_REQUIRE_SESSION_TOKEN` (default `true`). See [Assist Session Authentication](ASSIST_SESSION_AUTH.md) for the rollout order.

**Tests:** `assist/utils/sessionToken.test.js` (`npm test` in `assist/`). The token check is tested against tokens issued by `backend/pkg/token`.

## 3. Assist: crash hardening

A single connection without a `peerId`, or with invalid `sessionInfo`/`agentInfo` JSON, used to stop the whole Assist process. A `WEBRTC_AGENT_CALL` event could do the same.

- The authorizer validates `peerId` for all sockets.
- JSON parsing is guarded.
- Connection errors are caught and the socket is disconnected.
- Unhandled promise rejections are logged instead of ending the process.
- `WEBRTC_AGENT_CALL` is only relayed to agents in the same session.

**Behavior change:** errors that used to restart the container now only appear in the logs.

## 4. Mobile image upload: decompression limit

`POST /v1/mobile/images` limited the compressed body size but not the decompressed size. Decompressed data is now limited to `QUEUE_MESSAGE_SIZE_LIMIT`, which defaults to 1 MiB; larger payloads could not be written to the queue anyway. Oversized uploads and tar entries are rejected with HTTP 413.

**Tests:** `backend/pkg/images/api/handlers_test.go`.

## 5. Canvas upload: file names and disk errors

Canvas file names on `POST /v1/web/images` must be 1–100 characters from `[0-9A-Za-z_.-]`. The tracker's own names (`<timestamp>_<id>.<ext>`) match.

Previously a disk write error (for example a name longer than the file system allows) called `log.Fatal` and stopped the canvas service, and the queued message then failed again on every restart. In the canvas and image services, disk write errors are now logged and the file is skipped.

**Tests:** `backend/pkg/canvases/api/handlers_test.go`, `backend/pkg/canvases/service/canvas_test.go`.

## 6. Tracker: textarea masking

A textarea's text node mirrors its value, and React rewrites it on every render. That text node went through the regular text path, which at the default level only masks emails. Textarea text nodes are now always masked; the replay gets the value from the input module, which applies `defaultInputMode` and the per-element settings.

**Tests:** `tracker/tracker/src/tests/observer_textarea.test.ts`.

## 7. Deployment defaults

| Change | Helm (`scripts/helmcharts`) | Compose (`scripts/docker-compose`) |
| ------ | --------------------------- | ---------------------------------- |
| ClickHouse password | `clickhouse.password` generated in `vars.yaml` | `COMMON_CH_PASSWORD` |
| Redis/Valkey password | `redis.usePassword: true`; `redis.password` and `redis.redisPassword` share one generated value | `COMMON_REDIS_PASSWORD` |
| ClickHouse backup API | `API_USERNAME`/`API_PASSWORD` set from the ClickHouse credentials, also used by the backup cron job | n/a |
| Object storage console | n/a | Disabled, port 9001 no longer published |
| HTTPS | `ssl-redirect: "true"`, HSTS one year | Caddy sends HSTS (`Caddyfile`; not `Caddyfile.private`) |
| Install host | `init.sh` installs k3s with a 600 kubeconfig and makes `vars.yaml` readable only by the installing user; `openreplay-cli` prefers `~/.kube/config` | n/a |
| Upgrades | n/a | `upgrade.sh` generates secrets added by the release instead of keeping `change_me_*` |

**Upgrade notes:**
- **Existing Helm installs** keep their current, empty database passwords; set them as described in [Deployment Hardening](DEPLOYMENT_HARDENING.md#upgrading-an-existing-installation).
- **TLS at a load balancer:** if TLS terminates at a load balancer that forwards plain HTTP, it must send `X-Forwarded-Proto: https`, or the redirect loops.
- **`openreplay-cli`:** run it as the installing user, or with `sudo`.

**Tests:** `scripts/docker-compose/upgrade_test.sh`. The charts were checked with `helm template` using generated values.

## 8. Integration credentials

Members could read and change every integration credential: the error-tracking and log-provider keys, webhook URLs and auth headers, and Slack and Teams webhook URLs.

- **Python API** (`api/routers/core.py`, `core_dynamic.py`): the integration, webhook, Slack and Teams settings routes require the `owner` or `admin` role.
- **Lists members still use:** webhook lists and Slack/Teams channel lists no longer include `endpoint` or `authHeader` for members (`webhook.hide_secrets`).
- **Go API:** loads the user's role (`User.IsAdmin`) and requires owner/admin on `/{project}/integration/{name}` (`backend/pkg/integrations/api`). The session data lookup used by the player stays open.

**Behavior change:** members get 401/403 on the integration settings pages.

**Members can still:**
- share sessions and errors to Slack and Teams;
- create issues;
- view Sentry events and backend logs in the player;
- pick a webhook for alerts.

**Tests:** `api/test/test_integration_roles.py`, `backend/pkg/integrations/api/handlers_test.go`.

## 9. Login limits and password policy

- **Failed logins:** after `LOGIN_MAX_FAILED_ATTEMPTS` (default 10) failed logins for one email within `LOGIN_FAILED_ATTEMPTS_WINDOW_S` (default 900 s), `/api/login` returns 429 without checking the password. A successful login resets the counter.
- **Counter storage:** counters are kept in Redis (`REDIS_STRING`, with the email hashed) so they are shared across replicas, and fall back to process memory without Redis (`api/chalicelib/utils/attempt_limiter.py`).
- **Reset-link requests** are limited the same way per email. The response doesn't change, so it doesn't reveal whether the account exists.
- **Password policy:** signup, password change and password reset enforce the policy the UI already displays: at least 8 characters, with an uppercase letter, a lowercase letter, a digit and a special character (`users.password_policy_error`).

**Behavior change:**
- Repeated wrong passwords lock that email's login for the window.
- Weak new passwords are rejected. Existing passwords keep working.

The limit is per account; per-IP limiting belongs at the ingress (see [Deployment Hardening](DEPLOYMENT_HARDENING.md#5-rate-limit-per-client-ip-at-the-ingress)).

**Tests:** `api/test/test_login_limits.py`.

## 10. MCP sign-in

The browser sign-in used to accept any `client_id`/`state` pair. Whoever created an authorize link could collect the token after the link was approved.

- **Client** (`mcp_app`): generates a confirmation code (`XXXX-XXXX`), shows it to the user, and puts only its SHA-256 (`code_challenge`) in the authorize link.
- **Consent page** (`frontend/app/components/McpAuthorize`): asks for the code and warns users never to enter a code someone sent them.
- **API check:** `POST /v1/mcp/authorize` records the approval only if the code matches (`api/chalicelib/core/mcp/authorizers.py`).
- **Timeout:** `MCP_LOGIN_TIMEOUT_S` is fixed (it compared seconds with milliseconds, in the wrong direction) and defaults to 300 s.
- **Revocation:** changing or resetting a password deletes the user's MCP tokens (`users.revoke_mcp_tokens`), and the Go API rejects MCP tokens that are no longer registered.

**Behavior change:**
- MCP clients without the confirmation code can no longer sign in.
- A password change disconnects the user's MCP clients; a dashboard logout does not.

**Tests:** `api/test/test_mcp_authorize.py`, `backend/pkg/server/user/mcp_revocation_test.go`.

## 11. Tracker: selected text and attributes of masked elements

- **Selected text** (`modules/selection.ts`) is masked unless every text node it covers is recorded and unmasked. Otherwise it gets the usual number and email masking. In `privateMode` it is always masked.
- **Attributes:** on obscured or hidden elements, `title`, `alt`, `placeholder`, `label`, `value`, `content`, the `aria-*` text attributes and all `data-*` attributes are masked like the element's text (`app/observer/observer.ts`). Layout attributes such as `class`, `id` and `style` are unchanged.

**Behavior change:** CSS that targets `data-*` values on masked elements no longer matches in replays.

**Tests:** `tracker/tracker/src/tests/maskingGaps.test.ts`.

## 12. Tracker: cross-frame messages

In `app/index.ts`:

- **Parent page:**
  - registers its cross-frame listener only when `crossdomain.enabled` is set, as the cross-domain iframe setup already requires;
  - accepts messages only from iframes in the document;
  - a new `crossdomain.childDomains` option restricts which iframe origins can join the session and receive its token.
- **Child iframe:**
  - accepts start commands and tokens only from `window.parent`, and only from `crossdomain.parentDomain` when that is set;
  - logs a warning when `parentDomain` is `'*'`.

**Behavior change:** parent pages that track cross-domain iframes without `crossdomain.enabled` stop receiving iframe data.

**Tests:** `tracker/tracker/src/tests/crossdomainMessages.test.ts`.

## Settings reference

| Setting | Service | Default | Section |
| ------- | ------- | ------- | ------- |
| `TOKEN_SECRET` | `assist` | none, set by Helm/Compose | 2 |
| `ASSIST_REQUIRE_SESSION_TOKEN` | `assist` | `true` | 2 |
| `QUEUE_MESSAGE_SIZE_LIMIT` | `images` | `1048576` | 4 |
| `clickhouse.password`, `redis.password`, `redis.redisPassword` | Helm `vars.yaml` | generated | 7 |
| `COMMON_CH_PASSWORD`, `COMMON_REDIS_PASSWORD` | Compose `common.env` | generated | 7 |
| `LOGIN_MAX_FAILED_ATTEMPTS` | `chalice` | `10` | 9 |
| `LOGIN_FAILED_ATTEMPTS_WINDOW_S` | `chalice` | `900` | 9 |
| `MCP_LOGIN_TIMEOUT_S` | `chalice` | `300` | 10 |
| `crossdomain.childDomains` | tracker | not set (any iframe on the page) | 12 |

## Rollout

1. **Build** the `frontend`, `assist`, `images`, `canvases`, `chalice` and `api` images, and the `@openreplay/tracker` and `@openreplay/tracker-assist` packages. The other services are unchanged.
2. **Deployment configuration:** for an existing installation, apply the [upgrade steps](DEPLOYMENT_HARDENING.md#upgrading-an-existing-installation) for the database passwords. Review the [go-live checklist](DEPLOYMENT_HARDENING.md#before-go-live).
3. **Services:** deploy them with `ASSIST_REQUIRE_SESSION_TOKEN=false` if older trackers or mobile apps use Assist.
4. **Tracker:** release the new tracker packages in your applications. Check the cross-domain iframe settings if you use them.
5. **Assist enforcement:** once old trackers are gone, and if mobile Assist is not used, remove `ASSIST_REQUIRE_SESSION_TOKEN=false`.
6. **MCP:** distribute the updated MCP app to anyone who uses it.

## Running the tests

| Component | Command (from the component directory) |
| --------- | --------------------------------------- |
| Go backend | `go test ./pkg/images/... ./pkg/canvases/... ./pkg/integrations/... ./pkg/server/user/...` |
| Python API | `python -m pytest test/` (needs a `.env`, e.g. a copy of `env.default`) |
| Assist | `npm test` |
| Tracker, tracker-assist | `npx jest --coverage=false`, after `bun install` in `tracker/`. Run Jest with Node: some suites don't load under Bun's runtime. With Bun 1.3+, install with `bun install --linker hoisted`. |
| Frontend (player tests) | `npx jest tests/unit`, after `yarn install` in both `frontend/` and `player/` |
| Compose upgrade script | `bash upgrade_test.sh` |
