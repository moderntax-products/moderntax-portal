import { Download } from 'lucide-react';
import type { RequestEntity } from '@/lib/types';

interface TranscriptDownloadProps {
  entity: RequestEntity;
}

export function TranscriptDownload({ entity }: TranscriptDownloadProps) {
  const hasTranscripts = entity.transcript_urls && entity.transcript_urls.length > 0;

  return (
    <div className="bg-white rounded-lg shadow-md p-6 border-l-4 border-emerald-500">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-gray-900">{entity.entity_name}</h3>
        <p className="text-sm text-gray-600 mt-1">
          Form {entity.form_type} • {entity.tid_kind}: {entity.tid}
        </p>
        {entity.compliance_score !== null && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs font-medium text-gray-600">Compliance Score:</span>
            <span className="text-lg font-bold text-emerald-600">{entity.compliance_score}%</span>
          </div>
        )}
      </div>

      {hasTranscripts ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-gray-700 mb-4">Available Transcripts:</p>
          {entity.transcript_urls!.map((url, index) => (
            <a
              key={index}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
            >
              <span className="text-sm font-medium text-gray-900">
                Transcript {index + 1}
              </span>
              <Download className="w-4 h-4 text-emerald-600" />
            </a>
          ))}
        </div>
      ) : (
        <div className="p-4 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <p className="text-sm text-gray-600 text-center">
            {entity.status === 'completed'
              ? 'Transcripts will be available soon'
              : 'Transcripts not yet available'}
          </p>
        </div>
      )}
    </div>
  );
}
