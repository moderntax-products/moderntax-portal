# ModernTax Portal - Setup Guide

Complete production-ready Next.js 14 + Supabase + SendGrid portal for IRS transcript verification.

## Project Structure

```
moderntax-portal/
├── app/                      # Next.js 14 App Router
├── components/               # React components
├── lib/                      # Utilities and services
│   ├── types.ts             # TypeScript type definitions
│   ├── supabase.ts          # Supabase client setup
│   ├── sendgrid.ts          # Email notification service
│   ├── database.types.ts    # Auto-generated DB types
│   └── clients.ts           # Client config and utilities
├── supabase/
│   └── schema.sql           # PostgreSQL schema
├── public/                  # Static assets
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── next.config.js
├── postcss.config.js
├── .env.example             # Environment variables template
├── .env.local.example       # Local development overrides
├── .gitignore
└── vercel.json              # Vercel cron configuration
```

## Prerequisites

- Node.js 18+ and npm/yarn
- Supabase project (free tier works for development)
- SendGrid account with API key
- Vercel account for deployment (optional, but recommended)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables:
```bash
cp .env.example .env.local
# Edit .env.local with your actual values
```

## Supabase Setup

### 1. Create Supabase Project

1. Go to https://supabase.com and create a new project
2. Wait for the project to initialize
3. Get your project URL and anon key from Project Settings → API

### 2. Initialize Database Schema

1. Go to SQL Editor in Supabase dashboard
2. Create a new query
3. Copy the entire contents of `supabase/schema.sql`
4. Run the query

The schema will create:
- `clients` table with 3 seed records (Centerstone, TMC Financing, Clearfirm)
- `profiles` table (extends auth.users)
- `requests` table for verification requests
- `request_entities` table for individual entities
- `notifications` table for email tracking
- RLS policies for multi-tenant security
- Auto-trigger for profile creation on signup

### 3. Generate TypeScript Types (Optional but Recommended)

```bash
npm install -g @supabase/cli
supabase login
supabase link --project-ref your-project-ref
npx supabase gen types typescript --linked > lib/database.types.ts
```

### 4. Configure Authentication

In Supabase Auth settings:

1. Enable Email/Password provider
2. Set redirect URLs:
   - Development: `http://localhost:3000/auth/callback`
   - Production: `https://portal.moderntax.io/auth/callback`
3. Configure email templates (optional)

## SendGrid Setup

### 1. Create SendGrid Account

1. Go to https://sendgrid.com
2. Create an account and verify your sender email
3. Create an API key in Settings → API Keys
4. Add `notifications@moderntax.io` as a verified sender

### 2. Configure Environment Variables

```env
SENDGRID_API_KEY=SG.your_actual_api_key_here
SENDGRID_FROM_EMAIL=notifications@moderntax.io
```

### 3. Test Email Sending

In your API routes or scripts, you can test:

```typescript
import { sendRequestConfirmation } from '@/lib/sendgrid';

await sendRequestConfirmation('test@example.com', {
  id: 'test-id',
  account_number: '123-456-7890',
  created_at: new Date().toISOString(),
});
```

## Development

### Local Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Build for Production

```bash
npm run build
npm run start
```

### Linting

```bash
npm run lint
```

## Key Features

### Multi-Tenant Architecture
- Auto-provisioning users from email domains
- Role-based access control (processor, manager, admin)
- Row-level security policies in Postgres

### Email Notifications
- Request confirmation emails
- Completion notifications with transcript summaries
- Daily nudge emails with activity stats
- Admin failure alerts

### Real-Time Status Tracking
- 7-step request lifecycle (submitted → completed)
- Entity-level granularity (multiple forms per request)
- Compliance scoring and transcript storage

### Cron Jobs
- Daily 9am PT (16:00 UTC) nudge emails via Vercel
- Configure in `vercel.json`

## Client Configuration

The portal supports three lending partners:

1. **Centerstone SBA Lending**
   - Domain: teamcenterstone.com
   - Slug: centerstone

2. **TMC Financing**
   - Domain: tmcfinancing.com
   - Slug: tmc

3. **Clearfirm**
   - Domain: clearfirm.com
   - Slug: clearfirm

Users are auto-provisioned to their client based on email domain. See `lib/clients.ts` for configuration.

## Deployment

### Vercel (Recommended)

1. Push code to GitHub
2. Connect repo in Vercel dashboard
3. Set environment variables
4. Vercel auto-deploys on push
5. Cron jobs run automatically via `vercel.json`

### Other Platforms

For Docker or other platforms:

1. Build: `npm run build`
2. Start: `npm run start`
3. Set all environment variables
4. For cron jobs, use your platform's scheduler (GitHub Actions, AWS EventBridge, etc.)

## API Routes Structure

Create these in `app/api/`:

- `POST /api/requests` - Submit new request
- `GET /api/requests/:id` - Get request details
- `GET /api/requests` - List requests for current user
- `PUT /api/requests/:id` - Update request status
- `POST /api/cron/nudge` - Daily nudge email job (called by Vercel)
- `POST /api/auth/callback` - OAuth callback handler

## Database Operations

### Server Components (app/ directory)

```typescript
import { createServerComponentClient } from '@/lib/supabase';

export default async function Page() {
  const supabase = await createServerComponentClient();
  const { data } = await supabase.from('requests').select('*');
  return <div>{/* ... */}</div>;
}
```

### API Routes

```typescript
import { cookies } from 'next/headers';
import { createServerRouteClient } from '@/lib/supabase';

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data } = await supabase.from('requests').select('*');
  return Response.json(data);
}
```

### Admin Operations (Cron Jobs)

```typescript
import { createAdminClient } from '@/lib/supabase';

const supabase = createAdminClient();
// Bypasses RLS - use only in secure server contexts
const { data } = await supabase.from('requests').select('*');
```

## Security Best Practices

1. Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser
2. Always use row-level security (RLS) in Postgres
3. Validate user email domains for client assignment
4. Use HTTPS in production
5. Rotate SendGrid API keys regularly
6. Keep environment variables secure in Vercel

## Troubleshooting

### "Missing SUPABASE_SERVICE_ROLE_KEY"

Make sure environment variable is set in Vercel or your deployment platform.

### Emails Not Sending

1. Check SendGrid API key is correct
2. Verify sender email is confirmed in SendGrid
3. Check console logs for detailed error messages
4. Use SendGrid dashboard to see delivery status

### RLS Policy Errors

1. Ensure user has a profile record
2. Check user belongs to correct client
3. Verify RLS policies match your use case

### Authentication Issues

1. Check Supabase redirect URLs are configured
2. Verify JWT secret is properly configured
3. Test with `supabase.auth.getSession()`

## Next Steps

1. Create app pages in `app/` directory
2. Build API routes for core functionality
3. Create React components in `components/`
4. Add middleware for authentication checks
5. Set up monitoring and logging
6. Create admin dashboard
7. Configure backups for Supabase

## Support

For issues:
- Supabase Docs: https://supabase.com/docs
- Next.js Docs: https://nextjs.org/docs
- SendGrid Docs: https://docs.sendgrid.com

## License

Proprietary - ModernTax Inc.
