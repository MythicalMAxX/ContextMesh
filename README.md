# ContextMesh

Shared engineering memory and end-to-end encrypted messaging between the coding agents (Claude Code, Codex, Cursor, …) of developers on different teams and networks.

This repository is the **client**: the local node every developer runs and the MCP server their agents talk to. The node keeps your org's shared knowledge in a local graph (contracts, owners, implementation status, decisions, earlier answers), exchanges encrypted messages with teammates' nodes through a ContextMesh hub, and holds items that need your approval.

```text
Your agent ──stdio MCP──► your node (local graph memory, keys, approval queue) ◄──encrypted──► hub ◄──► teammates' nodes
```

- **Local graph memory.** `get_context`, `find_owner` and `get_dependencies` answer instantly from local SQLite, even offline, so agents don't ask for things the org already knows.
- **Change propagation.** Contracts, status and decisions you publish reach every member allowed to see that component. Updates from a component's owning team apply automatically. Everything else waits for your approval.
- **Priority queue.**
  - `urgent`: pushed in real time to the owning team; can be answered automatically by an always-on node running a read-only headless agent, with no approval.
  - `normal`: waits for the owner's agent.
  - `low`: change notices, implementation docs and memory updates, which wait for a developer's approval; the sender gets receipts.
- **End-to-end encryption.** The hub only relays ciphertext. It cannot read, forge or alter messages, and it cannot add members.

**New here? Follow the step-by-step [setup guide](SETUP.md)** (install, join or create an org, run your node, connect your agent).

- **Agents stay inside your project.** Tell the node your project folder(s) and what the project is (`agent-network setup`). Agents are given that map up front, so they do not roam your computer burning usage, and the node itself never reads outside it.
- **You choose the model.** Background work (like auto-answering urgent questions) runs on the tool and model you pick, such as Claude Code with haiku, Codex, another CLI, or a private API endpoint. Nothing defaults to the most expensive model.

## Install

Requires Node.js ≥ 22.18 and git.

```bash
npm install -g https://github.com/MythicalMAxX/ContextMesh/tarball/personal
```

This installs the `agent-network` command. Use the tarball URL rather than `github:MythicalMAxX/ContextMesh`: with npm 11 on Windows, a global install from a `github:` spec leaves a link to a temporary clone that npm deletes afterwards. Your node lives in `~/.agent-network` (override with `--home` or `AGENT_NETWORK_HOME`).

## Join your org

Your org admin sends you a single-use invite code over a trusted channel:

```bash
agent-network join <invite-code>
```

`join` prints your key fingerprint. Tell your admin, so they can approve you after comparing it:

```bash
agent-network org approve <you> --fingerprint <your-fingerprint>
```

Then add your local repositories and options to `~/.agent-network/node.yaml` (see [`examples/node.yaml`](examples/node.yaml)) and keep your node running:

```bash
agent-network run
```

`run` keeps a live connection to the hub, re-indexes your repositories (OpenAPI, CODEOWNERS), optionally auto-answers urgent questions, and serves your approvals dashboard at the printed `http://127.0.0.1:7421/?token=…` link.

## Connect your agent

Claude Code:

```bash
claude mcp add agent-network -- agent-network mcp --agent claude-code
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.agent-network]
command = "agent-network"
args = ["mcp", "--agent", "codex"]
```

The component is inferred from the working directory when it is inside a repository listed in `node.yaml`; otherwise pass `--component <id>`.

| Tool | Purpose |
|---|---|
| `get_context`, `find_owner`, `get_dependencies` | Read local graph memory: contracts, status, freshness, confidence, conflicts, decisions, earlier answers |
| `publish_context` | Share contracts, status and notes; breaking contract changes notify consuming teams |
| `ask` | Enquiry with `priority` `urgent` or `normal`; `wait_seconds` waits inline for the answer |
| `announce_change` | Change notice or implementation doc, queued for the recipients' developer approval |
| `report_conflict`, `resolve_conflict` | Disagreeing sources; settlements spread to every node |
| `get_inbox` | Enquiries to answer, answers, receipts, items awaiting your approval, approved work |
| `respond` | Answer, decline or escalate an enquiry or conflict |
| `decide` | Record your explicit decision: approve, reject, defer, done, or answer an escalation |

You can also decide from the terminal:

```bash
agent-network queue
```

```bash
agent-network decide <item-id> approve --note "will implement next sprint"
```

## For org admins

The admin who creates an org becomes its **root**. The root's key signs every member certificate and the ownership manifest (teams, developers, components, visibility), and every member pins it at join time. You need a hub URL and a bootstrap token from your hub operator:

```bash
agent-network org init --hub <hub-url> --org <org-id> --developer <you> --manifest org.yaml
```

Then invite and manage members:

```bash
agent-network org invite <developer>
```

```bash
agent-network org manifest org.yaml
```

`org pending`, `org approve` and `org revoke` handle the rest. [`examples/org.yaml`](examples/org.yaml) shows a manifest. Back up `~/.agent-network/identity.json` on the root machine: it is your org's trust anchor.

## Security model

| Property | How |
|---|---|
| Confidentiality | Each payload is AES-256-GCM encrypted with a fresh key, sealed to every recipient's X25519 key (ephemeral ECDH → HKDF-SHA256). The hub never holds keys. |
| Authenticity | Payloads are signed with the sender's Ed25519 key together with the header, and verified against root-signed member certificates. |
| Integrity | The header is AES-GCM associated data and key wraps are bound to message and recipient, so tampering, metadata swaps and moved wraps are rejected. |
| Membership | The root key is pinned from the invite. A malicious hub cannot inject members or swap keys. Revocations are root-signed. |
| Access control | Restricted components are only encrypted for their team, reader teams and org admins. |
| Hub authentication | Every request is signed (timestamp + nonce, replay rejected); there are no bearer tokens. |
| Keys at rest | `~/.agent-network/identity.json` (mode 0600). Set `AGENT_NETWORK_PASSPHRASE` before `join`/`org init` to encrypt it (PBKDF2 + AES-GCM). |

The hub can see member ids and public keys, who sent what kind of message to whom, priority, size and timing, and it can delay or drop messages. There is no forward secrecy: a stolen private key decrypts that member's messages until they expire from the hub (1 to 30 days). Org admins can read restricted components. The cryptography lives in [`shared/crypto.ts`](shared/crypto.ts) and [`src/node/envelope.ts`](src/node/envelope.ts) for review.

## Development

```bash
npm install
```

```bash
npm test
```

## Limitations

- The Jira and Linear task connectors follow their public APIs but have not been run against live instances.
- The auto-responder runs the command you configure on questions from other org members. Keep it read-only (e.g. `claude -p --allowedTools Read,Grep,Glob`); it is off by default.
- Task-text claim extraction is conservative pattern matching; code-level facts come from agents via `publish_context`.
