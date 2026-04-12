'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface VoiceRecorderProps {
  /** Current voice sample URL (if already recorded) */
  existingUrl?: string | null;
  /** Called after successful upload with the new URL */
  onUploaded: (url: string) => void;
  /** Show in compact mode for settings pages */
  compact?: boolean;
}

type RecordingState = 'idle' | 'recording' | 'recorded' | 'uploading' | 'done';

/**
 * IRS PPS call script for voice sample recording.
 * ~30 seconds of natural speaking — enough for VoxCPM2 zero-shot cloning.
 */
const VOICE_SCRIPT = `Hi, this is [YOUR NAME], I'm a tax practitioner. My CAF number is [YOUR CAF]. I have three business accounts to process today. I need Record of Account transcripts and Tax Return transcripts for all of them. I have signed 8821 forms on file for each one. Can you pull up the first account? The Employer Identification Number is 8, 4, 2, 1, 7, 3, 6, 5, 9. Thank you.`;

const MIN_DURATION_S = 10;
const MAX_DURATION_S = 60;

export function VoiceRecorder({ existingUrl, onUploaded, compact }: VoiceRecorderProps) {
  const [state, setState] = useState<RecordingState>(existingUrl ? 'done' : 'idle');
  const [error, setError] = useState('');
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(existingUrl || null);

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioBlob = useRef<Blob | null>(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorder.current?.state === 'recording') {
        mediaRecorder.current.stop();
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    setError('');
    audioChunks.current = [];
    setDuration(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000, // VoxCPM2 accepts 16kHz reference audio
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }

        const blob = new Blob(audioChunks.current, { type: 'audio/webm' });
        audioBlob.current = blob;
        setAudioUrl(URL.createObjectURL(blob));
        setState('recorded');
      };

      mediaRecorder.current = recorder;
      recorder.start(250); // collect data every 250ms
      setState('recording');

      // Duration counter
      const start = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        setDuration(elapsed);
        if (elapsed >= MAX_DURATION_S) {
          recorder.stop();
        }
      }, 500);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError('Microphone access denied. Please allow microphone access in your browser settings.');
      } else {
        setError('Could not access microphone. Check browser permissions.');
      }
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorder.current?.state === 'recording') {
      mediaRecorder.current.stop();
    }
  }, []);

  const reRecord = useCallback(() => {
    audioBlob.current = null;
    if (audioUrl && !existingUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setDuration(0);
    setState('idle');
    setError('');
  }, [audioUrl, existingUrl]);

  const upload = useCallback(async () => {
    if (!audioBlob.current) return;
    if (duration < MIN_DURATION_S) {
      setError(`Recording must be at least ${MIN_DURATION_S} seconds. Please try again.`);
      setState('recorded');
      return;
    }

    setState('uploading');
    setError('');

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob.current, 'voice-sample.webm');

      const res = await fetch('/api/expert/voice-sample', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Upload failed (${res.status})`);
      }

      const { url } = await res.json();
      setAudioUrl(url);
      setState('done');
      onUploaded(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setState('recorded');
    }
  }, [duration, onUploaded]);

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ─── Compact mode (for settings pages) ───
  if (compact) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          {state === 'done' && audioUrl ? (
            <>
              <div className="flex items-center gap-2 text-green-700 text-sm">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Voice sample recorded
              </div>
              <audio src={audioUrl} controls className="h-8" />
              <button onClick={reRecord} className="text-xs text-indigo-600 hover:underline">
                Re-record
              </button>
            </>
          ) : (
            <button
              onClick={state === 'idle' ? startRecording : stopRecording}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                state === 'recording'
                  ? 'bg-red-100 text-red-700 animate-pulse'
                  : 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'
              }`}
            >
              {state === 'recording' ? `Stop (${formatTime(duration)})` : 'Record Voice Sample'}
            </button>
          )}
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  // ─── Full onboarding mode ───
  return (
    <div className="border-t border-gray-200 pt-6">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">Voice Sample for IRS Calls</h3>
      <p className="text-xs text-gray-500 mb-4">
        Record yourself reading the script below. Our AI agent uses your voice when calling the IRS
        on your behalf, so the IRS agent hears you — not a robot.
      </p>

      {/* Script card */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Read this aloud:</p>
        <p className="text-sm text-gray-800 leading-relaxed italic">
          &ldquo;{VOICE_SCRIPT}&rdquo;
        </p>
        <p className="text-xs text-gray-400 mt-2">
          Replace [YOUR NAME] and [YOUR CAF] with your actual credentials. Speak naturally — the AI
          will match your tone, pace, and voice characteristics.
        </p>
      </div>

      {/* Recording controls */}
      <div className="flex flex-col items-center gap-4 py-4">
        {state === 'idle' && (
          <button
            onClick={startRecording}
            className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-full font-semibold text-sm hover:bg-indigo-700 transition-all shadow-lg hover:shadow-xl"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            Start Recording
          </button>
        )}

        {state === 'recording' && (
          <div className="flex flex-col items-center gap-3">
            {/* Pulsing indicator */}
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
                <div className="w-10 h-10 rounded-full bg-red-500 animate-pulse" />
              </div>
            </div>
            <p className="text-lg font-mono text-gray-700">{formatTime(duration)}</p>
            <p className="text-xs text-gray-500">
              {duration < MIN_DURATION_S
                ? `Keep going — at least ${MIN_DURATION_S}s needed`
                : 'Looking good! Stop when you finish the script.'}
            </p>
            <button
              onClick={stopRecording}
              disabled={duration < 3}
              className="px-6 py-2 bg-red-600 text-white rounded-full font-semibold text-sm hover:bg-red-700 transition-all disabled:opacity-50"
            >
              Stop Recording
            </button>
          </div>
        )}

        {state === 'recorded' && (
          <div className="flex flex-col items-center gap-3 w-full max-w-md">
            <p className="text-sm font-medium text-gray-700">Preview your recording ({formatTime(duration)})</p>
            {audioUrl && <audio src={audioUrl} controls className="w-full" />}
            <div className="flex gap-3">
              <button
                onClick={reRecord}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50"
              >
                Re-record
              </button>
              <button
                onClick={upload}
                className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-semibold text-sm hover:bg-indigo-700"
              >
                Save Voice Sample
              </button>
            </div>
          </div>
        )}

        {state === 'uploading' && (
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Saving voice sample...
          </div>
        )}

        {state === 'done' && (
          <div className="flex flex-col items-center gap-3 w-full max-w-md">
            <div className="flex items-center gap-2 text-green-700 text-sm font-medium">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Voice sample saved — your AI agent will sound like you on IRS calls
            </div>
            {audioUrl && <audio src={audioUrl} controls className="w-full" />}
            <button
              onClick={reRecord}
              className="text-xs text-indigo-600 hover:underline"
            >
              Record a new sample
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg mt-2">
          {error}
        </div>
      )}
    </div>
  );
}
