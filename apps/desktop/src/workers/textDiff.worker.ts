/// <reference lib="webworker" />

import { computeTextDiff, type ComputeTextDiffOptions, type TextDiffProjection } from '../../shared/textDiff';

export interface TextDiffWorkerRequest {
  requestId: number;
  originalText: string;
  draftText: string;
  options?: ComputeTextDiffOptions;
}

export interface TextDiffWorkerResponse {
  requestId: number;
  projection?: TextDiffProjection;
  error?: string;
}

self.onmessage = (event: MessageEvent<TextDiffWorkerRequest>) => {
  const { requestId, originalText, draftText, options } = event.data;
  try {
    const projection = computeTextDiff(originalText, draftText, options);
    self.postMessage({ requestId, projection } satisfies TextDiffWorkerResponse);
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error || 'Diff computation failed'),
    } satisfies TextDiffWorkerResponse);
  }
};

export {};
