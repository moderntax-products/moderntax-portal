# ModernTax Scale Assessment & Roadmap
**Date:** April 2, 2026
**Target Baseline:** 6,803 entity requests (not including monitoring, reorders, failed re-sends)

---

## 1. Features Shipped Today (April 2, 2026)

### Confirmed Deployed Commits

| Commit | Feature | Status |
|--------|---------|--------|
| `bf30625` | **Entity Transcript add-on ($19.99)** for processor intake — Manual Entry, PDF Upload, CSV Upload with preview + manager notification | Deployed |
| `d003eb9` | **Entity Transcript, 941 payroll, and supplemental transcript support** — bookmarklet v6.1 parsing, batch upload matching, webhook delivery categorization | Deployed |
| `b3c6cd2` | **Multi-designee support** and batch resend for Clearfirm 8821s — Parker + Holmes split | Deployed |
| `ba7b7c2` | Clearfirm 8821 cron schedule fix (Hobby plan daily limit) | Deployed |
| `f9d6623` | Clearfirm 8821 Bot with automated cron processing and admin tools | Deployed |
| `2c61fcf` | Compliance alerts on admin dashboard and request detail page | Deployed |
| `9fc76dd` | Transcript monitoring subscriptions (MOD-155) | Deployed |
| `74f169a` | Auto fax-back 8821 email when IRS rejects digital signature | Deployed |

### Today's Specific Additions
- **CSV Upload**: Required field validation for `first name`, `last name`, `address`, `city`, `state`, `zip_code` — previously listed as optional but needed for 8821 forms
- **CSV Preview**: Now shows Signer and Address columns with red validation warnings; submit blocked until all fields present
- **Column Reference**: Updated to reflect all required fields
- **Manager Notification**: Emails managers when processors order Entity Transcript add-on (all 3 intake methods)

---

## 2. Current Architecture Snapshot

### Clients
| Client | Intake | API | Webhook | Entities (est.) |
|--------|--------|-----|---------|-----------------|
| Centerstone SBA Lending | CSV, Manual | No | No | ~50 |
| TMC Financing | PDF, Manual | No | No | ~30 |
| Clearfirm | CSV, PDF, Manual, API | Yes | Yes | ~8 |
| **TOTAL** | | | | **~88** |

### Expert Network
- Unknown size (no expert count in code), but load-balancing assigns to expert with fewest active assignments
- 24-hour SLA deadline per assignment
- Single daily auto-assign cron (9 AM UTC)

### Infrastructure
- **Hosting:** Vercel Hobby Plan (daily cron only)
- **Database:** Supabase (PostgreSQL)
- **Email:** SendGrid
- **Signatures:** Dropbox Sign (test mode)
- **Storage:** Supabase Storage (uploads bucket)
- **Queue:** None (cron-only)
- **Monitoring:** None (console.log only)
- **SMS/Phone:** None
- **AI Agents:** None

---

## 3. Scale Gap Analysis: 88 Entities -> 6,803 Entities

### 3.1 The Math

**At 6,803 entity baseline:**
- ~6,803 8821 signature requests per cycle
- ~6,803 expert assignments per cycle
- ~6,803 transcript retrievals per cycle
- ~20,000+ emails per cycle (assignment + SLA warning + completion + nudge)
- ~6,803 webhook deliveries (API clients)
- Plus monitoring re-pulls, reorders, failures = estimated **~10,000 total entity events/cycle**

**Current system was built for ~88 entities.** That's a **77x scale increase.**

### 3.2 Critical Bottlenecks by Category

---

## BOTTLENECK #1: Expert Assignment & Load Balancing (CRITICAL)

**Current State:**
- `auto-assign-experts` runs **once per day** at 9 AM UTC
- Load balancing counts active assignments per expert with individual queries (O(n) queries for n experts)
- Experts get email notification only, no SMS/push/in-app

**At 6,803 entities:**
- If expert network is 50 experts: each gets ~136 entities/day
- If expert network is 200 experts: each gets ~34 entities/day
- Single daily cron means entities wait up to 24 hours before assignment
- N+1 query pattern: 200 experts = 201 database queries per cron run

**Fix Required:**
- [ ] Replace O(n) expert count queries with single `GROUP BY expert_id` query
- [ ] Move from daily cron to **event-driven assignment** (assign on 8821_signed status change)
- [ ] Add SMS/push notification for new assignments (Twilio)
- [ ] Implement capacity limits per expert (max_active_assignments field)
- [ ] Add expertise matching (form_type specialization, state jurisdiction)
- [ ] Batch assignment notification (1 email per expert per batch, not per entity)

---

## BOTTLENECK #2: Expert Workflow is 90% Manual (CRITICAL)

**Current Expert Steps (per entity):**
1. Receive email notification
2. Log into portal
3. Open expert dashboard
4. Download signed 8821 PDF
5. **Log into IRS e-Services manually**
6. **Navigate to Transcript Delivery System**
7. **Enter taxpayer TIN manually**
8. **Select form type manually**
9. **Select tax years manually**
10. **Wait for IRS system to process** (2-30 min hold times)
11. **Download transcript from IRS**
12. Run bookmarklet or manually upload transcript
13. Mark assignment complete

**Steps 5-11 are entirely manual and represent ~85% of expert time.**

**At 6,803 entities:** An expert handling 34 entities/day at ~15 min each = 8.5 hours of pure IRS interaction. No capacity for issues, re-pulls, or calls.

**Fix Required (Phased):**
- [ ] **Phase 1 - Twilio IRS Call Integration:** Experts initiate IRS calls from portal, system records wait times, call duration, outcomes
- [ ] **Phase 2 - Twilio IRS Fax Integration:** Automated 8821 fax submission to IRS, receive fax confirmations
- [ ] **Phase 3 - ElevenLabs/Bland AI Agents:** AI agents navigate IRS phone trees, authenticate with CAF/PTIN, request transcripts verbally, handle hold times
- [ ] **Phase 4 - Full Automation:** Human experts only handle exceptions (rejected 8821s, compliance issues, transcript discrepancies)

---

## BOTTLENECK #3: Unbounded Database Queries (CRITICAL)

**Failing Queries at Scale:**

| Cron Job | Query | Current | At 6,803 |
|----------|-------|---------|----------|
| `auto-complete-requests` | `SELECT * FROM requests WHERE status != 'completed'` | ~30 rows | ~5,000+ rows loaded into memory |
| `8821-reminder` | `SELECT * FROM request_entities WHERE status = '8821_sent'` | ~10 rows | ~3,000+ rows |
| `auto-assign-experts` | N+1 count per expert | ~5 queries | ~200+ queries |
| `auto-sync-8821` | Poll Dropbox Sign + N+1 entity lookup | ~10 API calls | ~6,800 API calls |
| `nudge` | Full request history per processor | ~50 rows | ~50,000+ rows |

**Fix Required:**
- [ ] Add `LIMIT` + cursor pagination to all cron queries
- [ ] Replace N+1 patterns with `GROUP BY` aggregations
- [ ] Add composite indexes: `(status, created_at)`, `(expert_id, status)`, `(request_id, status)`
- [ ] Create materialized views for dashboard aggregations
- [ ] Add database connection pooling (PgBouncer or Supabase pooler)

---

## BOTTLENECK #4: Email-Only Notification System (HIGH)

**Current:** SendGrid email is the only notification channel.

**Problems at Scale:**
- SendGrid free tier: 100 emails/day. Even paid tiers cap at ~100K/month.
- At 6,803 entities: assignment emails + SLA warnings + completions + nudges = **~20,000+ emails/cycle**
- Experts miss time-sensitive assignments because emails go to spam/promotions
- No read receipt — system doesn't know if expert saw the assignment
- No escalation path when expert doesn't respond

**Fix Required:**
- [ ] **Twilio SMS** for urgent notifications (new assignment, SLA warning at 2hr)
- [ ] **In-app notification center** with real-time updates (Supabase Realtime)
- [ ] **Push notifications** via web push API for experts on mobile
- [ ] **Notification digest** — batch multiple assignments into single notification
- [ ] **Read/acknowledge tracking** — expert must acknowledge assignment within 1 hour or it auto-reassigns
- [ ] **Escalation chain** — Email -> SMS (15 min) -> Phone call (30 min) -> Auto-reassign (60 min)

---

## BOTTLENECK #5: Cron-Only Architecture, No Job Queue (HIGH)

**Current:** 13 Vercel cron jobs, all daily, no retry on failure, no priority.

**Problems at Scale:**
- Daily crons mean 24-hour latency for every workflow step
- Failed crons are silent — no alerting, no retry
- No priority queue — urgent Clearfirm API requests wait same as batch CSV uploads
- Vercel Hobby plan limits to daily frequency only
- No job visibility or metrics

**Fix Required:**
- [ ] **Upgrade to Vercel Pro** ($20/mo) for sub-daily cron schedules
- [ ] Add **Inngest** or **Trigger.dev** for event-driven job processing
- [ ] Implement priority queues: `urgent` (API), `standard` (CSV/PDF), `background` (monitoring)
- [ ] Add job metrics: execution time, success/failure rate, queue depth
- [ ] Implement dead letter queue for permanently failed jobs
- [ ] Add health check endpoint (`/api/health`) with cron status

---

## BOTTLENECK #6: No IRS Integration (HIGH)

**Current:** Experts manually log into IRS e-Services, enter data, wait on hold, download transcripts.

**No programmatic IRS interaction exists in the codebase.**

**Twilio Integration Plan:**

### Phase 1: IRS Call Tracking (Expert-Initiated)
```
Expert clicks "Call IRS" in portal
  -> Twilio creates outbound call to IRS (1-800-908-9946)
  -> Call connected to expert's phone via Twilio conference
  -> System records: start time, hold time, talk time, outcome
  -> Expert logs call result in portal
  -> Metrics: avg wait time, success rate, calls per entity
```

**New tables:**
- `irs_calls` (id, entity_id, expert_id, call_sid, status, started_at, connected_at, ended_at, hold_duration_seconds, outcome, recording_url, notes)
- `irs_faxes` (id, entity_id, fax_sid, direction, status, pages, sent_at, delivered_at, document_url)

### Phase 2: Automated Fax Submission
```
Entity reaches '8821_signed' status
  -> System auto-faxes signed 8821 to IRS via Twilio Fax
  -> Fax confirmation stored in irs_faxes table
  -> Status updates to '8821_faxed'
  -> Confirmation webhook from Twilio updates delivery status
```

### Phase 3: AI Voice Agents (ElevenLabs/Bland)
```
Entity reaches 'irs_queue' status
  -> AI agent initiates IRS call via Bland.ai
  -> Agent navigates IRS phone tree (press 1, press 3, etc.)
  -> Agent authenticates with CAF number + PTIN
  -> Agent requests transcript for TIN + form type + years
  -> Agent handles hold music (average 20-45 min)
  -> Agent speaks to IRS representative
  -> Call recording + transcript stored
  -> Expert reviews AI-retrieved transcript for accuracy
  -> Expert only handles exceptions/issues
```

**Expert role transforms from "IRS caller" to "quality reviewer":**
- Review AI-retrieved transcripts for accuracy
- Handle flagged issues and exceptions
- Resolve compliance alerts
- Manage entity transcript filing requirement mismatches

---

## BOTTLENECK #7: Processor Onboarding Friction (MEDIUM)

**Current Pain Points:**
- CSV upload validation was incomplete (missing required fields — fixed today)
- No template auto-fill from previous submissions
- No saved entity templates for repeat borrowers
- Email intake requires admin mediation
- No batch status tracking for processors
- No real-time progress updates

**Fix Required:**
- [ ] **Entity template library** — save and reuse entity profiles
- [ ] **Smart CSV validation** — auto-detect column mappings, suggest corrections
- [ ] **Real-time progress tracker** — WebSocket updates as entities move through pipeline
- [ ] **Processor self-service** — remove admin dependency for email intake
- [ ] **Bulk re-order** — one-click reorder for previously completed entities
- [ ] **API-first intake** — all clients get API access, not just Clearfirm

---

## BOTTLENECK #8: Admin Manual Work (MEDIUM)

**Current Admin Manual Tasks:**
1. Monitor stuck entities via email alerts (no dashboard auto-refresh)
2. Manually reassign entities one at a time (no bulk operations)
3. Manually review expert performance (query-based, no real-time dashboard)
4. Manually create/manage expert accounts
5. Manually trigger batch resends when issues arise
6. Monitor Dropbox Sign for stuck signatures
7. Check webhook delivery status via logs only
8. Generate invoices via monthly cron (no adjustment UI)

**Fix Required:**
- [ ] **Bulk entity operations** — select multiple entities, reassign/cancel/retry in batch
- [ ] **Auto-escalation rules** — stuck entities auto-reassign after configurable timeout
- [ ] **Expert management dashboard** — onboard, credential, capacity, performance in one view
- [ ] **Webhook delivery dashboard** — real-time status, retry buttons, failure analysis
- [ ] **Invoice adjustment UI** — edit line items, apply credits, preview before send
- [ ] **Operational dashboard** — real-time pipeline view with entity counts per status

---

## 4. Infrastructure Upgrade Path

### Immediate (Week 1-2)
| Action | Cost | Impact |
|--------|------|--------|
| Upgrade Vercel to Pro | $20/mo | Sub-daily crons (every 5-15 min) |
| Add Supabase Pro pooling | Included | Connection pooling for concurrent queries |
| Fix unbounded queries (pagination + GROUP BY) | $0 | Prevents OOM crashes at scale |
| Add `/api/health` endpoint | $0 | Cron failure detection |
| Batch expert notification emails | $0 | 10x fewer emails sent |

### Short-term (Week 3-6)
| Action | Cost | Impact |
|--------|------|--------|
| Twilio account + IRS call tracking | ~$500/mo | Call metrics, hold time tracking |
| Twilio Fax for automated 8821 submission | ~$200/mo | Eliminate manual fax step |
| Inngest for event-driven job processing | $0-250/mo | Real-time assignment, priority queues |
| SendGrid Pro upgrade | ~$90/mo | 100K emails/mo capacity |
| In-app notification center (Supabase Realtime) | $0 | Real-time updates without email |

### Medium-term (Week 7-12)
| Action | Cost | Impact |
|--------|------|--------|
| Twilio SMS notifications for experts | ~$300/mo | Assignment acknowledgment, SLA alerts |
| Bland.ai for IRS AI voice agents | ~$2,000/mo | Automate 80% of IRS calls |
| ElevenLabs for custom IRS phone scripts | ~$500/mo | Natural-sounding AI agent voices |
| Expert acknowledgment + auto-reassign | $0 | Zero-touch assignment management |
| Bulk admin operations | $0 | 10x admin efficiency |

### Long-term (Week 13-24)
| Action | Cost | Impact |
|--------|------|--------|
| Full AI agent IRS automation | Variable | Experts become reviewers, not callers |
| Multi-region deployment | ~$100/mo | Redundancy and latency |
| Data warehouse + analytics | ~$200/mo | Business intelligence, forecasting |
| White-label portal for clients | $0 | Self-service client onboarding |
| Mobile app for experts | $0 | Field accessibility |

---

## 5. Expert Nudging Enhancement Plan

### Current Nudging (Weak)
- Weekly email summary to processors (actually runs daily — misnamed)
- SLA warning email 4 hours before deadline
- Stuck entity alert to admins (not experts)
- **No SMS, no push, no escalation, no acknowledgment tracking**

### Proposed Nudging System (Strong)

```
Assignment Created
  ├── T+0: Email + SMS + In-App notification to expert
  ├── T+15min: If not acknowledged → SMS reminder
  ├── T+30min: If not acknowledged → Phone call via Twilio
  ├── T+60min: If not acknowledged → Auto-reassign to next expert
  │
  ├── T+12hr: Progress check (if still 'assigned', not 'in_progress')
  │   └── SMS: "You have 12 hours left on [Entity Name]"
  │
  ├── T+20hr: SLA warning
  │   └── SMS + Email: "4 hours remaining on [Entity Name]"
  │
  ├── T+24hr: SLA deadline
  │   ├── If not complete → Mark SLA missed
  │   ├── Auto-reassign if expert inactive
  │   └── Alert admin dashboard
  │
  └── Completion
      ├── Log SLA met/missed
      ├── Update expert performance score
      └── Trigger webhook for API clients
```

### New Database Tables for Nudging

```sql
CREATE TABLE expert_nudges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID REFERENCES expert_assignments(id),
  expert_id UUID REFERENCES profiles(id),
  channel TEXT CHECK (channel IN ('email', 'sms', 'phone', 'in_app')),
  nudge_type TEXT CHECK (nudge_type IN ('assignment', 'reminder', 'sla_warning', 'escalation')),
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  delivered BOOLEAN DEFAULT false,
  delivery_sid TEXT -- Twilio message/call SID
);

CREATE TABLE expert_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID REFERENCES expert_assignments(id),
  expert_id UUID REFERENCES profiles(id),
  acknowledged_at TIMESTAMPTZ DEFAULT NOW(),
  channel TEXT CHECK (channel IN ('portal', 'sms_reply', 'phone'))
);
```

---

## 6. Twilio + AI Agent Architecture

### System Flow at Scale

```
                    ┌─────────────────────────────────┐
                    │     ModernTax Portal             │
                    │  6,803+ entities/cycle           │
                    └──────────┬──────────────────────┘
                               │
                    ┌──────────▼──────────────────────┐
                    │     Job Queue (Inngest)          │
                    │  Priority: urgent > standard     │
                    └──────────┬──────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼───────┐ ┌─────▼──────┐ ┌──────▼───────┐
     │  8821 Fax Bot  │ │ IRS Call   │ │  Transcript  │
     │  (Twilio Fax)  │ │ AI Agent   │ │  Upload Bot  │
     │                │ │ (Bland.ai) │ │ (Bookmarklet)│
     └────────┬───────┘ └─────┬──────┘ └──────┬───────┘
              │               │                │
              │      ┌────────▼────────┐       │
              │      │   IRS Systems   │       │
              │      │ e-Services/Phone│       │
              │      └────────┬────────┘       │
              │               │                │
              └───────────────┼────────────────┘
                              │
                    ┌─────────▼──────────────────────┐
                    │   Expert Review Queue           │
                    │   (Humans handle exceptions     │
                    │    only — 15-20% of volume)     │
                    └────────────────────────────────┘
```

### Expert Role Transformation

| Task | Today (Manual) | Tomorrow (AI-Assisted) | Expert Focus |
|------|---------------|----------------------|--------------|
| IRS Phone Calls | Expert dials, waits 20-45 min | Bland.ai agent calls, waits, authenticates | Review call transcripts |
| 8821 Fax Submission | Expert/signer prints, faxes | Twilio auto-fax on signature | Monitor fax confirmations |
| Transcript Retrieval | Expert navigates IRS website | AI agent requests verbally or via e-Services API | Verify transcript accuracy |
| Issue Resolution | Expert handles everything | AI triages, expert handles edge cases | Focus on complex issues |
| **Time per entity** | **~15 min** | **~2 min (review only)** | **7.5x throughput increase** |

### Capacity Planning

| Metric | Current | With AI Agents | Notes |
|--------|---------|---------------|-------|
| Entities/expert/day | ~34 | ~250+ | Review-only workflow |
| Experts needed for 6,803 | ~200 | ~28 | 7.5x efficiency gain |
| IRS call wait time (human cost) | 20-45 min/entity | $0 (AI waits) | AI agents don't have labor cost for hold time |
| 8821 fax turnaround | 1-3 days (signer) | <1 hour (automated) | Twilio Fax API |
| Assignment-to-completion | 24 hours (SLA) | 2-4 hours | Event-driven + AI |

---

## 7. Database Migration for Scale

```sql
-- Scale indexes for 6,803+ entities
CREATE INDEX CONCURRENTLY idx_request_entities_status_created
  ON request_entities(status, created_at);
CREATE INDEX CONCURRENTLY idx_request_entities_request_status
  ON request_entities(request_id, status);
CREATE INDEX CONCURRENTLY idx_requests_status_created
  ON requests(status, created_at);
CREATE INDEX CONCURRENTLY idx_expert_assignments_expert_status
  ON expert_assignments(expert_id, status);

-- IRS Call Tracking
CREATE TABLE irs_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES request_entities(id),
  expert_id UUID REFERENCES profiles(id),
  agent_type TEXT CHECK (agent_type IN ('human', 'ai_bland', 'ai_elevenlabs')),
  call_sid TEXT, -- Twilio Call SID
  irs_number TEXT DEFAULT '+18009089946',
  status TEXT CHECK (status IN ('initiated', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  connected_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  hold_duration_seconds INTEGER,
  talk_duration_seconds INTEGER,
  outcome TEXT CHECK (outcome IN ('transcript_obtained', 'auth_failed', 'system_down', 'no_record', 'callback_required', 'other')),
  recording_url TEXT,
  call_transcript TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_irs_calls_entity ON irs_calls(entity_id);
CREATE INDEX idx_irs_calls_expert ON irs_calls(expert_id);
CREATE INDEX idx_irs_calls_status ON irs_calls(status);

-- IRS Fax Tracking
CREATE TABLE irs_faxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES request_entities(id),
  fax_sid TEXT, -- Twilio Fax SID
  direction TEXT CHECK (direction IN ('outbound', 'inbound')),
  to_number TEXT,
  from_number TEXT,
  status TEXT CHECK (status IN ('queued', 'sending', 'delivered', 'failed', 'receiving', 'received')),
  pages INTEGER,
  document_url TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_irs_faxes_entity ON irs_faxes(entity_id);
CREATE INDEX idx_irs_faxes_status ON irs_faxes(status);

-- Expert Nudge Tracking
CREATE TABLE expert_nudges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID REFERENCES expert_assignments(id),
  expert_id UUID REFERENCES profiles(id),
  channel TEXT CHECK (channel IN ('email', 'sms', 'phone', 'in_app')),
  nudge_type TEXT CHECK (nudge_type IN ('assignment', 'reminder', 'sla_warning', 'escalation', 'auto_reassign')),
  message_sid TEXT, -- Twilio SMS/Call SID
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_nudges_assignment ON expert_nudges(assignment_id);
CREATE INDEX idx_nudges_expert ON expert_nudges(expert_id);

-- Expert capacity and specialization
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS max_active_assignments INTEGER DEFAULT 50;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS specializations TEXT[] DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS twilio_phone TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS availability_status TEXT DEFAULT 'available'
  CHECK (availability_status IN ('available', 'busy', 'offline', 'vacation'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS performance_score NUMERIC(5,2) DEFAULT 100.00;
```

---

## 8. Priority Execution Order

### Sprint 1 (This Week): Foundation Fixes
1. Fix unbounded queries with pagination + GROUP BY
2. Add scale indexes (concurrent, no downtime)
3. Upgrade Vercel to Pro for sub-daily crons
4. Batch expert notification emails (digest mode)
5. Add `/api/health` endpoint

### Sprint 2 (Next Week): Expert Nudging
1. Twilio account setup + SMS integration
2. Expert assignment acknowledgment system
3. Escalation chain (email -> SMS -> auto-reassign)
4. In-app notification center (Supabase Realtime)
5. Expert capacity limits + availability status

### Sprint 3 (Week 3-4): IRS Call Integration
1. Twilio outbound call tracking (expert-initiated)
2. IRS call logging dashboard (wait times, outcomes)
3. Twilio Fax for automated 8821 submission
4. Fax confirmation webhook handling
5. Expert dashboard: call history + fax status

### Sprint 4 (Week 5-6): Event-Driven Architecture
1. Inngest or Trigger.dev integration
2. Replace daily crons with event-driven handlers
3. Priority queue implementation
4. Job metrics dashboard
5. Dead letter queue + retry UI

### Sprint 5 (Week 7-8): AI Voice Agents
1. Bland.ai integration for IRS phone navigation
2. IRS phone tree mapping + script development
3. AI agent CAF/PTIN authentication flow
4. Call recording + transcript storage
5. Expert review queue for AI-retrieved transcripts

### Sprint 6 (Week 9-10): Scale Testing
1. Load test at 6,803 entity baseline
2. Database performance tuning
3. SendGrid volume testing
4. Twilio capacity testing
5. End-to-end latency optimization

### Sprint 7 (Week 11-12): Full AI Automation
1. ElevenLabs custom voice for IRS scripts
2. AI agent handles IRS representative conversation
3. Automated transcript extraction from AI calls
4. Expert role: review-only workflow
5. Auto-retry failed AI calls with human fallback

---

## 9. Cost Projection at 6,803 Entity Scale

| Service | Current | At Scale | Monthly |
|---------|---------|----------|---------|
| Vercel | Hobby ($0) | Pro | $20 |
| Supabase | Free | Pro | $25 |
| SendGrid | Free (100/day) | Pro (100K/mo) | $90 |
| Twilio SMS | N/A | ~5,000 msgs/mo | $50 |
| Twilio Voice | N/A | ~6,800 calls/mo (AI) | $2,000 |
| Twilio Fax | N/A | ~6,800 faxes/mo | $500 |
| Bland.ai | N/A | ~6,800 AI calls/mo | $2,000 |
| Inngest | N/A | Event processing | $250 |
| Dropbox Sign | Test mode | Production | $300 |
| **TOTAL** | **~$0** | | **~$5,235/mo** |

**Revenue at 6,803 entities:** 6,803 x $69.98 avg = **$476,074/cycle**
**Margin:** ~$470K revenue vs ~$5.2K infrastructure = **98.9% gross margin on infrastructure**

(Note: Expert labor cost is the primary expense, which AI agents reduce by 7.5x)

---

## 10. Key Metrics to Track

| Metric | Current | Target | How |
|--------|---------|--------|-----|
| Assignment-to-completion (avg) | ~24 hrs | <4 hrs | Event-driven + AI |
| Expert utilization | Unknown | >85% | Capacity tracking |
| SLA compliance | Unknown | >95% | Nudging + auto-reassign |
| IRS call success rate | Unknown | >90% | Call tracking |
| Avg IRS hold time | Unknown | Tracked | Twilio call logs |
| Transcript accuracy | Unknown | >99% | AI review + human QA |
| Webhook delivery rate | Unknown | >99.5% | Delivery dashboard |
| Entity completion rate | Unknown | >98% | Pipeline metrics |
| Email delivery rate | Unknown | >95% | SendGrid webhook integration |
| System uptime | No monitoring | 99.9% | Health checks + alerts |
