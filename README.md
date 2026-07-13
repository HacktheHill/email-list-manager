# Hack the Hill email updates service

This repository contains the standalone subscription service for Hack the Hill email updates. It is a Cloudflare Worker backed by D1. D1 is the source of truth; the CSV endpoint is an authenticated campaign snapshot for [`bulk-email`](https://github.com/HacktheHill/bulk-email).

## Routes

All state changes use `POST`. Browser `GET` requests only render a small page, which prevents email security scanners from accidentally confirming or removing a subscription.

### Subscribe

```text
GET  https://emails.hackthehill.com/subscribe
POST https://emails.hackthehill.com/subscribe
```

The POST body can be JSON or form data:

```json
{ "email": "person@example.com", "lang": "en" }
```

The service uses double opt-in. The address is not exported until the confirmation link has been opened and submitted. `lang` may be `en` or `fr` and is retained for confirmation messages and result pages.

To confirm a request, POST the token from the confirmation URL:

```json
{ "token": "..." }
```

### Unsubscribe

```text
GET  https://emails.hackthehill.com/unsubscribe?token=...
POST https://emails.hackthehill.com/unsubscribe?token=...
```

`POST` also accepts the RFC 8058 `List-Unsubscribe=One-Click` request. `token` is the only supported signed-token parameter.

### Authenticated CSV export

`bulk-email` obtains the active list with:

```bash
curl \
  -H "Authorization: Bearer $EXPORT_TOKEN" \
  -H 'Accept: text/csv' \
  'https://emails.hackthehill.com/subscribe?export=csv'
```

The response contains only confirmed active addresses and their `en`/`fr` preferred language in `email,language` columns. It is marked `no-store`.

The sender’s migration-compatible suppression endpoint is:

```text
GET /unsubscribe?suppressed=1&limit=1000&cursor=...
Authorization: Bearer <SUPPRESSION_READ_TOKEN>
```

## Cloudflare setup

The production Worker and D1 database are already deployed. The SES DNS records and the subscription rate-limit rule are configured in Cloudflare. No KV namespace is used.

1. The production D1 database is configured in `wrangler.jsonc`.
2. Apply migrations after schema changes:

   ```bash
   npx wrangler d1 migrations apply email-list-manager --remote
   ```

3. Configure the `emails.hackthehill.com` custom domain/route.
4. Set Worker secrets. Never put these values in `wrangler.jsonc`:

   ```bash
   npx wrangler secret put EXPORT_TOKEN
   npx wrangler secret put SUPPRESSION_READ_TOKEN
   npx wrangler secret put UNSUBSCRIBE_TOKEN_SECRET
   npx wrangler secret put AWS_ACCESS_KEY_ID
   npx wrangler secret put AWS_SECRET_ACCESS_KEY
   npx wrangler secret put AWS_REGION
   npx wrangler secret put SES_FROM_EMAIL
   npx wrangler secret put SES_FROM_NAME
   npx wrangler secret put SES_CONFIGURATION_SET
   ```

 `AWS_ACCESS_KEY_ID` should belong to an IAM principal restricted to sending from the Hack the Hill sender identity. Add `AWS_SESSION_TOKEN` only when using temporary credentials.

5. Set `UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET` during signing-key rotation and remove it after all old messages have aged out.
6. Configure Cloudflare rate limiting for subscription POSTs by source IP and enable Worker observability.
7. Configure AWS SES account-level suppression for both hard bounces and complaints, plus a configuration set with delivery/bounce/complaint event destinations.

CloudWatch alarms are configured for the SES configuration set: `email-list-manager-ses-bounce-rate` alerts at a 5% daily bounce rate, and `email-list-manager-ses-complaint-rate` alerts at a 0.1% daily complaint rate. Both target the `email-list-manager-ses-alerts` SNS topic. Its `info@hackthehill.com` email subscription must be confirmed from the AWS confirmation message before notifications can be delivered.

The deployed configuration uses `info@hackthehill.com` as the sender and `my-first-configuration-set` for SES. SES DKIM, domain, and custom MAIL FROM verification are complete.

For the Cloudflare rate-limit rule, target hostname `emails.hackthehill.com`, path `/subscribe`, and method `POST`. The deployed Free-plan rule allows **10 requests per IP per 10 seconds** and blocks for 10 seconds (Cloudflare Free only permits a 10-second period/mitigation window). The Worker already enforces a 15-minute per-address confirmation resend cooldown. No KV namespace is required.

The only route in the Hack the Hill Cloudflare account is `emails.hackthehill.com/*` → `email-list-manager`.

## SES verification records for `hackthehill.com`

The SES identity is created. These records are configured with proxying disabled (DNS-only):

| Type | Name | Target/value | Priority |
| --- | --- | --- | --- |
| CNAME | `omeox32zk4mhkvp5ptohvlmuvif3zpgg._domainkey` | `omeox32zk4mhkvp5ptohvlmuvif3zpgg.dkim.amazonses.com` | — |
| CNAME | `klhwzsmrp2cdrbpikqmzmmuli7dy62hj._domainkey` | `klhwzsmrp2cdrbpikqmzmmuli7dy62hj.dkim.amazonses.com` | — |
| CNAME | `ic2tj4uupgas2krgfxw2oomaxkdbapwv._domainkey` | `ic2tj4uupgas2krgfxw2oomaxkdbapwv.dkim.amazonses.com` | — |
| MX | `mail` | `feedback-smtp.ca-central-1.amazonses.com` | 10 |
| TXT | `mail` | `v=spf1 include:amazonses.com ~all` | — |

The MX and TXT records are for the configured custom MAIL FROM domain `mail.hackthehill.com`. After DNS propagation and SES's verification check complete, verify with:

```bash
aws sesv2 get-email-identity --email-identity hackthehill.com --region ca-central-1
```

Deploy with:

```bash
npm install
npm run typecheck
npm test
npx wrangler deploy
```

## Local development

```bash
npm install
npm test
npm run dev
```

The test Worker uses a local D1 database with the production schema (including the locale migration) and covers browser GET safety, one-click unsubscribe, confirmation, localized pages, authenticated export, and suppression pagination.

## Migration

Before production cutover:

1. Export the existing Google Sheet.
2. Import valid Sheet addresses as `active`.
3. Update `bulk-email` to use the new export and canonical `token` unsubscribe URLs.

Legacy suppressions from the previous system are intentionally not part of this list.

Do not delete unsubscribed rows during routine maintenance. They are the suppression record that prevents stale imports from restoring consent.
