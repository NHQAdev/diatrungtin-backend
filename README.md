# Địa Trung Tín — E-commerce Backend

REST API for **Trầm Hương Địa Trung Tín**, an online store selling agarwood (trầm hương) jewelry and incense. It serves both the customer storefront (`/api/*`) and the admin dashboard (`/api/admin/*`).

Frontend: [diatrungtin-frontend](https://github.com/NHQAdev/diatrungtin-frontend)

> 🚧 **Status: in development.** All MVP backend modules are implemented and covered by integration tests. Production deployment and online payments are not done yet. See [Roadmap](#roadmap).

## Tech stack

| Area | Choice |
|---|---|
| Runtime | Node.js 22, TypeScript (ESM) |
| HTTP | Fastify 5 (cookie, CORS, helmet, rate-limit, multipart) |
| Database | PostgreSQL 16, Kysely query builder, plain SQL migrations |
| Validation | Zod (environment variables and requests) |
| Testing | Vitest integration tests against a real PostgreSQL database |
| Email | Nodemailer with a database outbox and background worker |
| Deployment | Docker, Docker Compose, Caddy (HTTPS), backup/restore scripts |

## Highlights

- **Server-side pricing**: retail vs. approved-business price tiers are decided only on the server; the client never sends prices.
- **Safe ordering**: an order is created in one transaction with row locks, so stock can never be oversold; idempotency keys are enforced by a database constraint.
- **Order state machine** with separate order, payment and delivery states; cancelling restores stock exactly once.
- **Security**: random session tokens stored as SHA-256 hashes, HttpOnly/SameSite cookies, login rate limiting, origin checks on admin writes, audit log.
- **Vietnamese search** that ignores diacritics (e.g. "tram huong" finds "trầm hương").

## Progress

### ✅ Done
- **Platform**: validated config, SQL migrations with checksums, health checks, unified error format, request logging with cookies masked.
- **Admin auth**: cookie login/logout, CLI to create, reset or disable admins, audit log.
- **Catalog**: category tree, collections, tags, products, images, specs, variants/SKUs, retail and business prices, "extra beads" option for bracelets, stock with history, image upload.
- **Customer accounts**: individual and business sign-up, **email OTP verification**, login, forgot/reset/change password, profile, business upgrade with admin approval.
- **Checkout & orders**: server-side quote, guest checkout (phone + email), idempotent order creation, order lookup, cancellation by secret link or account.
- **Order management (admin)**: list, filters, details with history, status changes, editing shipping info with a required reason, recording cash-on-delivery payments.
- **Email**: order confirmation and updates, password reset, business approval results, OTP codes; failed emails can be viewed and re-sent by admins.
- **Store settings**: store info, flat shipping fee with free-shipping threshold, content/policy pages, admin dashboard stats.
- **Maintenance**: cleanup job every 6 hours (expired sessions, tokens, idempotency keys, sent emails).
- **Deployment setup**: Dockerfile, Docker Compose + Caddy, backup/restore scripts, deployment guide.

### 🔄 Not yet verified
- Running the full Docker Compose stack on a real VPS.
- Sending email through a real SMTP server.

### 🔜 Roadmap
- Bank transfer and online payment gateway (the MVP supports cash on delivery only)
- Vouchers, reviews, wishlist, blog
- Shipping carrier integration
- Staff roles with fine-grained permissions
- Image storage on S3/R2, HTML email templates

## Getting started

Requires Node.js ≥ 22.12 and PostgreSQL ≥ 16.

```bash
# 1. Create the databases
createuser -P dtt
createdb -O dtt dtt_dev
createdb -O dtt dtt_test

# 2. Configure
cp .env.example .env              # set DATABASE_URL and TEST_DATABASE_URL

# 3. Install and migrate
npm install
npm run db:migrate
npm run db:seed                   # categories, tags and 2 sample products
npm run db:seed:demo              # optional: demo catalog with product photos

# 4. Create an admin account (asks for a password, min. 12 characters)
npm run admin -- create --email owner@example.com --name "Owner"

# 5. Run
npm run dev                       # http://localhost:4000/health
```

With Docker, step 1 can be replaced by:

```bash
docker run -d --name dtt-postgres -e POSTGRES_USER=dtt -e POSTGRES_PASSWORD=change_me \
  -e POSTGRES_DB=dtt_dev -p 5432:5432 postgres:16
docker exec dtt-postgres createdb -U dtt dtt_test
```

After the first run, set the shipping fee as admin (`PUT /api/admin/store-settings`) before placing orders. Without SMTP settings, emails are printed to the dev server log.

## Tests

```bash
npm run typecheck
npm test          # uses TEST_DATABASE_URL; the test schema is recreated on every run
```

## Admin accounts

```bash
npm run admin -- create --email a@b.vn --name "Name"
npm run admin -- reset-password --email a@b.vn   # revokes all sessions
npm run admin -- disable --email a@b.vn          # locks the account and revokes all sessions
```

## Deployment

VPS deployment with Docker Compose (PostgreSQL + API + Caddy HTTPS), including backup and restore: see [docs/DEPLOY.md](docs/DEPLOY.md).

## Documentation (Vietnamese)

[Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Business decisions](docs/DECISIONS.md) · [Email setup](docs/EMAIL.md) · [Progress log](docs/PROGRESS.md)
