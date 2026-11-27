declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    RARRCORD_OWNER_EMAIL?: string;
    RARRCORD_TURN_BROKER?: string;
    RARRCORD_TURN_TOKEN?: string;
  }
}
