/** Trusted project-binding source frozen when a Session is first created. */
export type SessionProjectBindingSource = "config" | "explicit";

/** Internal binding provenance used for project-scoped checkpoint behavior. */
export interface SessionProjectBinding {
  sessionId: string;
  spaceId: string;
  source: SessionProjectBindingSource;
  configPath?: string;
}
