# 3MT Server

Express and MongoDB backend for authentication, products, product review requests, product images, enquiries, and orders.

## Requirements

- Node.js 18 or newer
- npm
- MongoDB connection
- Cloudinary account

## Environment

Copy `.env.example` to `.env` and provide:

```env
PORT=8080
NODE_ENV=development
CLIENT_URLS=http://localhost:3000,http://127.0.0.1:3000,https://3mt-machine-tools.netlify.app,https://3mt-dashboard.netlify.app
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
GOOGLE_CLIENT_ID=your_google_oauth_client_id
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
```

`CLIENT_URLS` contains frontend origins, not backend URLs. Keep values comma-separated and omit paths and trailing slashes.

`GOOGLE_CLIENT_ID` must match the OAuth client ID used by the frontend Google Sign-In button. The backend verifies Google credentials against this value before issuing a 3MT JWT.

## Commands

```bash
npm install
npm run dev
npm start
npm run check
npm test
npm run verify
```

- `npm run dev` starts Nodemon for local development.
- `npm start` runs the server normally.
- `npm run check` syntax-checks every first-party server module without connecting to external services.
- `npm test` runs the Node test suite without connecting to MongoDB or Cloudinary.
- `npm run verify` runs syntax checks followed by the complete backend test suite.

## Second-Hand Product Workflow

The backend supports new and second-hand products without changing the existing product endpoints.

- `condition`: `new` or `used`
- `availabilityType`: `sale`, `rent`, or `both`
- `availabilityStatus`: `available`, `on_rent`, `unavailable`, or `sold`
- Rental listings require `rentalPrice` and `rentPeriod` (`day`, `week`, or `month`).
- Sale listings require a positive `price`.
- Category and brand values are trimmed and converted to uppercase before persistence.
- Existing records without the new fields remain compatible through the defaults `new`, `sale`, and `available`.

Employees submit products through `POST /api/pending-products`. New requests always start with listing availability `available` and review status `pending`. An admin may edit the request and approve it; approval validates and copies the product fields and Cloudinary image references into the main `Product` collection. The `PendingProduct` record remains as review history until an admin deletes it.

The backend tests cover shared validation, employee submission preparation, admin approval payload creation, Product and PendingProduct schemas, and legacy product defaults.

## Rental and Machine Sale Data

Each second-hand Product `_id` represents one physical machine. Rental and MachineSale records reference that machine and the selected customer while preserving customer and machine snapshots for historical reporting.

Transaction money is stored as integer paise to avoid floating-point rounding. Rental records preserve lifecycle dates, agreed billing terms, calculated period/day splits, derived daily rates, final charges, late/deposit settlement values, settlement notes, payments, cancellation details, and audit history. A partial unique index prevents more than one active or overdue rental from occupying the same machine. Machine sales preserve agreed price, payments, balance, cancellation details, and audit history, with a partial unique index allowing only one completed sale per machine.

The reusable rental calculation utilities support daily rates, seven-day weekly blocks, fixed 30-day monthly blocks, derived per-day remainder rates, early-return recalculation, no-grace late charges, overdue estimates, and explicit deposit settlement. Eligibility validation restricts assignments to one available second-hand rent/both machine and a customer account with the contact details required for reminders. Rental APIs, dashboard workflows, and reminders are added by later tasks described in `RENTAL_REMINDER_ARCHITECTURE.md` at the project root.

### Reminder Data Foundation

Reminder scheduling uses three collections so schedule configuration, individual due times, and provider attempts remain independently auditable:

- `ReminderDefinition` supports rental activation confirmations, rental return reminders, and standalone custom reminders. It stores the selected customer contact snapshot, schedule mode, email/WhatsApp channels, bilingual content configuration, schedule version, cancellation history, and `Asia/Kolkata` business-zone metadata.
- `ReminderOccurrence` stores each exact due instant, independent email and WhatsApp state, retry timing, expiring claim locks, cancellation/missed history, and a unique definition/time/version key that prevents duplicate occurrences.
- `NotificationDeliveryAttempt` stores each channel attempt with an idempotency key, attempt number, provider identifiers, result, timestamps, and error metadata.

MongoDB `Date` fields hold UTC instants. Admin-entered India local date/time values are converted through `utils/businessTime.js`, and API/dashboard output can format the same instant with `Asia/Kolkata`. This avoids ambiguous server-local times while preserving IST behavior for the business.

Rental activation now creates an idempotent confirmation occurrence plus default return occurrences at 12 hours and 1 hour before the expected return time. If a default time has already passed for a short rental, its occurrence is retained as `missed` for an honest audit trail. Extending a rental cancels its unsent old return occurrences and creates a new schedule version; returning or cancelling a rental cancels all remaining unsent reminder work.

Reminder occurrence upserts explicitly store each selected channel as `pending` and each unselected channel as `not_selected`. This initialization is part of the database update payload and does not depend on document middleware, so automatic email processing and manual WhatsApp readiness remain consistent for lifecycle and restored reminders.

Default reminder definitions and occurrences contain rendered English and Hindi subjects and bodies. They show India-time rental dates, machine and rental identifiers, rental amount, amount paid, remaining balance, and security deposit as separate Indian-rupee values. The shared template utility also validates and combines future admin-authored bilingual messages for rental and standalone reminders.

Automatic Brevo email and admin-confirmed manual WhatsApp delivery are connected. Occurrences remain durable MongoDB work items, while the protected processor reconstructs process-local timers after startup or cron wakeup.

### Admin Reminder APIs

All reminder endpoints require an admin JWT. Dashboard date/time strings without `Z` or an explicit offset are interpreted as `Asia/Kolkata`; stored and returned date values are UTC instants.

- `POST /api/reminders/preview` validates a schedule and returns its bilingual content and generated UTC dates without saving.
- `POST /api/reminders` creates a custom rental reminder when `rentalId` is supplied, otherwise a standalone customer reminder.
- `GET /api/reminders` lists definitions with optional `type`, `status`, `customer`, `rental`, `page`, and `limit` filters.
- `GET /api/reminders/:id` returns one definition with all immutable occurrence history.
- `PATCH /api/reminders/:id` versions and replaces an unsent active/paused schedule; definitions with delivery history cannot be edited.
- `POST /api/reminders/:id/pause` and `POST /api/reminders/:id/resume` control a future series.
- `POST /api/reminders/:id/cancel` cancels a series with a required reason while preserving history.
- `GET /api/reminders/occurrences` lists occurrences with optional `status`, `definition`, `rental`, `page`, and `limit` filters.
- `POST /api/reminders/occurrences/:id/cancel` cancels one unsent occurrence with a required reason.
- `POST /api/reminders/occurrences/:id/send-email` atomically sends or retries one eligible email channel through Brevo and returns the saved provider attempt result.
- `POST /api/reminders/rentals/:rentalId/restore-defaults` replaces custom return reminders with the default 12-hour and 1-hour schedule.

Rental custom reminders support `offset_before_return` and `exact`. Standalone reminders support `exact`, `multiple_dates`, and `repeating` with `day`, `week`, or `month` frequency. Repeating schedules require an end date or occurrence limit and are capped at 100 generated occurrences. Custom content requires both English and Hindi bodies. Channels may be `email`, `whatsapp`, or both.

Reminder email delivery reuses `BREVO_API_KEY`, `OTP_EMAIL_FROM_EMAIL`, and optional `OTP_EMAIL_FROM_NAME`. The adapter sends English and Hindi in the same text/HTML email, passes a provider idempotency header, stores Brevo's `messageId`, and records every attempt independently. A Brevo acceptance marks only the email channel accepted; it does not mark WhatsApp successful. Tests mock `fetch` and never contact Brevo.

### Admin Rental APIs

All rental endpoints require an admin JWT.

- `POST /api/rentals/quote` previews calculated billing without saving.
- `POST /api/rentals` saves an editable draft by default; send `status: "active"` to confirm handover immediately.
- `GET /api/rentals` supports `status`, `customer`, `machine`, `search`, `page`, and `limit` filters.
- `GET /api/rentals/:id` returns rental detail with related machine, customer, and admin records.
- `PATCH /api/rentals/:id` edits and recalculates a draft. Active or historical rentals cannot use unrestricted draft editing.
- `POST /api/rentals/:id/activate` confirms a saved draft, atomically marks its machine `on_rent`, and records an audit event.
- `POST /api/rentals/:id/cancel` cancels a draft, active, or overdue rental with a required `reason`; occupying-rental cancellation safely releases the machine.
- `POST /api/rentals/:id/extend` extends an active/overdue deadline, recalculates the planned charge, and requires an audit `note`.
- `POST /api/rentals/:id/payments` records an additional payment for an active, overdue, or returned rental.
- `POST /api/rentals/:id/return-preview` previews early/late billing, payment refund, deposit use/refund, and remaining balance without saving.
- `POST /api/rentals/:id/return` records the admin-selected physical return time, saves the backend entry time separately, finalizes settlement, and marks the machine `available`.
- `POST /api/rentals/sync-overdue` marks expired active rentals overdue. Rental list/detail reads also synchronize overdue records and return live late-charge estimates.
- `DELETE /api/rentals/:id` permanently deletes a draft only.

Create/update payloads use `machineId`, `customerId`, `handoverAt`, `expectedReturnAt`, `billingPeriod`, `agreedRatePaise`, optional `dailyLateRatePaise`, `securityDepositReceivedPaise`, optional `initialPayment`, and `notes`. Money values are integer paise. An initial payment uses `amountPaise`, `method` (`cash`, `upi`, `bank_transfer`, `card`, or `other`), and optional `paidAt`, `reference`, and `note`.

Return preview/finalization accepts `actualReturnAt`, optional `otherApprovedChargesPaise`, explicit `depositAppliedPaise`, optional final `payment`, `settlementNote`, and `returnNote`. It never accepts a machine availability override: completing a return restores `available`, and any later damage/maintenance status is managed through the existing product workflow. Early-return rent overpayment is stored separately from the security-deposit refund.

### Admin Machine Sale APIs

All machine-sale endpoints require an admin JWT.

- `POST /api/machine-sales` saves an editable draft by default; send `status: "completed"` to complete the sale immediately.
- `GET /api/machine-sales` supports `status`, `customer`, `machine`, `search`, `page`, and `limit` filters.
- `GET /api/machine-sales/:id` returns the customer-linked sale detail and payment/audit history.
- `PATCH /api/machine-sales/:id` edits a draft while preserving additional payment history.
- `POST /api/machine-sales/:id/complete` completes a draft and atomically marks the machine `sold`.
- `POST /api/machine-sales/:id/payments` records a payment without exceeding the remaining sale balance.
- `POST /api/machine-sales/:id/cancel` cancels a draft with a required `reason`; paid drafts also require `refundConfirmed: true` and preserve the refunded amount.
- `DELETE /api/machine-sales/:id` permanently deletes an unpaid draft only; paid drafts must be cancelled to preserve refund history.

Create/update payloads use `machineId`, `customerId`, optional `soldAt`, `agreedSalePricePaise`, optional `initialPayment`, and `notes`. Completed sales may retain a remaining balance for partial-payment arrangements. Only one available second-hand Product offered for sale can be completed, and machines with active/overdue rentals are rejected.

## Health Check

```text
GET /api/health
```

Production backend:

`https://threemt-server.onrender.com`

## Product Read APIs

- `GET /api/products`
- `GET /api/products/search?q=grinder&limit=8`
- `GET /api/products/:id`
- `GET /api/products/:id/related?limit=30`

See `PROJECT_MEMORY.md` in the project root for the complete API and feature inventory.
# Automatic Email and Manual WhatsApp Reminders

Email and WhatsApp have independent delivery states. Email `accepted` means Brevo accepted the email, not that the customer read it. WhatsApp `manual_sent` means an admin confirmed sending in WhatsApp; there is no Meta integration or delivery receipt.

Admin endpoints:

- `GET /api/reminders/occurrences/:id/whatsapp`: prepare a bilingual customer-addressed link without marking anything sent.
- `POST /api/reminders/occurrences/:id/whatsapp-sent` with `{ "confirmed": true }`: record the admin and manual send time.
- Existing `POST /api/reminders/occurrences/:id/send-email`: retry an eligible due email, respecting retry backoff and limits.

Enable automatic email on the deployed backend with `REMINDER_EMAIL_AUTOMATION_ENABLED=true`, the existing Brevo sender configuration, and a random `REMINDER_CRON_SECRET` of at least 32 characters. The example keeps automation disabled to prevent accidental customer sends during development.

Configure the external cron service to POST `/api/reminder-jobs/process` every five minutes using `Authorization: Bearer <REMINDER_CRON_SECRET>`. Use a request timeout long enough for Render cold starts and retry failed requests. Never put this secret in dashboard environment variables or a query string. The endpoint awaits the database connection, schedules work, and returns promptly. The production cron, Render wakeup, Brevo email, and manual WhatsApp flow were verified on 24 October 2026. See `RENTAL_REMINDER_VERIFICATION.md` for the repeatable release checklist.

While awake, the backend scans every 30 seconds and sets timers for due emails within ten minutes. Rental activation requests also trigger a scan. Timers are deduplicated locally, email delivery is atomically claimed across instances, and sends are limited to three concurrent calls per process. Paused/cancelled/old-version reminders and inactive rentals are rechecked before delivery. Automatic emails more than ten minutes late are skipped; manual WhatsApp remains independent. Shutdown clears timers, and startup reconstructs pending timers. Interrupted/ambiguous provider requests become `uncertain` and are not automatically retried; inspect Brevo before taking further action. Do not treat the custom email idempotency header as a guarantee of provider-side deduplication.

Reminder edits, pauses, occurrence/series cancellations, rental deadline replacement, rental cancellation, and recorded return now remove their known process-local timer handles immediately after the durable MongoDB state change. The periodic scan and final delivery eligibility check remain in place for cross-instance work and race protection; an email already accepted by Brevo cannot be recalled.

Dashboard message preview may show the original occurrence snapshot. Default rental messages are refreshed with current dates and balances when preparing a WhatsApp link or sending email. No database migration is required for existing occurrences; new optional manual audit fields are added as needed.
