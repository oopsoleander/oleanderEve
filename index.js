/**
 * VELVET Events — Serverless API
 * Deploy on Vercel (api/ folder) or as Express server.
 * All endpoints: POST /api/apply | POST /api/verify | GET /api/events | POST /api/webhook/crm
 */

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const Stripe     = require('stripe');
const sgMail     = require('@sendgrid/mail');
const twilio     = require('twilio');
const axios      = require('axios');
const bcrypt     = require('bcryptjs');
const crypto     = require('crypto');

const app = express();
app.use(express.json());
app.use(require('cors')({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));

// ================================================================
//  CLIENTS
// ================================================================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ================================================================
//  RATE LIMITERS
// ================================================================
const applyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,
  message: { error: 'Too many applications from this IP. Please try again later.' },
  standardHeaders: true,
});
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: { error: 'Too many OTP attempts. Please wait 10 minutes.' },
});

// ================================================================
//  HELPERS
// ================================================================
const isPhone   = (val) => /^\+?[\d\s\-()]{9,15}$/.test(val);
const isEmail   = (val) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
const isDisposable = async (email) => {
  try {
    const res = await axios.get(`https://disposable.debounce.io/?email=${email}`, { timeout: 2000 });
    return res.data?.disposable === 'true';
  } catch { return false; }
};

async function verifyRecaptcha(token) {
  if (!token) return false;
  const res = await axios.post(
    `https://www.google.com/recaptcha/api/siteverify`,
    null,
    { params: { secret: process.env.RECAPTCHA_SECRET, response: token } }
  );
  return res.data?.score >= 0.5;
}

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

async function sendSMSOTP(phone, otp) {
  return twilioClient.messages.create({
    body: `Your VELVET verification code: ${otp}. Valid for 10 minutes. Do not share this code.`,
    from: process.env.TWILIO_FROM_NUMBER,
    to: phone,
  });
}

async function sendEmailOTP(email, otp, name) {
  return sgMail.send({
    to: email,
    from: { name: 'VELVET Events', email: process.env.SENDGRID_FROM_EMAIL },
    subject: `Your VELVET verification code: ${otp}`,
    html: `
      <div style="font-family:'Helvetica Neue',sans-serif;max-width:480px;margin:0 auto;background:#1E0B2C;padding:40px;border-radius:16px;">
        <h1 style="color:#FFB800;font-size:2rem;margin-bottom:8px;">VELVET</h1>
        <h2 style="color:#F0EBF8;font-weight:300;">Hi ${name},</h2>
        <p style="color:rgba(240,235,248,0.7);">Your one-time verification code is:</p>
        <div style="font-size:3rem;font-weight:700;color:#FFB800;letter-spacing:0.4em;text-align:center;padding:24px;background:rgba(255,184,0,0.08);border-radius:12px;margin:24px 0;">${otp}</div>
        <p style="color:rgba(240,235,248,0.5);font-size:0.85rem;">Valid for 10 minutes. Do not share this code with anyone.</p>
        <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:24px 0;" />
        <p style="color:rgba(240,235,248,0.3);font-size:0.75rem;">VELVET Events · Mumbai · <a href="https://velvet.events/privacy-policy" style="color:#0F6FC7;">Privacy Policy</a></p>
      </div>
    `,
  });
}

async function sendConfirmationEmail(email, name, event) {
  return sgMail.send({
    to: email,
    from: { name: 'VELVET Events', email: process.env.SENDGRID_FROM_EMAIL },
    subject: `✅ You're confirmed for ${event.name}!`,
    html: `
      <div style="font-family:'Helvetica Neue',sans-serif;max-width:480px;margin:0 auto;background:#1E0B2C;padding:40px;border-radius:16px;">
        <h1 style="color:#FFB800;">VELVET</h1>
        <h2 style="color:#F0EBF8;font-weight:300;">You're confirmed, ${name}! 🥂</h2>
        <p style="color:rgba(240,235,248,0.7);">Your spot at <strong style="color:#FFB800;">${event.name}</strong> is locked in.</p>
        <div style="background:rgba(255,184,0,0.08);border:1px solid rgba(255,184,0,0.2);border-radius:12px;padding:20px;margin:24px 0;">
          <p style="color:#F0EBF8;margin:0;"><strong>📅 Date:</strong> ${event.date}</p>
          <p style="color:#F0EBF8;margin:8px 0 0;"><strong>📍 Venue:</strong> ${event.venue}</p>
          <p style="color:#F0EBF8;margin:8px 0 0;"><strong>⏰ Doors:</strong> ${event.doors_open}</p>
        </div>
        <p style="color:rgba(240,235,248,0.7);font-size:0.85rem;">Show this email or your SMS confirmation at the VIP entrance. You'll skip the queue.</p>
        <p style="color:rgba(240,235,248,0.3);font-size:0.75rem;margin-top:32px;">We only use this email to manage your booking. <a href="https://velvet.events/unsubscribe" style="color:#0F6FC7;">Unsubscribe</a> · <a href="https://velvet.events/privacy-policy" style="color:#0F6FC7;">Privacy Policy</a></p>
      </div>
    `,
  });
}

// ================================================================
//  POST /api/apply
//  Validates input, checks honeypot + reCAPTCHA, creates DB entry, sends OTP
// ================================================================
app.post('/api/apply', applyLimiter, async (req, res) => {
  try {
    const {
      firstName, lastName, phoneEmail, consent,
      groupSize, preferences, eventId,
      recaptchaToken, utmSource, utmMedium, utmCampaign,
      _hp_website, // Honeypot
    } = req.body;

    // Honeypot check
    if (_hp_website) {
      return res.status(200).json({ success: true, message: 'Application received.' }); // Silent fail
    }

    // Validate required fields
    if (!firstName?.trim() || !phoneEmail?.trim()) {
      return res.status(400).json({ error: 'First name and contact are required.' });
    }
    if (!consent) {
      return res.status(400).json({ error: 'Consent is required.' });
    }

    // Validate contact type
    const contactIsPhone = isPhone(phoneEmail);
    const contactIsEmail = isEmail(phoneEmail);
    if (!contactIsPhone && !contactIsEmail) {
      return res.status(400).json({ error: 'Please enter a valid phone number or email address.' });
    }

    // Disposable email check
    if (contactIsEmail) {
      const disposable = await isDisposable(phoneEmail);
      if (disposable) {
        return res.status(400).json({ error: 'Please use a non-disposable email address.' });
      }
    }

    // reCAPTCHA v3
    const captchaOk = await verifyRecaptcha(recaptchaToken);
    if (!captchaOk && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Security check failed. Please try again.' });
    }

    // Hash sensitive contact info before storing
    const contactHash = await bcrypt.hash(phoneEmail.toLowerCase().trim(), 10);

    // Create application in Supabase
    const { data: application, error: dbError } = await supabase
      .from('applications')
      .insert({
        first_name: firstName.trim(),
        last_name: lastName?.trim() || '',
        contact_type: contactIsPhone ? 'phone' : 'email',
        contact_value: phoneEmail.trim(), // stored in a vault-encrypted column
        contact_hash: contactHash,
        event_id: eventId || null,
        group_size: parseInt(groupSize) || 1,
        preferences: preferences?.trim() || null,
        consent_given: true,
        consent_timestamp: new Date().toISOString(),
        utm_source: utmSource || null,
        utm_medium: utmMedium || null,
        utm_campaign: utmCampaign || null,
        ip_address: req.ip,
        status: 'pending_otp',
      })
      .select('id')
      .single();

    if (dbError) throw dbError;

    // Generate + store OTP (hashed)
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, 8);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase.from('otp_tokens').insert({
      application_id: application.id,
      otp_hash: otpHash,
      expires_at: otpExpiry,
      contact: phoneEmail.trim(),
    });

    // Send OTP
    if (contactIsPhone) {
      await sendSMSOTP(phoneEmail.trim(), otp);
    } else {
      await sendEmailOTP(phoneEmail.trim(), otp, firstName);
    }

    return res.status(200).json({
      success: true,
      applicationId: application.id,
      message: `Code sent to ${phoneEmail.slice(0, 4)}••••`,
      contactType: contactIsPhone ? 'phone' : 'email',
    });

  } catch (err) {
    console.error('POST /api/apply error:', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

// ================================================================
//  POST /api/verify
//  Verifies OTP, confirms application, sends confirmation email + SMS
// ================================================================
app.post('/api/verify', otpLimiter, async (req, res) => {
  try {
    const { applicationId, otp } = req.body;

    if (!applicationId || !otp || otp.length !== 6) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    // Fetch OTP record
    const { data: otpRecord } = await supabase
      .from('otp_tokens')
      .select('*')
      .eq('application_id', applicationId)
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!otpRecord) {
      return res.status(400).json({ error: 'OTP not found or already used.' });
    }

    if (new Date(otpRecord.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    }

    const valid = await bcrypt.compare(otp.trim(), otpRecord.otp_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    // Mark OTP as used
    await supabase.from('otp_tokens').update({ used: true }).eq('id', otpRecord.id);

    // Confirm application
    const { data: application } = await supabase
      .from('applications')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', applicationId)
      .select('*, events(*)')
      .single();

    // Send confirmation
    const eventData = application.events || { name: 'VELVET Night', date: 'Saturday', venue: 'TBA', doors_open: '10 PM' };
    if (application.contact_type === 'email') {
      await sendConfirmationEmail(otpRecord.contact, application.first_name, eventData);
    } else {
      await twilioClient.messages.create({
        body: `✅ VELVET: You're confirmed, ${application.first_name}! Event: ${eventData.name} on ${eventData.date} at ${eventData.venue}. Show this SMS at VIP entrance. 🥂`,
        from: process.env.TWILIO_FROM_NUMBER,
        to: otpRecord.contact,
      });
    }

    // Push to CRM (async, don't await)
    pushToCRM(application).catch(console.error);

    return res.status(200).json({ success: true, message: 'Booking confirmed!', applicationId });

  } catch (err) {
    console.error('POST /api/verify error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ================================================================
//  GET /api/events
//  Public event list with JSON-LD schema for SEO
// ================================================================
app.get('/api/events', async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('events')
      .select('id, name, date, venue, description, spots_remaining, is_sold_out, cover_image_url, price_deposit, slug')
      .eq('is_published', true)
      .gte('date', new Date().toISOString())
      .order('date', { ascending: true })
      .limit(20);

    if (error) throw error;

    // Generate JSON-LD schema array
    const schema = events.map(ev => ({
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: ev.name,
      startDate: ev.date,
      location: { '@type': 'Place', name: ev.venue },
      organizer: { '@type': 'Organization', name: 'VELVET Events' },
      offers: {
        '@type': 'Offer',
        price: ev.price_deposit || '0',
        priceCurrency: 'INR',
        availability: ev.is_sold_out ? 'SoldOut' : 'LimitedAvailability',
        url: `https://velvet.events/events/${ev.slug}`,
      },
    }));

    res.set('Cache-Control', 'public, max-age=300'); // 5 min cache
    return res.json({ events, schema });

  } catch (err) {
    console.error('GET /api/events error:', err);
    return res.status(500).json({ error: 'Could not fetch events.' });
  }
});

// ================================================================
//  POST /api/webhook/crm
//  Push confirmed applications to HubSpot / Zoho
// ================================================================
async function pushToCRM(application) {
  const payload = {
    properties: {
      firstname: application.first_name,
      lastname: application.last_name,
      phone: application.contact_type === 'phone' ? application.contact_value : '',
      email: application.contact_type === 'email' ? application.contact_value : '',
      velvet_event: application.events?.name || '',
      velvet_group_size: application.group_size,
      velvet_status: application.status,
      velvet_utm_source: application.utm_source,
    },
  };
  await axios.post(
    'https://api.hubapi.com/crm/v3/objects/contacts',
    payload,
    { headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

app.post('/api/webhook/crm', async (req, res) => {
  try {
    const { applicationId } = req.body;
    const { data: application } = await supabase
      .from('applications').select('*, events(*)').eq('id', applicationId).single();
    await pushToCRM(application);
    return res.json({ success: true });
  } catch (err) {
    console.error('CRM webhook error:', err);
    return res.status(500).json({ error: 'CRM sync failed.' });
  }
});

// ================================================================
//  POST /api/payment-link
//  Generate Stripe payment link for VIP table deposit
// ================================================================
app.post('/api/payment-link', async (req, res) => {
  try {
    const { applicationId, eventId, amount, description } = req.body;

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{
        price_data: {
          currency: 'inr',
          product_data: { name: description || 'VIP Table Deposit — VELVET' },
          unit_amount: amount * 100, // in paise
        },
        quantity: 1,
      }],
      metadata: { applicationId, eventId },
      after_completion: { type: 'redirect', redirect: { url: `https://velvet.events/confirmed?app=${applicationId}` } },
      payment_intent_data: { metadata: { applicationId, eventId } },
    });

    return res.json({ url: paymentLink.url });
  } catch (err) {
    console.error('Payment link error:', err);
    return res.status(500).json({ error: 'Could not create payment link.' });
  }
});

// ================================================================
//  POST /api/webhook/stripe
//  Handle payment_intent.succeeded
// ================================================================
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const { applicationId } = pi.metadata;
    if (applicationId) {
      await supabase.from('applications').update({
        payment_status: 'paid',
        payment_intent_id: pi.id,
        payment_amount: pi.amount_received / 100,
      }).eq('id', applicationId);
    }
  }

  res.json({ received: true });
});

// ================================================================
//  POST /api/reminder
//  Send 24h reminder (triggered by cron job / Supabase Edge Function)
// ================================================================
app.post('/api/reminder', async (req, res) => {
  const { secret } = req.headers;
  if (secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const { data: applications } = await supabase
    .from('applications')
    .select('*, events(*)')
    .eq('status', 'confirmed')
    .gte('events.date', tomorrow.toISOString().slice(0, 10))
    .lte('events.date', new Date(tomorrow.getTime() + 24*60*60*1000).toISOString().slice(0, 10));

  for (const app of applications || []) {
    const msg = `⏰ VELVET reminder: ${app.events.name} is TOMORROW at ${app.events.venue}. Doors ${app.events.doors_open}. Show this SMS at VIP entry. See you! 🥂`;
    if (app.contact_type === 'phone') {
      await twilioClient.messages.create({ body: msg, from: process.env.TWILIO_FROM_NUMBER, to: app.contact_value });
    } else {
      // sendgrid reminder email
    }
  }

  return res.json({ sent: applications?.length || 0 });
});

module.exports = app;
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`VELVET API running on :${PORT}`));
}
