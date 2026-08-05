import { useEffect, useRef, useState } from 'react';
import { computeCoarseTextDiff, type TextDiffProjection } from '../../../shared/textDiff';
import type { TextDiffWorkerRequest, TextDiffWorkerResponse } from '../../workers/textDiff.worker';

type TextDiffState = {
  projection: TextDiffProjection | null;
  isLoading: boolean;
};

const REQUEST_DEBOUNCE_MS = 80;
const WORKER_TIMEOUT_MS = 2_000;

export function useTextDiff(originalText: string, draftText: string): TextDiffState {
  const nextRequestId = useRef(0);
  const [state, setState] = useState<TextDiffState>({ projection: null, isLoading: true });

  useEffect(() => {
    const requestId = ++nextRequestId.current;
    let worker: Worker | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    setState((current) => ({ ...current, isLoading: true }));

    const debounce = setTimeout(() => {
      if (disposed) return;
      try {
        worker = new Worker(new URL('../../workers/textDiff.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<TextDiffWorkerResponse>) => {
          if (disposed || event.data.requestId !== requestId) return;
          if (watchdog) clearTimeout(watchdog);
          worker?.terminate();
          worker = null;
          const projection = event.data.projection
            ?? computeCoarseTextDiff(originalText, draftText, 'worker_error');
          setState({ projection, isLoading: false });
        };
        worker.onerror = () => {
          if (disposed) return;
          if (watchdog) clearTimeout(watchdog);
          worker?.terminate();
          worker = null;
          setState({
            projection: computeCoarseTextDiff(originalText, draftText, 'worker_error'),
            isLoading: false,
          });
        };
        watchdog = setTimeout(() => {
          if (disposed) return;
          worker?.terminate();
          worker = null;
          setState({
            projection: computeCoarseTextDiff(originalText, draftText, 'worker_timeout'),
            isLoading: false,
          });
        }, WORKER_TIMEOUT_MS);
        worker.postMessage({ requestId, originalText, draftText } satisfies TextDiffWorkerRequest);
      } catch {
        setState({
          projection: computeCoarseTextDiff(originalText, draftText, 'worker_error'),
          isLoading: false,
        });
      }
    }, REQUEST_DEBOUNCE_MS);

    return () => {
      disposed = true;
      clearTimeout(debounce);
      if (watchdog) clearTimeout(watchdog);
      worker?.terminate();
    };
  }, [draftText, originalText]);

  return state;
}
