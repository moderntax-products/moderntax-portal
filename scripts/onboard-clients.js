#!/usr/bin/env node
/**
 * Client Onboarding Script
 *
 * Creates client organizations and invites their loan processors/managers
 * to the ModernTax portal. Sends welcome emails with temporary passwords.
 *
 * Usage:
 *   node scripts/onboard-clients.js
 *
 * Configure the ACCOUNTS array below with your real data before running.
 *
 * Requirements:
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 *   - SENDGRID_API_KEY in .env.local (for welcome emails)
 *   - SENDGRID_FROM_EMAIL in .env.local
 *   - NEXT_PUBLIC_APP_URL in .env.local
 */

require('dotenv').config({ path: '.env.local' });

const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

// ─── Configuration ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';
// Always use production URL for welcome emails (not localhost)
const APP_URL = 'https://portal.moderntax.io';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── ACCOUNTS TO ONBOARD ───────────────────────────────────────────
//
// Edit this array with your real clients and their users.
//
// Each account has:
//   - name: Client org display name
//   - slug: URL-friendly identifier (lowercase, no spaces)
//   - domain: Company email domain
//   - intake_methods: How they submit requests ['csv', 'pdf', 'manual']
//   - users: Array of users to invite
//     - email: User's email
//     - fullName: Display name
//     - role: 'processor' or 'manager'
//
// Existing clients (already in DB) will be skipped.
// Existing users (by email) will be skipped.
//
const ACCOUNTS = [
  // ── Example: Uncomment and edit ──
  // {
  //   name: 'ABC Lending',
  //   slug: 'abc-lending',
  //   domain: 'abclending.com',
  //   intake_methods: ['csv', 'manual'],
  //   users: [
  //     { email: 'jane@abclending.com', fullName: 'Jane Smith', role: 'manager' },
  //     { email: 'bob@abclending.com', fullName: 'Bob Jones', role: 'processor' },
  //   ],
  // },
  // {
  //   name: 'XYZ Capital',
  //   slug: 'xyz-capital',
  //   domain: 'xyzcapital.com',
  //   intake_methods: ['pdf', 'manual'],
  //   users: [
  //     { email: 'sarah@xyzcapital.com', fullName: 'Sarah Lee', role: 'processor' },
  //   ],
  // },

  // ── Your existing clients — add users to them ──
  // To add processors to an existing client like Centerstone, just include it:
  // {
  //   name: 'Centerstone SBA Lending',
  //   slug: 'centerstone',
  //   domain: 'teamcenterstone.com',
  //   intake_methods: ['csv', 'manual'],
  //   users: [
  //     { email: 'processor@teamcenterstone.com', fullName: 'John Doe', role: 'processor' },
  //   ],
  // },
];

// ─── Email Template ─────────────────────────────────────────────────
function createWelcomeEmailHtml(fullName, role, tempPassword, clientName) {
  const roleLabel = role === 'manager' ? 'Manager' : 'Loan Processor';
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#1a2332;padding:24px 32px;">
      <h1 style="color:#ffffff;font-size:20px;margin:0;">
        <span style="color:#00C48C;">Modern</span>Tax Portal
      </h1>
    </div>
    <div style="border-top:3px solid #00C48C;padding:32px;">
      <h2 style="color:#1a2332;font-size:18px;margin:0 0 16px;">Welcome to ModernTax, ${fullName}!</h2>
      <p style="color:#4b5563;font-size:14px;line-height:1.6;margin:0 0 16px;">
        You've been invited to the <strong>ModernTax IRS Transcript Verification Portal</strong>
        ${clientName ? `as a <strong>${roleLabel}</strong> for <strong>${clientName}</strong>` : `as a <strong>${roleLabel}</strong>`}.
      </p>
      <p style="color:#4b5563;font-size:14px;line-height:1.6;margin:0 0 16px;">
        Use the portal to submit IRS transcript requests, track their status, and download completed transcripts &mdash; all in one secure place.
      </p>
      <div style="background:#fef9c3;border:1px solid #fde68a;border-radius:8px;padding:16px;margin:24px 0;">
        <p style="color:#92400e;font-size:13px;font-weight:600;margin:0 0 8px;">Your temporary login credentials:</p>
        <p style="color:#1a2332;font-size:14px;margin:0 0 4px;"><strong>Email:</strong> your email address</p>
        <p style="color:#1a2332;font-size:14px;margin:0;"><strong>Password:</strong> <code style="background:#fde68a;padding:2px 8px;border-radius:4px;font-size:15px;font-weight:bold;">${tempPassword}</code></p>
      </div>
      <p style="color:#6b7280;font-size:12px;margin:0 0 24px;">
        Please change your password after your first login for security.
      </p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${APP_URL}/login" style="display:inline-block;background:#00C48C;color:#ffffff;font-weight:600;font-size:14px;padding:12px 32px;border-radius:8px;text-decoration:none;">
          Log In Now &rarr;
        </a>
      </div>
    </div>
    <div style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
      <p style="color:#9ca3af;font-size:11px;margin:0;text-align:center;">
        ModernTax &bull; Secure IRS Transcript Verification &bull; SOC 2 Compliant
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ─── Password Generator ─────────────────────────────────────────────
function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const special = '!@#$%&*';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  password += special.charAt(Math.floor(Math.random() * special.length));
  password += Math.floor(Math.random() * 10);
  return password;
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  if (ACCOUNTS.length === 0) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  No accounts configured!                                     ║');
    console.log('║                                                              ║');
    console.log('║  Edit the ACCOUNTS array in scripts/onboard-clients.js       ║');
    console.log('║  with your real client data, then run again.                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
    console.log('Example:\n');
    console.log(`  {
    name: 'ABC Lending',
    slug: 'abc-lending',
    domain: 'abclending.com',
    intake_methods: ['csv', 'manual'],
    users: [
      { email: 'jane@abclending.com', fullName: 'Jane Smith', role: 'manager' },
      { email: 'bob@abclending.com', fullName: 'Bob Jones', role: 'processor' },
    ],
  }\n`);
    process.exit(0);
  }

  console.log('\n🏢 ModernTax Client Onboarding');
  console.log('═'.repeat(50));
  console.log(`Processing ${ACCOUNTS.length} account(s)...\n`);

  const results = {
    clientsCreated: 0,
    clientsSkipped: 0,
    usersCreated: 0,
    usersSkipped: 0,
    emailsSent: 0,
    emailsFailed: 0,
    errors: [],
  };

  for (const account of ACCOUNTS) {
    console.log(`\n── ${account.name} ──`);

    // 1. Find or create client
    let clientId;
    const { data: existingClient } = await supabase
      .from('clients')
      .select('id')
      .eq('slug', account.slug)
      .single();

    if (existingClient) {
      clientId = existingClient.id;
      console.log(`  ✓ Client exists (${clientId})`);
      results.clientsSkipped++;
    } else {
      const { data: newClient, error: clientErr } = await supabase
        .from('clients')
        .insert({
          name: account.name,
          slug: account.slug,
          domain: account.domain,
          intake_methods: account.intake_methods || ['manual'],
        })
        .select('id')
        .single();

      if (clientErr) {
        console.error(`  ✗ Failed to create client: ${clientErr.message}`);
        results.errors.push(`Client ${account.name}: ${clientErr.message}`);
        continue;
      }
      clientId = newClient.id;
      console.log(`  ✓ Client created (${clientId})`);
      results.clientsCreated++;
    }

    // 2. Invite users
    for (const user of account.users || []) {
      // Check if user already exists
      const { data: existingProfiles } = await supabase
        .from('profiles')
        .select('id, email')
        .eq('email', user.email);

      if (existingProfiles && existingProfiles.length > 0) {
        console.log(`  ⊘ User ${user.email} already exists — skipping`);
        results.usersSkipped++;
        continue;
      }

      // Create auth user
      const tempPassword = generateTempPassword();
      const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
        email: user.email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: {
          full_name: user.fullName,
          role: user.role,
        },
      });

      if (createErr) {
        console.error(`  ✗ Failed to create ${user.email}: ${createErr.message}`);
        results.errors.push(`User ${user.email}: ${createErr.message}`);
        continue;
      }

      // Update profile with role and client_id
      const { error: profileErr } = await supabase
        .from('profiles')
        .update({
          full_name: user.fullName,
          role: user.role,
          client_id: clientId,
        })
        .eq('id', newUser.user.id);

      if (profileErr) {
        console.error(`  ✗ Failed to update profile for ${user.email}: ${profileErr.message}`);
        await supabase.auth.admin.deleteUser(newUser.user.id);
        results.errors.push(`Profile ${user.email}: ${profileErr.message}`);
        continue;
      }

      console.log(`  ✓ Created ${user.role} ${user.fullName} <${user.email}>`);
      console.log(`    Password: ${tempPassword}`);
      results.usersCreated++;

      // 3. Send welcome email
      if (SENDGRID_API_KEY) {
        try {
          await sgMail.send({
            to: user.email,
            from: { email: FROM_EMAIL, name: 'ModernTax' },
            subject: `Welcome to ModernTax Portal — ${account.name}`,
            html: createWelcomeEmailHtml(user.fullName, user.role, tempPassword, account.name),
          });
          console.log(`    📧 Welcome email sent`);
          results.emailsSent++;
        } catch (emailErr) {
          console.error(`    ⚠ Email failed: ${emailErr.message}`);
          results.emailsFailed++;
        }
      } else {
        console.log(`    ⚠ No SENDGRID_API_KEY — email not sent (share password manually)`);
      }
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log('📊 Summary');
  console.log('═'.repeat(50));
  console.log(`  Clients created: ${results.clientsCreated}`);
  console.log(`  Clients skipped: ${results.clientsSkipped} (already existed)`);
  console.log(`  Users created:   ${results.usersCreated}`);
  console.log(`  Users skipped:   ${results.usersSkipped} (already existed)`);
  console.log(`  Emails sent:     ${results.emailsSent}`);
  if (results.emailsFailed > 0) {
    console.log(`  Emails failed:   ${results.emailsFailed}`);
  }
  if (results.errors.length > 0) {
    console.log(`\n⚠ Errors:`);
    results.errors.forEach((e) => console.log(`  - ${e}`));
  }
  console.log('');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
