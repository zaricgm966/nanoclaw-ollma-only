import { useQuery } from '@tanstack/react-query';

import { api } from '../api';
import { useLiveEvents } from '../hooks';

export function LogsPage() {
  useLiveEvents();
  const logs = useQuery({ queryKey: ['app-logs'], queryFn: api.appLogs, refetchInterval: 5000 });

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Logs</p>
          <h2>应用日志</h2>
        </div>
      </div>
      <section className="panel log-panel">
        <pre>
          {(logs.data?.lines || []).join('\n')}
        </pre>
      </section>
    </section>
  );
}
