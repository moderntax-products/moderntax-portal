/**
 * Expert Voice Sample Upload
 * POST — Upload a voice recording for VoxCPM2 voice cloning on IRS PPS calls.
 *
 * Stores the audio in Supabase Storage (voice-samples bucket) and updates
 * the expert's profile with the voice_sample_url.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = ['audio/webm', 'audio/wav', 'audio/mp4', 'audio/ogg', 'audio/mpeg'];

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'expert') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const formData = await request.formData();
    const audioFile = formData.get('audio') as File | null;

    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    if (audioFile.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 10 MB)' }, { status: 400 });
    }

    // Validate MIME type
    const mimeType = audioFile.type || 'audio/webm';
    if (!ALLOWED_TYPES.some(t => mimeType.startsWith(t.split('/')[0]))) {
      return NextResponse.json({ error: 'Invalid file type. Please upload an audio file.' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Determine file extension from MIME type
    const ext = mimeType.includes('webm') ? 'webm'
      : mimeType.includes('wav') ? 'wav'
      : mimeType.includes('mp4') ? 'm4a'
      : mimeType.includes('ogg') ? 'ogg'
      : 'webm';

    const filePath = `voice-samples/${user.id}/voice-sample.${ext}`;

    // Upload to Supabase Storage (overwrite any existing sample)
    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const { error: uploadError } = await adminSupabase.storage
      .from('uploads')
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: true, // Replace existing voice sample
      });

    if (uploadError) {
      console.error('Voice sample upload error:', uploadError);
      return NextResponse.json({ error: 'Failed to upload voice sample' }, { status: 500 });
    }

    // Get public URL
    const { data: urlData } = adminSupabase.storage
      .from('uploads')
      .getPublicUrl(filePath);

    const voiceSampleUrl = urlData.publicUrl;

    // Update profile with voice sample URL
    const { error: updateError } = await adminSupabase
      .from('profiles')
      .update({
        voice_sample_url: voiceSampleUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Profile update error:', updateError);
      return NextResponse.json({ error: 'Voice sample uploaded but profile update failed' }, { status: 500 });
    }

    return NextResponse.json({
      url: voiceSampleUrl,
      message: 'Voice sample saved successfully',
    });
  } catch (error) {
    console.error('Voice sample upload error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
