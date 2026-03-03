-- ================================================================
-- VELVET Events — Supabase / Postgres Migration
-- Run in Supabase SQL editor or via psql
-- ================================================================

-- Enable extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ================================================================
-- EVENTS
-- ================================================================
create table if not exists events (
  id              uuid primary key default uuid_generate_v4(),
  name            text not null,
  slug            text unique not null,
  description     text,
  date            timestamptz not null,
  doors_open      text default '10:00 PM',
  venue           text not null,
  city            text default 'Mumbai',
  cover_image_url text,
  gallery_urls    text[],
  capacity        int default 300,
  spots_remaining int default 300,
  price_deposit   int default 0,        -- in INR
  is_sold_out     boolean default false,
  is_published    boolean default false,
  tags            text[],               -- ['Ladies Free', 'Season Opener', etc.]
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ================================================================
-- USERS (staff / admin)
-- ================================================================
create table if not exists users (
  id          uuid primary key default uuid_generate_v4(),
  email       text unique not null,
  name        text,
  role        text default 'viewer',    -- admin | staff | viewer
  created_at  timestamptz default now()
);

-- ================================================================
-- APPLICATIONS
-- ================================================================
create table if not exists applications (
  id                  uuid primary key default uuid_generate_v4(),
  first_name          text not null,
  last_name           text,
  contact_type        text not null check (contact_type in ('phone', 'email')),
  -- NOTE: contact_value should be stored in Supabase Vault (encrypted column)
  -- For demo: storing as-is. In production: use pgcrypto or Vault
  contact_value       text not null,
  contact_hash        text not null,    -- bcrypt hash for deduplication
  event_id            uuid references events(id) on delete set null,
  group_size          int default 1,
  preferences         text,
  status              text default 'pending_otp'
                      check (status in ('pending_otp', 'confirmed', 'cancelled', 'no_show', 'waitlist')),
  consent_given       boolean not null default false,
  consent_timestamp   timestamptz,
  confirmed_at        timestamptz,
  payment_status      text default 'none' check (payment_status in ('none', 'pending', 'paid', 'refunded')),
  payment_intent_id   text,
  payment_amount      int,
  utm_source          text,
  utm_medium          text,
  utm_campaign        text,
  ip_address          inet,
  crm_synced          boolean default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- ================================================================
-- OTP TOKENS
-- ================================================================
create table if not exists otp_tokens (
  id              uuid primary key default uuid_generate_v4(),
  application_id  uuid references applications(id) on delete cascade,
  otp_hash        text not null,         -- bcrypt hash of OTP
  contact         text not null,         -- phone or email (for sending)
  expires_at      timestamptz not null,
  used            boolean default false,
  created_at      timestamptz default now()
);

-- ================================================================
-- TESTIMONIALS
-- ================================================================
create table if not exists testimonials (
  id          uuid primary key default uuid_generate_v4(),
  author_name text not null,
  author_role text,
  author_city text,
  avatar_url  text,
  body        text not null,
  rating      int default 5 check (rating between 1 and 5),
  event_id    uuid references events(id) on delete set null,
  event_tag   text,
  is_featured boolean default false,
  is_approved boolean default false,
  created_at  timestamptz default now()
);

-- ================================================================
-- ANALYTICS EVENTS (server-side)
-- ================================================================
create table if not exists analytics_events (
  id              uuid primary key default uuid_generate_v4(),
  event_name      text not null,         -- apply_start | verify_complete | payment_success
  application_id  uuid references applications(id) on delete set null,
  session_id      text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  meta            jsonb,
  created_at      timestamptz default now()
);

-- ================================================================
-- INDEXES
-- ================================================================
create index if not exists idx_applications_status on applications(status);
create index if not exists idx_applications_event on applications(event_id);
create index if not exists idx_applications_created on applications(created_at desc);
create index if not exists idx_otp_application on otp_tokens(application_id);
create index if not exists idx_events_date on events(date asc);
create index if not exists idx_events_published on events(is_published) where is_published = true;

-- ================================================================
-- ROW LEVEL SECURITY
-- ================================================================
alter table applications enable row level security;
alter table otp_tokens   enable row level security;
alter table events       enable row level security;
alter table testimonials enable row level security;

-- Events: public read for published events
create policy "Public can read published events"
  on events for select using (is_published = true);

-- Applications: only service role can write/read (API uses service key)
create policy "Service role full access on applications"
  on applications for all using (auth.role() = 'service_role');

create policy "Service role full access on otp_tokens"
  on otp_tokens for all using (auth.role() = 'service_role');

-- Testimonials: public read for approved
create policy "Public read approved testimonials"
  on testimonials for select using (is_approved = true);

-- ================================================================
-- UPDATED_AT TRIGGER
-- ================================================================
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger applications_updated_at
  before update on applications
  for each row execute procedure set_updated_at();

create trigger events_updated_at
  before update on events
  for each row execute procedure set_updated_at();

-- ================================================================
-- SAMPLE DATA (dev only — remove before production)
-- ================================================================
insert into events (name, slug, description, date, venue, city, capacity, spots_remaining, price_deposit, is_sold_out, is_published, tags)
values
  ('VELVET Saturdays', 'velvet-saturdays-apr5', 'The definitive Saturday night experience. Live DJs, table service, and curated crowd.', '2025-04-05 22:00:00+05:30', 'The Grand, Lower Parel', 'Mumbai', 300, 12, 2000, false, true, ARRAY['Season Opener', 'VIP Tables']),
  ('Ladies Night Deluxe', 'ladies-night-apr11', 'Girls free before 11PM. Reserved sections, female-friendly staff, premium cocktails.', '2025-04-11 21:00:00+05:30', 'Elevate, Bandra', 'Mumbai', 200, 28, 0, false, true, ARRAY['Girls Free till 11', 'Female-Friendly']),
  ('Birthday Blackout', 'birthday-blackout-apr19', 'An unforgettable evening for birthday celebrations. Complimentary bottle for the birthday person.', '2025-04-19 23:00:00+05:30', 'Playboy Club, Juhu', 'Mumbai', 150, 0, 3000, true, true, ARRAY['Birthday Special', 'Sold Out']);

insert into testimonials (author_name, author_role, author_city, body, rating, event_tag, is_featured, is_approved) values
  ('Riya M.', 'Marketing Lead', 'Delhi', 'Honestly, the easiest club experience I've ever had. One form, one OTP, and we had a table for six ready when we arrived. Zero drama.', 5, 'VELVET Saturdays', true, true),
  ('Priya K. & Group', 'Professionals', 'Bangalore', 'As a group of five women, safety matters to us. VELVET''s female-friendly promise isn''t just a badge — staff actually checked in on us. Will be back every week.', 5, 'Ladies Night', true, true),
  ('Arjun T.', 'Entrepreneur', 'Mumbai', 'I came via an Instagram Story ad, booked in 45 seconds, and walked straight past a 90-min queue. The OTP system is genius. Never going back to other promoters.', 5, 'Season Opening', true, true);
