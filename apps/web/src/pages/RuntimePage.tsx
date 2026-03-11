import { useQuery } from '@tanstack/react-query';

import { api } from '../api';

function Row({ label, value }: { label: string; value: string | number | boolean }) {
  return (
    <div className="kv-row">
      <span>{label}</span>
      <strong className="mono">{String(value || '-')}</strong>
    </div>
  );
}

export function RuntimePage() {
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime, refetchInterval: 10000 });

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Runtime</p>
          <h2>设置</h2>
          <p className="muted">查看当前运行时、模型与代理的只读配置快照</p>
        </div>
      </div>

      {runtime.isLoading && <section className="panel"><p className="muted">加载中...</p></section>}

      {runtime.data && (
        <div className="kv-grid">
          <section className="panel">
            <div className="panel-header">
              <h3>运行总览</h3>
            </div>
            <div className="list compact">
              <Row label="助手名称" value={runtime.data.assistantName} />
              <Row label="模型提供方" value={runtime.data.provider} />
              <Row label="时区" value={runtime.data.timezone} />
              <Row label="触发规则" value={runtime.data.triggerPattern} />
              <Row label="启动时间" value={new Date(runtime.data.startedAt).toLocaleString('zh-CN')} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>Ollama</h3>
            </div>
            <div className="list compact">
              <Row label="Host" value={runtime.data.ollama.host || '未配置'} />
              <Row label="模型" value={runtime.data.ollama.model || '未配置'} />
              <Row label="温度" value={runtime.data.ollama.temperature || '默认'} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>Web UI</h3>
            </div>
            <div className="list compact">
              <Row label="已启用" value={runtime.data.webUi.enabled ? '是' : '否'} />
              <Row label="托管模式" value={runtime.data.webUi.mode} />
              <Row label="监听地址" value={`${runtime.data.webUi.host}:${runtime.data.webUi.port}`} />
              <Row label="构建产物就绪" value={runtime.data.webUi.staticBuildReady ? '是' : '否'} />
              <Row label="静态目录" value={runtime.data.webUi.staticDir} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>代理</h3>
            </div>
            <div className="list compact">
              <Row label="HTTP_PROXY" value={runtime.data.proxy.httpProxy || '未配置'} />
              <Row label="HTTPS_PROXY" value={runtime.data.proxy.httpsProxy || '未配置'} />
              <Row label="NO_PROXY" value={runtime.data.proxy.noProxy || '未配置'} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>容器</h3>
            </div>
            <div className="list compact">
              <Row label="镜像" value={runtime.data.container.image} />
              <Row label="超时毫秒" value={runtime.data.container.timeoutMs} />
              <Row label="最大并发" value={runtime.data.container.maxConcurrent} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>渠道配置</h3>
            </div>
            <div className="list compact">
              <Row label="已安装渠道" value={runtime.data.channels.installed.join(', ') || '无'} />
              <Row label="Telegram 已配置" value={runtime.data.channels.telegramConfigured ? '是' : '否'} />
              <Row label="QQ 已配置" value={runtime.data.channels.qqConfigured ? '是' : '否'} />
              <Row label="QQ Access Token" value={runtime.data.channels.qqAccessTokenConfigured ? '已配置' : '未配置'} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h3>路径</h3>
            </div>
            <div className="list compact">
              <Row label="项目根目录" value={runtime.data.paths.projectRoot} />
              <Row label="群组目录" value={runtime.data.paths.groupsDir} />
              <Row label="数据目录" value={runtime.data.paths.dataDir} />
              <Row label="存储目录" value={runtime.data.paths.storeDir} />
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
