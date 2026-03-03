# VELVET Events — Production Setup Guide

> **Stack:** Next.js 14 + Tailwind CSS · Supabase (Postgres) · Stripe · Twilio · SendGrid · Vercel

---

## Folder Structure

```
velvet-events/
├── index.html              ← Standalone landing page (no build required)
├── api/
│   └── index.js            ← Express / Vercel serverless API
├── schema.sql              ← Supabase / Postgres migration
├── README.md
└── .env.example            ← Copy to .env.local
```

---

## 1. Prerequisites

- Node.js ≥ 18
- [Supabase](https://supabase.com) project (free tier works)
- [Stripe](https://stripe.com) account
- [Twilio](https://twilio.com) account (SMS OTP)
- [SendGrid](https://sendgrid.com) account (transactional email)
- [Vercel](https://vercel.com) account (deployment)
- [reCAPTCHA v3](https://www.google.com/recaptcha) site/secret keys

---

## 2. Environment Variables

Create `.env.local` (never commit this):

```env
# Supabase
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR...   # service_role key (NOT anon key)
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...               # anon key (for client-side)

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...

# Twilio (SMS OTP)
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+12015551234

# SendGrid (email)
SENDGRID_API_KEY=SG...
SENDGRID_FROM_EMAIL=noreply@velvet.events

# reCAPTCHA v3
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=6L...
RECAPTCHA_SECRET=6L...

# HubSpot CRM (optional)
HUBSPOT_ACCESS_TOKEN=pat-...

# Security
CRON_SECRET=your_very_long_random_secret_here
ALLOWED_ORIGINS=https://velvet.events,https://www.velvet.events

# Analytics (optional — add to HTML)
NEXT_PUBLIC_GA4_ID=G-XXXXXXXXXX
NEXT_PUBLIC_FB_PIXEL_ID=XXXXXXXXXXXXXXXX
NEXT_PUBLIC_TIKTOK_PIXEL_ID=XXXXXXXXXXXXXXXXXX
```

---

## 3. Database Setup (Supabase)

1. Go to **Supabase → SQL Editor**
2. Paste and run `schema.sql`
3. Verify tables: `events`, `applications`, `otp_tokens`, `testimonials`, `analytics_events`
4. For production: enable **Supabase Vault** for encrypting `contact_value` column

```sql
-- Enable Vault (production only)
select vault.create_secret('velvet_contact_key');
-- Then update application inserts to use vault.encrypt()
```

---

## 4. Install Dependencies

```bash
npm install express cors express-rate-limit @supabase/supabase-js stripe @sendgrid/mail twilio axios bcryptjs
```

For Next.js project:
```bash
npx create-next-app@latest velvet-events --typescript --tailwind --app
cd velvet-events
npm install @supabase/supabase-js stripe twilio @sendgrid/mail bcryptjs
```

---

## 5. Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod

# Set environment variables via CLI
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_KEY production
# ... repeat for all env vars
```

Or go to **Vercel Dashboard → Settings → Environment Variables** and paste them in bulk.

---

## 6. Connect Stripe Webhook

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Listen locally (dev)
stripe listen --forward-to localhost:3001/api/webhook/stripe

# Set webhook in production
# Go to Stripe Dashboard → Webhooks → Add Endpoint
# URL: https://your-domain.com/api/webhook/stripe
# Events to listen: payment_intent.succeeded, payment_intent.payment_failed
```

Copy the webhook signing secret to `STRIPE_WEBHOOK_SECRET`.

---

## 7. Test OTP Flow (curl)

### Step 1: Apply
```bash
curl -X POST https://your-domain.com/api/apply \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Riya",
    "lastName": "M",
    "phoneEmail": "+919876543210",
    "consent": true,
    "eventId": "your-event-uuid",
    "recaptchaToken": "test_token",
    "utmSource": "instagram",
    "utmMedium": "story"
  }'

# Response:
# { "success": true, "applicationId": "uuid", "message": "Code sent to +919•••••" }
```

### Step 2: Verify OTP
```bash
curl -X POST https://your-domain.com/api/verify \
  -H "Content-Type: application/json" \
  -d '{
    "applicationId": "uuid-from-step1",
    "otp": "123456"
  }'

# Response:
# { "success": true, "message": "Booking confirmed!", "applicationId": "uuid" }
```

### Get Events
```bash
curl https://your-domain.com/api/events
```

---

## 8. Instagram Deep Linking

### Linktree / Link-in-Bio Setup
Add these links to your Linktree or similar:

| Label | URL |
|---|---|
| 🥂 Reserve VIP | `https://velvet.events/?utm_source=instagram&utm_medium=bio` |
| 👩 Ladies Night | `https://velvet.events/?utm_source=instagram&utm_medium=bio&offer=ladiesfree` |
| 📅 All Events | `https://velvet.events/events?utm_source=instagram&utm_medium=bio` |

### Story Swipe-Up / Link Sticker
```
https://velvet.events/?utm_source=instagram&utm_medium=story&utm_campaign=sat_apr5
```

### Pre-fill Form via URL
```
https://velvet.events/?email=user@email.com&name=Riya&utm_source=email_campaign
```
The form will auto-populate name and email fields — one-tap apply for warm leads.

### Instagram DM Rapid Reply
Save this as an Instagram Quick Reply:
```
Hey! 👋 Thanks for your interest in VELVET.

Reserve your spot in 60 seconds:
👉 velvet.events

What to expect:
✓ VIP entry — skip the queue
✓ Optional table service
✓ Safe, female-friendly environment
✓ Instant SMS confirmation

Questions? Reply here. See you Saturday! 🥂
```

---

## 9. Analytics Setup

Add to `<head>` in HTML/Next.js layout:

```html
<!-- Google Analytics 4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>

<!-- Meta (Facebook) Pixel -->
<script>
!function(f,b,e,v,n,t,s){...}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', 'PIXEL_ID');
fbq('track', 'PageView');
</script>

<!-- TikTok Pixel -->
<script src="https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=PIXEL_ID"></script>
```

### Key Conversion Events to Track
| Event | Trigger | KPI |
|---|---|---|
| `apply_start` | User opens form | Traffic → Intent rate |
| `verify_complete` | OTP verified | Verify rate (target: >70%) |
| `payment_success` | Stripe webhook | Payment rate (target: >30% of confirmed) |

---

## 10. A/B Test Plan

### Variant A: Dark Hero (default — current)
- Background: `#1E0B2C`
- CTA: "Reserve VIP · 1 min"

### Variant B: Light Hero
- Background: `#F6F9FB`, dark text
- CTA: "Girls Free till 11 — Apply"

### Variant C: Urgency CTA
- Same dark hero
- CTA: "⚡ Only 12 Spots Left — Reserve Now"

**Implementation:** Use a URL param `?variant=b` to swap CSS class. Track `apply_start` events per variant in GA4.

### KPI Thresholds
| KPI | Green | Yellow (iterate) | Red (pause) |
|---|---|---|---|
| Apply rate | >8% | 4–8% | <4% |
| Verify rate | >72% | 55–72% | <55% |
| Payment rate | >35% | 20–35% | <20% |
| Bounce rate | <45% | 45–65% | >65% |

---

## 11. Dev Checklist

- [ ] Create Next.js project + install Tailwind
- [ ] Run `schema.sql` on Supabase
- [ ] Set all environment variables in Vercel
- [ ] Configure Twilio number + SendGrid sender authentication
- [ ] Add reCAPTCHA v3 keys to `.env` and HTML
- [ ] Connect Stripe webhook → `POST /api/webhook/stripe`
- [ ] Add GA4 + Facebook + TikTok pixels to `<head>`
- [ ] Add UTM capture logic to form
- [ ] Set up Supabase Vault for contact encryption (production)
- [ ] Test full flow: Instagram → Apply → OTP → Confirm → Payment
- [ ] Lighthouse mobile score >90 (run: `npx lighthouse https://yoururl.com --preset mobile`)
- [ ] WCAG AA contrast audit (Chrome DevTools → Lighthouse → Accessibility)
- [ ] Configure cookie consent banner
- [ ] Add privacy policy + terms pages
- [ ] Set up 24h reminder cron (Supabase Edge Function or Vercel Cron)
- [ ] Launch and A/B test hero variants; review KPIs weekly

---

## 12. Instagram Copy — Ready to Paste

### Story
```
🥂 Skip The Queue.
Girls Free till 11PM.

Tap the link to reserve your spot — takes 60 seconds.
Limited. First come, first served.

👇 SWIPE UP
```

### Link-in-Bio Description
```
✦ VELVET — Mumbai's Most Exclusive Nights
VIP access · Guest list · Table service
Reserve in 60 seconds ↓
```

### Ad Copy (sponsored)
```
Still waiting in line? 😅

VELVET guests skip the queue.
Reserve your VIP spot now — it's free to apply.

⚡ Limited spots per night
👩 Female-friendly guarantee
💳 No payment until you decide

RSVP below 👇
```

---

## Security Checklist

- [ ] HTTPS enforced (Vercel does this automatically)
- [ ] TLS 1.3 (Vercel default)
- [ ] Sensitive fields hashed with bcrypt (not stored in plain text)
- [ ] Contact value encrypted at rest (Supabase Vault)
- [ ] No full payment details stored (Stripe handles PCI compliance)
- [ ] OTP expires after 10 minutes
- [ ] Rate limiting on `/api/apply` (5 req / 15 min per IP)
- [ ] Honeypot field in form (catches bots)
- [ ] reCAPTCHA v3 score ≥ 0.5 required
- [ ] Disposable email detection via debounce.io
- [ ] CORS limited to allowed origins
- [ ] CSP headers configured in `vercel.json`
- [ ] Data retention: purge after 90 days (Supabase pg_cron)
