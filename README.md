# ContextMesh

Human-authorized relationships between independently owned coding agents.

Coding agents increasingly depend on work that other people own: another team's API, a contractor's code, a service whose rules live in someone's head. ContextMesh lets those agents ask each other directly, end-to-end encrypted, while the **people** decide which agents may talk, what a relationship may cover, what is answered automatically, what needs approval, and when it ends. It sits above MCP (an agent's tools) and A2A (agents finding each other): it is the layer that says *who may ask whom about what*.

This is an **experiment**. The question it tests: how many human interruptions can agents resolve between themselves without more mistakes or leaks? The design, the experiment and the results are in the project's documents; this repository is the **client** (the local node every developer runs and the tools their agents call).

```text
Your agent ──MCP or shell──► your node (local memory, keys, approval queue) ◄──encrypted──► hub ◄──► other nodes
```

**You are an AI agent?** Read [AGENT-QUICKSTART.md](AGENT-QUICKSTART.md). It is one page of commands.
**You are a person setting this up?** Follow the [setup guide](SETUP.md).

## What it does

- **Relationships, enforced where the answer is given.** The org manifest (signed by the org root) can list who may ask about which component, which files an answer may draw on, whether answers go out by themselves or wait for a person, and when the relationship ends. The **receiving** node checks this with its own copy of the manifest before anything is queued or any agent is started. A sender that skips its own check gets a `declined` answer with a reason code.
- **Answers from a restricted copy.** When a relationship limits answers to some files, the answering agent is started in a folder holding only those files (secret-looking files left out, secret values redacted). It cannot quote what it was never shown.
- **Safety basics.** Text containing keys, passwords or tokens is blocked before it is sent. Everything another party's agent writes is marked `untrusted`. A sender that repeats a question or fires a burst of questions at one component is stopped, as is any single asker that exceeds the hourly limit.
- **Local graph memory.** `get_context`, `find_owner` and `get_dependencies` answer from local SQLite, even offline, so agents do not ask for what the org already knows.
- **End-to-end encryption.** The hub only relays ciphertext. It cannot read, forge or alter messages, and it cannot add members.
- **Two ways in.** Agents that can run an MCP server use it; agents that only have a shell use `agent-network call`, `inbox --wait` and `doctor`. Both run the same tools.

## A relationship

```yaml
policy:
  relationships: strict            # asking needs a relationship (owners, their team and admins excepted)

relationships:
  contractor-api-docs:
    from: { developers: [carol] }
    about: { components: [orders-api] }
    may: [ask]
    answers: auto                  # or: approval (a person approves every answer)
    scope: [docs/api/**]           # the only files an answer may draw on
    expires: 2026-12-31
```

A relationship that is not listed does not exist. `answers: auto` requires an explicit `scope` (`["**"]` means the whole component, on purpose). See [`examples/org.yaml`](examples/org.yaml) for a full manifest.

**Known limit.** The restricted copy is enforced for the node's own auto-responder. An interactive agent that answers through the `respond` tool can read its whole repository, so for it the scope is shown with the question and `answers: approval` puts the draft in front of a person. The experiment measures how well that holds.

## Install

Requires Node.js ≥ 22.18. No root needed:

```bash
npm install -g --prefix "$HOME/.local" https://github.com/MythicalMAxX/ContextMesh/tarball/relationship-experiment
export PATH="$HOME/.local/bin:$PATH"
agent-network doctor
```

Use the tarball URL rather than `github:MythicalMAxX/ContextMesh`: with npm 11 on Windows, a global install from a `github:` spec leaves a link to a temporary clone that npm deletes afterwards. Your node lives in `~/.agent-network` (override with `--home` or `AGENT_NETWORK_HOME`). `agent-network doctor` checks Node, the hub, your clock and whether you are approved, and prints the fix for each problem; it works on any Node version.

## Join an org

Your org admin sends you a single-use invite code over a trusted channel:

```bash
agent-network join <invite-code>
```

`join` prints your key fingerprint. Tell your admin, who approves you after comparing it:

```bash
agent-network org approve <you> --fingerprint <your-fingerprint>
```

Keep a node connected with `agent-network run` (live sync, indexing, auto-responder, approvals dashboard), or use the shell commands below, which sync on demand.

## Connect your agent

MCP (Claude Code):

```bash
claude mcp add agent-network -- agent-network mcp --agent claude-code
```

MCP (Codex, `~/.codex/config.toml`):

```toml
[mcp_servers.agent-network]
command = "agent-network"
args = ["mcp", "--agent", "codex"]
```

Shell (any agent that can run commands):

```bash
agent-network tools                                  # the tools and their arguments
agent-network call ask --json '{"owner":"orders-api","question":"..."}'
agent-network inbox --wait 60                        # blocks until something needs you
```

Output is one JSON object (`{"ok":true,"result":...}` or `{"ok":false,"error":...}`). In our tests Codex and Claude Haiku did not use the tools unless a rules file (`AGENTS.md`, `CLAUDE.md`) told them when to ask; the MCP `instructions` field had no effect on them.

| Tool | Purpose |
|---|---|
| `orient` | The project map: folders, components, owners, the rules for staying in scope |
| `get_context`, `find_owner`, `get_dependencies` | Read local memory: contracts, status, freshness, conflicts, decisions, earlier answers |
| `publish_context` | Share contracts, status and notes; breaking contract changes notify consuming teams |
| `ask` | Put a question to the owning team's agent; waits for the answer (30 s by default) |
| `announce_change` | Change notice or implementation doc, queued for the recipients' approval |
| `report_conflict`, `resolve_conflict` | Disagreeing sources; settlements spread to every node |
| `get_inbox` | Questions to answer, answers, receipts, items awaiting a person, approved work |
| `respond` | Answer, decline or escalate a question; held for approval where the relationship says so |
| `decide` | Record **a person's** decision: approve, reject, defer, done, or answer an escalation |

## For org admins

The admin who creates an org becomes its **root**. The root's key signs every member certificate and the manifest (teams, developers, components, visibility, relationships), and every member pins it at join time.

```bash
agent-network org init --hub <hub-url> --org <org-id> --developer <you> --manifest org.yaml
agent-network org invite <developer>
agent-network org manifest org.yaml        # publish a changed manifest; revocations and expiries take effect on the next question
```

`org pending`, `org approve` and `org revoke` handle the rest. Back up `~/.agent-network/identity.json` on the root machine: it is your org's trust anchor.

## Security model

| Property | How |
|---|---|
| Confidentiality | Each payload is AES-256-GCM encrypted with a fresh key, sealed to every recipient's X25519 key (ephemeral ECDH → HKDF-SHA256). The hub never holds keys. |
| Authenticity | Payloads are signed with the sender's Ed25519 key together with the header, and verified against root-signed member certificates. |
| Integrity | The header is AES-GCM associated data and key wraps are bound to message and recipient, so tampering, metadata swaps and moved wraps are rejected. |
| Membership | The root key is pinned from the invite. A malicious hub cannot inject members or swap keys. Revocations are root-signed. |
| Authorization | The receiving node decides, from the signed manifest, whether a question may be asked and what the answer may use. |
| Hub authentication | Every request is signed (timestamp + nonce, replay rejected); there are no bearer tokens. |
| Keys at rest | `~/.agent-network/identity.json` (mode 0600). Set `AGENT_NETWORK_PASSPHRASE` before `join`/`org init` to encrypt it. |

The hub can see member ids and public keys, who sent what kind of message to whom, priority, size and timing, and it can delay or drop messages. There is no forward secrecy: a stolen private key decrypts that member's messages until they expire from the hub (1 to 30 days). Org admins can read restricted components. In an **experiment** org the manifest can name observers, who receive a copy of every message; they are listed in every message's audience and in the agents' instructions, so nobody is observed in secret. The cryptography lives in [`shared/crypto.ts`](shared/crypto.ts) and [`src/node/envelope.ts`](src/node/envelope.ts) for review.

## Limitations

- Version 0 of relationships knows one permission (`ask`), file-glob scopes, and relationships inside one org. Relationships across independent organizations are not built.
- The secret scan has a short list of high-confidence patterns; a credential in an unusual shape gets through.
- The auto-responder runs the command you configure on questions from other org members. Keep it read-only; it is off by default.
- The Jira and Linear task connectors follow their public APIs but have not been run against live instances.

## Development

```bash
npm install
npm test
```
