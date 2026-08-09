![Satomi-2000 header](img/header.png)

**A command-line interface (CLI) tool for microblog publishing.**

Satomi-2000 is a command-line publishing tool for a Jekyll microblog.

With a single command, you can publish text and an optional PNG, JPEG, WebP, or animated GIF image to:

- A Jekyll blog (**mandatory**)
- X (optional)
- Mastodon (optional)
- Bluesky (optional)
- Org Social (optional)

**Note:** The X API currently charges per use. Satomi-2000 blocks X payloads containing a URL unless that one run includes `--force-x`.

The Satomi-2000 project and the Jekyll site may live anywhere on the same machine. The Jekyll repository, posts directory, media directory, generated public-files directory, and public URLs are configuration values. Satomi does not assume a custom collection or a `/microblog` subpath.

## Requirements

- Node.js 20 or newer
- Git
- The Ruby, Bundler, and Jekyll toolchain required by the target site
- FFmpeg only when a publication combines an animated GIF with Bluesky

## Installation

From a checkout:

```bash
npm install
npm run build
./satomi-2000 --help
```

## Configuration

Rename `satomi.config.example.yml` to `satomi.config.yml` and complete the information.
When `--config` is omitted, Satomi-2000 reads `satomi.config.yml` from the current
working directory. `SATOMI_CONFIG` can define a different default path.

Change a destination from `true` to `false` to uncheck it:

```yaml
destinations:
  jekyll: true # Required canonical source; cannot be disabled.
  org_social: true # Generates and publishes social.org.
  mastodon: true
  bluesky: true
  x: true
```

The Jekyll filesystem paths and public URLs are independent:

```yaml
site:
  # Root or subpath where posts are publicly available. No trailing slash.
  public_url: https://example.com/microblog

  # Public URL corresponding to media_directory. No trailing slash.
  media_url: https://example.com/assets/microblog/media

  # Absolute, or relative to the directory containing this config file.
  repository_path: /Users/you/Sites/your-site

  # Relative to repository_path. This can be _posts, _microblog, or another
  # source directory already configured in Jekyll.
  posts_directory: _posts

  # An optional PNG, JPEG, WebP, or GIF is copied here.
  media_directory: assets/microblog/media

  # feed.xml, feed.json, and social.org are written here. This directory must
  # be served at public_url. Use "." for the site root.
  public_files_directory: microblog
```

Org Social has its own profile metadata and language settings. These values do
not come from the Jekyll/RSS `content` metadata:

```yaml
org_social:
  title: My Org Social journal
  nick: MyNick
  description: Notes published on Org Social
  avatar_url: https://example.com/avatar.png
  links:
    - https://example.com/microblog/
    - https://example.com/about/
  languages:
    - es
    - en
  default_language: es
```

`languages` produces the global `#+LANGUAGE` declaration. `default_language`
must be one of those values and is stored as `syndicate.org_social_language` in
each new Jekyll entry, then used for that post's `:LANG:` property. Changing the
default later therefore does not relabel existing entries. `links` may contain
zero, one, or several profile links.

Copy `.env.example` to `.env` if you run in local environment:
And fill the information.

Expected variables:

```text
MASTODON_URL
MASTODON_TOKEN
BLUESKY_HANDLE
BLUESKY_APP_PASSWORD
X_ACCESS_TOKEN
```

## Usage

Interactive publication:

```bash
./satomi-2000
```

Non-interactive publication:

```bash
./satomi-2000 post \
  -t "Enemies now react to the weapon element." \
  -i captures/slime-fire.gif
```

PNG, JPEG, and WebP use the same option and are uploaded natively without FFmpeg:

```bash
./satomi-2000 post --text "New title screen." --image captures/title.png
./satomi-2000 post --text "New key art." --image captures/key-art.jpg
./satomi-2000 post --text "New portrait." --image captures/portrait.webp
```

For a text-only publication, press Enter at the interactive image prompt or omit `--image` in a non-interactive command:

```bash
./satomi-2000 post -t "The save system is now stable."
```

Alternative text is optional and is never requested interactively. Supply it explicitly with `--alt` when wanted. Satomi-2000 sends provided alt text only through platform features that support it: Mastodon media descriptions, Bluesky image/video alt, and X image metadata for PNG, JPEG, and WebP. X animated GIF uploads do not receive image-only alt metadata.

`--text`, `--image`, and `--alt` also have the short forms `-t`, `-i`, and `-a`.

Formats are detected from their file signatures. With `validation.require_matching_image_extension` enabled, JPEG accepts either `.jpg` or `.jpeg`; PNG and WebP require `.png` and `.webp`. The existing `max_png_mb` platform setting is the shared size limit for all three static image formats.

The title is derived from the first sentence. The slug uses the local date plus the image filename, or the derived title for a text-only post. Both can be supplied explicitly with `--title` and `--slug`. Tags default to `content.default_tags` and can be replaced with `--tags tag-one,tag-two`.

Other commands:

```bash
# Validate credentials, limits, media, target files, and a temporary Jekyll build.
./satomi-2000 validate --text "..." --image capture.png

# Build the actual Jekyll repository without committing or publishing.
./satomi-2000 preview

# Show the 10 most recent publications and failed attempts as a table.
./satomi-2000 history

# Read local state without consulting social APIs.
./satomi-2000 status 2026-08-08-slime-fire

# Retry a failure that happened before the Jekyll commit, using its history ID.
./satomi-2000 retry A000001

# Retry one failed social platform. Published and ambiguous attempts are rejected.
./satomi-2000 retry A000002 --platform mastodon
```

Run `./satomi-2000 --help` for the command overview, or
`./satomi-2000 post --help` for all publication options.

The usual forms are:

```bash
# Text only
./satomi-2000 post -t "A text-only update."

# Text and image
./satomi-2000 post -t "Animation update." -i game.gif

# Text, image, and optional alternative text
./satomi-2000 post -t "Animation update." -i game.gif -a "The player running"
```

### Per-run destination exclusions

Without `--exclude`/`-e`, Satomi uses the destinations checked in
`satomi.config.yml`. The option temporarily unchecks destinations for one
`post` or `validate` run; it never edits the configuration and cannot enable a
destination whose configured value is `false`. Jekyll is mandatory and cannot
be excluded.

The codes can be combined in any order:

- `o`: Org Social (`social.org`)
- `x`: X
- `m`: Mastodon
- `b`: Bluesky
- `t`: Telegram (accepted now and reserved for the future adapter)

For example, this publishes everywhere enabled by the configuration except
Telegram and X:

```bash
./satomi-2000 post -t "No Telegram or X for this update." -e tx
```

This leaves only the mandatory Jekyll publication:

```bash
./satomi-2000 post -t "Jekyll only." -e xtmbo
```

See [Publication history and recovery](#publication-history-and-recovery) for attempt IDs, status and phase definitions, worktree conflict resolution, and safe retry procedures.

If X is selected and its final payload contains any URL, validation stops before creating files or calling social APIs. Authorize only that higher-cost publication explicitly:

```bash
./satomi-2000 post --text "Full notes: https://example.com/update" --force-x
```

The same flag is required for an X retry containing a URL. `--force-x` does not bypass character limits, media limits, duplicate protection, daily X limits, or the configured maximum cost.

Use `--config /private/path/config.yml` or set `SATOMI_CONFIG` when the private configuration is stored elsewhere.

## Publication history and recovery

Satomi records a publication attempt before it starts inspecting media, running preflight checks, staging Jekyll files, or calling a social API. This makes failures that happen before a post exists recoverable and distinguishes them from posts that reached Jekyll or a social platform.

The history is stored locally in the `attempts` object of the configured `state.file` (normally `.satomi/state.json`). This private state is excluded from Git by the supplied `.gitignore`. It contains the post text and may contain an absolute local media path, so it should not be published or shared. `history` only reads this local state; it does not call Jekyll, GitHub, Mastodon, Bluesky, or X.

### Listing recent attempts

Run without options to show the 10 most recent posts and attempts:

```bash
satomi-2000 history
```

Choose a different number, from 1 through 100, with `--limit`:

```bash
satomi-2000 history --limit 25
```

Example output:

```text
ID       WHEN              STATUS     PHASE     SLUG                          NETWORKS          NEXT
-------  ----------------  ---------  --------  ----------------------------  ----------------  ----------------------------------------------
A000003  2026-08-09 12:40  failed     staging   2026-08-09-bubble-bobble      M:- B:- X:-       satomi-2000 resolve A000003
A000002  2026-08-09 12:10  partial    complete  2026-08-09-new-title-screen   M:ok B:fail X:ok  satomi-2000 retry A000002 --platform bluesky
A000001  2026-08-09 11:50  published  complete  2026-08-09-save-system        M:ok B:ok X:-     -

Details:
A000003: Generated target files have local changes: M microblog/feed.json ...
```

The columns mean:

| Column | Meaning |
| --- | --- |
| `ID` | Stable attempt identifier. Use this value with `retry` or `resolve`. New IDs use the form `A000001`. |
| `WHEN` | Attempt start time in `content.timezone`. |
| `STATUS` | Overall result of the publication attempt. |
| `PHASE` | Last pipeline phase reached. It identifies where the failure occurred. |
| `SLUG` | Deterministic Jekyll slug. It may be known even when no post was created. |
| `NETWORKS` | Compact Mastodon (`M`), Bluesky (`B`), and X state: `ok`, `fail`, `...`, `?`, or `-`. |
| `NEXT` | Complete safe command to run next. `-` means that no recovery action is required. |

Long error messages are printed below the table under `Details`. Entries created before attempt history was introduced appear with phase `legacy`; their slug is their identifier.

### Attempt statuses

| Status | Meaning | Safe action |
| --- | --- | --- |
| `running` | A publication currently owns the Satomi lock and has not finished. | Wait for it to finish. Do not start another publication. |
| `failed` | The operation stopped with a definite error. Nothing after the displayed phase should be assumed to have happened. | Follow `NEXT`. A pre-commit failure can normally be retried by attempt ID. |
| `published` | The canonical Jekyll publication completed and every selected social destination completed. Unchecked networks remain `-`. | No retry is needed. |
| `partial` | Jekyll completed, but one or more selected social platforms failed definitively. | Retry only a platform whose state is `failed`. |
| `unknown` | A social create request may have reached the remote service, but its result could not be confirmed. | Inspect the remote account manually. Satomi deliberately refuses an automatic retry to prevent duplicates. |

Network state abbreviations are:

| Value | Stored state | Meaning |
| --- | --- | --- |
| `ok` | `published` | The platform returned a successful publication result. |
| `fail` | `failed` | The platform returned a definite failure and may be retried. |
| `...` | `pending` | An attempt was recorded but has no safe final result yet. Reconcile it manually. |
| `?` | `unknown` | The request outcome is ambiguous. Check the platform before doing anything else. |
| `-` | `not_started` | The destination was unchecked or no request was attempted. This is not a failure. |

### Pipeline phases

| Phase | What Satomi was doing |
| --- | --- |
| `input` | The draft was collected and assigned an attempt ID. |
| `prepare` | Text, slug, title, tags, media signature, dimensions, MIME type, limits, and payloads were being prepared. |
| `preflight` | Required tools, Git branch, credentials, platform guardrails, and remote Mastodon limits were being checked. |
| `staging` | Satomi was creating and building a temporary Jekyll copy or checking whether generated target files were clean. No staged files had been applied to the real repository yet. |
| `commit` | Generated files were being applied and committed to the real Jekyll repository. Automatic full-publication retry is intentionally conservative after this phase begins. |
| `push` | The canonical Git commit was being pushed. |
| `deployment` | Satomi was waiting for the canonical post and media URLs to become publicly available. |
| `platforms` | Selected Mastodon, Bluesky, and X publications were running. Each network keeps its own state. |
| `syndication` | Optional public syndication metadata was being updated. |
| `complete` | The pipeline finished. Read `STATUS` and `NETWORKS` for its final result. |
| `legacy` | The post predates attempt-level history and only the older publication state is available. |

### Retrying a failure before the Jekyll commit

For a safely retryable failure in `prepare`, `preflight`, or `staging`, use the attempt ID shown in `NEXT`:

```bash
satomi-2000 retry A000003
```

Satomi reuses the same attempt instead of creating another history row. The stored recovery draft includes:

- The original post text and optional alternative text.
- An absolute media path, so retrying from another working directory does not change the selected file.
- The resolved slug, title, and tags, so later configuration changes do not silently change the post identity.
- The original per-run X URL authorization setting.

The media file must still exist and retain valid contents. All current safety checks, credentials, size limits, cost guardrails, Git checks, and the temporary Jekyll build run again. `retry` does not bypass validation.

### Understanding a dirty generated file such as `feed.json`

This error does **not** mean that the new post was published:

```text
ERROR: Generated target files have local changes:
M microblog/feed.json
Resolve them before publishing.
Nothing was created or published.
```

It means that a file Satomi needs to regenerate already differs from the current Git commit in the configured Jekyll repository. The difference may have come from manual edits, another tool, a previous development task, or changes to existing post source files that were reflected in the generated feed. Satomi stops during `staging` before copying the new post into the real repository because overwriting or committing those changes could lose work or make the feed inconsistent with its source posts.

The attempt is recorded as `failed`, and `history` shows an ID plus a `resolve` command:

```bash
satomi-2000 resolve A000003
```

Without additional options, `resolve` does not modify the Jekyll worktree. It lists the repository and every recorded file that is still locally changed; if all blockers were already handled, it only clears their stale markers from Satomi's private state. Review changed files with Git before choosing what they mean:

```bash
git -C /absolute/path/to/your-jekyll-repository status --short
git -C /absolute/path/to/your-jekyll-repository diff -- microblog/feed.json
```

If the local changes are intentional, preserve all files listed by `resolve` in a local commit:

```bash
satomi-2000 resolve A000003 --keep-local-changes
```

This option validates the configured branch, refuses to mix with already staged work, commits only the files recorded for that failed attempt, and prints the resulting commit hash. It does not push by itself. A later successful publication may push that local commit together with the new post.

If the local changes are unwanted, restore or otherwise correct them manually with Git. Satomi provides no discard flag and never deletes local work automatically. For a reviewed, tracked file, a typical Git command is:

```bash
git -C /absolute/path/to/your-jekyll-repository restore -- microblog/feed.json
```

Run `resolve` again after handling the files. When no recorded blockers remain, it clears the stale blocker and prints the retry command:

```bash
satomi-2000 resolve A000003
satomi-2000 retry A000003
```

### Retrying a failed social platform

If Jekyll succeeded but a social destination has the definite state `failed`, retry only that destination:

```bash
satomi-2000 retry A000002 --platform mastodon
satomi-2000 retry A000002 --platform bluesky
satomi-2000 retry A000002 --platform x
```

When exactly one platform failed, the attempt ID alone is also sufficient; Satomi can infer it. Supplying `--platform` is clearer and is required when multiple platforms failed.

For an X payload containing a URL, authorize the higher configured cost for that retry explicitly:

```bash
satomi-2000 retry A000002 --platform x --force-x
```

Satomi rebuilds the platform payload and verifies its hash against the original publication before retrying. If configuration changes would alter the payload, retry stops and asks you to restore the original configuration. A platform with state `published`, `not_started`, `pending`, or `unknown` cannot be retried.

For an old entry whose history ID is its slug, include the platform explicitly:

```bash
satomi-2000 retry 2026-08-08-slime-fire --platform mastodon
```

### Failures that cannot be recorded

Attempt history starts after Satomi has loaded a valid configuration, acquired its publication lock, and collected the draft. Failures before that point cannot be written as a normal attempt. Examples include an unreadable or invalid configuration file, an existing publication lock, terminal input failure, or an unreadable state file. Their error remains visible in the terminal, but no retry ID is created.

Similarly, failures at or after the `commit` phase may require manual Git or remote reconciliation because Satomi can no longer safely assume that nothing happened. Such rows use `manual-check` instead of offering an automatic retry.

## Platform behavior

### Org Social

When `destinations.org_social` is checked, Satomi-2000 publishes `social.org` under `site.public_files_directory` as part of the same Jekyll deployment. It requires no API key and does not use Emacs. The choice is stored in each entry's front matter, so an entry published while Org Social is unchecked will not appear retroactively if the file is regenerated later.

The `org_social` block controls the profile header independently from Jekyll,
RSS, and JSON Feed. It supports a dedicated title, nick, description, avatar,
multiple links, advertised languages, and a default language for new posts.

### Mastodon

Satomi-2000 optionally reads the instance configuration, verifies its advertised MIME support, applies the lower remote limits, uploads an attached PNG, JPEG, WebP, or GIF with a media description, waits for media processing, and creates the status with an idempotency key derived from the slug. Text-only statuses skip media upload.

### Bluesky

An animated GIF is converted to a silent H.264 MP4 with even dimensions and `yuv420p`, then published as `app.bsky.embed.video`. PNG, JPEG, and WebP are uploaded directly with their real MIME type as `app.bsky.embed.images`; they are never converted to MP4. Text-only posts have no embed. All variants use a persisted AT Protocol TID record key for safe retries and the same rich-text facet handling.

### X

Satomi-2000 uses the official chunked media workflow (`INIT`, `APPEND`, `FINALIZE`, and `STATUS`) for an attached PNG, JPEG, WebP, or GIF and creates exactly one post. Supported image metadata is added to static-image uploads. Text-only posts skip media upload. A timeout or server error after the create request is stored as `unknown`; Satomi-2000 will not retry it. Reconcile the account manually first.

X is selected in the example so all choices are visible. Uncheck it until credentials and cost controls are ready. API pricing and access rules can change, so review the developer console before leaving it selected. Cost estimates are configuration values, not hard-coded assumptions.

Official references:

- [Jekyll posts](https://jekyllrb.com/docs/posts/)
- [Jekyll collections](https://jekyllrb.com/docs/collections/)
- [Org Social](https://org-social.org/)
- [Bluesky video uploads](https://docs.bsky.app/docs/tutorials/video)
- [Bluesky image embeds](https://docs.bsky.app/docs/tutorials/creating-a-post#images-embeds)
- [Mastodon media API](https://docs.joinmastodon.org/methods/media/)
- [Mastodon supported attachment formats](https://docs.joinmastodon.org/user/posting/#attachments)
- [Mastodon status API](https://docs.joinmastodon.org/methods/statuses/)
- [X chunked media uploads](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)
- [X image specifications](https://docs.x.com/x-api/media/quickstart/best-practices#image-specifications-and-recommendations)
- [X create post API](https://docs.x.com/x-api/posts/create-post)

## Development

```bash
npm run typecheck
npm test
npm run build

# All checks
npm run check
```

### Make the command available permanently (macOS and zsh)

Running `export` directly in a terminal only affects that terminal session. The
setting disappears when the terminal is closed. To keep it permanently, first
run `pwd` from the Satomi-2000 project directory to find its absolute path.

Then open the zsh configuration file:

```bash
nano ~/.zshrc
```

Add these lines, replacing `/absolute/path/to/satomi` with the project directory:

```bash
export PATH="/absolute/path/to/satomi:$PATH"
export SATOMI_CONFIG="/absolute/path/to/satomi/satomi.config.yml"
```

Save the file and reload the shell configuration:

```bash
source ~/.zshrc
```

Verify both settings:

```bash
command -v satomi-2000
echo "$SATOMI_CONFIG"
satomi-2000 --help
```

The executable and configuration will now be available in new terminal
sessions. Relative image paths are still resolved from the terminal's current
directory, so use an absolute image path when publishing from elsewhere.

## License

MIT
