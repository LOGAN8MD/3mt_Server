# Rental Reminder Release Verification

This checklist verifies the dashboard and backend reminder-plan workflow without involving the customer website. Use a dedicated test customer and machine for manual production checks.

Approved Task 28 test recipient: Deepak Mishra, `deepak.mishra2327@gmail.com`, WhatsApp ending `4286`. Do not place provider credentials, JWTs, the complete phone number, or the cron secret in source control or screenshots.

## Automated Verification

Run before every reminder-related deployment:

```bash
cd 3mt_Server
npm run verify

cd ../3mt_dashboard
npm run verify
```

The backend suite currently passes 157 tests and covers billing and settlement, one-machine eligibility, lifecycle reminder creation, selected-channel initialization, bilingual rendering, schedule versioning, scoped rental/standalone filtering before pagination, deterministic grouped-log identity and legacy fallbacks, exact-group isolation, retries, atomic email claims, duplicate timer prevention, cancellation cleanup, and inactive-rental eligibility rejection. The dashboard suite currently passes 81 tests plus the optimized production build and covers creation/drafts, rental management, standalone plans, plan lifecycle controls, grouped rental/custom log overview and history, all retained occurrence statuses, message previews, provider attempts, independent channel actions, query-preserving navigation, route compatibility, roles, long content, keyboard dismissal, and persistent navigation.

## Production Configuration

Confirm these values exist only in Render, never in frontend variables or Git:

- `MONGO_URI`
- `JWT_SECRET`
- `BREVO_API_KEY`
- `OTP_EMAIL_FROM_EMAIL`
- `OTP_EMAIL_FROM_NAME`
- `REMINDER_EMAIL_AUTOMATION_ENABLED=true`
- `REMINDER_CRON_SECRET` with at least 32 characters

Confirm cron-job.org sends `POST https://threemt-server.onrender.com/api/reminder-jobs/process` every five minutes with `Authorization: Bearer <REMINDER_CRON_SECRET>`, an empty request body, and failure notifications enabled. A healthy response resembles:

```json
{"enabled":true,"scheduled":0,"timers":0}
```

Brevo IP security must authorize every outbound IP range shown under the Render service's Connect > Outbound view. Render may use any address in those listed ranges.

## Deployment Order and Compatibility

1. Run backend and dashboard verification locally.
2. Deploy the backend first. Wait for `GET /api/health` to return HTTP 200 before publishing the dashboard.
3. Confirm the deployed backend exposes the admin-only reminder plan routes, accepts `scope=rental` and `scope=standalone` on `GET /api/reminders/occurrences`, and serves `GET /api/reminders/log-groups` plus `GET /api/reminders/log-groups/:groupType/:groupId` before enabling the grouped dashboard UI.
4. Deploy the dashboard and sign in with a dedicated admin account.
5. Keep the customer website unchanged; the reminder-plan release does not require a website deployment.

After dashboard deployment, verify these admin routes at desktop and mobile widths:

- `/admin/create-reminder/rental` and `/admin/create-reminder/custom`
- `/admin/manage-reminders/rental` and `/admin/manage-reminders/custom`
- `/admin/reminder-logs/rental` and `/admin/reminder-logs/custom`

Refresh each route and use browser back/forward between tabs. Confirm only Create Reminders, Manage Reminders, and Reminder Logs appear in the sidebar; the active entry remains highlighted and the mobile menu closes after navigation. Confirm `/admin/rentals`, `/admin/rentals?workspace=create`, and `/admin/reminders` redirect without a full-page reload.

### Grouped Reminder Logs

Use dedicated test records rather than deleting or rewriting production history:

1. Confirm Rental Machines shows one entry per rental booking and combines its activation confirmation with every return-reminder version.
2. Confirm Custom Messages shows one entry per reminder plan. Create two plans for the same test customer and confirm they remain separate entries and separate histories.
3. Confirm legacy records without a plan remain visible under their deterministic definition/occurrence fallback group.
4. Search by customer name, email, and phone; verify totals and pagination are calculated after search.
5. Verify created/scheduled sorting in both directions. Scheduled sorting uses the next future unsent occurrence, or the latest scheduled occurrence when none remains.
6. Open a rental and custom group. Confirm starting/confirmation messages, edited schedule versions, pending, processing, sent, partially failed, failed, missed, and cancelled history remain visible in chronological order.
7. Confirm all displayed times are IST and that Back to reminder logs restores the selected tab, search, sort, direction, and page.
8. On eligible test occurrences only, verify View message, Retry email, Share on WhatsApp, and Mark as sent affect the selected occurrence and preserve independent channel state.
9. Repeat the overview and detail checks at desktop and mobile widths, including long customer names/messages and browser refresh/back/forward.

No destructive data migration is required. Existing reminder definitions and occurrences remain readable, while new complete plans add `ReminderPlan` records and optional references. Before live creation, confirm MongoDB has these indexes from the current schemas:

- `reminderplans`: unique `planCode`; unique partial `{ createdBy, submissionKey }`; rental/customer/type status indexes.
- `reminderdefinitions`: unique definition key and lifecycle lookup indexes.
- `reminderoccurrences`: unique occurrence key and `{ plan, scheduleVersion, scheduledAt }` lookup index.

If index creation reports existing duplicates, stop deployment and inspect the conflicting records. Do not delete production reminder history merely to force an index.

## Rollback

1. Disable or pause the cron job before rolling back reminder-processing code.
2. Redeploy the previously known-good dashboard and backend commits, backend first.
3. Do not delete newly created plans, definitions, occurrences, or delivery-attempt history. Older code can ignore additive optional fields.
4. If email automation itself is unsafe, set `REMINDER_EMAIL_AUTOMATION_ENABLED=false` in Render and redeploy/restart the backend.
5. Re-enable cron only after the health endpoint and reminder eligibility behavior are verified.

If only the dashboard reorganization must be rolled back, redeploy the previous dashboard commit while leaving the additive backend scope support in place. Do not roll the dashboard forward again until the backend scope endpoint is deployed; otherwise Rental Machines and Custom Messages logs cannot be reliably separated before pagination.

## Manual End-to-End Checklist

### Activation and channels

1. Create or activate a rental for a test customer with valid email and WhatsApp details.
2. Confirm the machine changes to `on_rent` and the rental becomes `active`.
3. Confirm one activation occurrence and the default 12-hour and 1-hour return occurrences exist without duplicate keys.
4. Confirm the activation email is accepted by Brevo and received by the customer.
5. Confirm WhatsApp shows `Message ready`, opens the bilingual customer-addressed message, and changes to `manual_sent` only after admin confirmation.

### Scheduled reminders

1. Use a test return time that makes the 1-hour reminder practical.
2. Confirm cron wakes Render and email is delivered within the allowed window.
3. Confirm email acceptance does not mark WhatsApp sent.
4. Share WhatsApp manually and confirm the independent audit timestamp.

### Custom rental plan

1. Create a test rental using Custom reminders with at least two distinct future offsets.
2. Preview and confirm that every calculated time is shown in IST and remains before the return deadline.
3. Confirm each selected email channel is accepted/received once and each WhatsApp channel remains `Message ready` until manually shared and confirmed.
4. Edit one future unsent row, then verify the prior row is retained as cancelled history and the replacement uses the next schedule version.

### Standalone reminder plan

1. Open Create Reminder > Custom Message and select the approved test customer.
2. Create at least two practical near-future reminders, optionally attaching a product only as descriptive context.
3. Confirm the product remains unchanged and no inventory status is reserved.
4. Confirm email and manual WhatsApp outcomes independently and verify no duplicate send occurs after another cron call.

### Plan lifecycle

1. Pause one future plan and confirm its due work does not send.
2. Resume it and confirm eligible work is reconstructed after a cron/backend scan.
3. Cancel one future occurrence with a reason and confirm it never sends.
4. Cancel a separate plan with a reason and confirm sent history remains visible while future unsent work is cancelled.

### Extension replacement

1. Extend an active rental with a required note.
2. Confirm the previous unsent return occurrences are `cancelled` with a superseded reason.
3. Confirm new return occurrences use the next schedule version and updated return time.
4. Confirm no duplicate email is sent from the old schedule.

### Cancellation and return cleanup

1. Cancel one active test rental with a reason; separately test a normal return when practical.
2. Confirm the machine becomes `available`.
3. Confirm remaining unsent reminder definitions and occurrences become `cancelled`.
4. Confirm cancelled reminders expose neither email retry nor WhatsApp share actions and never send after their old due time.
5. Remember that a message already accepted by Brevo cannot be recalled.

### Overdue and settlement

1. Let a test rental pass its expected return time and synchronize/read rentals.
2. Confirm the rental becomes `overdue` while the machine remains `on_rent`.
3. Preview and record the physical return time.
4. Confirm any started late day is billed as a full day with no grace period, deposit application is explicit, and the final balance/refund values match the preview.

### Recovery and duplicate protection

1. Trigger the cron processor more than once for the same due occurrence.
2. Confirm only one email attempt is accepted and the occurrence attempt count does not duplicate unexpectedly.
3. After a Render restart or cold start, trigger cron and confirm pending work is reconstructed from MongoDB.
4. Treat `uncertain` delivery as manual review work; check Brevo before retrying.

## Verified Production Evidence

As of 24 October 2026:

- The protected cron endpoint returned HTTP 200 with automation enabled.
- The deployed `/api/health` endpoint returned `status: ok` during the final Task 18 check.
- Render cold-start wakeup and MongoDB reminder scanning worked.
- A rental activation email was accepted through Brevo after Render outbound ranges were authorized.
- The prepared bilingual WhatsApp message opened and was manually shared.
- A scheduled 1-hour email arrived automatically.
- Its WhatsApp channel independently showed `Message ready` and was manually shared.
- Selected channel statuses were repaired and future occurrence upserts initialize them explicitly.
- The final read-only MongoDB integrity audit found zero duplicate occurrence keys, zero selected channels left as `not_selected`, and zero active reminder definitions attached to returned or cancelled rentals.
- The last deployed production evidence predates the local grouped-log Tasks 36-41. Current local verification passes 157 backend tests, 81 dashboard tests, backend syntax/reminder checks, and the optimized dashboard production build. A local browser check confirmed the protected Reminder Logs route redirects to secure login. These results do not prove deployed MongoDB aggregation, authenticated desktop/mobile rendering, or provider/customer receipt.

Cancellation/return and extension replacement are covered by automated lifecycle and cleanup tests. Repeat their manual production smoke tests after changes to rental lifecycle, reminder scheduling, cron configuration, or provider configuration.

## Task 28 Evidence Log

Record each live check separately with the plan/rental code, scheduled IST time, email provider result, actual inbox receipt, WhatsApp preparation/manual confirmation result, cancellation outcome, and duplicate-attempt count. An HTTP 200 cron response proves only that processing ran; it does not prove provider acceptance or customer receipt.

At implementation time, automated checks passed with 139 backend tests, 43 dashboard tests, backend syntax checks, and an optimized dashboard production build. The approved recipient is recorded above. Live delivery evidence must be added only after the new backend and dashboard commits are deployed and the admin creates the controlled test records.

Deployment readiness recorded on 24 October 2026:

- Backend commit `3b0de02` was pushed to `main`; Render returned HTTP 200 from `/api/health`.
- Dashboard commit `cd5a6c8` was pushed to `main`; Netlify served the verified `main.d2de43ed.js` production bundle.
- `GET /api/reminders/plans` without a JWT returned HTTP 401, confirming the deployed reminder API remains protected.
- The customer website repository was not changed or deployed.

Live message checks remain pending an authenticated admin session. In the deployed dashboard, use Deepak Mishra and create: (1) a rental confirmation, (2) a custom rental plan with practical near-future offsets, and (3) a standalone custom plan. For every case, record the plan/rental code and confirm actual inbox receipt, WhatsApp readiness/manual sharing, cancellation where applicable, and absence of duplicates. No admin password or JWT was requested, stored, or placed in source control.

For Tasks 29-35, also verify the three-workspace sidebar, both tabs in each workspace, desktop/mobile layout, refresh/back/forward behavior, legacy redirects, rental/custom log separation, and links between creation, management, and logs. The local browser reached the login guard, but authenticated visual inspection was not claimed because no credentials or dedicated authenticated fixture were supplied.

## Failure Triage

- `not_selected` on a selected channel: inspect occurrence creation/upsert initialization.
- Brevo HTTP 401 mentioning an unrecognized IP: update Brevo Authorized IPs with all current Render outbound ranges.
- Email `uncertain`: inspect Brevo before any manual retry.
- Cron HTTP 401: verify the same secret is configured in Render and the cron Authorization header.
- `scheduled: 0`: valid when no eligible email is due within ten minutes.
- WhatsApp does not open: verify the customer snapshot contains a valid India mobile number or an international number with country code.
