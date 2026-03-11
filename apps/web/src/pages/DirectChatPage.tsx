import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { api } from '../api';

interface StreamState {
  userMessage: string;
  assistantReply: string;
}

export function DirectChatPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [streamState, setStreamState] = useState<StreamState | null>(null);
  const [streamError, setStreamError] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const messages = useQuery({
    queryKey: ['direct-messages'],
    queryFn: api.directMessages,
    refetchInterval: isStreaming ? false : 5000,
  });

  const hasMessages = useMemo(
    () => (messages.data?.length || 0) > 0 || Boolean(streamState),
    [messages.data, streamState],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.data, streamState, isStreaming]);

  async function streamDirectReply(text: string): Promise<void> {
    const response = await fetch('/api/direct-chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
      }),
    });

    if (!response.ok || !response.body) {
      let errorMessage = `API request failed: ${response.status}`;
      try {
        const payload = await response.json() as { message?: string; error?: string };
        errorMessage = payload.message || payload.error || errorMessage;
      } catch {
        // Ignore JSON parse failure and keep fallback message.
      }
      throw new Error(errorMessage);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const payload = JSON.parse(trimmed) as {
          type: 'start' | 'chunk' | 'done' | 'error';
          value?: string;
          message?: string;
        };

        if (payload.type === 'chunk') {
          setStreamState((current) => current
            ? { ...current, assistantReply: current.assistantReply + (payload.value || '') }
            : current);
        }

        if (payload.type === 'error') {
          throw new Error(payload.message || '流式回复失败');
        }
      }

      if (done) {
        break;
      }
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isStreaming) return;

    setMessage('');
    setStreamError('');
    setIsStreaming(true);
    setStreamState({ userMessage: trimmed, assistantReply: '' });

    try {
      await streamDirectReply(trimmed);
      setStreamState(null);
      await queryClient.invalidateQueries({ queryKey: ['direct-messages'] });
      await queryClient.invalidateQueries({ queryKey: ['summary'] });
      await queryClient.invalidateQueries({ queryKey: ['chats'] });
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : '发送失败');
    } finally {
      setIsStreaming(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const form = event.currentTarget.form;
      if (form) {
        form.requestSubmit();
      }
    }
  }

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Direct Chat</p>
          <h2>直接对话</h2>
          <p className="muted">不经过 Telegram，直接在 Web 控制台里与 NanoClaw 对话</p>
        </div>
      </div>

      <section className="panel chat-panel">
        <div className="chat-thread">
          {messages.isLoading && !streamState && <p className="muted">加载对话中...</p>}
          {!hasMessages && (
            <div className="chat-empty">
              <strong>还没有对话记录</strong>
              <p className="muted">现在就发第一条消息，NanoClaw 会直接通过本地 Ollama 回复你。</p>
            </div>
          )}
          {messages.data?.map((item) => {
            const isAssistant = item.sender === 'web:assistant' || item.is_bot_message;
            return (
              <article
                className={`chat-bubble ${isAssistant ? 'assistant' : 'user'}`}
                key={`${item.id}-${item.timestamp}`}
              >
                <div className="chat-bubble-meta">
                  <strong>{item.sender_name}</strong>
                  <span>{new Date(item.timestamp).toLocaleString('zh-CN')}</span>
                </div>
                {isAssistant ? (
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p>{item.content}</p>
                )}
              </article>
            );
          })}
          {streamState && (
            <>
              <article className="chat-bubble user optimistic">
                <div className="chat-bubble-meta">
                  <strong>你</strong>
                  <span>刚刚</span>
                </div>
                <p>{streamState.userMessage}</p>
              </article>
              <article className="chat-bubble assistant pending">
                <div className="chat-bubble-meta">
                  <strong>Andy</strong>
                  <span>{isStreaming ? '正在回复...' : '已中断'}</span>
                </div>
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {streamState.assistantReply || '处理中，请稍候...'}
                  </ReactMarkdown>
                </div>
              </article>
            </>
          )}
          <div ref={bottomRef} />
        </div>

        <form className="chat-composer" onSubmit={onSubmit}>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="直接输入你想让 NanoClaw 处理的内容，Enter 发送，Shift + Enter 换行"
            rows={4}
          />
          <div className="chat-composer-footer">
            <span className="muted">发送时会附带当前浏览器 userAgent，帮助 NanoClaw 识别你的系统环境。</span>
            <button type="submit" disabled={isStreaming || !message.trim()}>
              {isStreaming ? '回复中...' : '发送'}
            </button>
          </div>
          {streamError && <p className="form-error">{streamError}</p>}
        </form>
      </section>
    </section>
  );
}
