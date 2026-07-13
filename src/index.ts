import { AwsClient } from "aws4fetch";

const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIRMATION_RESEND_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_EMAIL_LENGTH = 254;
const MAX_EXPORT_PAGE_SIZE = 1000;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_SES_RESPONSE_BYTES = 16 * 1024;
const SES_REQUEST_TIMEOUT_MS = 15_000;
const WEBSITE_ORIGIN = "https://hackthehill.com";
const PRIVACY_POLICY_URL = "https://cdn1.hackthehill.com/legal/privacy-policy.pdf";

type SubscriberStatus = "pending" | "active" | "unsubscribed";
type Locale = "en" | "fr";

type SubscriberRow = {
	email_normalized: string;
	status: SubscriberStatus;
	confirmation_sent_at: string | null;
	preferred_locale: Locale;
};

type RequestBody = {
	email?: unknown;
	token?: unknown;
	lang?: unknown;
};

type UnsubscribePayload = { email: string };

class RequestBodyTooLargeError extends Error {}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return response(null, { status: 204, headers: { Allow: "GET, POST, OPTIONS" } }, request, env);
		}

		if (url.pathname !== "/subscribe" && url.pathname !== "/unsubscribe") {
			return textResponse("Not Found", 404, request, env);
		}

		try {
			if (url.pathname === "/subscribe") return await handleSubscribe(request, env, url);
			return await handleUnsubscribe(request, env, url);
		} catch (error) {
			if (error instanceof RequestBodyTooLargeError) {
				logEvent("request_rejected", { outcome: "body_too_large", path: url.pathname });
				const locale = resolveLocale(url.searchParams.get("lang"), request);
				if (wantsHtml(request)) return htmlResponse(renderRequestTooLargePage(locale), 413, request, env, locale);
				return textResponse("Request body too large", 413, request, env);
			}
			logEvent("request_failed", {
				level: "error",
				path: url.pathname,
				errorType: error instanceof Error ? error.name : "UnknownError",
			});
			return jsonResponse({ ok: false, error: "Service temporarily unavailable" }, 503, request, env);
		}
	},
} satisfies ExportedHandler<Env>;

async function handleSubscribe(request: Request, env: Env, url: URL): Promise<Response> {
	if (url.searchParams.get("export") === "csv") {
		if (request.method !== "GET") return methodNotAllowed("GET", request, env);
		return exportCsv(request, env);
	}

	const queryLocale = resolveLocale(url.searchParams.get("lang"), request);
	if (request.method === "GET") {
		return htmlResponse(renderSubscribePage(url.searchParams.get("token"), queryLocale), 200, request, env, queryLocale);
	}

	if (request.method !== "POST") return methodNotAllowed("GET, POST, OPTIONS", request, env);
	const body = await parseBody(request);
	const locale = resolveLocale(firstString(body.lang) ?? url.searchParams.get("lang"), request);
	const token = firstString(body.token) ?? url.searchParams.get("token");
	if (token) return confirmSubscription(token, request, env, locale);

	const email = normalizeEmail(body.email);
	if (!email) {
		logEvent("subscription", { outcome: "invalid_email" });
		if (wantsHtml(request)) {
			return htmlResponse(renderSubscribePage(null, locale, localeText(locale, "invalidEmail")), 400, request, env, locale);
		}
		return jsonResponse({ ok: false, error: "A valid email address is required" }, 400, request, env);
	}

	return requestSubscription(email, originalEmail(body.email) ?? email, locale, request, env);
}

async function handleUnsubscribe(request: Request, env: Env, url: URL): Promise<Response> {
	if (url.searchParams.get("suppressed") === "1") {
		if (request.method !== "GET") return methodNotAllowed("GET", request, env);
		return exportSuppressed(request, env, url);
	}

	let body: RequestBody = {};
	if (request.method === "POST") body = await parseBody(request);
	const locale = resolveLocale(firstString(body.lang) ?? url.searchParams.get("lang"), request);
	const token = url.searchParams.get("token") ?? firstString(body.token);
	if (!token) {
		logEvent("unsubscribe", { outcome: "missing_token" });
		if (wantsHtml(request)) return htmlResponse(renderUnsubscribePage(false, "", locale), 400, request, env, locale);
		return textResponse("Missing token", 400, request, env);
	}

	if (request.method === "GET") {
		const payload = await verifyUnsubscribeToken(token, env);
		if (!payload) {
			logEvent("unsubscribe", { outcome: "invalid_token", method: "GET" });
			return htmlResponse(renderUnsubscribePage(false, "", locale), 400, request, env, locale);
		}
		return htmlResponse(renderUnsubscribePage(true, token, locale), 200, request, env, locale);
	}

	if (request.method !== "POST") return methodNotAllowed("GET, POST, OPTIONS", request, env);
	const payload = await verifyUnsubscribeToken(token, env);
	if (!payload) {
		logEvent("unsubscribe", { outcome: "invalid_token", method: "POST" });
		if (wantsHtml(request)) return htmlResponse(renderUnsubscribePage(false, "", locale), 400, request, env, locale);
		return textResponse("Invalid token", 400, request, env);
	}

	await recordUnsubscribe(payload.email, env);
	logEvent("unsubscribe", { outcome: "recorded" });
	return unsubscribeResponse(request, env, locale);
}

async function requestSubscription(email: string, emailOriginal: string, locale: Locale, request: Request, env: Env): Promise<Response> {
	const now = new Date();
	const nowIso = now.toISOString();
	const existing = await env.DB.prepare(
		"SELECT email_normalized, status, confirmation_sent_at, preferred_locale FROM subscribers WHERE email_normalized = ?",
	)
		.bind(email)
		.first<SubscriberRow>();

	if (existing?.status === "active" || isWithinCooldown(existing?.confirmation_sent_at, now.getTime())) {
		logEvent(existing?.status === "active" ? "subscription" : "rate_limited", {
			outcome: existing?.status === "active" ? "already_active" : "confirmation_cooldown",
		});
		return acceptedSubscriptionResponse(request, env, locale);
	}

	const token = randomToken();
	const tokenHash = await sha256Hex(token);
	const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString();
	const eventType = existing?.status === "unsubscribed" ? "resubscribe_requested" : "subscribe_requested";
	const claimed = await env.DB.prepare(
		`INSERT INTO subscribers (
			email_normalized, email_original, status, source, consent_text_version, preferred_locale,
			requested_at, confirmed_at, unsubscribed_at, confirmation_sent_at,
			updated_at, confirmation_token_hash, confirmation_expires_at
		) VALUES (?, ?, 'pending', 'web', ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
		ON CONFLICT(email_normalized) DO UPDATE SET
			email_original = excluded.email_original,
			status = CASE WHEN subscribers.status = 'unsubscribed' THEN 'unsubscribed' ELSE 'pending' END,
			source = 'web',
			consent_text_version = excluded.consent_text_version,
			preferred_locale = excluded.preferred_locale,
			requested_at = excluded.requested_at,
			confirmed_at = NULL,
			unsubscribed_at = CASE WHEN subscribers.status = 'unsubscribed' THEN subscribers.unsubscribed_at ELSE NULL END,
			confirmation_sent_at = excluded.confirmation_sent_at,
			updated_at = excluded.updated_at,
			confirmation_token_hash = excluded.confirmation_token_hash,
			confirmation_expires_at = excluded.confirmation_expires_at
		WHERE subscribers.status <> 'active'
		  AND (subscribers.confirmation_sent_at IS NULL OR subscribers.confirmation_sent_at <= ?)
		RETURNING email_normalized`,
	)
		.bind(email, emailOriginal, env.CONSENT_TEXT_VERSION, locale, nowIso, nowIso, nowIso, tokenHash, expiresAt,
			new Date(now.getTime() - CONFIRMATION_RESEND_COOLDOWN_MS).toISOString())
		.first<{ email_normalized: string }>();

	if (!claimed) {
		logEvent("rate_limited", { outcome: "confirmation_cooldown" });
		return acceptedSubscriptionResponse(request, env, locale);
	}

	await env.DB.prepare(
		"INSERT INTO subscription_events (email_normalized, event_type, source, occurred_at, consent_text_version) VALUES (?, ?, 'web', ?, ?)",
	)
		.bind(email, eventType, nowIso, env.CONSENT_TEXT_VERSION)
		.run();

	try {
		await sendConfirmationEmail(email, token, locale, env);
	} catch (error) {
		logEvent("subscription", { level: "error", outcome: "confirmation_email_failed", errorType: error instanceof Error ? error.name : "UnknownError" });
		await env.DB.prepare(
			"UPDATE subscribers SET confirmation_sent_at = NULL, confirmation_token_hash = NULL, confirmation_expires_at = NULL, updated_at = ? WHERE email_normalized = ? AND status IN ('pending', 'unsubscribed')",
		)
			.bind(new Date().toISOString(), email)
			.run();
		if (wantsHtml(request)) return htmlResponse(renderErrorPage(locale), 503, request, env, locale);
		return jsonResponse({ ok: false, error: "Unable to send confirmation email" }, 503, request, env);
	}

	logEvent("subscription", { outcome: eventType });
	return acceptedSubscriptionResponse(request, env, locale);
}

async function confirmSubscription(token: string, request: Request, env: Env, requestedLocale: Locale): Promise<Response> {
	if (token.length > 512) return invalidConfirmationResponse(request, env, requestedLocale);

	const nowIso = new Date().toISOString();
	const tokenHash = await sha256Hex(token);
	const row = await env.DB.prepare(
		"SELECT email_normalized, preferred_locale FROM subscribers WHERE confirmation_token_hash = ? AND status IN ('pending', 'unsubscribed') AND confirmation_expires_at > ?",
	)
		.bind(tokenHash, nowIso)
		.first<{ email_normalized: string; preferred_locale: Locale }>();
	if (!row) return invalidConfirmationResponse(request, env, requestedLocale);

	const activated = await env.DB.prepare(
		"UPDATE subscribers SET status = 'active', confirmed_at = ?, unsubscribed_at = NULL, confirmation_token_hash = NULL, confirmation_expires_at = NULL, confirmation_sent_at = NULL, updated_at = ? WHERE email_normalized = ? AND status IN ('pending', 'unsubscribed') RETURNING email_normalized",
	)
		.bind(nowIso, nowIso, row.email_normalized)
		.first<{ email_normalized: string }>();
	if (!activated) return invalidConfirmationResponse(request, env, requestedLocale);

	await env.DB.prepare(
		"INSERT INTO subscription_events (email_normalized, event_type, source, occurred_at, consent_text_version) VALUES (?, 'subscribe_confirmed', 'web', ?, ?)",
	)
		.bind(row.email_normalized, nowIso, env.CONSENT_TEXT_VERSION)
		.run();
	logEvent("confirmation", { outcome: "activated" });

	if (wantsHtml(request)) return htmlResponse(renderConfirmationResult(row.preferred_locale), 200, request, env, row.preferred_locale);
	return jsonResponse({ ok: true, status: "active" }, 200, request, env);
}

function invalidConfirmationResponse(request: Request, env: Env, locale: Locale): Response {
	logEvent("confirmation", { outcome: "invalid_token" });
	if (wantsHtml(request)) return htmlResponse(renderInvalidConfirmation(locale), 400, request, env, locale);
	return textResponse("Invalid or expired confirmation link", 400, request, env);
}

async function recordUnsubscribe(email: string, env: Env): Promise<void> {
	const nowIso = new Date().toISOString();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO subscribers (
				email_normalized, email_original, status, source, consent_text_version, preferred_locale,
				requested_at, confirmed_at, unsubscribed_at, confirmation_sent_at,
				updated_at, confirmation_token_hash, confirmation_expires_at
			) VALUES (?, ?, 'unsubscribed', 'unsubscribe_link', ?, 'en', NULL, NULL, ?, NULL, ?, NULL, NULL)
			ON CONFLICT(email_normalized) DO UPDATE SET
				status = 'unsubscribed',
				unsubscribed_at = excluded.unsubscribed_at,
				confirmation_token_hash = NULL,
				confirmation_expires_at = NULL,
				confirmation_sent_at = NULL,
				updated_at = excluded.updated_at`,
		)
			.bind(email, email, env.CONSENT_TEXT_VERSION, nowIso, nowIso),
		env.DB.prepare(
			"INSERT INTO subscription_events (email_normalized, event_type, source, occurred_at, consent_text_version) VALUES (?, 'unsubscribe_requested', 'unsubscribe_link', ?, ?)",
		).bind(email, nowIso, env.CONSENT_TEXT_VERSION),
	]);
}

async function exportCsv(request: Request, env: Env): Promise<Response> {
	if (!(await timingSafeStringEquals(request.headers.get("authorization") ?? "", `Bearer ${env.EXPORT_TOKEN}`))) {
		logEvent("export", { outcome: "unauthorized" });
		return textResponse("Unauthorized", 401, request, env);
	}
	const result = await env.DB.prepare(
		"SELECT email_normalized, preferred_locale FROM subscribers WHERE status = 'active' ORDER BY email_normalized ASC",
	).all<{ email_normalized: string; preferred_locale: string }>();
	const subscribers = result.results.map(row => ({
		email: row.email_normalized,
		language: row.preferred_locale === "fr" ? "fr" : "en",
	}));
	const nowIso = new Date().toISOString();
	await env.DB.prepare(
		"INSERT INTO subscription_events (email_normalized, event_type, source, occurred_at, metadata_json) VALUES (?, 'csv_exported', 'bulk-email', ?, ?)",
	)
		.bind(null, nowIso, JSON.stringify({ rowCount: subscribers.length }))
		.run()
		.catch(() => undefined);
	const csv = ["email,language", ...subscribers.map(row => `${escapeCsv(row.email)},${row.language}`)].join("\r\n") + "\r\n";
	logEvent("export", { outcome: "completed", rowCount: subscribers.length });
	return response(csv, {
		status: 200,
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="email-list-manager-${new Date().toISOString().slice(0, 10)}.csv"`,
			"Cache-Control": "no-store",
		},
	}, request, env);
}

async function exportSuppressed(request: Request, env: Env, url: URL): Promise<Response> {
	if (!(await timingSafeStringEquals(request.headers.get("authorization") ?? "", `Bearer ${env.SUPPRESSION_READ_TOKEN}`))) {
		logEvent("suppression", { outcome: "unauthorized" });
		return textResponse("Unauthorized", 401, request, env);
	}
	const parsedLimit = Number(url.searchParams.get("limit") ?? "1000");
	const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), MAX_EXPORT_PAGE_SIZE) : MAX_EXPORT_PAGE_SIZE;
	const cursor = url.searchParams.get("cursor");
	const query = cursor
		? env.DB.prepare("SELECT email_normalized FROM subscribers WHERE status = 'unsubscribed' AND email_normalized > ? ORDER BY email_normalized ASC LIMIT ?").bind(cursor, limit + 1)
		: env.DB.prepare("SELECT email_normalized FROM subscribers WHERE status = 'unsubscribed' ORDER BY email_normalized ASC LIMIT ?").bind(limit + 1);
	const result = await query.all<{ email_normalized: string }>();
	const hasNext = result.results.length > limit;
	const page = hasNext ? result.results.slice(0, limit) : result.results;
	const nextCursor = hasNext ? page[page.length - 1]?.email_normalized : undefined;
	logEvent("suppression", { outcome: "completed", rowCount: page.length, done: !hasNext });
	return jsonResponse({ emails: page.map(row => row.email_normalized), cursor: nextCursor, done: !hasNext }, 200, request, env);
}

async function sendConfirmationEmail(email: string, token: string, locale: Locale, env: Env): Promise<void> {
	const confirmationUrl = new URL("/subscribe", env.PUBLIC_BASE_URL);
	confirmationUrl.searchParams.set("token", token);
	confirmationUrl.searchParams.set("lang", locale);
	const url = confirmationUrl.toString();
	const copy = locale === "fr"
		? {
			subject: "Confirmez votre abonnement aux mises à jour de Hack the Hill",
			intro: "Une demande d’abonnement aux mises à jour par courriel de Hack the Hill a été reçue.",
			cta: "Confirmer mon abonnement",
			expires: "Ce lien expire dans 24 heures.",
			ignore: "Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer ce courriel.",
			contact: "Hack the Hill est organisé par Capital Technology Network.",
		}
		: {
			subject: "Confirm your Hack the Hill email updates",
			intro: "A request was received to subscribe to Hack the Hill email updates.",
			cta: "Confirm my subscription",
			expires: "This link expires in 24 hours.",
			ignore: "If you did not request this, you can ignore this email.",
			contact: "Hack the Hill is organized by Capital Technology Network.",
		};
	const escapedUrl = escapeHtml(url);
	const html = `<!doctype html><html lang="${locale}"><body style="margin:0;background:#f6bc83;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6bc83;padding:24px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#650014;border-radius:16px;overflow:hidden"><tr><td style="padding:32px 28px;color:#fff"><p style="margin:0 0 20px;font-size:18px;line-height:1.55">${escapeHtml(copy.intro)}</p><p style="text-align:center;margin:28px 0"><a href="${escapedUrl}" style="display:inline-block;padding:14px 22px;border-radius:16px;background:#f6bc83;color:#650014;font-weight:bold;text-decoration:none">${escapeHtml(copy.cta)}</a></p><p style="margin:16px 0 0;font-size:15px;line-height:1.55">${escapeHtml(copy.expires)} ${escapeHtml(copy.ignore)}</p></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px"><tr><td style="padding:18px 8px 0;text-align:center;color:#333;font-size:13px;line-height:1.55"><p style="margin:0 0 6px">${escapeHtml(copy.contact)}</p><p style="margin:0 0 6px"><a href="mailto:info@hackthehill.com" style="color:#650014;text-decoration:underline">info@hackthehill.com</a></p><p style="margin:0">0109-800 King Edward Avenue, Ottawa, ON K1N 6N5, Canada</p></td></tr></table></td></tr></table></body></html>`;
	const text = `${copy.intro}\n\n${copy.cta}: ${url}\n\n${copy.expires} ${copy.ignore}\n\n${copy.contact}\ninfo@hackthehill.com\n0109-800 King Edward Avenue, Ottawa, ON K1N 6N5, Canada`;
	const from = env.SES_FROM_NAME ? `${env.SES_FROM_NAME} <${env.SES_FROM_EMAIL}>` : env.SES_FROM_EMAIL;
	const client = new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN, region: env.AWS_REGION, service: "ses" });
	const signal = AbortSignal.timeout(SES_REQUEST_TIMEOUT_MS);
	const sesResponse = await client.fetch(`https://email.${env.AWS_REGION}.amazonaws.com/v2/email/outbound-emails`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		signal,
		body: JSON.stringify({
			FromEmailAddress: from,
			ReplyToAddresses: ["info@hackthehill.com"],
			Destination: { ToAddresses: [email] },
			Content: { Simple: { Subject: { Data: copy.subject, Charset: "UTF-8" }, Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } } } },
			ConfigurationSetName: env.SES_CONFIGURATION_SET,
		}),
	});
	const responseBody = await readBoundedResponseBody(sesResponse, MAX_SES_RESPONSE_BYTES);
	if (!sesResponse.ok) throw new Error(`SES returned ${sesResponse.status}: ${responseBody.slice(0, 500)}`);
}

async function verifyUnsubscribeToken(token: string, env: Env): Promise<UnsubscribePayload | null> {
	if (token.length > 2048) return null;
	const versioned = token.split(".");
	if (versioned.length !== 4 || versioned[0] !== "v1") return null;
	const [, keyId, payloadPart, signaturePart] = versioned;
	if (!keyId || !payloadPart || !signaturePart) return null;
	const keyring = parseUnsubscribeKeyring(env);
	const secret = keyring.keys[keyId];
	if (!secret) return null;
	const signedValue = `v1.${keyId}.${payloadPart}`;
	const expected = await hmacBase64Url(signedValue, secret);
	if (!(await timingSafeStringEquals(expected, signaturePart))) return null;
	return decodeUnsubscribePayload(payloadPart);
}

function parseUnsubscribeKeyring(env: Env): { activeKeyId: string | null; keys: Record<string, string> } {
	if (!env.UNSUBSCRIBE_TOKEN_KEYS) return { activeKeyId: null, keys: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(env.UNSUBSCRIBE_TOKEN_KEYS);
	} catch {
		throw new Error("UNSUBSCRIBE_TOKEN_KEYS must be valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("UNSUBSCRIBE_TOKEN_KEYS must be a JSON object");
	}
	const keys: Record<string, string> = {};
	for (const [keyId, value] of Object.entries(parsed)) {
		if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId) || typeof value !== "string" || value.length < 32) {
			throw new Error("UNSUBSCRIBE_TOKEN_KEYS contains an invalid key");
		}
		keys[keyId] = value;
	}
	const activeKeyId = env.UNSUBSCRIBE_TOKEN_ACTIVE_KEY_ID ?? null;
	if (activeKeyId && !keys[activeKeyId]) throw new Error("The active unsubscribe key ID is missing from the keyring");
	return { activeKeyId, keys };
}

function decodeUnsubscribePayload(payloadPart: string): UnsubscribePayload | null {
	try {
		const parsed = JSON.parse(decodeBase64Url(payloadPart)) as { email?: unknown };
		const email = normalizeEmail(parsed.email);
		return email ? { email } : null;
	} catch {
		return null;
	}
}

async function parseBody(request: Request): Promise<RequestBody> {
	const contentTypeHeader = request.headers.get("content-type") ?? "";
	const contentType = contentTypeHeader.split(";", 1)[0].trim().toLowerCase();
	const body = await readBoundedBody(request, MAX_REQUEST_BODY_BYTES);
	if (contentType === "application/json") {
		const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
		return value && typeof value === "object" ? value as RequestBody : {};
	}
	if (contentType === "application/x-www-form-urlencoded" || contentType === "multipart/form-data") {
		const formRequest = new Request("https://body.invalid/", { method: "POST", headers: { "Content-Type": contentTypeHeader }, body });
		const form = await formRequest.formData();
		return { email: form.get("email"), token: form.get("token"), lang: form.get("lang") };
	}
	return {};
}

function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || email.includes("\n") || email.includes("\r")) return null;
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function isWithinCooldown(sentAt: string | null | undefined, nowMs: number): boolean {
	if (!sentAt) return false;
	const sentMs = Date.parse(sentAt);
	return Number.isFinite(sentMs) && nowMs - sentMs < CONFIRMATION_RESEND_COOLDOWN_MS;
}

function randomToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return encodeBase64Url(bytes);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64Url(value: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
	return encodeBase64Url(new Uint8Array(signature));
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	return new TextDecoder().decode(Uint8Array.from(atob(padded), character => character.charCodeAt(0)));
}

async function timingSafeStringEquals(a: string, b: string): Promise<boolean> {
	const [aDigest, bDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(aDigest, bDigest);
}

function firstString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
	const length = Number(request.headers.get("content-length"));
	if (Number.isFinite(length) && length > maxBytes) throw new RequestBodyTooLargeError();
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw new RequestBodyTooLargeError();
			chunks.push(value);
		}
	} finally {
		if (total > maxBytes) await reader.cancel().catch(() => undefined);
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw new Error("SES response body exceeded the configured limit");
			chunks.push(value);
		}
	} finally {
		if (total > maxBytes) await reader.cancel().catch(() => undefined);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function originalEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim();
	return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && !email.includes("\n") && !email.includes("\r") ? email : null;
}

function escapeCsv(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function wantsHtml(request: Request): boolean {
	return request.headers.get("accept")?.includes("text/html") ?? false;
}

function resolveLocale(value: string | null | undefined, request: Request): Locale {
	if (value === "fr") return "fr";
	if (value === "en") return "en";
	return request.headers.get("accept-language")?.toLowerCase().split(",")[0]?.startsWith("fr") ? "fr" : "en";
}

function localeText(locale: Locale, key: "invalidEmail"): string {
	return locale === "fr" ? "Veuillez saisir une adresse courriel valide." : "Please enter a valid email address.";
}

function renderLayout(title: string, body: string, locale: Locale, path: string, query: Record<string, string> = {}): string {
	const languageLinks = Object.entries({ en: "EN", fr: "FR" }).map(([language, label]) => {
		const params = new URLSearchParams({ ...query, lang: language });
		return `<a class="language-link" href="${escapeHtml(`${path}?${params}`)}" aria-current="${language === locale}">${label}</a>`;
	}).join("");
	const footer = locale === "fr"
		? `<p>Hack the Hill est organisé par Capital Technology Network.</p><p><a href="mailto:info@hackthehill.com">info@hackthehill.com</a></p><p>0109-800 King Edward Avenue, Ottawa, ON K1N 6N5, Canada</p><p><a href="${PRIVACY_POLICY_URL}">Politique de confidentialité</a></p>`
		: `<p>Hack the Hill is organized by Capital Technology Network.</p><p><a href="mailto:info@hackthehill.com">info@hackthehill.com</a></p><p>0109-800 King Edward Avenue, Ottawa, ON K1N 6N5, Canada</p><p><a href="${PRIVACY_POLICY_URL}">Privacy policy</a></p>`;
	return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="icon" href="${WEBSITE_ORIGIN}/icons/favicon-128.png"><link rel="stylesheet" href="/styles.css"><title>${escapeHtml(title)}</title></head><body><div class="page"><nav class="language-nav" aria-label="Language">${languageLinks}</nav><header class="brand-header"><img class="brand" src="${WEBSITE_ORIGIN}/Logos/hackthehill-banner.svg" alt="Hack the Hill"></header><main class="card">${body}</main><footer class="footer">${footer}</footer></div></body></html>`;
}

function renderSubscribePage(token: string | null, locale: Locale, error = "", email = ""): string {
	if (token) {
		const text = locale === "fr" ? { title: "Confirmez vos mises à jour par courriel", copy: "Confirmez que vous souhaitez recevoir les mises à jour par courriel de Hack the Hill.", button: "Confirmer mon abonnement" } : { title: "Confirm your email updates", copy: "Confirm that you want to receive email updates from Hack the Hill.", button: "Confirm my subscription" };
		return renderLayout(text.title, `<h1>${text.title}</h1><p class="lede">${text.copy}</p><form class="form" method="post" action="/subscribe"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="lang" value="${locale}"><button class="button" type="submit">${text.button}</button></form>`, locale, "/subscribe", { token });
	}
	const text = locale === "fr"
		? { title: "Mises à jour de Hack the Hill", description: "Recevez occasionnellement par courriel les annonces, les nouvelles et les occasions de Hack the Hill.", label: "Adresse courriel", note: "Nous vous enverrons un courriel de confirmation. Vous pouvez vous désabonner en tout temps.", button: "S’abonner aux mises à jour" }
		: { title: "Hack the Hill email updates", description: "Get occasional Hack the Hill announcements, news, and opportunities by email.", label: "Email address", note: "We’ll send you a confirmation email. You can unsubscribe at any time.", button: "Subscribe to updates" };
	const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
	return renderLayout(text.title, `<h1 class="sr-only">${text.title}</h1><p class="lede subscribe-intro">${text.description}</p>${errorHtml}<form class="form" method="post" action="/subscribe"><label class="label" for="email">${text.label}</label><input class="input" id="email" name="email" type="email" inputmode="email" autocomplete="email" required maxlength="254" value="${escapeHtml(email)}"><p class="notice">${text.note}</p><input type="hidden" name="lang" value="${locale}"><button class="button" type="submit">${text.button}</button></form>`, locale, "/subscribe");
}

function renderConfirmationResult(locale: Locale): string {
	const text = locale === "fr" ? { title: "Votre abonnement est confirmé", copy: "Vous recevrez maintenant les mises à jour par courriel de Hack the Hill.", link: "Visiter hackthehill.com" } : { title: "You’re subscribed", copy: "You’ll now receive occasional email updates from Hack the Hill.", link: "Visit hackthehill.com" };
	return renderLayout(text.title, `<h1>${text.title}</h1><p class="lede">${text.copy}</p><p class="action-row"><a class="button" href="${WEBSITE_ORIGIN}">${text.link}</a></p>`, locale, "/subscribe");
}

function renderInvalidConfirmation(locale: Locale): string {
	const text = locale === "fr" ? { title: "Lien de confirmation invalide", copy: "Ce lien de confirmation est invalide ou a expiré.", link: "Recommencer" } : { title: "Invalid confirmation link", copy: "This confirmation link is invalid or has expired.", link: "Start again" };
	return renderLayout(text.title, `<h1>${text.title}</h1><p class="lede">${text.copy}</p><p class="action-row"><a class="button" href="/subscribe?lang=${locale}">${text.link}</a></p>`, locale, "/subscribe");
}

function renderUnsubscribePage(valid: boolean, token: string, locale: Locale): string {
	if (!valid) {
		const text = locale === "fr" ? { title: "Lien de désabonnement invalide", copy: "Ce lien de désabonnement est invalide.", link: "S’abonner aux mises à jour" } : { title: "Invalid unsubscribe link", copy: "This unsubscribe link is invalid.", link: "Subscribe to updates" };
		return renderLayout(text.title, `<h1>${text.title}</h1><p class="lede">${text.copy}</p><p class="action-row"><a class="button" href="/subscribe?lang=${locale}">${text.link}</a></p>`, locale, "/unsubscribe");
	}
	const text = locale === "fr" ? { title: "Se désabonner des mises à jour de Hack the Hill", copy: "Vous cesserez de recevoir les annonces, les nouvelles et les occasions de Hack the Hill à cette adresse.", button: "Se désabonner" } : { title: "Unsubscribe from Hack the Hill updates", copy: "You’ll stop receiving Hack the Hill announcements, news, and opportunities at this address.", button: "Unsubscribe" };
	return renderLayout(text.title, `<h1>${text.title}</h1><p class="lede">${text.copy}</p><form class="form" method="post" action="/unsubscribe"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="lang" value="${locale}"><button class="button button-secondary" type="submit">${text.button}</button></form>`, locale, "/unsubscribe", { token });
}

function acceptedSubscriptionResponse(request: Request, env: Env, locale: Locale): Response {
	if (wantsHtml(request)) {
		const copy = locale === "fr" ? { title: "Consultez votre boîte de réception", text: "Nous avons reçu votre demande. Si une confirmation est nécessaire, un courriel arrivera bientôt. Si cette adresse est déjà abonnée, aucune autre action n’est requise." } : { title: "Check your inbox", text: "We’ve received your request. If confirmation is needed, an email will arrive shortly. If this address is already subscribed, you’re all set." };
		return htmlResponse(renderLayout(copy.title, `<h1>${copy.title}</h1><p class="lede">${copy.text}</p>`, locale, "/subscribe"), 202, request, env, locale);
	}
	return jsonResponse({ ok: true, status: "accepted" }, 202, request, env);
}

function unsubscribeResponse(request: Request, env: Env, locale: Locale): Response {
	if (wantsHtml(request)) {
		const copy = locale === "fr" ? { title: "Vous êtes désabonné", text: "Vous ne recevrez plus les mises à jour par courriel de Hack the Hill.", link: "S’abonner à nouveau" } : { title: "You’re unsubscribed", text: "You won’t receive future Hack the Hill email updates.", link: "Subscribe again" };
		return htmlResponse(renderLayout(copy.title, `<h1>${copy.title}</h1><p class="lede">${copy.text}</p><p class="action-row"><a class="button" href="/subscribe?lang=${locale}">${copy.link}</a></p>`, locale, "/unsubscribe"), 200, request, env, locale);
	}
	return textResponse("ok", 200, request, env);
}

function renderErrorPage(locale: Locale): string {
	const copy = locale === "fr" ? { title: "Une erreur s’est produite", text: "Veuillez réessayer plus tard." } : { title: "Something went wrong", text: "Please try again later." };
	return renderLayout(copy.title, `<h1>${copy.title}</h1><p class="lede">${copy.text}</p>`, locale, "/subscribe");
}

function renderRequestTooLargePage(locale: Locale): string {
	const copy = locale === "fr"
		? { title: "Demande trop volumineuse", text: "Votre demande est trop volumineuse. Veuillez réessayer avec une adresse courriel seulement." }
		: { title: "Request too large", text: "Your request is too large. Please try again with an email address only." };
	return renderLayout(copy.title, `<h1>${copy.title}</h1><p class="lede">${copy.text}</p>`, locale, "/subscribe");
}

function response(body: BodyInit | null, init: ResponseInit, request: Request, env: Env, locale?: Locale): Response {
	const headers = new Headers(init.headers);
	headers.set("Content-Security-Policy", "default-src 'none'; style-src 'self'; font-src https://hackthehill.com; img-src https://hackthehill.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
	if (locale) headers.set("Content-Language", locale);
	const origin = request.headers.get("origin");
	if (origin && isAllowedOrigin(origin, env)) {
		headers.set("Access-Control-Allow-Origin", origin);
		headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
		headers.set("Access-Control-Max-Age", "86400");
		headers.append("Vary", "Origin");
	}
	return new Response(body, { ...init, headers });
}

function allowedOrigins(env: Env): Set<string> {
	return new Set((env.ALLOWED_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean));
}

function isAllowedOrigin(origin: string, env: Env): boolean {
	const origins = allowedOrigins(env);
	if (origins.has(origin)) return true;

	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}

	if (url.protocol !== "https:" || url.port || url.origin !== origin) return false;

	return [...origins].some(pattern => {
		const match = /^https:\/\/\*\.([a-z0-9.-]+)$/i.exec(pattern);
		return Boolean(match?.[1] && url.hostname.endsWith(`.${match[1].toLowerCase()}`));
	});
}

function jsonResponse(payload: unknown, status: number, request: Request, env: Env): Response {
	return response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }, request, env);
}

function htmlResponse(html: string, status: number, request: Request, env: Env, locale?: Locale): Response {
	return response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }, request, env, locale);
}

function textResponse(text: string, status: number, request: Request, env: Env): Response {
	return response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }, request, env);
}

function methodNotAllowed(allow: string, request: Request, env: Env): Response {
	return response("Method Not Allowed", { status: 405, headers: { Allow: allow } }, request, env);
}

function logEvent(event: string, fields: Record<string, string | number | boolean> = {}): void {
	const payload = { event, ...fields };
	if (fields.level === "error") console.error(JSON.stringify(payload));
	else console.log(JSON.stringify(payload));
}
