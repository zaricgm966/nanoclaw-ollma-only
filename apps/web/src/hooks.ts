import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { LogsPayload, Summary } from './api';

export function useLiveEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource('/api/events');

    source.addEventListener('summary', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as Summary;
      queryClient.setQueryData(['summary'], data);
    });

    source.addEventListener('logs', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as LogsPayload;
      queryClient.setQueryData(['app-logs'], data);
    });

    return () => source.close();
  }, [queryClient]);
}
