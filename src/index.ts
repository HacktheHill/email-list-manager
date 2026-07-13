import { AwsClient } from "aws4fetch";

const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIRMATION_RESEND_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_EMAIL_LENGTH = 254;
const MAX_EXPORT_PAGE_SIZE = 1000;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

type SubscriberStatus = "pending" | "active" | "unsubscribed";

type SubscriberRow = {
	email_normalized: string;
	status: SubscriberStatus;
	confirmation_sent_at: string | null;
};

type SubscribeBody = {
	email?: unknown;
	token?: unknown;
	consent?: unknown;
};

type UnsubscribePayload = {
	email: string;
};

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
			if (url.pathname === "/subscribe") {
				return await handleSubscribe(request, env, url);
			}

			return await handleUnsubscribe(request, env, url);
		} catch (error) {
			if (error instanceof RequestBodyTooLargeError) {
				logEvent("request_rejected", { outcome: "body_too_large", path: url.pathname });
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
		if (request.method !== "GET") {
			return methodNotAllowed("GET", request, env);
		}

		return exportCsv(request, env);
	}

	if (request.method === "GET") {
		return htmlResponse(renderSubscribePage(url.searchParams.get("token")), 200, request, env);
	}

	if (request.method !== "POST") {
		return methodNotAllowed("GET, POST, OPTIONS", request, env);
	}
	const body = await parseBody(request);
	const token = firstString(body.token) ?? url.searchParams.get("token");
	if (token) {
		return confirmSubscription(token, request, env);
	}
	if (!isConsentGiven(body.consent)) {
		logEvent("subscription", { outcome: "consent_required" });
		return jsonResponse({ ok: false, error: "Consent is required" }, 400, request, env);
	}

	const email = normalizeEmail(body.email);
	if (!email) {
		logEvent("subscription", { outcome: "invalid_email" });
		return jsonResponse({ ok: false, error: "A valid email address is required" }, 400, request, env);
	}

	return requestSubscription(email, originalEmail(body.email) ?? email, request, env);
}

async function handleUnsubscribe(request: Request, env: Env, url: URL): Promise<Response> {
	if (url.searchParams.get("suppressed") === "1") {
		if (request.method !== "GET") {
			return methodNotAllowed("GET", request, env);
		}

		return exportSuppressed(request, env, url);
	}

	let token = url.searchParams.get("token") ?? url.searchParams.get("t");
	if (!token && request.method === "POST") {
		token = firstString((await parseBody(request)).token);
	}
	if (!token) {
		logEvent("unsubscribe", { outcome: "missing_token" });
		return textResponse("Missing token", 400, request, env);
	}

	if (request.method === "GET") {
		const payload = await verifyUnsubscribeToken(token, env);
		if (!payload) {
			logEvent("unsubscribe", { outcome: "invalid_token", method: "GET" });
			return htmlResponse(renderUnsubscribePage(false), 400, request, env);
		}

		return htmlResponse(renderUnsubscribePage(true, token), 200, request, env);
	}

	if (request.method !== "POST") {
		return methodNotAllowed("GET, POST, OPTIONS", request, env);
	}

	const payload = await verifyUnsubscribeToken(token, env);
	if (!payload) {
		logEvent("unsubscribe", { outcome: "invalid_token", method: "POST" });
		return textResponse("Invalid token", 400, request, env);
	}

	await recordUnsubscribe(payload.email, env);
	logEvent("unsubscribe", { outcome: "recorded" });
	return unsubscribeResponse(request, env);
}

async function requestSubscription(email: string, emailOriginal: string, request: Request, env: Env): Promise<Response> {
	const now = new Date();
	const nowIso = now.toISOString();
	const existing = await env.DB.prepare(
		"SELECT email_normalized, status, confirmation_sent_at FROM subscribers WHERE email_normalized = ?",
	)
		.bind(email)
		.first<SubscriberRow>();

	// Always return the same public response for active, pending, and unknown addresses.
	if (existing?.status === "active" || isWithinCooldown(existing?.confirmation_sent_at, now.getTime())) {
		if (existing?.status === "active") {
			logEvent("subscription", { outcome: "already_active" });
		} else {
			logEvent("rate_limited", { outcome: "confirmation_cooldown" });
		}
		return acceptedSubscriptionResponse(request, env);
	}

	const token = randomToken();
	const tokenHash = await sha256Hex(token);
	const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString();
	const eventType = existing?.status === "unsubscribed" ? "resubscribe_requested" : "subscribe_requested";

	const claimed = await env.DB.prepare(
		`INSERT INTO subscribers (
			email_normalized, email_original, status, source, consent_text_version,
			requested_at, confirmed_at, unsubscribed_at, confirmation_sent_at,
			updated_at, confirmation_token_hash, confirmation_expires_at
		) VALUES (?, ?, 'pending', 'web', ?, ?, NULL, NULL, ?, ?, ?, ?)
		ON CONFLICT(email_normalized) DO UPDATE SET
			email_original = excluded.email_original,
			status = 'pending',
			source = 'web',
			consent_text_version = excluded.consent_text_version,
			requested_at = excluded.requested_at,
			confirmed_at = NULL,
			unsubscribed_at = NULL,
			confirmation_sent_at = excluded.confirmation_sent_at,
			updated_at = excluded.updated_at,
			confirmation_token_hash = excluded.confirmation_token_hash,
			confirmation_expires_at = excluded.confirmation_expires_at
		WHERE subscribers.status <> 'active'
		  AND (subscribers.confirmation_sent_at IS NULL OR subscribers.confirmation_sent_at <= ?)
		RETURNING email_normalized`,
	)
		.bind(
			email,
			emailOriginal,
			env.CONSENT_TEXT_VERSION,
			nowIso,
			nowIso,
			nowIso,
			tokenHash,
			expiresAt,
			new Date(now.getTime() - CONFIRMATION_RESEND_COOLDOWN_MS).toISOString(),
		)
		.first<{ email_normalized: string }>();

	if (!claimed) {
		logEvent("rate_limited", { outcome: "confirmation_cooldown" });
		return acceptedSubscriptionResponse(request, env);
	}

	await env.DB.prepare(
		"INSERT INTO subscription_events (email_normalized, event_type, source, occurred_at, consent_text_version) VALUES (?, ?, 'web', ?, ?)",
	)
		.bind(email, eventType, nowIso, env.CONSENT_TEXT_VERSION)
		.run();

	try {
		await sendConfirmationEmail(email, token, env);
	} catch (error) {
		logEvent("subscription", {
			level: "error",
			outcome: "confirmation_email_failed",
			errorType: error instanceof Error ? error.name : "UnknownError",
		});
		await env.DB.prepare(
			"UPDATE subscribers SET confirmation_sent_at = NULL, confirmation_token_hash = NULL, confirmation_expires_at = NULL, updated_at = ? WHERE email_normalized = ? AND status = 'pending'",
		)
			.bind(new Date().toISOString(), email)
			.run();
		return jsonResponse({ ok: false, error: "Unable to send confirmation email" }, 503, request, env);
	}

	logEvent("subscription", { outcome: eventType });
	return acceptedSubscriptionResponse(request, env);
}

async function confirmSubscription(token: string, request: Request, env: Env): Promise<Response> {
	if (token.length > 512) {
		logEvent("confirmation", { outcome: "invalid_token" });
		return textResponse("Invalid or expired confirmation link", 400, request, env);
	}

	const nowIso = new Date().toISOString();
	const tokenHash = await sha256Hex(token);
	const row = await env.DB.prepare(
		"SELECT email_normalized FROM subscribers WHERE confirmation_token_hash = ? AND status = 'pending' AND confirmation_expires_at > ?",
	)
		.bind(tokenHash, nowIso)
		.first<{ email_normalized: string }>();

	if (!row) {
		logEvent("confirmation", { outcome: "invalid_token" });
		return textResponse("Invalid or expired confirmation link", 400, request, env);
	}

	const activated = await env.DB.prepare(
		"UPDATE subscribers SET status = 'active', confirmed_at = ?, unsubscribed_at = NULL, confirmation_token_hash = NULL, confirmation_expires_at = NULL, confirmation_sent_at = NULL, updated_at = ? WHERE email_normalized = ? AND status = 'pending' RETURNING email_normalized",
	)
		.bind(nowIso, nowIso, row.email_normalized)
		.first<{ email_normalized: string }>();

	if (!activated) {
		logEvent("confirmation", { outcome: "invalid_token" });
		return textResponse("Invalid or expired confirmation link", 400, request, env);
	}

	await env.DB.prepare(
		"INSERT INTO subscription_events (email_normalized, event_type, source, occurred_at, consent_text_version) VALUES (?, 'subscribe_confirmed', 'web', ?, ?)",
	)
		.bind(row.email_normalized, nowIso, env.CONSENT_TEXT_VERSION)
		.run();
	logEvent("confirmation", { outcome: "activated" });

	if (wantsHtml(request)) {
		return htmlResponse(renderConfirmationResult(), 200, request, env);
	}

	return jsonResponse({ ok: true, status: "active" }, 200, request, env);
}

async function recordUnsubscribe(email: string, env: Env): Promise<void> {
	const nowIso = new Date().toISOString();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO subscribers (
				email_normalized, email_original, status, source, consent_text_version,
				requested_at, confirmed_at, unsubscribed_at, confirmation_sent_at,
				updated_at, confirmation_token_hash, confirmation_expires_at
			) VALUES (?, ?, 'unsubscribed', 'unsubscribe_link', ?, NULL, NULL, ?, NULL, ?, NULL, NULL)
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
		"SELECT email_normalized FROM subscribers WHERE status = 'active' ORDER BY email_normalized ASC",
	).all<{ email_normalized: string }>();
	const emails = result.results.map(row => row.email_normalized);
	const nowIso = new Date().toISOString();

	await env.DB.prepare(
		"INSERT INTO subscription_events (email_normalized, event_type, source, occurred_at, metadata_json) VALUES (?, 'csv_exported', 'bulk-email', ?, ?)",
	)
		.bind(
			null,
			nowIso,
			JSON.stringify({ rowCount: emails.length }),
		)
		.run()
		.catch(() => undefined);

	const csv = ["email", ...emails.map(escapeCsv)].join("\r\n") + "\r\n";
	logEvent("export", { outcome: "completed", rowCount: emails.length });
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
	const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
		? Math.min(Math.floor(parsedLimit), MAX_EXPORT_PAGE_SIZE)
		: MAX_EXPORT_PAGE_SIZE;
	const cursor = url.searchParams.get("cursor");
	const query = cursor
		? env.DB.prepare(
				"SELECT email_normalized FROM subscribers WHERE status = 'unsubscribed' AND email_normalized > ? ORDER BY email_normalized ASC LIMIT ?",
			)
				.bind(cursor, limit + 1)
		: env.DB.prepare(
				"SELECT email_normalized FROM subscribers WHERE status = 'unsubscribed' ORDER BY email_normalized ASC LIMIT ?",
			)
				.bind(limit + 1);
	const result = await query.all<{ email_normalized: string }>();
	const hasNext = result.results.length > limit;
	const page = hasNext ? result.results.slice(0, limit) : result.results;
	const nextCursor = hasNext ? page[page.length - 1]?.email_normalized : undefined;
	logEvent("suppression", { outcome: "completed", rowCount: page.length, done: !hasNext });

	return jsonResponse(
		{ emails: page.map(row => row.email_normalized), cursor: nextCursor, done: !hasNext },
		200,
		request,
		env,
	);
}

async function sendConfirmationEmail(email: string, token: string, env: Env): Promise<void> {
	const confirmationUrl = new URL("/subscribe", env.PUBLIC_BASE_URL);
	confirmationUrl.searchParams.set("token", token);
	const escapedUrl = escapeHtml(confirmationUrl.toString());
	const html = `<p>Someone requested to subscribe <strong>${escapeHtml(email)}</strong> to the Hack the Hill email list.</p><p><a href="${escapedUrl}">Confirm subscription</a></p><p>This link expires in 24 hours. If you did not request this, you can ignore this email.</p>`;
	const text = `Someone requested to subscribe ${email} to the Hack the Hill email list.\n\nConfirm subscription: ${confirmationUrl}\n\nThis link expires in 24 hours. If you did not request this, you can ignore this email.`;
	const from = env.SES_FROM_NAME ? `${env.SES_FROM_NAME} <${env.SES_FROM_EMAIL}>` : env.SES_FROM_EMAIL;
	const client = new AwsClient({
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		sessionToken: env.AWS_SESSION_TOKEN,
		region: env.AWS_REGION,
		service: "ses",
	});
	const response = await client.fetch(`https://email.${env.AWS_REGION}.amazonaws.com/v2/email/outbound-emails`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			FromEmailAddress: from,
			Destination: { ToAddresses: [email] },
			Content: {
				Simple: {
					Subject: { Data: "Confirm your Hack the Hill email list subscription", Charset: "UTF-8" },
					Body: {
						Html: { Data: html, Charset: "UTF-8" },
						Text: { Data: text, Charset: "UTF-8" },
					},
				},
			},
			ConfigurationSetName: env.SES_CONFIGURATION_SET,
		}),
	});

	if (!response.ok) {
		const errorBody = (await response.text()).slice(0, 500);
		throw new Error(`SES returned ${response.status}: ${errorBody}`);
	}
}

async function verifyUnsubscribeToken(token: string, env: Env): Promise<UnsubscribePayload | null> {
	if (token.length > 2048) {
		return null;
	}

	const [payloadPart, signaturePart, extraPart] = token.split(".");
	if (!payloadPart || !signaturePart || extraPart) {
		return null;
	}

	const secrets = [env.UNSUBSCRIBE_TOKEN_SECRET, env.UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET].filter(
		(secret): secret is string => Boolean(secret),
	);
	for (const secret of secrets) {
		const expected = await hmacBase64Url(payloadPart, secret);
		if (!(await timingSafeStringEquals(expected, signaturePart))) {
			continue;
		}

		try {
			const parsed = JSON.parse(decodeBase64Url(payloadPart)) as { email?: unknown };
			const email = normalizeEmail(parsed.email);
			return email ? { email } : null;
		} catch {
			return null;
		}
	}

	return null;
}

async function parseBody(request: Request): Promise<SubscribeBody> {
	const contentTypeHeader = request.headers.get("content-type") ?? "";
	const contentType = contentTypeHeader.split(";", 1)[0].trim().toLowerCase();
	const body = await readBoundedBody(request, MAX_REQUEST_BODY_BYTES);
	if (contentType === "application/json") {
		const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
		return value && typeof value === "object" ? value as SubscribeBody : {};
	}

	if (contentType === "application/x-www-form-urlencoded" || contentType === "multipart/form-data") {
		const formRequest = new Request("https://body.invalid/", {
			method: "POST",
			headers: { "Content-Type": contentTypeHeader },
			body,
		});
		const form = await formRequest.formData();
		return { email: form.get("email"), token: form.get("token"), consent: form.get("consent") };
	}

	return {};
}

function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const email = value.trim().toLowerCase();
	if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || email.includes("\n") || email.includes("\r")) {
		return null;
	}

	// Deliberately conservative syntax validation; SMTP probing is not performed.
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return null;
	}

	return email;
}

function isWithinCooldown(sentAt: string | null | undefined, nowMs: number): boolean {
	if (!sentAt) {
		return false;
	}

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
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
	return encodeBase64Url(new Uint8Array(signature));
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

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
	if (Number.isFinite(length) && length > maxBytes) {
		throw new RequestBodyTooLargeError();
	}

	if (!request.body) {
		return new Uint8Array();
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				throw new RequestBodyTooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
		}
	}

	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function isConsentGiven(value: unknown): boolean {
	return value === true || value === "true" || value === "yes" || value === "on";
}

function originalEmail(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const email = value.trim();
	return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && !email.includes("\n") && !email.includes("\r")
		? email
		: null;
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

function renderLayout(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

function renderSubscribePage(token: string | null): string {
	if (token) {
		return renderLayout(
			"Confirm email list subscription",
			`<p>Click the button below to confirm your Hack the Hill email list subscription.</p><form method="post" action="/subscribe"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Confirm subscription</button></form>`,
		);
	}

	return renderLayout(
		"Hack the Hill email list",
		`<form method="post" action="/subscribe"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"><p>Hack the Hill will use this address to send email list updates. You can unsubscribe at any time.</p><label><input name="consent" type="checkbox" value="yes" required>I agree to receive the Hack the Hill email list.</label><p>We will send a confirmation email before adding you to the email list.</p><button type="submit">Subscribe</button></form>`,
	);
}

function renderConfirmationResult(): string {
	return renderLayout("Subscription confirmed", "<p>You are now subscribed to the Hack the Hill email list.</p>");
}

function renderUnsubscribePage(valid: boolean, token = ""): string {
	if (!valid) {
		return renderLayout("Invalid unsubscribe link", "<p>This unsubscribe link is invalid or has expired.</p>");
	}

	return renderLayout(
		"Unsubscribe from the email list",
		`<p>Click the button below to stop receiving future Hack the Hill email list emails.</p><form method="post" action="/unsubscribe"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Unsubscribe</button></form><p>Your email client may submit this request automatically through its one-click unsubscribe feature.</p>`,
	);
}

function acceptedSubscriptionResponse(request: Request, env: Env): Response {
	if (wantsHtml(request)) {
		return htmlResponse(renderLayout("Check your email", "<p>If a confirmation message was requested, it will arrive shortly. If you already confirmed this address, no further action is needed.</p>"), 202, request, env);
	}

	return jsonResponse({ ok: true, status: "accepted" }, 202, request, env);
}

function unsubscribeResponse(request: Request, env: Env): Response {
	if (wantsHtml(request)) {
		return htmlResponse(renderLayout("Unsubscribed", "<p>You have been unsubscribed from future Hack the Hill email list emails.</p>"), 200, request, env);
	}

	return textResponse("ok", 200, request, env);
}

function response(body: BodyInit | null, init: ResponseInit, request: Request, env: Env): Response {
	const headers = new Headers(init.headers);
	headers.set("Content-Security-Policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
	const origin = request.headers.get("origin");
	if (origin && allowedOrigins(env).has(origin)) {
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

function jsonResponse(payload: unknown, status: number, request: Request, env: Env): Response {
	return response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }, request, env);
}

function htmlResponse(html: string, status: number, request: Request, env: Env): Response {
	return response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }, request, env);
}

function textResponse(text: string, status: number, request: Request, env: Env): Response {
	return response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }, request, env);
}

function methodNotAllowed(allow: string, request: Request, env: Env): Response {
	return response("Method Not Allowed", { status: 405, headers: { Allow: allow } }, request, env);
}

function logEvent(event: string, fields: Record<string, string | number | boolean> = {}): void {
	const payload = { event, ...fields };
	if (fields.level === "error") {
		console.error(JSON.stringify(payload));
		return;
	}
	console.log(JSON.stringify(payload));
}
