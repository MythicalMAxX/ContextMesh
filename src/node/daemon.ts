/**
 * The always-on part of a node: a WebSocket to the hub for real-time delivery, catch-up sync, periodic
 * re-indexing of local repositories, the urgent-enquiry auto-responder, and the local approvals dashboard.
 */
import type { Server } from 'node:http';
import { iso } from '../util.ts';
import { startDashboard } from './dashboard.ts';
import type { LocalNode, ProcessResult } from './node.ts';
import { tryAutoRespond } from './responder.ts';
import { AgentSession } from './session.ts';

export interface Daemon {
  stop(): Promise<void>;
  dashboardUrl: string | null;
}

export async function runDaemon(node: LocalNode, options: { dashboard?: boolean; index?: boolean } = {}): Promise<Daemon> {
  const log = node.ctx.log;
  const session = new AgentSession(node, { agent: 'node' });
  const timers: NodeJS.Timeout[] = [];
  let socket: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;
  // Messages are processed one at a time so graph updates apply in order.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>) => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  const heartbeat = () => node.setState('daemon_heartbeat', iso(node.ctx.now()));
  heartbeat();
  timers.push(setInterval(heartbeat, 10_000));

  const afterProcessing = async (results: Array<ProcessResult | null>) => {
    for (const result of results) {
      if (!result?.urgentEnquiry) continue;
      const outcome = await tryAutoRespond(node, result.id).catch((error: unknown) => ({ answered: false, reason: String(error) }));
      log(outcome.answered ? `auto-answered urgent enquiry ${result.id}` : `urgent enquiry ${result.id} waiting for an agent: ${outcome.reason}`);
    }
  };

  const catchUp = () =>
    serial(async () => {
      try {
        await node.flushOutbox();
        const results = await node.pull();
        await afterProcessing(results);
        await node.publishPending();
      } catch (error) {
        log(`sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  const connect = async () => {
    if (stopped) return;
    let url: string;
    try {
      url = await node.hub.socketUrl();
    } catch (error) {
      log(`cannot open realtime connection: ${String(error)}`);
      return;
    }
    const ws = new WebSocket(url);
    socket = ws;
    let ping: NodeJS.Timeout | null = null;
    ws.onopen = () => {
      backoff = 1000;
      log('connected to hub (realtime)');
      // Keep-alives are answered by the hub runtime without waking the Durable Object.
      ping = setInterval(() => ws.readyState === ws.OPEN && ws.send('ping'), 45_000);
      void catchUp();
    };
    ws.onmessage = (event) => {
      const text = String(event.data);
      if (text === 'pong') return;
      let message: any;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.type === 'message') {
        void serial(async () => {
          const result = await node.processEnvelope(message.envelope);
          await afterProcessing([result]);
          node.setState('last_pull', iso(node.ctx.now()));
        });
      } else if (message.type === 'presence') {
        node.presence(message.online ?? []);
      } else if (message.type === 'directory') {
        void serial(() => node.refreshDirectory().catch((error: unknown) => log(`directory refresh failed: ${String(error)}`)));
      } else if (message.type === 'join') {
        log(`join request from ${message.developer}: review with "agent-network org pending"`);
      }
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      if (socket === ws) socket = null;
      if (stopped) return;
      setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };
    ws.onerror = () => {
      // onclose follows; reconnect happens there.
    };
  };

  await node.refreshDirectory().catch((error: unknown) => log(`directory refresh failed: ${String(error)}`));
  await catchUp();
  await connect();

  // Polling fallback while the realtime connection is down.
  timers.push(
    setInterval(() => {
      if (!socket || socket.readyState !== socket.OPEN) void catchUp();
    }, Math.max(node.settings.sync.poll_seconds, 60) * 1000),
  );

  const reindex = () =>
    serial(async () => {
      try {
        const report = await node.index();
        for (const repo of report.repositories) {
          for (const change of repo.contract_changes) {
            const notices = await session.notifyConsumers(change.subject, change.key, change.component, change.changes);
            if (notices.length) log(`contract change in ${change.subject}: notified ${notices.map((n) => n.component).join(', ')}`);
          }
        }
        await node.publishPending();
      } catch (error) {
        log(`index failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  if (options.index !== false) {
    void reindex();
    if (node.settings.index.interval_minutes > 0) timers.push(setInterval(() => void reindex(), node.settings.index.interval_minutes * 60_000));
  }

  let dashboard: { server: Server; url: string } | null = null;
  if (options.dashboard !== false) dashboard = await startDashboard(node);

  return {
    dashboardUrl: dashboard?.url ?? null,
    async stop() {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      socket?.close();
      await queue;
      if (dashboard) await new Promise<void>((done) => dashboard!.server.close(() => done()));
      node.setState('daemon_heartbeat', new Date(0).toISOString());
    },
  };
}
