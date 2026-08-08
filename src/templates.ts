import matter from "gray-matter";
import type { EntryState, PreparedEntry, PublicationState, ResolvedConfig } from "./types.js";

export interface ContentEntry {
  slug: string;
  title: string;
  date: string;
  image?: string;
  alt?: string;
  tags: string[];
  language: string;
  text: string;
  orgSocial: boolean;
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absoluteUrl(config: ResolvedConfig, value: string): string {
  if (value.startsWith("http")) return value;
  const origin = new URL(config.site.public_url).origin;
  return new URL(value.startsWith("/") ? value : `/${value}`, origin).toString();
}

export function contentEntryFromPrepared(entry: PreparedEntry, config: ResolvedConfig): ContentEntry {
  const result: ContentEntry = {
    slug: entry.slug,
    title: entry.title,
    date: entry.publishedAt,
    tags: entry.tags,
    language: entry.language,
    text: entry.text,
    orgSocial: config.destinations.org_social,
  };
  if (entry.media) result.image = `${config.site.media_url}/${entry.media.fileName}`;
  if (entry.alt) result.alt = entry.alt;
  return result;
}

export function renderPost(entry: ContentEntry, config: ResolvedConfig): string {
  const publicPath = new URL(config.site.public_url).pathname.replace(/\/$/, "");
  const frontMatter: Record<string, unknown> = {
    satomi: true,
    title: entry.title,
    date: entry.date,
    slug: entry.slug,
    permalink: `${publicPath}/${entry.slug}/`.replace(/^\/\//, "/"),
    lang: entry.language,
    tags: entry.tags,
    syndicate: {
      org_social: entry.orgSocial,
      mastodon: config.destinations.mastodon,
      bluesky: config.destinations.bluesky,
      x: config.destinations.x,
    },
  };
  if (entry.image) frontMatter.image = entry.image;
  if (entry.alt) frontMatter.alt = entry.alt;
  return matter.stringify(`${entry.text.trim()}\n`, frontMatter);
}

function orgTimestamp(isoDate: string): string {
  return isoDate.replace(/\.\d{3}Z$/, "+0000").replace(/([+-]\d{2}):(\d{2})$/, "$1$2");
}

export function renderSocialOrg(entries: ContentEntry[], config: ResolvedConfig): string {
  const header = [
    `#+TITLE: ${config.content.title}`,
    `#+NICK: ${config.content.nick}`,
    `#+DESCRIPTION: ${config.content.description}`,
    `#+AVATAR: ${config.content.avatar_url}`,
    `#+LINK: ${config.site.public_url}/`,
    "",
    "* Posts",
  ];
  const posts = entries.filter((entry) => entry.orgSocial).flatMap((entry) => {
    const post = [
      "",
      `** ${orgTimestamp(entry.date)}`,
      ":PROPERTIES:",
      `:LANG: ${entry.language}`,
      `:TAGS: ${entry.tags.join(" ")}`,
      ":END:",
      "",
      entry.text.trim(),
    ];
    if (entry.image) post.push("", `[[${absoluteUrl(config, entry.image)}][${entry.alt ?? ""}]]`);
    return post;
  });
  return `${[...header, ...posts].join("\n")}\n`;
}

export function renderRss(entries: ContentEntry[], config: ResolvedConfig): string {
  const channelUrl = `${config.site.public_url}/`;
  const items = entries
    .map((entry) => {
      const url = `${config.site.public_url}/${entry.slug}/`;
      const image = entry.image
        ? `<p><img src="${xml(absoluteUrl(config, entry.image))}" alt="${xml(entry.alt ?? "")}"></p>`
        : "";
      const description = `<p>${xml(entry.text)}</p>${image}`;
      return [
        "    <item>",
        `      <title>${xml(entry.title)}</title>`,
        `      <link>${xml(url)}</link>`,
        `      <guid isPermaLink="true">${xml(url)}</guid>`,
        `      <pubDate>${new Date(entry.date).toUTCString()}</pubDate>`,
        `      <description>${xml(description)}</description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xml(config.content.title)}</title>
    <link>${xml(channelUrl)}</link>
    <description>${xml(config.content.description)}</description>
    <language>${xml(config.content.language)}</language>
${items}
  </channel>
</rss>
`;
}

export function renderJsonFeed(entries: ContentEntry[], config: ResolvedConfig): string {
  const home = `${config.site.public_url}/`;
  return `${JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: config.content.title,
      home_page_url: home,
      feed_url: `${config.site.public_url}/feed.json`,
      description: config.content.description,
      language: config.content.language,
      items: entries.map((entry) => {
        const url = `${config.site.public_url}/${entry.slug}/`;
        const item: Record<string, unknown> = {
          id: url,
          url,
          title: entry.title,
          content_text: entry.text,
          date_published: entry.date,
          tags: entry.tags,
          language: entry.language,
        };
        if (entry.image) item.image = absoluteUrl(config, entry.image);
        return item;
      }),
    },
    null,
    2,
  )}\n`;
}

export function renderSyndicationData(state: PublicationState): string {
  const data = Object.fromEntries(
    Object.entries(state.entries).map(([slug, entry]: [string, EntryState]) => [
      slug,
      Object.fromEntries(
        Object.entries(entry.platforms)
          .filter(([, platform]) => platform.status === "published")
          .map(([name, platform]) => [name, { url: platform.url, id: platform.id, uri: platform.uri }]),
      ),
    ]),
  );
  return `${JSON.stringify(data, null, 2)}\n`;
}

