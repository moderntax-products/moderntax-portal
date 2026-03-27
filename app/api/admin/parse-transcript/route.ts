import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { parseMultipleTranscripts, type ParsedTranscript } from '@/lib/wage-income-parser';

/**
 * Admin API route: Parse Wage & Income Transcript
 *
 * POST /api/admin/parse-transcript
 *
 * Body:
 *   entityId: string     — The request_entity ID whose transcripts to parse
 *   save?: boolean        — If true, saves parsed employment_data to the entity
 *
 * Fetches the entity's uploaded transcript files from Supabase storage,
 * extracts text from PDFs, runs the parser, and returns structured JSON.
 */
export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    // Verify the caller is an admin
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!callerProfile || callerProfile.role !== 'admin') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { entityId, save } = body;

    if (!entityId) {
      return NextResponse.json({ error: 'entityId is required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Fetch entity with transcript URLs
    const { data: entity, error: entityError } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, tid, request_id, transcript_urls, form_type, years')
      .eq('id', entityId)
      .single();

    if (entityError || !entity) {
      return NextResponse.json(
        { error: entityError?.message || 'Entity not found' },
        { status: 404 }
      );
    }

    const transcriptUrls: string[] = entity.transcript_urls || [];

    if (transcriptUrls.length === 0) {
      return NextResponse.json(
        { error: 'No transcript files uploaded for this entity' },
        { status: 400 }
      );
    }

    // Download and extract text from each transcript file
    const transcriptTexts: { text: string; year?: string }[] = [];
    const errors: string[] = [];

    for (const filePath of transcriptUrls) {
      try {
        const { data: fileData, error: downloadError } = await adminSupabase.storage
          .from('uploads')
          .download(filePath);

        if (downloadError || !fileData) {
          errors.push(`Failed to download ${filePath}: ${downloadError?.message || 'No data'}`);
          continue;
        }

        let extractedText = '';

        if (filePath.toLowerCase().endsWith('.pdf')) {
          // Extract text from PDF using pdf-parse
          const buffer = Buffer.from(await fileData.arrayBuffer());
          try {
            // Dynamic import — pdf-parse v1 is CJS so .default holds the function
            const pdfParseModule = await import('pdf-parse');
            const pdfParse = pdfParseModule.default ?? pdfParseModule;
            const pdfData = await (pdfParse as (buf: Buffer) => Promise<{ text: string }>)(buffer);
            extractedText = pdfData.text;
          } catch (pdfError) {
            errors.push(
              `Failed to parse PDF ${filePath}: ${pdfError instanceof Error ? pdfError.message : 'Unknown PDF error'}`
            );
            continue;
          }
        } else if (
          filePath.toLowerCase().endsWith('.txt') ||
          filePath.toLowerCase().endsWith('.text')
        ) {
          // Plain text file
          extractedText = await fileData.text();
        } else if (
          filePath.toLowerCase().endsWith('.html') ||
          filePath.toLowerCase().endsWith('.htm')
        ) {
          // HTML file — strip tags to get text content
          const html = await fileData.text();
          extractedText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        } else {
          // Try treating as text
          try {
            extractedText = await fileData.text();
          } catch {
            errors.push(`Unsupported file format: ${filePath}`);
            continue;
          }
        }

        if (!extractedText.trim()) {
          errors.push(`Empty text extracted from ${filePath}`);
          continue;
        }

        transcriptTexts.push({ text: extractedText });
      } catch (fileError) {
        errors.push(
          `Error processing ${filePath}: ${fileError instanceof Error ? fileError.message : 'Unknown error'}`
        );
      }
    }

    if (transcriptTexts.length === 0) {
      return NextResponse.json(
        {
          error: 'Could not extract text from any transcript files',
          file_errors: errors,
        },
        { status: 422 }
      );
    }

    // Parse the transcript text(s)
    let parsed: ParsedTranscript;
    try {
      parsed = parseMultipleTranscripts(transcriptTexts, entity.request_id);
    } catch (parseError) {
      return NextResponse.json(
        {
          error: `Parsing failed: ${parseError instanceof Error ? parseError.message : 'Unknown parse error'}`,
          file_errors: errors,
        },
        { status: 422 }
      );
    }

    // Optionally save employment_data to the entity
    if (save) {
      const { error: updateError } = await adminSupabase
        .from('request_entities')
        .update({
          employment_data: parsed.employment_data as unknown as Record<string, unknown>,
        })
        .eq('id', entityId);

      if (updateError) {
        return NextResponse.json(
          {
            error: `Parsed successfully but failed to save: ${updateError.message}`,
            parsed,
            file_errors: errors,
          },
          { status: 500 }
        );
      }

      // Audit log
      await logAuditFromRequest(adminSupabase, request, {
        action: 'file_uploaded',
        userId: user.id,
        userEmail: user.email || '',
        resourceType: 'request_entity',
        resourceId: entityId,
        details: {
          admin_action: 'transcript_parsed_and_saved',
          files_parsed: transcriptTexts.length,
          files_skipped: errors.length,
          w2_count: parsed.employment_data.summary.total_employers,
          income_sources_count: parsed.income_sources.length,
          total_w2_income: parsed.employment_data.summary.total_w2_income,
          total_income: parsed.employment_data.summary.total_income,
          years_covered: parsed.employment_data.summary.years_covered,
        },
      });
    }

    return NextResponse.json({
      success: true,
      saved: !!save,
      parsed,
      file_errors: errors.length > 0 ? errors : undefined,
      files_processed: transcriptTexts.length,
      files_total: transcriptUrls.length,
    });
  } catch (error) {
    console.error('Parse transcript error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
