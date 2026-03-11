import { useQuery } from '@tanstack/react-query';

import { api } from '../api';

function formatSchedule(task: { schedule_type: string; schedule_value: string }) {
  if (task.schedule_type === 'interval') {
    const ms = Number(task.schedule_value);
    if (!Number.isFinite(ms)) return task.schedule_value;
    const minutes = Math.round(ms / 60000);
    return `每 ${minutes} 分钟`;
  }
  if (task.schedule_type === 'once') return '单次任务';
  return task.schedule_value;
}

export function TasksPage() {
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, refetchInterval: 5000 });

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Tasks</p>
          <h2>任务</h2>
          <p className="muted">查看调度任务和最近执行状态</p>
        </div>
      </div>
      <section className="panel">
        <div className="list">
          {tasks.isLoading && <p className="muted">加载中...</p>}
          {tasks.data?.map((task) => (
            <article className="task-card" key={task.id}>
              <div className="task-head">
                <div>
                  <strong>{task.group_folder}</strong>
                  <p className="muted mono">{task.id}</p>
                </div>
                <span className={task.status === 'active' ? 'badge ok' : 'badge soft'}>
                  {task.status}
                </span>
              </div>
              <p className="task-prompt">{task.prompt}</p>
              <div className="task-meta-grid">
                <div>
                  <span className="detail-label">调度方式</span>
                  <strong>{formatSchedule(task)}</strong>
                </div>
                <div>
                  <span className="detail-label">下一次执行</span>
                  <strong>{task.next_run ? new Date(task.next_run).toLocaleString('zh-CN') : '-'}</strong>
                </div>
                <div>
                  <span className="detail-label">上次执行</span>
                  <strong>{task.last_run ? new Date(task.last_run).toLocaleString('zh-CN') : '-'}</strong>
                </div>
              </div>
              {task.last_result && (
                <div className="task-result">
                  <span className="detail-label">最近结果</span>
                  <p>{task.last_result}</p>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
