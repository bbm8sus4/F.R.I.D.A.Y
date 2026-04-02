# F.R.I.D.A.Y Bot — Complete Feature Documentation

> Auto-generated: 2026-04-02 | Branch: refactor/modularize | Commit: 4309cc0

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Commands Reference](#commands-reference)
3. [Secretary AI Layer](#secretary-ai-layer)
4. [Cron Jobs](#cron-jobs)
5. [Database Schema](#database-schema)
6. [External Integrations](#external-integrations)
7. [Role-Based Access Control](#role-based-access-control)
8. [Deployment & Configuration](#deployment--configuration)

---

## Architecture Overview

- **Runtime:** Cloudflare Worker (single entry point `src/index.js`)
- **Database:** D1 SQLite (migrations 0001–0014)
- **AI:** Google Gemini 2.5 Flash (summaries, analysis) + 2.5 Pro (secretary with tools)
- **Messaging:** Telegram Bot API with inline keyboards
- **Multi-instance:** Wrangler envs (`[env.daisy]`, `[env.sigma]`), each with own D1 database
- **Cron:** Every 3 hours → proactive alerts, insight alerts, summarize & cleanup, calendar reminders, daily digest

### File Structure

```
src/
├── index.js                    # Main entry, routing, middleware
├── handlers/
│   ├── calendar.js             # /cal commands
│   ├── members.js              # /allow, /revoke, /users
│   ├── read.js                 # /readhtml, /readpdf, /readimg, /readlink, /readvoice
│   ├── recap.js                # /recap (group conversation recaps)
│   ├── send.js                 # /send (boss → group messaging)
│   └── ...
├── secretary/
│   ├── secretary-prompt.js     # AI prompt templates
│   ├── secretary-context.js    # Context builder (tasks, events, memories)
│   ├── conversation.js         # Multi-turn state machine
│   ├── tool-executor.js        # Main tool-calling loop
│   ├── ai-provider.js          # Gemini API wrapper
│   ├── tool-registry.js        # Tool definitions + executor map
│   ├── guardrails.js           # Permission & confirmation checks
│   ├── fallback.js             # Regex intent extraction (backup)
│   ├── ai-logger.js            # Usage tracking
│   └── tools/
│       ├── task-tools.js       # create/update/complete/block/list tasks
│       ├── calendar-tools.js   # CRUD calendar events (Google Calendar)
│       ├── memory-tools.js     # save/delete memories
│       ├── send-tools.js       # send_message (with confirmation)
│       ├── query-tools.js      # ask_clarification, resolve_user, resolve_task
│       ├── summary-tools.js    # workspace/overdue/employee summaries
│       └── employee-tools.js   # add/list workspace members
├── cron/
│   ├── proactive-alert.js      # Overdue/stale task alerts (no AI)
│   ├── proactive-insight.js    # AI-powered message analysis → alerts
│   ├── summarize-cleanup.js    # Daily/weekly summaries + data cleanup
│   ├── calendar-reminder.js    # Upcoming event reminders
│   ├── daily-digest.js         # Team status summary
│   └── conversation-cleanup.js # Expired conversation state cleanup
├── lib/
│   ├── auth.js                 # getUserRole, detectBossMention, parseCommand
│   ├── telegram.js             # sendTelegram, sendTelegramWithKeyboard, etc.
│   ├── gemini.js               # askGemini (general chat AI)
│   ├── google-calendar.js      # Google Calendar API client
│   ├── context.js              # Smart context assembly for AI
│   ├── html-utils.js           # sanitizeHtml, splitMessage, escapeHtml
│   └── constants.js            # URGENT_PATTERNS, MEMBER_COMMANDS, ALLOWED_TAGS
└── migrations/
    └── 0001–0014               # D1 SQLite migrations
```

---

## Commands Reference

### Message & Media Processing

#### `/readhtml` — Analyze HTML Files
- **Trigger:** Send HTML file → bot offers callback buttons
- **Flow:** Upload → `file_cache` → buttons (สรุป/วิเคราะห์/ถาม) → AI processes
- **AI Model:** Gemini 2.5 Flash
- **Access:** Boss + Member

#### `/readpdf` — Analyze PDF Files
- **Trigger:** Send PDF file → same flow as HTML
- **Processing:** PDF → base64 → Gemini multimodal
- **Access:** Boss + Member

#### `/readimg` — Analyze Images
- **Trigger:** Send image → bot offers callback buttons
- **Processing:** Image → base64 → Gemini vision
- **Access:** Boss + Member

#### `/readlink <URL>` — Fetch & Analyze Web Pages
- **Trigger:** `/readlink https://example.com`
- **Security:** SSRF protection blocks private IPs, localhost, metadata endpoints
- **Cache:** `readlink_cache` (24h TTL)
- **Access:** Boss + Member

#### `/readvoice <text>` — Text-to-Speech
- **Trigger:** `/readvoice สวัสดีครับ`
- **Processing:** Google Cloud TTS → OGG voice message
- **Access:** Boss + Member (requires TTS config)

---

### Task Management

#### `/task <title>` — Create Task
- **Trigger:** `/task เช็คสต็อกนม`
- **Fields:** title, description, assignee, due_on, priority, category
- **Access:** Boss + Member

#### `/tasks` — List Tasks
- **Trigger:** `/tasks` or `/tasks pending` or `/tasks @username`
- **Filters:** status, assignee, category, overdue_only
- **Display:** Inline keyboard with status indicators
- **Access:** Boss + Member

#### `/done <task_id> [result]` — Complete Task
- **Trigger:** `/done 42 เสร็จแล้วค่ะ`
- **Access:** Boss + Member (member: own tasks only)

#### `/cancel <task_id>` — Cancel Task
- **Trigger:** `/cancel 42`
- **Access:** Boss + Member (member: own tasks only)

---

### Memory System

#### `/remember <content>` — Save Memory
- **Trigger:** `/remember ร้านนมอยู่ซอย 5`
- **Auto-categorize:** person, preference, rule, project, task, general
- **Priority:** hot (new), warm, cold
- **Access:** Boss only

#### `/memories [category]` — Browse Memories
- **Trigger:** `/memories` or `/memories person`
- **Display:** Paginated list with delete buttons
- **Access:** Boss only

---

### Group Communication

#### `/send` — Send Message to Group
- **Flow:** Select group → AI drafts message → Boss approves/edits → Send
- **Confirmation:** Always required before sending
- **Tracking:** `pending_sends` + `bot_messages` tables
- **Access:** Boss only

#### `/recap [group]` — Group Conversation Recap
- **Trigger:** `/recap` (DM only — select group) or `/recap` (in group)
- **AI Model:** Gemini 2.5 Flash
- **Data:** Messages + summaries from target group
- **Access:** Boss + Member

#### `/summary [date_range]` — Generate Summary
- **Trigger:** `/summary` (today) or `/summary 7วัน`
- **Types:** Daily, weekly, custom date range
- **Storage:** `summaries` table with dedup
- **Access:** Boss + Member

---

### Calendar

#### `/cal` — List Upcoming Events (14 days)
- **Display:** Thai day names, emoji indicators
- **Integration:** Google Calendar API
- **Access:** Boss + Member

#### `/cal add <title> <date> <time>` — Create Event
- **Trigger:** `/cal add ประชุม 2026-04-05 14:00`
- **Date Parsing:** Thai natural language supported via secretary
- **Access:** Boss + Member

#### `/cal edit <event_id> <field> <value>` — Update Event
- **Access:** Boss only

#### `/cal delete <event_id>` — Delete Event
- **Confirmation:** Required
- **Access:** Boss only

---

### User Management

#### `/allow <user_id|username>` — Grant Member Access
- **Storage:** `allowed_users(user_id, granted_by_id, granted_at)`
- **Access:** Boss only

#### `/revoke <user_id|username>` — Revoke Access
- **Auto-message:** Notifies revoked user
- **Access:** Boss only

#### `/users` — List Members
- **Display:** All allowed users with roles
- **Access:** Boss only

---

### Company / Multi-tenant

#### `/company` — Company Management
- **Callbacks:** `co:add`, `co:s:<id>`, `co:l`
- **Purpose:** Associate groups with companies for filtered summaries
- **Access:** Boss only

---

### Mention & Alert Handling

#### Boss Mention Detection (Automatic)
- **Triggers:** @mention, reply to boss, nickname keywords (configurable via `BOSS_NICKNAMES`)
- **AI Model:** Gemini 2.5 Flash
- **Actions:** Classify urgency, suggest reply options
- **Output:** Alert with analysis buttons

#### Real-time Urgent Alerts (Automatic)
- **Patterns:** `ด่วน`, `ระบบล่ม`, `เสียหาย`, `ลูกค้าโกรธ`, etc.
- **No AI:** Instant regex-based detection
- **Output:** Direct alert to boss with context

---

## Secretary AI Layer

### Overview
The secretary is an AI-powered autonomous agent for the boss, using Gemini's function-calling API with multi-turn conversation support.

### Identity & Behavior
- **Name:** Configurable via `BOT_NAME` (default: "Friday")
- **Gender:** Female (Thai polite particles: ค่ะ, นะคะ)
- **Style:** ZERO PREAMBLE — goes straight to action/content
- **Format:** Telegram HTML only (no Markdown)
- **Language:** Thai/English per user preference

### Thai Natural Language Understanding
The secretary parses Thai commands into structured tool calls:

| User Says | Tool Called |
|-----------|------------|
| "ให้เมย์เช็คสต็อกนมพรุ่งนี้" | `create_task(title="เช็คสต็อกนม", assignee="เมย์", due_on=tomorrow)` |
| "เตรียม report ส่งวันศุกร์" | `create_task(title="เตรียม report", due_on=friday, priority="high")` |
| "ลงนัดโปรแกรม PICO พรุ่งนี้ 17:00" | `create_calendar_event(title="โปรแกรม PICO", date=tomorrow, time="17:00")` |
| "จำไว้ว่าร้านนมอยู่ซอย 5" | `save_memory(content="ร้านนมอยู่ซอย 5")` |
| "ส่งข้อความให้กลุ่ม sales ว่า..." | `send_message(chat_id=..., message="...")` (with confirmation) |

### Tool Catalog (25+ tools)

#### Task Tools
| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_task` | title*, description, assignee_name, due_on, priority, category, expected_output | Create new task with fuzzy assignee resolution |
| `update_task` | task_id*, status, assignee_name, priority, due_on, comment | Update task fields |
| `complete_task` | task_id*, result | Mark task as done |
| `block_task` | task_id*, blocker_description*, blocked_by_task_id | Mark task as blocked |
| `list_tasks` | status, assignee_name, category, overdue_only | List/filter tasks (max 30) |
| `get_task_detail` | task_id* | Full task + comments + blockers |
| `get_task_summary` | — | Aggregate stats by status/assignee |

#### Calendar Tools
| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_calendar_event` | title*, date*, time*, duration, description, location | Create Google Calendar event |
| `update_calendar_event` | event_id*, title?, date?, time?, duration?, location? | Smart merge update |
| `delete_calendar_event` | event_id* | Delete with confirmation |
| `list_calendar_events` | start_date*, end_date? | List events (default +7 days) |

#### Memory Tools
| Tool | Parameters | Description |
|------|-----------|-------------|
| `save_memory` | content*, category? | Auto-classify via AI if category missing |
| `delete_memory` | memory_id* | Delete with confirmation |

#### Send Tools
| Tool | Parameters | Description |
|------|-----------|-------------|
| `send_message` | chat_id*, message* | Always requires boss confirmation |
| `schedule_reminder` | task_id*, remind_at | Schedule future reminder |

#### Query Tools
| Tool | Parameters | Description |
|------|-----------|-------------|
| `ask_clarification` | question, options[] | Pause for user input |
| `resolve_user_by_name` | name | Fuzzy search workspace members |
| `resolve_task_reference` | keyword | Fuzzy search tasks |

#### Summary Tools
| Tool | Description |
|------|-------------|
| `get_workspace_summary` | Overall stats by status/priority/assignee |
| `get_overdue_tasks` | All late tasks with days_overdue |
| `get_employee_summary` | Per-person workload breakdown |

#### Employee Tools
| Tool | Parameters | Description |
|------|-----------|-------------|
| `add_member` | display_name*, nicknames[], telegram_user_id, role | Add workspace member |
| `list_members` | — | List active members |

### Execution Flow

```
User message
  → buildSecretaryContext() [tasks, events, memories, messages]
  → buildSecretaryPrompt() [identity, rules, context]
  → executeSecretaryTurn() [max 5 rounds]
    → GeminiProvider.complete() [Flash primary, Pro fallback]
    → Parse response:
       - No tools → return text
       - ask_clarification → save state, return question
       - Other tools → checkPermission → execute → collect results
       - requiresConfirmation → save state, return pending
    → Loop until done or max rounds
  → logAIUsage() [tokens, tools, duration]
  → Send response via Telegram
```

### Multi-turn Conversation State
- **Storage:** `conversation_state` table (chat_id, user_id, state_type, state_data JSON)
- **TTL:** 30 minutes (auto-cleanup via cron)
- **States:** `clarification` (waiting for more info), `confirmation` (waiting for approval)

### Guardrails

| Check | Boss | Member |
|-------|------|--------|
| All tools | Allowed | Limited set |
| send_message, calendar write, memory write | Allowed | Blocked |
| Task modification | No restriction | Own tasks only (ownership check) |
| Destructive actions (delete) | Confirmation required | Blocked |

---

## Cron Jobs

All cron jobs run every 3 hours.

### 1. Proactive Task Alerts (No AI)
- Check overdue tasks (due_on < today, status=pending) — up to 10
- Check stale tasks (no due_on, created > 48h ago) — up to 5
- Format: emoji indicators with Done/Cancel buttons per task
- Recipient: Boss only

### 2. Proactive Insight Alerts (AI-powered)
- **Per-group message gathering** with learned `priority_weight`:
  - High weight (>=2.0): 150 messages
  - Medium weight (>=1.0): 80 messages
  - Low weight (<1.0): 30 messages
- **AI analysis:** Structured JSON output with urgency/category/who/summary/topic_fingerprint
- **Dedup:** Check topic_fingerprint against last 12h alerts
- **Sort:** By urgency (critical → high → medium → low)
- **Feedback learning:** Boss action adjusts group priority_weight (+0.1 for handle, -0.15 for dismiss)

### 3. Alert Callback Handler
| Action | Callback | Effect |
|--------|----------|--------|
| Short analysis | `pa:s:<chatId>:<alertId>` | 3-5 sentence summary + 4 suggested replies with copy buttons |
| Detailed analysis | `pa:d:<chatId>:<alertId>` | Comprehensive SWOT + risks + recommendations |
| Handled | `pa:h:<chatId>:<alertId>` | Mark handled, +0.1 weight |
| Dismiss | `pa:x:<chatId>:<alertId>` | Mark dismissed, -0.15 weight |

### 4. Summarize & Cleanup
- **Daily summaries:** Auto-generate for groups with 24h+ old messages (15 combos/run)
- **Weekly summaries:** For groups with 30+ day old messages (10 groups/run)
- **Message cleanup:** Delete in batches (500/batch, 5 rounds max)
- **Task archival:** Completed > 7 days → save result to memories → archive
- **Cache cleanup:** readlink_cache (24h), file_cache (24h), bot_messages (48h)
- **Memory alert:** Warn boss if hot memories > 200

### 5. Calendar Reminders
- Query events for today + tomorrow
- Send formatted reminder to boss (once per day)

### 6. Daily Digest
- Sections: overdue (by assignee), due today, blocked, in-progress, per-person summary
- Smart filtering: only show sections with content
- Recipient: Boss

### 7. Conversation Cleanup
- Delete expired `conversation_state` rows (TTL: 24h)

---

## Database Schema

### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `messages` | Group message archive | chat_id, user_id, username, message_text, has_media, created_at |
| `tasks` | Task management | title, status, assignee_id/name, due_on, priority, category, result, blocked_reason |
| `summaries` | Daily/weekly summaries | chat_id, summary_text, summary_type, summary_date, message_count |
| `memories` | Boss knowledge base | content, category (person/preference/rule/project/task/general), priority (hot/warm/cold) |
| `alerts` | Proactive alert tracking | chat_id, urgency, category, who, summary, topic_fingerprint, status, boss_action |
| `calendar_events` | Calendar entries | title, date, time, end_time, location, google_event_id |

### Access Control

| Table | Purpose |
|-------|---------|
| `allowed_users` | user_id, granted_by_id, granted_at |
| `group_registry` | chat_id, chat_title, is_active, priority_weight (0.2–3.0) |
| `workspace_members` | telegram_user_id, display_name, nicknames (JSON), role, department |

### State & Cache

| Table | Purpose | TTL |
|-------|---------|-----|
| `conversation_state` | Multi-turn AI state | 24h |
| `file_cache` | Uploaded file content | 24h |
| `readlink_cache` | Fetched URL content | 24h |
| `bot_messages` | Bot's sent messages | 48h |
| `pending_sends` | Draft messages | Until sent/cancelled |
| `pending_recaps` | Recap requests | Until processed |

### Analytics

| Table | Purpose |
|-------|---------|
| `ai_usage_logs` | Token counts, tool usage, duration, success/error per AI call |

### Multi-tenant

| Table | Purpose |
|-------|---------|
| `companies` | Company registry |
| `group_company_mapping` | Associate groups with companies |

---

## External Integrations

| Service | Usage | Config |
|---------|-------|--------|
| **Google Gemini API** | AI chat, summaries, secretary tools, vision, function calling | `GEMINI_API_KEY` |
| **Telegram Bot API** | Messaging, keyboards, media, voice | `TELEGRAM_BOT_TOKEN` |
| **Google Calendar API** | Event CRUD, reminders | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN` |
| **Google Cloud TTS** | /readvoice text-to-speech | Optional config |
| **Google Search** | Member chat web search | Enabled in Gemini config |

---

## Role-Based Access Control

### Roles

| Role | Determination | Access Level |
|------|--------------|--------------|
| **Boss** | `userId === BOSS_USER_ID` | Full: all commands, all tools, all callbacks |
| **Member** | Exists in `allowed_users` | Limited: task/read/summary/calendar view only |
| **Rejected** | Not in allowed_users | No access (ignored) |

### Member Allowed Commands
```
/task, /tasks, /done, /cancel,
/readlink, /readpdf, /readhtml, /readimg, /readvoice,
/summary, /menu, /start, /recap, /delete, /cal
```

### Member Allowed Callbacks
```
tk:, rl:, fc:, recap:, del:, sm:, cl:, sec:
```

### Member Secretary
- **No tools** — Q&A only (Gemini Pro with Google Search)
- Cannot: send messages, manage calendar, save memories, manage employees

---

## Deployment & Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Telegram Bot API key |
| `BOT_NAME` | No | "Friday" | Bot display name |
| `BOT_USERNAME` | Yes | — | Telegram @username |
| `BOSS_USER_ID` | Yes | — | Boss Telegram ID |
| `BOSS_TITLE` | No | "นาย" | Title for boss in prompts |
| `BOSS_USERNAME` | Yes | — | Boss @username for mention detection |
| `BOSS_NICKNAMES` | No | `["บ๊อบ","bob"]` | JSON array of boss nicknames |
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key |
| `GOOGLE_CLIENT_ID` | No | — | For Google Calendar OAuth |
| `GOOGLE_CLIENT_SECRET` | No | — | For Google Calendar OAuth |
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | No | — | Google Calendar refresh token |
| `GOOGLE_CALENDAR_ID` | No | "primary" | Calendar ID |
| `DASHBOARD_URL` | No | — | Mini App URL |

### Deploy Commands
```bash
npm run deploy:all     # Deploy all instances (Friday + Daisy + Sigma)
npm run db:migrate:all # Run D1 migrations on all instances
```

### Multi-Instance Setup
Each instance defined in `wrangler.toml` as `[env.name]` with:
- Own D1 database binding
- Own environment variables (BOT_NAME, tokens, etc.)
- Shared codebase

---

## Feature Matrix

| Feature | Trigger | Who | AI Model | DB Tables |
|---------|---------|-----|----------|-----------|
| Boss Mention Analysis | @boss, reply, nickname | Boss | Flash | messages |
| Urgent Alert | Keyword regex | All | None | alerts |
| /readhtml | HTML file upload | Boss+Member | Flash | file_cache |
| /readpdf | PDF file upload | Boss+Member | Flash | file_cache |
| /readimg | Image upload | Boss+Member | Flash | file_cache |
| /readlink | URL command | Boss+Member | Flash | readlink_cache |
| /readvoice | Text command | Boss+Member | TTS | — |
| /send | Command (DM) | Boss | Flash | pending_sends, bot_messages |
| /task | Command | All | None | tasks |
| /tasks | Command | All | None | tasks |
| /done, /cancel | Command | All | None | tasks |
| /remember | Command | Boss | None | memories |
| /memories | Command | Boss | None | memories |
| /recap | Command (DM) | Boss+Member | Flash | messages, summaries |
| /summary | Command | Boss+Member | Flash | summaries |
| /cal | Command | Boss+Member | None | calendar_events |
| /company | Command | Boss | None | companies |
| /allow, /revoke, /users | Command | Boss | None | allowed_users |
| Secretary (boss) | Mention/DM | Boss | Pro | tasks, calendar, memories |
| Secretary (member) | Mention/DM | Member | Pro | read-only |
| Proactive Alert | Cron 3h | Internal | None | tasks |
| Proactive Insight | Cron 3h | Internal | Flash | messages, alerts |
| Daily Summary | Cron 3h | Internal | Flash | messages, summaries |
| Calendar Reminder | Cron 3h | Internal | None | calendar_events |
| Daily Digest | Cron 3h | Internal | None | tasks |
| Cleanup | Cron 3h | Internal | None | all caches |
