# ContextMesh: install, set up and run

This guide takes you from nothing to a working setup:

- the ContextMesh client installed on your machine,
- your **node** (your local memory, keys and approval queue) joined to your org and connected to the hub,
- your coding agent (Claude Code, Codex, Cursor) using it through MCP.

Every command below is ready to run. The only thing you type yourself is the three variables in [step 3](#3-set-your-variables).

**Two roles:**

| Role | Who | What they do |
|---|---|---|
| **Admin (org root)** | One person, once per org | Creates the org, owns the ownership manifest, invites and approves members. The admin is also a regular developer. |
| **Developer** | Everyone else | Joins with an invite, runs their node, connects their agent. |

Developers follow steps 1–4 and 6–9. The admin follows steps 1–3, then 5, then 6–9.

> Commands are shown for **PowerShell** (Windows) and **bash** (macOS, Linux, Git Bash on Windows). `agent-network` commands are identical in both; only setting variables differs.

---

## 1. Before you start

You need:

| Requirement | Why | Check |
|---|---|---|
| Node.js **22.18 or newer** | The client uses Node's built-in SQLite | `node --version` |
| npm | Installs the client | `npm --version` |
| git (recommended) | Records commits for the repositories your node indexes | `git --version` |
| A **hub URL** | The relay your org uses; your admin or hub operator gives it to you | – |
| A coding agent with MCP support | Claude Code, Codex, Cursor, … | – |

---

## 2. Install the client

```bash
npm install -g https://github.com/MythicalMAxX/ContextMesh/tarball/relationship-experiment
```

Check it worked:

```bash
agent-network --help
```

- **Update:** run the same install command again.
- **Uninstall:** `npm uninstall -g agent-network`. This doesn't touch your node folder (`~/.agent-network`).

> Use the tarball URL above rather than `npm install -g github:MythicalMAxX/ContextMesh`. With npm 11 on Windows, a global install from a `github:` spec leaves a link to a temporary folder that npm deletes, and the command then fails with "Cannot find module".

---

## 3. Set your variables

Set these once per terminal session, using your own values.

**PowerShell**

```powershell
$HUB = "https://your-hub.your-account.workers.dev"   # hub URL from your admin / hub operator
$ORG = "my-company"                                    # org id: lowercase letters, digits and dashes
$ME  = "alice"                                         # your developer id in the org manifest
```

**bash**

```bash
HUB="https://your-hub.your-account.workers.dev"   # hub URL from your admin / hub operator
ORG="my-company"                                    # org id: lowercase letters, digits and dashes
ME="alice"                                          # your developer id in the org manifest
```

Your node lives in `~/.agent-network` (`C:\Users\<you>\.agent-network` on Windows). To keep a separate node, for example for a second org, set `AGENT_NETWORK_HOME` first:

```powershell
$env:AGENT_NETWORK_HOME = "$HOME\.agent-network-second-org"
```

```bash
export AGENT_NETWORK_HOME="$HOME/.agent-network-second-org"
```

---

## 4. Developers: join an existing org

### 4.1 Get an invite code

Ask your admin to add you to the org manifest and send you an invite code (they follow [step 5.5](#55-add-a-teammate)). The code starts with `an1_`. It is **single-use**, expires in 72 hours by default, and is a secret: whoever uses it first becomes you in the org.

### 4.2 (Optional) Protect your keys with a passphrase

If you want your private keys encrypted on disk, set a passphrase **before joining**. You will then need it set in every terminal where you use `agent-network`, and in your agent's MCP config ([step 8](#8-connect-your-coding-agent)).

```powershell
$env:AGENT_NETWORK_PASSPHRASE = "choose-a-long-passphrase"
```

```bash
export AGENT_NETWORK_PASSPHRASE="choose-a-long-passphrase"
```

### 4.3 Join

```bash
agent-network join "PASTE-YOUR-INVITE-CODE-HERE" --name "Your Name"
```

Output:

```text
Join request sent as alice.
Your fingerprint: 9715-b146-0c7f-6f31-5c23-3754
Org root fingerprint (pinned): 545c-8995-c8f0-8734-a1ce-0608
```

Now:

1. Send **your fingerprint** to your admin over a different channel from the invite (a call, or a chat you trust). They compare it before approving you, which proves the join request really came from you.
2. Optionally compare the **org root fingerprint** with the one your admin sees. It is pinned now, and your node will refuse a hub that presents any other root.

### 4.4 After your admin approves you

```bash
agent-network sync
```

```bash
agent-network status
```

`status` should show `"manifest_version": 1` or higher and list you under `members`. The first sync also downloads a snapshot of the shared memory you're allowed to read.

Continue with [step 6](#6-configure-your-node).

---

## 5. Admins: create an org (once)

### 5.1 What you need

- The **hub URL** (`$HUB`).
- **A hosted hub:** an account (you sign in with your email, no token needed). **A hub you run yourself:** the `BOOTSTRAP_TOKEN` secret set when it was deployed.

You become the org's **root**: your key signs every member certificate and every manifest, and every member pins it when they join.

### 5.2 Write the ownership manifest

The manifest describes teams, developers and components (services, apps, libraries). Every member receives it, signed by you and end-to-end encrypted.

- `developers`: every person in the org. You must be listed, with `admin: true`.
- `components`: what your teams own.
  - `team` and `owners` decide who may publish knowledge about a component and who answers questions about it.
  - `repository` is a logical repository id. Each developer maps it to a local folder in their own `node.yaml`.
  - `visibility: restricted` means the component is encrypted only for its team, `readers` teams and admins.
  - `consumes` lists what this component depends on; consumers get change notices when a contract breaks.

Start with yourself and your own components. You can add people any time (step 5.5).

**PowerShell**

```powershell
$manifest = @'
organization: my-company

teams:
  backend:  { name: Backend }
  frontend: { name: Frontend }

developers:
  alice: { name: Alice, email: alice@example.com, teams: [backend], admin: true }

components:
  orders-api:
    team: backend
    owners: [alice]
    description: Orders REST API
    repository: orders-api
'@
[IO.File]::WriteAllText("$PWD\org.yaml", $manifest)
```

**bash**

```bash
cat > org.yaml <<'EOF'
organization: my-company

teams:
  backend:  { name: Backend }
  frontend: { name: Frontend }

developers:
  alice: { name: Alice, email: alice@example.com, teams: [backend], admin: true }

components:
  orders-api:
    team: backend
    owners: [alice]
    description: Orders REST API
    repository: orders-api
EOF
```

Keep `org.yaml` somewhere safe (e.g. next to your notes, or in `~/.agent-network`); you'll edit and re-publish it.

### 5.3 Create the org

**On a hosted hub, sign in with your email** (no shared secret, nothing to ask the operator for):

```bash
agent-network login --hub "$HUB" --email you@example.com
agent-network org init --hub "$HUB" --org "$ORG" --developer "$ME" --manifest org.yaml
```

`login` emails you a 6-digit code (valid 10 minutes) and asks for it. Your sign-in is saved on this machine in `~/.agent-network-account.json`. `agent-network whoami --hub "$HUB"` shows your orgs and plan, and `agent-network logout --hub "$HUB"` signs out. `org init` reserves the org name for your key, so nobody else can claim it or make themselves its root. The free plan allows 3 orgs per account.

**On a hub you run yourself,** set the bootstrap token, create the org, then clear the token from your terminal.

**PowerShell**

```powershell
$env:BOOTSTRAP_TOKEN = "PASTE-BOOTSTRAP-TOKEN-HERE"
agent-network org init --hub "$HUB" --org "$ORG" --developer "$ME" --manifest org.yaml
Remove-Item Env:BOOTSTRAP_TOKEN
```

**bash**

```bash
export BOOTSTRAP_TOKEN="PASTE-BOOTSTRAP-TOKEN-HERE"
agent-network org init --hub "$HUB" --org "$ORG" --developer "$ME" --manifest org.yaml
unset BOOTSTRAP_TOKEN
```

Output:

```text
Org "my-company" created. You are its root.
Root fingerprint: 545c-8995-c8f0-8734-a1ce-0608
```

Lines starting with `[agent-network]` (e.g. `manifest v1 applied`) are informational. In PowerShell they may appear in red because they go to stderr.

### 5.4 Back up your root identity

`identity.json` holds the org's root key. If you lose it, nobody can be invited or approved and you must create a new org. Copy it somewhere safe and offline (password manager attachment, encrypted USB drive, …).

```powershell
Copy-Item "$HOME\.agent-network\identity.json" "D:\secure-backup\contextmesh-$ORG-root-identity.json"
```

```bash
cp ~/.agent-network/identity.json "/path/to/secure-backup/contextmesh-$ORG-root-identity.json"
```

### 5.5 Add a teammate

**1. Add them to the manifest.** Rewrite `org.yaml` with the new developer (and any components they own), then publish it. For example, adding Bob and his web app:

**PowerShell**

```powershell
$manifest = @'
organization: my-company

teams:
  backend:  { name: Backend }
  frontend: { name: Frontend }

developers:
  alice: { name: Alice, email: alice@example.com, teams: [backend], admin: true }
  bob:   { name: Bob,   email: bob@example.com,   teams: [frontend] }

components:
  orders-api:
    team: backend
    owners: [alice]
    description: Orders REST API
    repository: orders-api
  web-app:
    team: frontend
    owners: [bob]
    description: Customer web app
    repository: web-app
    consumes: [orders-api]
'@
[IO.File]::WriteAllText("$PWD\org.yaml", $manifest)
agent-network org manifest org.yaml
```

**bash**

```bash
cat > org.yaml <<'EOF'
organization: my-company

teams:
  backend:  { name: Backend }
  frontend: { name: Frontend }

developers:
  alice: { name: Alice, email: alice@example.com, teams: [backend], admin: true }
  bob:   { name: Bob,   email: bob@example.com,   teams: [frontend] }

components:
  orders-api:
    team: backend
    owners: [alice]
    description: Orders REST API
    repository: orders-api
  web-app:
    team: frontend
    owners: [bob]
    description: Customer web app
    repository: web-app
    consumes: [orders-api]
EOF
agent-network org manifest org.yaml
```

**2. Create their invite** and send the printed `an1_…` code to them privately. Add `--hours 24` for a shorter expiry (maximum 168).

```bash
agent-network org invite bob
```

**3. Approve them** once they have run `join` and sent you their fingerprint. List pending requests and compare the fingerprint with the one they sent you:

```bash
agent-network org pending
```

Approve with the fingerprint they gave you. The command refuses if it doesn't match what the hub holds.

```bash
agent-network org approve bob --fingerprint "PASTE-THEIR-FINGERPRINT"
```

Approval certifies them and sends them the manifest plus a snapshot of the memory they may read. They then run `agent-network sync` (step 4.4).

### 5.6 Remove a member

Revoke first (they can no longer use the hub, and new messages are no longer encrypted for them). Then remove them from `org.yaml` and publish it.

```bash
agent-network org revoke bob
```

```bash
agent-network org manifest org.yaml
```

---

## 6. Configure your node

Your node's settings are in `node.yaml`, in your node folder. Open it:

```powershell
notepad "$HOME\.agent-network\node.yaml"
```

```bash
${EDITOR:-nano} ~/.agent-network/node.yaml
```

### Start here: your project folder and your AI model

One guided command sets up the two things that save the most time and usage. It asks in plain language and changes nothing outside `node.yaml`:

```bash
agent-network setup
```

1. **Your project.** Which folder(s) is it, and what is it, in a sentence? Your agents are told exactly where to work and what the project is, so they stop searching the rest of your computer. Add several folders, or group several projects into a workspace. Folders as broad as your home folder or a whole drive are refused.
2. **The AI tool and model for background work.** Only for work your node starts itself, such as answering an urgent question while you are away. Pick Claude Code, Codex CLI, Gemini CLI, opencode, any other tool you can run (give the command, for example for `agy`), or an API endpoint (an OpenAI-compatible server, a private or self-hosted model, or Anthropic). The model is always your choice (for Claude Code the cheapest, `haiku`, is suggested first) and nothing silently falls back to the most expensive one. Your own interactive agent is never affected.

Or do the same without prompts:

```bash
agent-network project add "C:/code/orders" --name orders --description "Orders API (Go). Run make test." --repository orders-api
agent-network agent add background --tool claude-code --model haiku --responder
agent-network agent test background --scope-check
```

`--scope-check` makes the agent try to read a file outside a throwaway project and tells you whether it was kept out. Run it once for any tool before you turn the auto-responder on.

To make a tool respect the boundary even when it does not use this MCP server, write the rules into the project:

```bash
agent-network scope --tool claude-code --write     # CLAUDE.md; also codex (AGENTS.md) and cursor (.cursor/rules)
```

Agents get the same map through the MCP server: it tells them your folders in its instructions, and the `orient` tool returns the project descriptions, the shared components that live there, and who owns them. Check what they will see with `agent-network orient`.

### 6.1 Point it at your local repositories

For every component you own, map its `repository` id from the manifest to the folder where you have it checked out. Your node indexes those folders (OpenAPI specs and CODEOWNERS) and shares what it finds with everyone allowed to see it.

Append a `repositories` section. Run this **once**, after replacing the id and path; after that, edit the file directly.

**PowerShell**

```powershell
[IO.File]::AppendAllText("$HOME\.agent-network\node.yaml", @'

repositories:
  web-app: { path: 'C:/code/web-app' }
'@)
```

**bash**

```bash
cat >> ~/.agent-network/node.yaml <<'EOF'

repositories:
  web-app: { path: '/home/you/code/web-app' }
EOF
```

Then index and share right away:

```bash
agent-network index
```

### 6.2 All settings

A complete `node.yaml`, with the values `join` / `org init` created at the top:

```yaml
hub: https://your-hub.your-account.workers.dev
org: my-company
developer: alice
identity: identity.json
database: graph.db

# What agents may look at. Once any project exists, nothing outside the projects is indexed or served,
# and agents are told these folders and descriptions instead of searching your computer.
# Created for you by `agent-network setup` / `project add`.
projects:
  orders:
    description: Orders API (Go). Run make test.
    paths: ['C:/code/orders-api']
    repository: orders-api        # makes this folder the local checkout of that manifest repository
workspaces:                       # optional: group projects an agent works across
  shop: { description: Everything for the online shop, projects: [orders] }
workspace: shop                   # optional: the group agents are oriented to (default: all projects)

# How this node runs an agent by itself. You choose the tool AND the model; there is no silent default.
agents:
  profiles:
    background: { tool: claude-code, model: haiku }
    # tool: claude-code | codex | antigravity | gemini | opencode | custom | api
    # other: { tool: custom, command: ['agy', '--model', '{model}', '--ask', '{prompt}'], model: fast-1 }
    # private: { tool: api, provider: openai-compatible, base_url: 'http://localhost:11434/v1', model: llama3 }

# Local checkouts this node indexes and publishes (usually the components you own).
# (A project with `repository:` above already provides one, so you can leave this out.)
repositories:
  orders-api: { path: 'C:/code/orders-api' }
  # A repository you don't have locally can be shallow-cloned instead:
  # billing: { url: https://github.com/your-org/billing.git, branch: main }

# Optional task sources. Claims in task descriptions (e.g. "`region` can be null") are compared
# with the real contracts, and disagreements show up as conflicts.
tasks:
  - { type: file, path: 'C:/code/tasks.yaml' }
  # Jira Cloud: set JIRA_EMAIL and JIRA_API_TOKEN in the environment of `agent-network run`
  # - type: jira
  #   base_url: https://your-company.atlassian.net
  #   jql: project = WEB AND updated >= -30d
  #   component_map: { Web: web-app }
  # Linear: set LINEAR_API_KEY
  # - type: linear
  #   team_keys: [WEB]
  #   team_map: { WEB: web-app }

# How shared memory from other members is applied:
#   owner_authoritative  knowledge about a component from its owning team applies automatically;
#                        everything else waits for your approval (default)
#   manual               every update waits for your approval
#   all                  apply everything from verified members
policy: { apply_updates: owner_authoritative }

# Answer URGENT questions about your components while you're away, with a read-only headless agent.
# Off by default. The question comes from another org member; keep the command read-only.
# The command is built from the profile: read-only, limited to the project's folders, with your chosen model.
responder:
  enabled: false
  profile: background
  timeout_seconds: 120
  max_per_hour: 20
  max_per_day: 100

dashboard: { host: 127.0.0.1, port: 7421 }   # local approvals page (never exposed beyond this machine)
index: { interval_minutes: 15 }               # how often `run` re-indexes your repositories (0 = never)
sync: { poll_seconds: 30 }                    # how often agent tools sync with the hub when `run` isn't running
```

After changing `node.yaml`, restart `agent-network run` (if it's running) so it picks up the change.

---

## 7. Run your node

```bash
agent-network run
```

```text
Node running for alice (my-company). Dashboard: http://127.0.0.1:7421/?token=…
[agent-network] connected to hub (realtime)
```

While it runs, your node:

- keeps a live, encrypted connection to the hub, so questions and updates arrive instantly,
- re-indexes your repositories every 15 minutes and shares changes (breaking contract changes notify the teams that consume them),
- answers urgent questions automatically if the responder is enabled,
- serves your **approvals dashboard** at the printed link (open it in your browser; the token logs you in).

Stop it with `Ctrl+C`.

Your agent works without `run` too: it syncs with the hub on demand (at most every 30 seconds). You just lose real-time delivery, background indexing and the auto-responder.

### Keep it running

**Windows: start at login.** This creates a small script in your Startup folder that opens the node in a minimized window whenever you log in:

```powershell
[IO.File]::WriteAllText("$([Environment]::GetFolderPath('Startup'))\contextmesh-node.cmd", "@echo off`r`nstart ""ContextMesh node"" /min cmd /k agent-network run`r`n")
```

To start it now without logging out:

```powershell
Start-Process cmd -ArgumentList '/k', 'agent-network run' -WindowStyle Minimized
```

To stop starting it at login:

```powershell
Remove-Item "$([Environment]::GetFolderPath('Startup'))\contextmesh-node.cmd"
```

**macOS: background process with a log file**

```bash
nohup agent-network run >> ~/.agent-network/node.log 2>&1 &
```

**Linux: systemd user service**

```bash
mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/contextmesh-node.service <<EOF
[Unit]
Description=ContextMesh node

[Service]
ExecStart=$(command -v agent-network) run
Environment=PATH=$PATH
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now contextmesh-node
```

---

## 8. Connect your coding agent

Your agent starts the MCP server itself (`agent-network mcp`). You only register it once.

The server works out which component you're working on from the folder your agent runs in, if that folder is inside a repository listed in `node.yaml`. Otherwise add `--component <id>` to the arguments.

### Claude Code

Windows (the `cmd /c` wrapper is needed because `agent-network` is a `.cmd` launcher):

```powershell
claude mcp add --scope user agent-network -- cmd /c agent-network mcp --agent claude-code
```

macOS / Linux:

```bash
claude mcp add --scope user agent-network -- agent-network mcp --agent claude-code
```

Check it's registered:

```bash
claude mcp list
```

If you protected your keys with a passphrase (step 4.2), add `-e AGENT_NETWORK_PASSPHRASE=your-passphrase` before `--`. Claude Code then stores the passphrase in its config file.

### Codex

Appends the server to `~/.codex/config.toml`.

**PowerShell**

```powershell
New-Item -ItemType Directory -Force "$HOME\.codex" | Out-Null
[IO.File]::AppendAllText("$HOME\.codex\config.toml", @'

[mcp_servers.agent-network]
command = "cmd"
args = ["/c", "agent-network", "mcp", "--agent", "codex"]
'@)
```

**bash**

```bash
mkdir -p ~/.codex && cat >> ~/.codex/config.toml <<'EOF'

[mcp_servers.agent-network]
command = "agent-network"
args = ["mcp", "--agent", "codex"]
EOF
```

### Cursor

Creates `~/.cursor/mcp.json` if you don't have one yet. If you do, add the `agent-network` entry to its `mcpServers` by hand.

**PowerShell**

```powershell
New-Item -ItemType Directory -Force "$HOME\.cursor" | Out-Null
if (-not (Test-Path "$HOME\.cursor\mcp.json")) { [IO.File]::WriteAllText("$HOME\.cursor\mcp.json", '{ "mcpServers": { "agent-network": { "command": "cmd", "args": ["/c", "agent-network", "mcp", "--agent", "cursor"] } } }') }
```

**bash**

```bash
mkdir -p ~/.cursor && [ -f ~/.cursor/mcp.json ] || echo '{ "mcpServers": { "agent-network": { "command": "agent-network", "args": ["mcp", "--agent", "cursor"] } } }' > ~/.cursor/mcp.json
```

### First run

Start your agent in one of your repositories and ask it:

> Check the agent network inbox, then tell me what the org knows about the components this repository depends on.

The server tells the agent how to use its tools (check the inbox at session start, read memory before asking, publish after finishing work, never make another team's decisions), so no extra prompt setup is needed.

---

## 9. Everyday use

### What your agent does

| Tool | When the agent uses it |
|---|---|
| `get_context`, `find_owner`, `get_dependencies` | Before building against another component: instant answers from your local memory, even offline |
| `ask` | When memory is missing or unclear. `urgent` if it is blocked right now (goes to the whole owning team, may be answered automatically); `normal` otherwise |
| `publish_context` | After finishing work others use: contracts, status, tests, commit |
| `announce_change` | New features or behavior changes other teams must adopt (waits for their developers' approval) |
| `report_conflict`, `resolve_conflict` | When sources disagree (task vs. contract vs. code) |
| `get_inbox`, `respond` | Answering questions addressed to your components; answers become shared memory |
| `decide` | Recording **your** explicit decision on an approval item; your agent should only call it after asking you |

### Your approvals

Change notices, implementation docs, memory updates from non-owners, and questions your agent escalated to you wait for your decision. Handle them in the dashboard (`agent-network run` prints the link) or in the terminal.

List what's waiting:

```bash
agent-network queue
```

Approve (the sender gets a receipt; approved work shows up for your agent as something to implement):

```bash
agent-network decide "ITEM-ID" approve --note "will ship next sprint"
```

Other decisions:

```bash
agent-network decide "ITEM-ID" reject --note "not planned"
```

```bash
agent-network decide "ITEM-ID" defer
```

```bash
agent-network decide "ITEM-ID" done
```

Answer an escalated question, either by picking one of the suggested options or with your own text:

```bash
agent-network decide "ITEM-ID" answer --option 1
```

```bash
agent-network decide "ITEM-ID" answer --text "Show deleted resources greyed out"
```

---

## 10. Maintenance

| Task | How |
|---|---|
| Update the client | Re-run the install command from step 2, then restart `agent-network run` |
| Check your node | `agent-network status`: org, root fingerprint, manifest version, members, last sync, realtime, unsent messages |
| Sync now | `agent-network sync` |
| Re-index and share now | `agent-network index` |
| Move to a new machine | Stop the node, copy the whole node folder (`~/.agent-network`) to the new machine, install the client there, fix the repository paths in `node.yaml`, then run `agent-network status` |
| Lost your node folder (developer) | Ask your admin to `org revoke` you and send a new invite, then `join` again |
| Rotate your keys (developer) | Same as above: revoke, then re-invite |
| Change the manifest (admin) | Edit `org.yaml`, then `agent-network org manifest org.yaml` |

---

## 11. Troubleshooting

| Message or symptom | Fix |
|---|---|
| `Cannot find module …\dist\src\cli.js` after installing | You installed with a `github:` spec. Reinstall with the tarball URL from step 2. |
| `Node configuration not found` | You haven't joined yet, or `AGENT_NETWORK_HOME` points somewhere else. Run `join` (or `org init`), or fix the variable. |
| `A node already exists in …` | That folder already holds a node. Use it, or set `AGENT_NETWORK_HOME` to a new folder for another org. |
| `Add bob to the manifest (and publish it) before inviting them` | Admin: add the developer to `org.yaml` and run `agent-network org manifest org.yaml` first. |
| `invite is unknown, used or expired` | Ask the admin for a new invite (`agent-network org invite <you>`). |
| `The hub does not present the org root from your invite` | Stop. The hub doesn't match your invite; check the invite and hub with your admin. |
| `Fingerprint mismatch … Do not approve` | Admin: the pending join doesn't match what the developer reported. Don't approve; send a new invite. |
| `unknown or inactive member` (401) | You haven't been approved yet, or you were revoked. Ask your admin. |
| `request timestamp outside the allowed window` | Your computer's clock is off by more than 5 minutes. Turn on automatic time sync. |
| `rate limit exceeded` (429) | Too many requests in 10 minutes (often a runaway script). Wait a few minutes. |
| `This identity is passphrase-protected: set AGENT_NETWORK_PASSPHRASE` | Set the variable in this terminal (step 4.2) and in your agent's MCP config (step 8). |
| `Nobody who owns … has joined the network yet` | The owners of that component haven't joined. Ask your admin to invite them. |
| Dashboard doesn't start (port in use) | Change `dashboard: { port: 7422 }` in `node.yaml` and restart `agent-network run`. |
| Agent doesn't see the tools | `claude mcp list` (or your agent's MCP settings). On Windows make sure the `cmd /c` wrapper is used. Restart the agent after registering. |
| Answers or updates arrive late | `agent-network run` isn't running, so your node only syncs when your agent calls a tool. Start it (step 7). |

---

## 12. Command reference

Every command accepts `--home <folder>` (or the `AGENT_NETWORK_HOME` variable) to choose the node folder.

| Command | Who | What it does |
|---|---|---|
| `agent-network setup` | Anyone | Guided setup: your project folders and the AI tool + model for background work |
| `agent-network project add <folder> [--name N] [--description D] [--notes T] [--repository ID]` | Anyone | Add a project (or another folder to one); `project list` / `project remove <name>` |
| `agent-network workspace set <name> --projects a,b` / `use <name\|none>` / `list` | Anyone | Group projects; choose which group agents are oriented to |
| `agent-network agent add <name> --tool T --model M [--responder]` | Anyone | Save a way to run an agent; `agent list`, `agent test <name> [--scope-check]`, `agent enable-responder` |
| `agent-network scope [project] [--tool T] [--write]` | Anyone | The boundary rules for your project, optionally written into CLAUDE.md / AGENTS.md / .cursor/rules |
| `agent-network orient` | Anyone | The project map your agent receives |
| `agent-network login --hub URL --email E` | Anyone | Sign in to a hosted hub with an emailed code; `logout`, `whoami` |
| `agent-network join <invite-code> [--name N]` | Developer | Create your keys and request membership |
| `agent-network sync` | Anyone | Pull and apply everything waiting on the hub; send anything queued |
| `agent-network status` | Anyone | Node, org, members and sync state |
| `agent-network run` | Anyone | Keep the node connected (realtime, indexing, auto-responder, dashboard) |
| `agent-network mcp [--agent A] [--component C]` | Your agent | Stdio MCP server; your agent starts it |
| `agent-network index` | Anyone | Index your repositories and task sources now, and share changes |
| `agent-network queue` | Anyone | Items waiting for your decision |
| `agent-network decide <id> <approve\|reject\|defer\|done\|answer> [--text T] [--option N] [--note N]` | Anyone | Record your decision |
| `agent-network org init --hub URL --org ID --developer ID --manifest org.yaml [--name N]` | Admin | Create the org (signed in with `login`, or `BOOTSTRAP_TOKEN` on a self-hosted hub) |
| `agent-network org manifest <org.yaml>` | Admin | Publish a new manifest version to every member |
| `agent-network org invite <developer> [--hours H]` | Admin | Single-use invite code (default 72 h, max 168 h) |
| `agent-network org pending` | Admin | Join requests and their fingerprints |
| `agent-network org approve <developer> [--fingerprint FP]` | Admin | Certify a member; sends them the manifest and a memory snapshot |
| `agent-network org revoke <developer>` | Admin | Remove a member |
