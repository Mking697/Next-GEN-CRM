import "server-only";
import { JWT } from "google-auth-library";
import { env, isDriveEnabled, isGoogleEnabled } from "./env";

/**
 * The thin Google client: a service-account JWT plus direct REST calls.
 *
 * Deliberately not the `googleapis` package. That pulls in every Google API
 * surface and tens of megabytes for what is, here, four endpoints: read a
 * range, append a row, update a range, upload a file. google-auth-library is
 * under a megabyte and does the only genuinely hard part, which is signing.
 *
 * Everything below throws GoogleError on failure. Callers are expected to
 * catch: the database is the source of truth and the mirror is allowed to be
 * behind, so a Google outage must never fail a save.
 */

export class GoogleError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
  }
}

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

let client: JWT | null = null;

function jwt(): JWT {
  if (!isGoogleEnabled()) {
    throw new GoogleError(
      "Google is not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY and GOOGLE_SHEET_ID.",
    );
  }
  if (!client) {
    client = new JWT({
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim(),
      key: normalisePrivateKey(env.GOOGLE_PRIVATE_KEY),
      scopes: SCOPES,
    });
  }
  return client;
}

const PEM_HEADER = "-----BEGIN PRIVATE KEY-----";
const PEM_FOOTER = "-----END PRIVATE KEY-----";

/**
 * Rebuild the PEM from however it survived being pasted somewhere.
 *
 * There are three ways the same key arrives mangled, and all of them fail the
 * same useless way: a bare 401 from Google with nothing pointing at the cause.
 *
 *   - A .env file strips the surrounding quotes; a panel text box does not,
 *     so the value arrives wrapped in literal quote characters.
 *   - Escaped \n has to come back as real newlines.
 *   - A panel field is a single line, so pasting the multi-line PEM into it
 *     silently turns every newline into a space.
 *
 * Rather than guess which happened, the body is stripped of all whitespace and
 * re-wrapped at 64 characters. That is safe because base64 contains no spaces
 * or newlines of its own, so nothing is lost and nothing is ambiguous. The
 * header and footer are matched first precisely because they DO contain
 * spaces, which is why blindly swapping spaces for newlines would not work.
 */
function normalisePrivateKey(raw: string): string {
  let key = raw.trim();

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  key = key.replace(/\\n/g, "\n").trim();

  const start = key.indexOf(PEM_HEADER);
  const end = key.indexOf(PEM_FOOTER);

  if (start === -1 || end === -1) {
    throw new GoogleError(
      "GOOGLE_PRIVATE_KEY is not a complete PEM key. Paste the whole private_key value from the service account JSON, including the -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- lines.",
    );
  }

  const body = key
    .slice(start + PEM_HEADER.length, end)
    .replace(/\s+/g, "");

  if (body.length === 0) {
    throw new GoogleError("GOOGLE_PRIVATE_KEY has no key data between its BEGIN and END lines.");
  }

  const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `${PEM_HEADER}\n${wrapped}\n${PEM_FOOTER}\n`;
}

async function call(
  url: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const token = await jwt().getAccessToken();
  if (!token.token) throw new GoogleError("Could not obtain an access token.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.GOOGLE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token.token}`,
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { raw: text.slice(0, 400) };
      }
    }

    if (!response.ok) {
      const detail =
        (body.error as { message?: string } | undefined)?.message ??
        `HTTP ${response.status}`;
      throw new GoogleError(detail, response.status);
    }
    return body;
  } catch (error) {
    if (error instanceof GoogleError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GoogleError("Google did not answer in time.");
    }
    throw new GoogleError(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

function sheetId(): string {
  return env.GOOGLE_SHEET_ID;
}

/** Read a range, e.g. "Clientdata!A2:F". Missing values come back as []. */
export async function readRange(range: string): Promise<string[][]> {
  const body = await call(
    `${SHEETS}/${sheetId()}/values/${encodeURIComponent(range)}`,
  );
  const values = body.values;
  return Array.isArray(values) ? (values as string[][]) : [];
}

/**
 * Append a row to a tab, writing the header first if the tab is still empty.
 *
 * The header is written in the same call sequence rather than by hand, so the
 * very first quotation is what creates it and nobody has to remember to set
 * the sheet up beforehand.
 */
export async function appendRow(
  tab: string,
  header: string[],
  row: (string | number)[],
): Promise<{ rowNumber: number | null }> {
  const existing = await readRange(`${tab}!A1:A1`);
  if (existing.length === 0) {
    await call(
      `${SHEETS}/${sheetId()}/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: [header] }),
      },
    );
  }

  const body = await call(
    `${SHEETS}/${sheetId()}/values/${encodeURIComponent(`${tab}!A1`)}:append` +
      `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    },
  );

  // "SALES CRM!A7:S7" -> 7, so the row can be pointed at later.
  const updates = body.updates as { updatedRange?: string } | undefined;
  const match = updates?.updatedRange?.match(/!\D+(\d+)/);
  return { rowNumber: match?.[1] ? Number(match[1]) : null };
}

/** Overwrite a specific row, used when a quotation is mirrored again. */
export async function writeRow(
  tab: string,
  rowNumber: number,
  row: (string | number)[],
): Promise<void> {
  await call(
    `${SHEETS}/${sheetId()}/values/${encodeURIComponent(`${tab}!A${rowNumber}`)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    },
  );
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

/**
 * Upload a PDF into the configured folder.
 *
 * `supportsAllDrives` is not optional here: the folder lives in a Shared
 * Drive, which is the only way a service account can own a file at all. A
 * service account has no Drive storage quota of its own, so uploading into a
 * personal My Drive folder fails with storageQuotaExceeded no matter how the
 * folder is shared.
 */
export async function uploadPdf(
  name: string,
  pdf: Buffer,
): Promise<{ id: string; url: string }> {
  if (!isDriveEnabled()) {
    throw new GoogleError(
      "Drive is not configured. Set GOOGLE_DRIVE_FOLDER_ID to a folder inside a Shared Drive.",
    );
  }

  const boundary = `crm${Date.now()}${Math.random().toString(36).slice(2)}`;
  const metadata = {
    name,
    parents: [env.GOOGLE_DRIVE_FOLDER_ID],
    mimeType: "application/pdf",
  };

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\ncontent-type: application/pdf\r\n\r\n`,
      "utf8",
    ),
    pdf,
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);

  const result = await call(
    "https://www.googleapis.com/upload/drive/v3/files" +
      "?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink",
    {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(body),
    },
  );

  const id = String(result.id ?? "");
  if (!id) throw new GoogleError("Drive did not return a file id.");

  return {
    id,
    url:
      typeof result.webViewLink === "string"
        ? result.webViewLink
        : `https://drive.google.com/file/d/${id}/view`,
  };
}

/**
 * Replace an already-uploaded PDF in place, so re-mirroring a quotation does
 * not leave a trail of near-identical files behind.
 */
export async function replacePdf(fileId: string, pdf: Buffer): Promise<void> {
  await call(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}` +
      "?uploadType=media&supportsAllDrives=true",
    {
      method: "PATCH",
      headers: { "content-type": "application/pdf" },
      body: new Uint8Array(pdf),
    },
  );
}

/** A quick reachability probe for the Lead sources page. */
export async function googleHealth(): Promise<{
  ok: boolean;
  spreadsheetTitle?: string;
  tabs?: string[];
  error?: string;
}> {
  if (!isGoogleEnabled()) return { ok: false, error: "not configured" };
  try {
    const body = await call(
      `${SHEETS}/${sheetId()}?fields=properties.title,sheets.properties.title`,
    );
    const properties = body.properties as { title?: string } | undefined;
    const sheets = (body.sheets ?? []) as {
      properties?: { title?: string };
    }[];
    return {
      ok: true,
      spreadsheetTitle: properties?.title,
      tabs: sheets.map((sheet) => sheet.properties?.title ?? "").filter(Boolean),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
