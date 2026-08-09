import type { z } from "zod";
import type { configSchema } from "./config.js";

export type Config = z.infer<typeof configSchema>;
export type PlatformName = "mastodon" | "bluesky" | "x";
export type MediaType = "gif" | "png" | "jpeg" | "webp";
export type ImageMimeType = "image/gif" | "image/png" | "image/jpeg" | "image/webp";
export type PlatformStatus =
  | "not_started"
  | "pending"
  | "published"
  | "failed"
  | "unknown";
export type PublicationAttemptStatus = "running" | "failed" | "published" | "partial" | "unknown";
export type PublicationAttemptPhase =
  | "input"
  | "prepare"
  | "preflight"
  | "staging"
  | "commit"
  | "push"
  | "deployment"
  | "platforms"
  | "syndication"
  | "complete";

export interface ResolvedConfig extends Config {
  configPath: string;
  configDirectory: string;
  repositoryPath: string;
  statePath: string;
  lockPath: string;
  envPath: string;
}

export interface DraftInput {
  text: string;
  imagePath?: string;
  alt?: string;
  title?: string;
  slug?: string;
  tags?: string[];
  forceXUrl?: boolean;
}

export interface PreparedMedia {
  sourcePath: string;
  fileName: string;
  type: MediaType;
  mimeType: ImageMimeType;
  bytes: number;
  width: number;
  height: number;
  frames?: number;
  sha256: string;
  publicUrl: string;
}

export interface PreparedEntry {
  slug: string;
  title: string;
  text: string;
  alt?: string;
  tags: string[];
  language: string;
  publishedAt: string;
  media?: PreparedMedia;
  contentSha256: string;
  canonicalUrl: string;
  forceXUrl: boolean;
  platformPayloads: Partial<Record<PlatformName, string>>;
  payloadSha256: Partial<Record<PlatformName, string>>;
}

export interface PlatformState {
  status: PlatformStatus;
  attempted_at?: string;
  id?: string;
  uri?: string;
  cid?: string;
  url?: string;
  error?: string;
}

export interface EntryState {
  content_sha256: string;
  media_sha256?: string;
  gif_sha256?: string;
  canonical_url: string;
  media_url?: string;
  repository_media_path?: string;
  text: string;
  alt?: string;
  tags: string[];
  language: string;
  published_at: string;
  org_social_url?: string;
  payload_sha256: Partial<Record<PlatformName, string>>;
  platforms: Record<PlatformName, PlatformState>;
}

export interface PublicationState {
  version: 1;
  entries: Record<string, EntryState>;
  attempts?: Record<string, PublicationAttempt>;
}

export interface PublicationAttempt {
  id: string;
  created_at: string;
  updated_at: string;
  status: PublicationAttemptStatus;
  phase: PublicationAttemptPhase;
  draft: DraftInput;
  destinations?: Config["destinations"];
  slug?: string;
  error?: string;
  retryable: boolean;
  worktree_files?: string[];
}

export interface PublicationHistoryRow {
  id: string;
  createdAt: string;
  slug: string;
  status: string;
  phase: string;
  platforms: Record<PlatformName, PlatformStatus>;
  nextCommand: string;
  error?: string;
}

export interface PlatformResult {
  id?: string;
  uri?: string;
  cid?: string;
  url: string;
}

export interface Credentials {
  mastodon?: { url: string; token: string };
  bluesky?: { handle: string; appPassword: string };
  x?: { accessToken: string };
}

export interface PublishSummary {
  attemptId?: string;
  slug: string;
  web: string;
  orgSocial?: string;
  platforms: Partial<Record<PlatformName, PlatformState>>;
}
