# Mob Cash Telegram Bot

Telegram-only customer interface built with Bun, TypeScript, grammY, Hono, and SQLite.

## What is included
- `/start` menu with top-up, order status, prices, and support.
- Customer chooses an amount and enters their account/phone identifier.
- Orders are stored in SQLite.
- Admin can list pending orders and approve/reject them.
- The Mobi Cash provider adapter is deliberately isolated in `src/providers/mobicash.ts`.
- Health endpoint for Railway: `/api/health`.

## Important integration note
This starter does **not** invent a Mobi Cash API endpoint or request format. Automatic recharge is activated only after the real provider API documentation is added to `src/providers/mobicash.ts`. Until then, approved orders are marked `awaiting_provider` and are not falsely reported as successfully topped up.

If BaridiMob payment is by manual transfer, the admin must verify receipt/payment before approving the order. Do not put secret API tokens in Telegram messages or commit `.env` to GitHub.

## Run locally
1. Install Bun.
2. Copy `.env.example` to `.env` and fill `BOT_TOKEN` and your Telegram numeric `ADMIN_ID`.
3. Run `bun install`.
4. Run `bun run start`.

## Deploy to Railway
1. Push these files to your GitHub repository (the existing `gold-charge-bot` can be used).
2. In Railway, connect the repository to the service.
3. Add environment variables from `.env.example` in Railway Variables.
4. Deploy. Railway provides `PORT` automatically.
5. Open `/api/health`; it should return `{"ok":true,...}`.

## Admin commands
- `/admin` — admin menu.
- `/pending` — list pending-payment orders.
- `/approve ORDER_ID` — mark payment verified and queue provider recharge.
- `/reject ORDER_ID` — reject an order.

Only use `/approve` after verifying that the customer actually paid.

## Customer flow
`/start` → Top up → amount → account identifier → payment instructions → admin verifies payment → provider recharge.

## Next required information
To finish automatic recharge, provide the official Mobi Cash API documentation or exact endpoint, HTTP method, required headers/body, and a sample successful response. Never share a live secret token in chat; add it privately to Railway Variables.
