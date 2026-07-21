// SPDX-License-Identifier: MIT
// Fork addition (closed-groups support): a poller for a single legacy closed
// group's swarm (namespace −10, unauthenticated retrieve). The existing
// `Poller` is hardcoded to the instance's own pubkey/swarm; this one targets an
// arbitrary 05-prefixed group pubkey, decrypts with a provided keypair registry
// (newest-first), dedupes by per-group lastHash + the global `message_hash:`
// keys, drops our own messages, and scales cadence with last activity (desktop
// model). Dependencies are injected (no compile-time `Session` coupling) so the
// `@session.js/groups` package can drive it through a structural interface and
// it is testable against a stub network. Written fresh — (c) 2026 AdnaneKhan,
// upstreamable. See docs/evidence/G2-T2.md.
import { SignalService } from "@session.js/types/signal-bindings";
import type { Storage } from "@session.js/types";
import { SnodeNamespaces } from "@session.js/types/namespaces";
import type { ResponsePoll } from "@session.js/types/network/response";
import type { RequestPollBody } from "@session.js/types/network/request";
import type { EnvelopePlus } from "@session.js/types/envelope";
import type { RequestNamespace } from "@session.js/types/snode-retrieve";
import type { Swarm } from "@session.js/types/swarm";
import type { SessionKeys } from "@session.js/keypair";
import { SWARM_POLLING_TIMEOUT } from "@session.js/consts";
import {
	SessionFetchError,
	SessionFetchErrorCode,
	SessionRuntimeError,
	SessionRuntimeErrorCode,
} from "@session.js/errors";
import { decodeMessage, decryptMessage, extractContent } from "@/crypto/message-decrypt";

/** A decrypted group-swarm message handed to the consumer. */
export type GroupPollerMessage = {
	hash: string;
	envelope: EnvelopePlus;
	content: SignalService.Content;
};

export type GroupPollerOptions = {
	/** The group's 05-prefixed public key (the swarm being polled). */
	groupPubKey: string;
	/** Our own 05-prefixed Session ID — used to drop our own messages. */
	ourPubKey: string;
	/** Returns the group's encryption keypairs (append order; newest last). */
	getEncryptionKeyPairs: () => SessionKeys[] | Promise<SessionKeys[]>;
	/** Performs the swarm Poll request (Session._request({ type: Poll, body })). */
	request: (body: RequestPollBody) => Promise<ResponsePoll>;
	/** Resolves the swarm(s) for the group pubkey (Session.getSwarmsFor). */
	getSwarmsFor: (pubkey: string) => Promise<Swarm[]>;
	/** Storage for the per-group lastHash and the global message_hash dedupe. */
	storage: Storage;
	/** Called with decrypted, de-duplicated, non-own messages. */
	onMessagesReceived: (messages: GroupPollerMessage[]) => void;
	/** Injectable clock (default Date.now). */
	now?: () => number;
	/** Optional diagnostic logger. */
	logger?: (message: string) => void;
};

const RE_POLL_THRESHOLD = 95; // a near-full page → re-poll immediately
const ACTIVE_WINDOW = 2 * 24 * 60 * 60 * 1000; // last activity < 2 days
const MEDIUM_WINDOW = 7 * 24 * 60 * 60 * 1000; // last activity < 7 days

export class GroupPoller {
	readonly #groupPubKey: string;
	readonly #ourPubKey: string;
	readonly #opts: GroupPollerOptions;
	readonly #now: () => number;
	#lastActivity: number;
	#lastPollCount = 0;
	#polling = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#swarm: Swarm | undefined;

	constructor(opts: GroupPollerOptions) {
		if (!opts.groupPubKey.startsWith("05")) {
			throw new SessionRuntimeError({
				code: SessionRuntimeErrorCode.Generic,
				message: "GroupPoller requires a 05-prefixed legacy closed-group pubkey",
			});
		}
		this.#opts = opts;
		this.#groupPubKey = opts.groupPubKey;
		this.#ourPubKey = opts.ourPubKey;
		this.#now = opts.now ?? (() => Date.now());
		this.#lastActivity = this.#now();
	}

	get groupPubKey(): string {
		return this.#groupPubKey;
	}

	isPolling(): boolean {
		return this.#polling;
	}

	/**
	 * Activity-scaled cadence (desktop model): <2 d since last activity → 5 s;
	 * <7 d → 60 s; else 120 s.
	 */
	computeInterval(): number {
		const idle = this.#now() - this.#lastActivity;
		if (idle < ACTIVE_WINDOW) return SWARM_POLLING_TIMEOUT.ACTIVE;
		if (idle < MEDIUM_WINDOW) return SWARM_POLLING_TIMEOUT.MEDIUM_ACTIVE;
		return SWARM_POLLING_TIMEOUT.INACTIVE;
	}

	/** Begin auto-polling (self-rescheduling at the activity-scaled cadence). */
	startPolling(): void {
		if (this.#polling) return;
		this.#polling = true;
		this.#schedule(0);
	}

	/** Stop auto-polling. */
	stopPolling(): void {
		this.#polling = false;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#schedule(delay: number): void {
		if (!this.#polling) return;
		this.#timer = setTimeout(() => {
			void this.poll()
				.catch((e) =>
					this.#opts.logger?.(
						`group poll failed for ${this.#groupPubKey}: ${
							e instanceof Error ? e.message : String(e)
						}`,
					),
				)
				.finally(() => {
					// A near-full page means more is likely buffered → re-poll at once.
					const next = this.#lastPollCount >= RE_POLL_THRESHOLD ? 0 : this.computeInterval();
					this.#schedule(next);
				});
		}, delay);
	}

	#lastHashesKey(): string {
		return `closed_group:${this.#groupPubKey}:last_hashes`;
	}

	async #getLastHash(): Promise<string | undefined> {
		const stored = await this.#opts.storage.get(this.#lastHashesKey());
		if (stored === null) return undefined;
		try {
			const arr = JSON.parse(stored) as Array<{ namespace: number; lastHash: string }>;
			return arr.find((h) => h.namespace === SnodeNamespaces.ClosedGroupMessage)?.lastHash;
		} catch {
			return undefined;
		}
	}

	async #pickSwarm(): Promise<Swarm> {
		const swarms = await this.#opts.getSwarmsFor(this.#groupPubKey);
		if (!swarms.length) {
			throw new SessionRuntimeError({
				code: SessionRuntimeErrorCode.Generic,
				message: `No swarms found for group ${this.#groupPubKey}`,
			});
		}
		const swarm = swarms[Math.floor(Math.random() * swarms.length)] ?? swarms[0];
		this.#swarm = swarm;
		return swarm;
	}

	/**
	 * Run one poll cycle: retrieve the group's namespace −10 since the last
	 * hash, decrypt newest-first, drop our own + already-seen messages, advance
	 * the last hash, and deliver. Returns the decrypted messages.
	 */
	async poll(): Promise<GroupPollerMessage[]> {
		const storage = this.#opts.storage;
		const lastHash = await this.#getLastHash();
		let swarm = this.#swarm ?? (await this.#pickSwarm());

		const makeBody = (s: Swarm): RequestPollBody => ({
			swarm: s,
			namespaces: [
				{
					namespace: SnodeNamespaces.ClosedGroupMessage,
					pubkey: this.#groupPubKey,
					isOurPubkey: false,
					// The −10 retrieve is unauthenticated: buildRetrieveRequest reads
					// only `timestamp` and then drops it, so a placeholder suffices.
					signature: { timestamp: this.#now(), pubkeyEd25519: "", signature: "" },
					lastHash,
				} satisfies RequestNamespace,
			],
		});

		let response: ResponsePoll;
		try {
			response = await this.#opts.request(makeBody(swarm));
		} catch (e) {
			if (e instanceof SessionFetchError && e.code === SessionFetchErrorCode.FetchFailed) {
				// Rotate to a different swarm node for this group and retry once.
				const swarms = await this.#opts.getSwarmsFor(this.#groupPubKey);
				swarm = swarms.find((s) => s !== swarm) ?? swarms[0] ?? swarm;
				this.#swarm = swarm;
				response = await this.#opts.request(makeBody(swarm));
			} else {
				throw e;
			}
		}

		const items = response.messages.flatMap((m) => m.messages);
		this.#lastPollCount = items.length;

		const lastItem = items[items.length - 1];
		if (lastItem) {
			await storage.set(
				this.#lastHashesKey(),
				JSON.stringify([
					{ namespace: SnodeNamespaces.ClosedGroupMessage, lastHash: lastItem.hash },
				]),
			);
		}

		const keypairs = await this.#opts.getEncryptionKeyPairs();
		const decrypted: GroupPollerMessage[] = [];
		for (const item of items) {
			// Global message-hash dedupe (hashes are swarm-unique).
			if (await storage.has("message_hash:" + item.hash)) continue;
			await storage.set("message_hash:" + item.hash, this.#now().toString());

			const content = extractContent(item.data);
			if (content === null) continue;

			const envelope = decodeMessage(content, {
				overrideSource: this.#groupPubKey,
				ourPubKey: this.#ourPubKey,
			});
			if (envelope === null) continue;

			try {
				const plaintext = decryptMessage(keypairs, envelope);
				// Drop our own messages (real author recovered from the sealed box).
				if (envelope.senderIdentity === this.#ourPubKey) continue;
				decrypted.push({
					hash: item.hash,
					envelope,
					content: SignalService.Content.decode(new Uint8Array(plaintext)),
				});
				this.#lastActivity = this.#now();
			} catch {
				// Undecryptable with the current keypairs — the consumer (GroupManager)
				// caches these for retry when a new keypair arrives (P5). Skip here.
			}
		}

		if (decrypted.length) this.#opts.onMessagesReceived(decrypted);
		return decrypted;
	}
}
