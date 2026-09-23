/**
 * Local approvals dashboard (127.0.0.1 only): the developer reviews change notices, implementation docs,
 * memory updates and escalated questions, and sees what their agents sent and received.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomId, timingSafeEqual } from '../../shared/crypto.ts';
import { listAudit } from '../audit.ts';
import { getContext } from '../context.ts';
import { activeMembers } from './directory.ts';
import type { LocalNode } from './node.ts';
import { AgentSession } from './session.ts';

class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const render = (v: unknown): string => (v instanceof Html ? v.value : Array.isArray(v) ? v.map(render).join('') : v === null || v === undefined || v === false ? '' : esc(String(v)));
function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => (out += render(v) + strings[i + 1]!));
  return new Html(out);
}

const STYLE = `
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e3e2dd;--accent:#3b5bdb;--warn:#b35c00;--ok:#2b8a3e;--bad:#c92a2a;--chip:#efeee9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--text:#ecebe6;--muted:#9a9993;--line:#2f2e2b;--accent:#8ca0ff;--warn:#f0a050;--ok:#69db7c;--bad:#ff7b7b;--chip:#2a2926}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
header nav{display:flex;flex-wrap:wrap;gap:4px 14px;flex:1 1 auto}header a{color:var(--muted);text-decoration:none}header a:hover{color:var(--text)}
main{max-width:1000px;margin:0 auto;padding:20px 16px 60px}h1{font-size:19px;margin:0 0 14px}h2{font-size:13px;margin:26px 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:10px}.card h3{margin:0 0 6px;font-size:15px}
.muted{color:var(--muted)}.small{font-size:12px}.chip{display:inline-block;padding:1px 8px;border-radius:10px;background:var(--chip);font-size:12px;margin-right:4px}
.urgent{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}
pre{background:var(--chip);padding:10px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word}
textarea,input[type=text]{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text);font:inherit}
button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer;margin:4px 6px 0 0}button.secondary{background:var(--chip);color:var(--text)}
.empty{padding:20px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:8px}
table{width:100%;border-collapse:collapse;background:var(--panel)}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.scroll{overflow-x:auto}
label.option{display:block;padding:6px 8px;border:1px solid var(--line);border-radius:6px;margin:4px 0}
`;

function page(node: LocalNode, title: string, body: Html, flash?: string): string {
  return `<!doctype html>${html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Agent Network</title><style>${new Html(STYLE)}</style></head><body>
<header><strong>Agent Network</strong><nav><a href="/">Queue</a><a href="/outbox">Sent</a><a href="/context">Memory</a><a href="/members">Members</a><a href="/audit">Audit</a></nav>
<span class="muted small">${node.developer} · ${node.keys.org} · ${node.daemonAlive() ? 'realtime' : 'offline'}</span></header>
<main>${flash ? html`<div class="card">${flash}</div>` : ''}${body}</main></body></html>`.value}`;
}

function field(payload: Record<string, any>, key: string) {
  const value = payload[key];
  if (!value || (Array.isArray(value) && value.length === 0)) return '';
  return html`<pre>${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>`;
}

async function queuePage(node: LocalNode, flash?: string): Promise<string> {
  const inbox = await new AgentSession(node, { agent: 'dashboard' }).inbox();
  const decisionCard = (item: any) => {
    const escalated = item.state === 'escalated';
    const options: string[] = item.note?.options ?? [];
    return html`<div class="card"><h3><span class="chip ${item.priority === 'urgent' ? 'urgent' : ''}">${item.priority}</span><span class="chip">${item.kind}</span> ${item.title ?? item.subject ?? item.id}</h3>
<div class="muted small">from ${item.from} · ${item.received}</div>
${item.note?.summary ? html`<p>${item.note.summary}</p>` : ''}${item.summary && !escalated ? html`<p>${item.summary}</p>` : ''}${item.question ? html`<p><strong>Question:</strong> ${item.question}</p>` : ''}
${field(item, 'changes')}${field(item, 'doc')}${item.update ? html`<pre>${JSON.stringify(item.update, null, 2).slice(0, 4000)}</pre>` : ''}${item.description ? html`<p>${item.description}</p>` : ''}
<form method="post" action="/decide"><input type="hidden" name="item_id" value="${item.id}">
${escalated
  ? html`${options.map((o, i) => html`<label class="option"><input type="radio" name="option" value="${i + 1}"> ${o}</label>`)}<textarea name="text" rows="2" placeholder="Your decision or answer"></textarea><button name="decision" value="answer">Send decision</button>`
  : html`<input type="text" name="note" placeholder="Note for the sender (optional)"><button name="decision" value="approve">Approve</button><button class="secondary" name="decision" value="defer">Defer</button><button class="secondary" name="decision" value="reject">Reject</button>`}
</form></div>`;
  };
  const body = html`<h1>Needs your decision</h1>
${inbox.awaiting_your_developer.length ? inbox.awaiting_your_developer.map(decisionCard) : html`<div class="empty">Nothing needs you. Your agents handle routine questions.</div>`}
${inbox.approved_actions.length ? html`<h2>Approved, to implement</h2>${inbox.approved_actions.map((a: any) => html`<div class="card"><h3>${a.title ?? a.subject}</h3><div class="muted small">from ${a.from}</div><form method="post" action="/decide"><input type="hidden" name="item_id" value="${a.id}"><button name="decision" value="done">Mark done</button></form></div>`)}` : ''}
<h2>Questions for your agents</h2>
${[...inbox.urgent_enquiries, ...inbox.enquiries, ...inbox.conflict_reports].length
  ? [...inbox.urgent_enquiries, ...inbox.enquiries, ...inbox.conflict_reports].map((q: any) => html`<div class="card"><h3><span class="chip ${q.priority === 'urgent' ? 'urgent' : ''}">${q.priority}</span> ${q.subject ?? q.component}</h3><p>${q.question ?? q.description}</p><div class="muted small">from ${q.from} · ${q.received} · your agent answers these (no approval needed)</div></div>`)
  : html`<div class="empty">No open questions.</div>`}
${inbox.answers.length || inbox.receipts.length ? html`<h2>New answers and receipts</h2>${[...inbox.answers, ...inbox.receipts].map((a: any) => html`<div class="card"><div class="muted small">${a.kind} from ${a.from}</div>${a.question ? html`<p><strong>Q:</strong> ${a.question}</p>` : ''}<p>${a.answer ?? `${a.decision}${a.note ? `: ${a.note}` : ''}`}</p></div>`)}` : ''}`;
  return page(node, 'Queue', body, flash);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function startDashboard(node: LocalNode): Promise<{ server: Server; url: string }> {
  let token = node.state('dashboard_token');
  if (!token) {
    token = randomId();
    node.setState('dashboard_token', token);
  }
  const session = new AgentSession(node, { agent: 'dashboard' });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, body: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", ...headers });
        res.end(body);
      };
      const cookie = /(?:^|;\s*)an_local=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const given = url.searchParams.get('token');
      if (given && timingSafeEqual(given, token!)) {
        res.writeHead(303, { location: '/', 'set-cookie': `an_local=${token}; HttpOnly; SameSite=Strict; Path=/` });
        return res.end();
      }
      if (!cookie || !timingSafeEqual(cookie, token!)) return send(401, '<p>Open the dashboard with the link printed by <code>agent-network run</code>.</p>');
      try {
        if (req.method === 'POST' && url.pathname === '/decide') {
          const form = await readForm(req);
          const option = form.get('option');
          await session.decide(
            {
              item_id: form.get('item_id') ?? '',
              decision: (form.get('decision') ?? 'approve') as 'approve',
              text: form.get('text') || undefined,
              option: option ? Number(option) : undefined,
              note: form.get('note') || undefined,
            },
            'dashboard',
          );
          return send(200, await queuePage(node, 'Decision recorded and sent.'));
        }
        if (url.pathname === '/') return send(200, await queuePage(node));
        if (url.pathname === '/outbox') {
          const rows = node.ctx.db.all<{ id: string; kind: string; priority: string; state: string; subject: string | null; audience: string; created_at: string; replies: string; error: string | null }>(
            'SELECT id, kind, priority, state, subject, audience, created_at, replies, error FROM outbox ORDER BY created_at DESC LIMIT 200',
          );
          return send(200, page(node, 'Sent', html`<h1>Sent by your agents</h1><div class="scroll"><table><tr><th>When</th><th>Kind</th><th>State</th><th>Subject</th><th>To</th><th>Replies</th></tr>${rows.map((r) => html`<tr><td class="small muted">${r.created_at}</td><td>${r.kind} <span class="chip">${r.priority}</span></td><td>${r.state}${r.error ? html`<br><span class="small warn">${r.error}</span>` : ''}</td><td>${r.subject}</td><td class="small">${JSON.parse(r.audience).join(', ')}</td><td class="small">${JSON.parse(r.replies).length}</td></tr>`)}</table></div>`));
        }
        if (url.pathname === '/context') {
          const subject = url.searchParams.get('subject') ?? '';
          let result = html`<p class="muted">Look up anything your agents can see in local memory.</p>`;
          if (subject) {
            try {
              result = html`<pre>${JSON.stringify(getContext(node.ctx, node.me('dashboard'), { subject }), null, 2)}</pre>`;
            } catch (error) {
              result = html`<div class="card">${error instanceof Error ? error.message : String(error)}</div>`;
            }
          }
          return send(200, page(node, 'Memory', html`<h1>Graph memory</h1><form method="get"><input type="text" name="subject" value="${subject}" placeholder="GET /api/resources/{id}"></form>${result}`));
        }
        if (url.pathname === '/members') {
          return send(200, page(node, 'Members', html`<h1>Verified members</h1><p class="muted small">Compare fingerprints out of band when in doubt. Org root: ${node.keys.root.id} (${node.keys.root.fingerprint})</p><div class="scroll"><table><tr><th>Member</th><th>Status</th><th>Fingerprint</th></tr>${activeMembers(node.ctx).map((m) => html`<tr><td>${m.id}${m.name ? html` <span class="muted">(${m.name})</span>` : ''}</td><td class="ok">${m.status}</td><td><code>${m.fingerprint}</code></td></tr>`)}</table></div>`));
        }
        if (url.pathname === '/audit') {
          return send(200, page(node, 'Audit', html`<h1>Local audit log</h1><div class="scroll"><table><tr><th>Time</th><th>Actor</th><th>Action</th><th>Ref</th></tr>${listAudit(node.ctx, { limit: 300 }).map((a) => html`<tr><td class="small muted">${a.ts}</td><td class="small">${a.actor ? `${a.actor.developer} (${a.actor.agent})` : 'system'}</td><td>${a.action}</td><td class="small">${a.request_id ?? ''} ${a.subject ?? ''}</td></tr>`)}</table></div>`));
        }
        return send(404, page(node, 'Not found', html`<div class="empty">Not found</div>`));
      } catch (error) {
        return send(400, page(node, 'Error', html`<div class="card">${error instanceof Error ? error.message : String(error)}</div>`));
      }
    })();
  });
  const { host, port } = node.settings.dashboard;
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, done);
  });
  const actual = (server.address() as AddressInfo).port;
  return { server, url: `http://${host}:${actual}/?token=${token}` };
}
