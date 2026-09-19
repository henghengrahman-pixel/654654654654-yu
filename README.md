# AI LIVECHAT 8008 — Production Durable Ingress

Current release: v1.32.3

Version 1.32.3. Existing business workflows are preserved. This release hardens LiveChat lifecycle consistency: newest-thread selection is chronological, provider-confirmed inactive chats are removed and archived immediately, deep-sync misses are verified before closure, and transient PostgreSQL disconnects no longer terminate the Node process.

## Runtime architecture

LiveChat Webhook -> PostgreSQL `livechat_ingress_jobs` -> ingress worker -> existing AI/workflow engine -> Agent Chat Web API. Fast active-chat polling remains a recovery path; a full active-chat deep sync runs separately and paginates with the Agent Chat API v3.6 contract. Historical/inactive chats are not scanned in the 1-second hot path.

Important guarantees at the application layer: no intentional active-chat count cap, durable ingress across Railway restarts, per-chat serialized jobs, event/job deduplication, a separate customer-event processing ledger so a provider failure after message persistence is still retryable, stale-job recovery, exponential retry for transient provider failures, human takeover priority, immediate closed-chat send guard, and active/closed reconciliation that verifies missing chats before local closure so a temporary provider-list miss cannot make an active conversation disappear.

## LiveChat API requirements

Use Agent Chat Web API v3.6 credentials with read/write access to the required groups. `deactivate_chat` is sent with `id` and `ignore_requester_presence:true`. `list_chats` uses `filters.active:true`; only the first page sends filters/limit/sort order, while subsequent pages send `page_id` only. `send_event` sends only the documented `chat_id` and `event` fields. If LiveChat returns `403 Requester is not user of the chat`, the client adds the PAT requester with `add_user_to_chat` + `ignore_requester_presence:true` and retries that send exactly once; unrelated 403 responses are never masked. File upload sends only the multipart `file`, and file events send `type`, `url`, and `visibility` rather than response-only metadata.

If webhook ingress is exposed in production, set `LIVECHAT_WEBHOOK_SECRET` and configure the upstream webhook/proxy to send `x-livechat-signature` as the HMAC-SHA256 hex digest of the raw JSON body using the same secret. The endpoint acknowledges only after the event is persisted to PostgreSQL.

## Railway

Set all secrets in Railway Variables; never commit them. At minimum configure `DATABASE_URL`, `BRAIN_DATABASE_URL` (or allow the configured fallback), `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` (32+ chars), `LIVECHAT_ACCOUNT_ID`, `LIVECHAT_PAT`, and `OPENAI_API_KEY`. Telegram variables are required only when the Telegram bridge is enabled. Set `LIVECHAT_REQUESTER_USER_ID` to the exact LiveChat agent email/user ID that owns `LIVECHAT_PAT` when membership recovery is required. The app only infers it from `LIVECHAT_ACCOUNT_ID` when that value is unambiguously an email; numeric account/license IDs are never used as Agent Chat `user_id`.

Run `npm run verify` before deploy. Production starts with `npm start`.

## LiveChat requester identity (v1.32.2+)

When `LIVECHAT_INBOX_MODE=all_active`, the bot can discover chats that the PAT owner has not joined yet. LiveChat requires the requester to be a chat user before `send_event`. Set `LIVECHAT_REQUESTER_USER_ID` to the exact LiveChat agent email/user ID that owns `LIVECHAT_PAT`. Do not put the numeric license/account ID here. The app no longer guesses a numeric `LIVECHAT_ACCOUNT_ID` as `user_id`, because LiveChat rejects that with `422 user_id not found`.


## Lifecycle consistency (v1.32.3)

`/conversations` is an active-thread view. Thread selection never assumes the last array element is newest; it selects the newest thread by `created_at` because Agent Chat `get_chat` defaults to newest threads first. A `422 Chat not active`, inactive `get_chat`, `chat_deactivated`, or confirmed missing chat closes the local send gate, archives the session, and removes it from `/conversations`. A chat missing from one deep-sync inventory is not closed blindly; it is verified with `get_chat` first, and transient verification failures fail open for visibility so an active chat does not disappear from the operator inbox.

The PostgreSQL pool also attaches error listeners to checked-out clients. Railway/PostgreSQL restarts such as `57P01 terminating connection due to administrator command` are logged and recovered instead of becoming an unhandled Node EventEmitter crash. Database transactions that archive sessions or reset session state use one dedicated pooled client for BEGIN/COMMIT/ROLLBACK.

## Token-efficiency hotfix (v1.33.2)

The AI Agent now keeps the same operational/session behavior while reducing repeated model context: recent prompt turns are bounded with operational anchors preserved, relevant brain sources are capped before model submission, provider-facing internal IDs are omitted, and long-history digests are cached incrementally per session instead of being regenerated from the beginning on every turn. New-session creation still clears digest/case state, so this optimization does not reuse old-session context.

Actual OpenAI token usage remains visible in `ai_logs.prompt_tokens/output_tokens/total_tokens` when the provider returns usage.

## v1.33.3 LiveChat Lane Separation
Conversations now separates **MY CHATS / QUEUED / SUPERVISED**. Only MY CHATS enters heavy AI processing; QUEUED and SUPERVISED remain lightweight metadata lanes until LiveChat routing changes. **Traffic** is intentionally not polled by the bot and opens the provider Traffic view directly. Keep `LIVECHAT_INBOX_MODE=all_active` when you want all lanes discovered.
