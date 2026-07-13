import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const unsubscribeSecret = "unsubscribe-secret";
const migrations = [{
	name: "0001_initial",
	queries: [
		"CREATE TABLE IF NOT EXISTS subscribers (email_normalized TEXT PRIMARY KEY, email_original TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'unsubscribed')), source TEXT NOT NULL, consent_text_version TEXT NOT NULL, requested_at TEXT, confirmed_at TEXT, unsubscribed_at TEXT, confirmation_sent_at TEXT, updated_at TEXT NOT NULL, confirmation_token_hash TEXT, confirmation_expires_at TEXT)",
		"CREATE UNIQUE INDEX IF NOT EXISTS subscribers_confirmation_token ON subscribers (confirmation_token_hash) WHERE confirmation_token_hash IS NOT NULL",
		"CREATE INDEX IF NOT EXISTS subscribers_status_email ON subscribers (status, email_normalized)",
		"CREATE TABLE IF NOT EXISTS subscription_events (id INTEGER PRIMARY KEY AUTOINCREMENT, email_normalized TEXT, event_type TEXT NOT NULL, source TEXT NOT NULL, occurred_at TEXT NOT NULL, consent_text_version TEXT, metadata_json TEXT, FOREIGN KEY (email_normalized) REFERENCES subscribers(email_normalized))",
		"CREATE INDEX IF NOT EXISTS subscription_events_email_time ON subscription_events (email_normalized, occurred_at)",
	],
}];

beforeAll(async () => {
	await applyD1Migrations(env.DB, migrations);
});

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM subscription_events").run();
	await env.DB.prepare("DELETE FROM subscribers").run();
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
		expect(await response.text()).toContain("Unsubscribed");
		const row = await env.DB.prepare("SELECT status FROM subscribers WHERE email_normalized = ?")
			.bind("form@example.com")
			.first<{ status: string }>();
		expect(row?.status).toBe("unsubscribed");
	});

	it("accepts consent from the browser subscribe form", async () => {
		await seedSubscriber("member@example.com", "active");
		const response = await SELF.fetch("https://emails.hackthehill.com/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
			body: new URLSearchParams({ email: "member@example.com", consent: "yes" }),
		});

		expect(response.status).toBe(202);
		expect(await response.text()).toContain("Check your email");
	});

	it("rejects a streamed body after it exceeds the byte limit", async () => {
		const oversized = JSON.stringify({ email: `${"a".repeat(17_000)}@example.com`, consent: true });
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
		expect(await response.text()).toBe("email\r\nactive@example.com\r\n");
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

	it("clears stale unsubscribe metadata when a resubscription is confirmed", async () => {
		const token = "resubscribe-token";
		await seedPending("returning@example.com", await sha256Hex(token), new Date(0).toISOString());

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

	it("adds restrictive security headers to HTML and API responses", async () => {
		for (const url of [
			"https://emails.hackthehill.com/subscribe",
			"https://emails.hackthehill.com/unsubscribe",
		]) {
			const response = await SELF.fetch(url, { headers: { Accept: "text/html" } });
			expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
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
			updated_at, confirmation_token_hash, confirmation_expires_at
		) VALUES (?, ?, ?, 'test', 'test', ?, ?, ?, NULL, ?, NULL, NULL)`,
	)
		.bind(email, email, status, now, status === "active" ? now : null, status === "unsubscribed" ? now : null, now)
		.run();
}

async function seedPending(email: string, tokenHash: string, unsubscribedAt: string | null = null): Promise<void> {
	const now = new Date();
	await env.DB.prepare(
		`INSERT INTO subscribers (
			email_normalized, email_original, status, source, consent_text_version,
			requested_at, confirmed_at, unsubscribed_at, confirmation_sent_at,
			updated_at, confirmation_token_hash, confirmation_expires_at
		) VALUES (?, ?, 'pending', 'test', 'test', ?, NULL, ?, ?, ?, ?, ?)`,
	)
		.bind(email, email, now.toISOString(), unsubscribedAt, now.toISOString(), now.toISOString(), tokenHash, new Date(now.getTime() + 60_000).toISOString())
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
