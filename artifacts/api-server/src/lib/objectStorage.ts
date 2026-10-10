/**
 * Replit App Storage (a GCS bucket) through the local Replit sidecar, which
 * works in both the workspace and the published app. Development and
 * production share the bucket named by DEFAULT_OBJECT_STORAGE_BUCKET_ID.
 *
 * Only signed URLs are used here: clients fetch objects straight from GCS, so
 * large files never stream through this (single-instance) API server.
 */
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export function appBucketId(): string | null {
  return process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"] || null;
}

/** A V4 signed URL for one object, valid for `ttlSec`. Throws if the sidecar refuses. */
export async function signObjectUrl(options: {
  bucketName: string;
  objectName: string;
  method: "GET" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: options.bucketName,
      object_name: options.objectName,
      method: options.method,
      expires_at: new Date(Date.now() + options.ttlSec * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Object URL signing failed with status ${response.status}`);
  const { signed_url: signedUrl } = (await response.json()) as { signed_url?: string };
  if (!signedUrl) throw new Error("Object URL signing returned no URL");
  return signedUrl;
}
