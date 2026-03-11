import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { api } from '../api';

export function GroupsPage() {
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups });

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Groups</p>
          <h2>群组</h2>
        </div>
      </div>
      <section className="panel">
        <div className="list">
          {groups.isLoading && <p className="muted">加载中...</p>}
          {groups.data?.map((group) => (
            <Link className="list-row list-link" key={group.jid} to={`/groups/${encodeURIComponent(group.jid)}`}>
              <div>
                <strong>{group.name}</strong>
                <p className="muted mono">{group.jid}</p>
              </div>
              <span className="mono">{group.folder}</span>
            </Link>
          ))}
        </div>
      </section>
    </section>
  );
}
