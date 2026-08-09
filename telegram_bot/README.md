# Satomi Telegram Worker

Authenticated Cloudflare Worker gateway used to publish Satomi entries to one
Telegram channel. The Telegram bot token and channel identifier remain in
Cloudflare; Satomi will only hold a separate, revocable gateway token.

This directory is an independent npm project inside the Satomi repository. It
does not contain a nested Git repository.

Node.js 22 or newer is required by the current Wrangler toolchain. The
`.node-version` file documents the local and CI runtime.

## Endpoints

- `GET /health` is public and returns the service version.
- `POST /validate` requires bearer authentication and verifies the bot, channel,
  and `can_post_messages` permission without publishing.
- `POST /publish` requires bearer authentication and publishes one entry.

The publication payload contains the final Telegram text:

```json
{
  "slug": "2026-08-09-new-animation",
  "text": "New animation finished.\n\nhttps://example.com/microblog/new-animation/",
  "media": {
    "url": "https://example.com/media/new-animation.gif",
    "type": "gif"
  }
}
```

`media` is optional. PNG and JPEG use `sendPhoto`, GIF uses `sendAnimation`,
and WebP currently uses `sendDocument`.

## Local checks

Unit tests mock Telegram and require no credentials:

```bash
npm install
npm run check
```

`npm run dev` uses Wrangler. `.dev.vars.example` documents the required
bindings, but do not copy a production Telegram token locally when the token is
intended to remain exclusively in Cloudflare.

## Cloudflare secrets

Configure these as encrypted Worker secrets, never as plaintext `vars`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHANNEL_ID`
- `TELEGRAM_GATEWAY_TOKEN` (at least 32 random characters)

The names are declared in `wrangler.jsonc`; their values are not part of this
repository. No deployment has been performed as part of the local scaffold.
