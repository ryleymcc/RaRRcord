declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    RARRCORD_OWNER_EMAIL?: string;
    /** "access" (Cloudflare Access) or "sites" (OpenAI Sites). Unset signs nobody in. */
    RARRCORD_AUTH?: string;
    /** Cloudflare Access team domain, such as myteam.cloudflareaccess.com. */
    CF_ACCESS_TEAM_DOMAIN?: string;
    /** The Access application's Audience (AUD) tag. */
    CF_ACCESS_AUD?: string;
    /** Cloudflare TURN key id and API token (Realtime > TURN in the dashboard). */
    RARRCORD_TURN_KEY_ID?: string;
    RARRCORD_TURN_KEY_TOKEN?: string;
    RARRCORD_TURN_BROKER?: string;
    RARRCORD_TURN_TOKEN?: string;
  }
}
