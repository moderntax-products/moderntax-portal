# ModernTax Portal - File Structure & Documentation

## Core Configuration Files

### package.json
- Dependencies: Next.js 14, React 18, TypeScript, Tailwind CSS
- Supabase SSR integration (@supabase/supabase-js, @supabase/ssr)
- SendGrid email service (@sendgrid/mail)
- Scripts: dev, build, start, lint

### next.config.js
- Standard Next.js 14 configuration
- React strict mode enabled
- SWC minification for faster builds
- Server component external packages configured

### tsconfig.json
- TypeScript strict mode enabled
- Path alias: @/ = . (root directory)
- ES2020 target with modern JS features
- Proper Next.js App Router configuration

### tailwind.config.ts
- Tailwind CSS 3.4 configuration
- Custom brand colors:
  - mt-green: #00C48C
  - mt-dark: #0A1929
  - mt-navy: #102A43
- Configured for app/ and components/ directories

### postcss.config.js
- PostCSS configuration for Tailwind CSS and Autoprefixer

### .eslintrc.json
- ESLint configuration using Next.js core-web-vitals rules

### vercel.json
- Cron job configuration for daily nudge emails
- Runs daily at 16:00 UTC (9am PT)
- Endpoint: /api/cron/nudge

## Environment Configuration

### .env.example
- Template for production environment variables
- Supabase URL and API keys
- SendGrid API key and from email
- Application base URL
- Admin email for alerts

### .env.local.example
- Development-specific environment overrides
- localhost:3000 for local testing

## Database & Schema

### supabase/schema.sql
**Postgres schema with 5 main tables:**

1. **clients** - Lending partner organizations
   - id (UUID PK)
   - name, slug (unique), domain, logo_url
   - Seed data: Centerstone, TMC Financing, Clearfirm

2. **profiles** - User accounts (extends auth.users)
   - id (UUID FK to auth.users)
   - email, full_name
   - role: processor, manager, admin
   - client_id (FK)
   - Auto-created via trigger on user signup

3. **requests** - IRS verification requests
   - id (UUID PK)
   - client_id, requested_by (FK)
   - account_number
   - status: submitted → 8821_sent → 8821_signed → irs_queue → processing → completed/failed
   - timestamps: created_at, updated_at, completed_at
   - notes field for internal comments
   - Indexes on client_id, requested_by, status

4. **request_entities** - Individual entities per request
   - id (UUID PK)
   - request_id (FK)
   - entity_name, ein, form_type (1040/1065/1120/1120S)
   - years array
   - status, compliance_score (0-100)
   - gross_receipts (JSONB)
   - transcript_urls array
   - completed_at timestamp

5. **notifications** - Email notification log
   - id (UUID PK)
   - user_id, request_id (FKs)
   - type: confirmation, completion, nudge
   - sent_at timestamp, channel (default: email)
   - read_at for tracking

**Security Features:**
- Row-level security (RLS) policies
  - Users see own profile + same client profiles
  - Users read/create requests only for their client
  - Admins see all data
- Automatic trigger: profile creation on auth.users insert
- Production-ready indexes for performance

## TypeScript Type Definitions

### lib/types.ts
**Enums:**
- RequestStatus (7 values: submitted → completed)
- FormType (1040, 1065, 1120, 1120S)
- UserRole (processor, manager, admin)
- NotificationType (confirmation, completion, nudge)

**Interfaces:**
- Client - Lending partner metadata
- Profile - User account extending auth.users
- Request - Verification request record
- RequestEntity - Individual entity within request
- Notification - Email notification record
- DailyNudgeStats - Daily activity metrics
- RequestWithEntities - Request with expanded entity array

### lib/database.types.ts
**Auto-generated Supabase TypeScript definitions**
- Row types (database records)
- Insert types (creation payloads)
- Update types (partial updates)
- Fully typed database operations

## Library & Utility Files

### lib/supabase.ts
**Supabase client initialization with proper SSR support:**
- createClient() - Browser-side client
- createServerComponentClient() - Server Components (async)
- createServerRouteClient(cookies) - API routes
- createAdminClient() - Admin operations (service role key)
- Follows Next.js App Router best practices
- Automatic cookie/session management

### lib/sendgrid.ts
**Email notification functions with HTML templates:**

**Functions:**
1. sendRequestConfirmation(email, requestData)
   - Triggered: User submits new request
   - Template: Dark background, green accents, request details
   - CTA: "View Request" button

2. sendCompletionNotification(email, requestData, entities)
   - Triggered: Transcripts ready for download
   - Template: Entity summaries with compliance scores
   - CTA: "View Transcripts" button

3. sendDailyNudge(email, stats)
   - Triggered: Daily cron job (9am PT)
   - Template: Activity dashboard with stats
   - Metrics: pending, in_progress, completed
   - CTA: "View Dashboard" button

4. sendAdminFailureAlert(adminEmail, requestId, reason)
   - Triggered: Request processing fails
   - Template: Error details and investigation link
   - CTA: "View Request" button

**Features:**
- ModernTax branded HTML emails (dark theme, green accents)
- Responsive design for all email clients
- Error handling and logging
- SendGrid API integration

### lib/clients.ts
**Client configuration and domain-based provisioning:**
- CLIENT_CONFIG: Maps email domains to client metadata
- getClientSlugFromEmail(email) - Extract client from domain
- getClientConfigFromEmail(email) - Get full client config
- isRecognizedClientDomain(domain) - Validation
- getAllClientSlugs() / getAllClients() - List functions
- validateUserClientAccess(email, slug) - Access control
- inferUserRole(email) - Auto-determine role from domain
  - moderntax.io → admin
  - Client domains → processor

**Client Data:**
- Centerstone SBA Lending (teamcenterstone.com)
- TMC Financing (tmcfinancing.com)
- Clearfirm (clearfirm.com)

## Application Pages

### app/layout.tsx
- Root layout for Next.js 14 app
- Sets metadata (title, description)
- Renders children for page routes

### app/page.tsx
- Home page with ModernTax branding
- Gradient background (mt-dark to mt-navy)
- Feature highlights
- Link to SETUP.md documentation

### app/globals.css
- Global Tailwind CSS imports
- Custom scrollbar styling
- Link and button transitions
- Typography defaults

## Documentation

### SETUP.md
**Complete setup and deployment guide:**
- Project structure overview
- Prerequisites and installation
- Supabase initialization (schema, auth, types)
- SendGrid configuration
- Development server setup
- Build and deployment instructions
- Client configuration details
- API routes structure
- Database operations examples
- Security best practices
- Troubleshooting guide
- Next steps for implementation

### FILES.md (this file)
- Comprehensive file documentation
- Purpose and contents of each file
- Data structure overview
- Security and performance notes

## Git Configuration

### .gitignore
- Standard Node.js exclusions (node_modules, .next, dist)
- Environment files (.env, .env.local)
- IDE and OS files (.vscode, .idea, .DS_Store)
- Build artifacts and logs

## Summary Statistics

**Total Files: 20**
- Configuration: 8 files
- Environment: 2 files
- Database: 1 file
- TypeScript Libraries: 4 files
- Application: 3 files
- Documentation: 2 files

**Lines of Code:**
- Database schema: 250+ lines
- TypeScript utilities: 800+ lines
- Configuration: 200+ lines
- Total: 1,250+ lines of production-ready code

**Key Technologies:**
- Next.js 14 (React 18 App Router)
- TypeScript 5.3
- Tailwind CSS 3.4
- Supabase (Postgres + Auth)
- SendGrid Email API
- Vercel Cron Jobs

## Next Steps for Development

1. Run `npm install` to install dependencies
2. Set up Supabase project and run schema.sql
3. Configure environment variables in .env.local
4. Create API routes in app/api/
5. Build React components in components/
6. Implement authentication middleware
7. Create request submission flow
8. Build dashboard pages
9. Implement admin interface
10. Deploy to Vercel or your platform

## Security Notes

- Service role key (SUPABASE_SERVICE_ROLE_KEY) never exposed to browser
- Row-level security (RLS) enforces multi-tenant isolation
- Email domains validate client assignment
- SendGrid keys stored securely in environment
- All timestamps in UTC for consistency
- HTTPS required in production
- JWT-based authentication via Supabase Auth

## Production Checklist

- [ ] Supabase project created and backed up
- [ ] SendGrid account with verified senders
- [ ] Environment variables configured in Vercel
- [ ] Custom domain pointed to Vercel
- [ ] SSL certificate configured
- [ ] Email template testing completed
- [ ] Database RLS policies verified
- [ ] Cron job schedule confirmed
- [ ] Monitoring and alerting set up
- [ ] User documentation prepared
- [ ] Disaster recovery plan documented
