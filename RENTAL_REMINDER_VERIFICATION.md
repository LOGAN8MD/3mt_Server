# Rental Reminder Release Verification

This checklist verifies the dashboard and backend rental-reminder workflow without involving the customer website. Use a dedicated test customer and machine for manual production checks.

## Automated Verification

Run before every reminder-related deployment:

```bash
cd 3mt_Server
npm run verify

cd ../3mt_dashboard
npm run verify
```

The backend suite covers billing and settlement, one-machine eligibility, lifecycle reminder creation, selected-channel initialization, bilingual rendering, schedule versioning, retries, atomic email claims, duplicate timer prevention, cancellation cleanup, and inactive-rental eligibility rejection. The dashboard suite covers rental forms and management, reminder channel presentation/manual WhatsApp confirmation, route access, and production build compatibility.

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
- Final automated verification passed 117 backend tests, 26 dashboard tests, backend syntax checks, and the optimized dashboard production build.

Cancellation/return and extension replacement are covered by automated lifecycle and cleanup tests. Repeat their manual production smoke tests after changes to rental lifecycle, reminder scheduling, cron configuration, or provider configuration.

## Failure Triage

- `not_selected` on a selected channel: inspect occurrence creation/upsert initialization.
- Brevo HTTP 401 mentioning an unrecognized IP: update Brevo Authorized IPs with all current Render outbound ranges.
- Email `uncertain`: inspect Brevo before any manual retry.
- Cron HTTP 401: verify the same secret is configured in Render and the cron Authorization header.
- `scheduled: 0`: valid when no eligible email is due within ten minutes.
- WhatsApp does not open: verify the customer snapshot contains a valid India mobile number or an international number with country code.
