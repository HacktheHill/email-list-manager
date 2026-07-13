import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const unsubscribeSecret = "unsubscribe-secret";
// Keep the test schema in lockstep with the checked-in migrations, including
// the additive locale migration used by production.
const migrations = [{
	name: "0001_initial",
	queries: [
		"CREATE TABLE IF NOT EXISTS subscribers (email_normalized TEXT PRIMARY KEY, email_original TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'unsubscribed')), source TEXT NOT NULL, consent_text_version TEXT NOT NULL, requested_at TEXT, confirmed_at TEXT, unsubscribed_at TEXT, confirmation_sent_at TEXT, updated_at TEXT NOT NULL, confirmation_token_hash TEXT, confirmation_expires_at TEXT)",
		"CREATE UNIQUE INDEX IF NOT EXISTS subscribers_confirmation_token ON subscribers (confirmation_token_hash) WHERE confirmation_token_hash IS NOT NULL",
		"CREATE INDEX IF NOT EXISTS subscribers_status_email ON subscribers (status, email_normalized)",
		"CREATE TABLE IF NOT EXISTS subscription_events (id INTEGER PRIMARY KEY AUTOINCREMENT, email_normalized TEXT, event_type TEXT NOT NULL, source TEXT NOT NULL, occurred_at TEXT NOT NULL, consent_text_version TEXT, metadata_json TEXT, FOREIGN KEY (email_normalized) REFERENCES subscribers(email_normalized))",
		"CREATE INDEX IF NOT EXISTS subscription_events_email_time ON subscription_events (email_normalized, occurred_at)",
	],
}, {
	name: "0002_preferred_locale",
	queries: ["ALTER TABLE subscribers ADD COLUMN preferred_locale TEXT NOT NULL DEFAULT 'en' CHECK (preferred_locale IN ('en', 'fr'))"],
}];

beforeAll(async () => {
	await applyD1Migrations(env.DB, migrations);
});

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM subscription_events").run();
	await env.DB.prepare("DELETE FROM subscribers").run();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("email list subscription service", () => {
	it("does not mutate state when a browser opens an unsubscribe link", async () => {
		const token = await createUnsubscribeToken("scanner@example.com");
		const response = await SELF.fetch(`https://emails.hackthehill.com/unsubscribe?token=${token}`, {
			headers: { Accept: "text/html" },
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Unsubscribe");
		const row = await env.DB.prepare("SELECT status FROM subscribers WHERE email_normalized = ?")
			.bind("scanner@example.com")
			.first<{ status: string }>();
		expect(row).toBeNull();
	});

	it("suppresses an address on one-click POST and is idempotent", async () => {
		const token = await createUnsubscribeToken("person@example.com");
		const request = () => SELF.fetch(`https://emails.hackthehill.com/unsubscribe?token=${token}`, { method: "POST" });

		expect((await request()).status).toBe(200);
		expect((await request()).status).toBe(200);

		const row = await env.DB.prepare("SELECT status FROM subscribers WHERE email_normalized = ?")
			.bind("person@example.com")
			.first<{ status: string }>();
		expect(row?.status).toBe("unsubscribed");
	});

	it("accepts the browser confirmation form token in the POST body", async () => {
		const token = await createUnsubscribeToken("form@example.com");
		const form = new URLSearchParams({ token });
		const response = await SELF.fetch("https://emails.hackthehill.com/unsubscribe", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
			body: form,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("You’re unsubscribed");
		const row = await env.DB.prepare("SELECT status FROM subscribers WHERE email_normalized = ?")
			.bind("form@example.com")
			.first<{ status: string }>();
		expect(row?.status).toBe("unsubscribed");
	});

	it("accepts a browser subscribe form without a consent checkbox", async () => {
		await seedSubscriber("member@example.com", "active");
		const response = await SELF.fetch("https://emails.hackthehill.com/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
			body: new URLSearchParams({ email: "member@example.com" }),
		});

		expect(response.status).toBe(202);
		expect(await response.text()).toContain("Check your inbox");
	});

	it("renders the branded English and French subscribe pages without consent controls", async () => {
		const english = await SELF.fetch("https://emails.hackthehill.com/subscribe", { headers: { Accept: "text/html" } });
		const englishHtml = await english.text();
		expect(englishHtml).not.toContain("Stay in the loop");
		expect(englishHtml).toContain("Get occasional Hack the Hill announcements, news, and opportunities by email.");
		expect(englishHtml).toContain("We’ll send you a confirmation email. You can unsubscribe at any time.");
		expect(englishHtml).toContain("https://hackthehill.com/Logos/hackthehill-banner.svg");
		expect(englishHtml).toContain('class="brand-header"');
		expect(englishHtml.indexOf('class="brand-header"')).toBeLessThan(englishHtml.indexOf('<main class="card">'));
		expect(englishHtml.slice(englishHtml.indexOf('<main class="card">'))).not.toContain('class="brand"');
		expect(englishHtml).toContain("/styles.css");
		expect(englishHtml).not.toContain('type="checkbox"');
		expect(englishHtml).not.toContain("consent");
		expect(english.headers.get("Content-Language")).toBe("en");

		const french = await SELF.fetch("https://emails.hackthehill.com/subscribe", {
			headers: { Accept: "text/html", "Accept-Language": "fr-CA,fr;q=0.9" },
		});
		const frenchHtml = await french.text();
		expect(frenchHtml).not.toContain("Restez au courant");
		expect(frenchHtml).toContain("Recevez occasionnellement par courriel les annonces, les nouvelles et les occasions de Hack the Hill.");
		expect(frenchHtml).toContain("Nous vous enverrons un courriel de confirmation. Vous pouvez vous désabonner en tout temps.");
		expect(french.headers.get("Content-Language")).toBe("fr");
	});

	it("sends the simplified confirmation email with an external footer", async () => {
		let outboundPayload: unknown;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
			const outboundRequest = input instanceof Request ? input : new Request(input);
			outboundPayload = await outboundRequest.clone().json();
			return new Response("{}", { status: 200 });
		});
		const response = await SELF.fetch("https://emails.hackthehill.com/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "confirmation-email@example.com", lang: "en" }),
		});
		expect(response.status).toBe(202);
		expect(fetchSpy).toHaveBeenCalledOnce();

		const payload = outboundPayload as {
			FromEmailAddress: string;
			ReplyToAddresses: string[];
			Content: { Simple: { Body: { Html: { Data: string } } } };
		};
		const emailHtml = payload.Content.Simple.Body.Html.Data;
		expect(payload.FromEmailAddress).toBe("info@hackthehill.com");
		expect(payload.ReplyToAddresses).toEqual(["info@hackthehill.com"]);
		expect(emailHtml).not.toContain("<img");
		expect(emailHtml).not.toContain("#fff3b6");
		expect(emailHtml).toContain("background:#f6bc83");
		expect(emailHtml).toContain("background:#650014");
		expect(emailHtml).toContain("color:#333");
		expect(emailHtml).toContain('style="color:#650014;text-decoration:underline"');
	});

	it("rejects legacy t token parameters", async () => {
		const subscribe = await SELF.fetch("https://emails.hackthehill.com/subscribe?t=not-supported", { headers: { Accept: "text/html" } });
		expect(await subscribe.text()).not.toContain('name="token"');
		const unsubscribe = await SELF.fetch("https://emails.hackthehill.com/unsubscribe?t=not-supported", { headers: { Accept: "text/html" } });
		expect(unsubscribe.status).toBe(400);
	});

	it("returns styled browser validation errors", async () => {
		const response = await SELF.fetch("https://emails.hackthehill.com/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
			body: new URLSearchParams({ email: "not-an-email", lang: "fr" }),
		});
		expect(response.status).toBe(400);
		expect(response.headers.get("Content-Type")).toContain("text/html");
		expect(await response.text()).toContain("Veuillez saisir une adresse courriel valide.");
	});

	it("rejects a streamed body after it exceeds the byte limit", async () => {
		const oversized = JSON.stringify({ email: `${"a".repeat(17_000)}@example.com` });
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(oversized.slice(0, 8_000)));
				controller.enqueue(new TextEncoder().encode(oversized.slice(8_000)));
				controller.close();
			},
		});
		const request = new Request("https://emails.hackthehill.com/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});

		const response = await SELF.fetch(request);
		expect(response.status).toBe(413);

		const browserResponse = await SELF.fetch(new Request("https://emails.hackthehill.com/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "text/html" },
			body: oversized,
		}));
		expect(browserResponse.headers.get("Content-Type")).toContain("text/html");
		expect(await browserResponse.text()).toContain("Request too large");
	});

	it("requires export authentication and returns only active addresses", async () => {
		await seedSubscriber("active@example.com", "active");
		await seedSubscriber("pending@example.com", "pending");
		await seedSubscriber("unsubscribed@example.com", "unsubscribed");

		const unauthorized = await SELF.fetch("https://emails.hackthehill.com/subscribe?export=csv");
		expect(unauthorized.status).toBe(401);

		const response = await SELF.fetch("https://emails.hackthehill.com/subscribe?export=csv", {
			headers: { Authorization: "Bearer export-token" },
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("email,language\r\nactive@example.com,en\r\n");
	});

	it("requires a POST after opening a confirmation link", async () => {
		const token = "confirmation-token";
		const tokenHash = await sha256Hex(token);
		await seedPending("confirm@example.com", tokenHash);

		const getResponse = await SELF.fetch(`https://emails.hackthehill.com/subscribe?token=${token}`, {
			headers: { Accept: "text/html" },
		});
		expect(getResponse.status).toBe(200);
		let row = await env.DB.prepare("SELECT status FROM subscribers WHERE email_normalized = ?")
			.bind("confirm@example.com")
			.first<{ status: string }>();
		expect(row?.status).toBe("pending");

		const postResponse = await SELF.fetch(`https://emails.hackthehill.com/subscribe?token=${token}`, {
			method: "POST",
			headers: { Accept: "application/json" },
		});
		expect(postResponse.status).toBe(200);
		row = await env.DB.prepare("SELECT status FROM subscribers WHERE email_normalized = ?")
			.bind("confirm@example.com")
			.first<{ status: string }>();
		expect(row?.status).toBe("active");
	});

	it("uses the stored locale for confirmation success and keeps resubscribe fresh", async () => {
		const token = "confirmation-fr-token";
		await seedPending("fr@example.com", await sha256Hex(token), null, "pending", "fr");
		const response = await SELF.fetch(`https://emails.hackthehill.com/subscribe?token=${token}`, {
			method: "POST",
			headers: { Accept: "text/html" },
		});
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Language")).toBe("fr");
		expect(html).toContain("Votre abonnement est confirmé");
		expect(html).not.toContain("Subscribe again");
	});

	it("clears stale unsubscribe metadata when a resubscription is confirmed", async () => {
		const token = "resubscribe-token";
		await seedPending("returning@example.com", await sha256Hex(token), new Date(0).toISOString(), "unsubscribed");

		const beforeConfirmation = await SELF.fetch(
			"https://emails.hackthehill.com/unsubscribe?suppressed=1",
			{ headers: { Authorization: "Bearer suppression-token" } },
		);
		expect(await beforeConfirmation.json()).toEqual({ emails: ["returning@example.com"], done: true });

		const response = await SELF.fetch(`https://emails.hackthehill.com/subscribe?token=${token}`, {
			method: "POST",
		});

		expect(response.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT status, unsubscribed_at FROM subscribers WHERE email_normalized = ?",
		)
			.bind("returning@example.com")
			.first<{ status: string; unsubscribed_at: string | null }>();
		expect(row).toEqual({ status: "active", unsubscribed_at: null });
	});

	it("supports the existing sender's suppressed-list pagination endpoint", async () => {
		await seedSubscriber("a@example.com", "unsubscribed");
		await seedSubscriber("b@example.com", "unsubscribed");
		const response = await SELF.fetch("https://emails.hackthehill.com/unsubscribe?suppressed=1&limit=1", {
			headers: { Authorization: "Bearer suppression-token" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ emails: ["a@example.com"], cursor: "a@example.com", done: false });
	});

	it("requires suppression authentication", async () => {
		const response = await SELF.fetch("https://emails.hackthehill.com/unsubscribe?suppressed=1");
		expect(response.status).toBe(401);
	});

	it("allows Pages preview subdomains in CORS preflights without allowing lookalikes", async () => {
		const previewOrigin = "https://a4b7cd9b.website-1cg.pages.dev";
		const preview = await SELF.fetch("https://emails.hackthehill.com/subscribe", {
			method: "OPTIONS",
			headers: {
				Origin: previewOrigin,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(preview.status).toBe(204);
		expect(preview.headers.get("Access-Control-Allow-Origin")).toBe(previewOrigin);

		for (const origin of ["https://website-1cg.pages.dev", "https://preview.website-1cg.pages.dev.evil"]) {
			const response = await SELF.fetch("https://emails.hackthehill.com/subscribe", {
				method: "OPTIONS",
				headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
			});
			expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
		}
	});

	it("adds restrictive security headers to HTML and API responses", async () => {
		for (const url of [
			"https://emails.hackthehill.com/subscribe",
			"https://emails.hackthehill.com/unsubscribe",
		]) {
			const response = await SELF.fetch(url, { headers: { Accept: "text/html" } });
			expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
			expect(response.headers.get("Content-Security-Policy")).toContain("style-src 'self'");
			expect(response.headers.get("Content-Security-Policy")).toContain("font-src https://hackthehill.com");
			expect(response.headers.get("Content-Security-Policy")).toContain("img-src https://hackthehill.com");
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
			expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
		}
	});
});

async function seedSubscriber(email: string, status: "active" | "pending" | "unsubscribed"): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO subscribers (
			email_normalized, email_original, status, source, consent_text_version,
			requested_at, confirmed_at, unsubscribed_at, confirmation_sent_at,
			updated_at, confirmation_token_hash, confirmation_expires_at, preferred_locale
		) VALUES (?, ?, ?, 'test', 'test', ?, ?, ?, NULL, ?, NULL, NULL, 'en')`,
	)
		.bind(email, email, status, now, status === "active" ? now : null, status === "unsubscribed" ? now : null, now)
		.run();
}

async function seedPending(
	email: string,
	tokenHash: string,
	unsubscribedAt: string | null = null,
	status: "pending" | "unsubscribed" = "pending",
	locale: "en" | "fr" = "en",
): Promise<void> {
	const now = new Date();
	await env.DB.prepare(
		`INSERT INTO subscribers (
			email_normalized, email_original, status, source, consent_text_version,
			requested_at, confirmed_at, unsubscribed_at, confirmation_sent_at,
			updated_at, confirmation_token_hash, confirmation_expires_at, preferred_locale
		) VALUES (?, ?, ?, 'test', 'test', ?, NULL, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(email, email, status, now.toISOString(), unsubscribedAt, now.toISOString(), now.toISOString(), tokenHash, new Date(now.getTime() + 60_000).toISOString(), locale)
		.run();
}

async function createUnsubscribeToken(email: string): Promise<string> {
	const payload = encodeBase64Url(JSON.stringify({ email, iat: Date.now() }));
	const signature = await hmacBase64Url(payload, unsubscribeSecret);
	return `${payload}.${signature}`;
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

function encodeBase64Url(value: string | Uint8Array): string {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
