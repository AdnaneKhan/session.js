// SPDX-License-Identifier: MIT
// Copyright (c) 2026 AdnaneKhan
// Written fresh from the published SessionProtos.proto field facts —
// no code copied from GPL/AGPL sources. MIT-licensable for upstream
// contribution to @session.js/client.
/**
 * Network implementation for Node.js >= 18 runtimes (uses global fetch, no Bun APIs).
 *
 * Behavior mirrors `@session.js/bun-network` (the Bun-only reference connector): same JSON-RPC
 * flows, method names, params and error semantics. Documented divergences:
 * - TLS verification is ON by default (`insecureTls: false`). bun-network disables TLS
 *   verification for all snode/seed requests; this is a deliberate, safer default. Pass
 *   `insecureTls: true` for parity experiments with bun-network.
 * - bun-network fetches snode lists from `http://` seed URLs and (due to an upstream bug)
 *   always queries only the first seed; we use `https://<seed>/json_rpc` and iterate all
 *   configured seeds.
 * - Request timeouts use `AbortSignal.timeout` (Node-compatible) instead of Bun's fetch
 *   `timeout` option. When `insecureTls` is enabled, HTTPS requests bypass `fetchImpl` via a
 *   minimal `node:https` client with `rejectUnauthorized: false` (per-request TLS settings are
 *   not possible with the standard fetch API), and timeouts are not applied on that path.
 */
import { request as httpsRequest } from "node:https";
import type { Network } from "@session.js/types";
import {
	RequestType,
	type RequestDeleteMessages,
	type RequestDownloadAttachment,
	type RequestGetSwarmsBody,
	type RequestPollBody,
	type RequestSogs,
	type RequestStoreBody,
	type RequestUploadAttachment,
} from "@session.js/types/network/request";
import type {
	ResponseGetSnodes,
	ResponseGetSwarms,
	ResponsePoll,
	ResponseStore,
	ResponseUploadAttachment,
} from "@session.js/types/network/response";
import type { Snode } from "@session.js/types/snode";
import type { Swarm } from "@session.js/types/swarm";
import type { RequestNamespace } from "@session.js/types/snode-retrieve";
import { SnodeNamespace, SnodeNamespaces } from "@session.js/types/namespaces";
import {
	SessionFetchError,
	SessionFetchErrorCode,
	SessionRuntimeError,
	SessionRuntimeErrorCode,
	SessionValidationError,
	SessionValidationErrorCode,
} from "@session.js/errors";

export const ERROR_421_HANDLED_RETRY_REQUEST = "421 handled. Retry this request with a new snode.";
export const MAX_SUBREQUESTS_COUNT = 20;

const DEFAULT_USER_AGENT = "WhatsApp"; // don't ask, it's a tradition: https://github.com/oxen-io/session-desktop/blob/48a245e13c3b9f99da93fc8fe79dfd5019cd1f0a/ts/session/apis/seed_node_api/SeedNodeAPI.ts#L259
const DEFAULT_SEED_NODES = ["seed1.getsession.org", "seed2.getsession.org", "seed3.getsession.org"];
const FILE_SERVER_URL = "http://filev2.getsession.org";

type FetchLikeResponse = {
	status: number;
	ok: boolean;
	text(): Promise<string>;
	json(): Promise<any>;
	arrayBuffer(): Promise<ArrayBuffer>;
};

type FetchInit = {
	method: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
	signal?: AbortSignal;
};

type SnodeRpcParams = {
	method: string;
	params: unknown;
	targetNode: Snode;
	timeout?: number;
};

type SnodeRpcResult = {
	body: string;
	status: number;
	bodyBinary: null;
};

type BatchSubRequest = {
	method: string;
	params?: unknown;
};

export class NetworkNode implements Network {
	/**
	 * Whether to disable TLS certificate verification for snode/seed HTTPS requests.
	 * Default FALSE — a documented divergence from `@session.js/bun-network`, which disables
	 * TLS verification. Enable only for parity testing against bun-network behavior.
	 */
	public readonly insecureTls: boolean;
	public readonly userAgent: string;
	public readonly seedNodes: string[];
	protected fetchImpl: typeof fetch;

	constructor(options?: {
		insecureTls?: boolean;
		userAgent?: string;
		seedNodes?: string[];
		/** Fetch implementation to use for requests (default: global fetch). Injectable for tests */
		fetchImpl?: typeof fetch;
	}) {
		this.insecureTls = options?.insecureTls ?? false;
		this.userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;
		this.seedNodes = options?.seedNodes ?? DEFAULT_SEED_NODES;
		this.fetchImpl = options?.fetchImpl ?? fetch;
	}

	onRequest(type: RequestType, body: unknown): Promise<unknown> {
		switch (type) {
			case RequestType.Store:
				return this.storeMessage(body as RequestStoreBody);
			case RequestType.GetSnodes:
				return this.getSnodes();
			case RequestType.GetSwarms:
				return this.getSwarms(body as RequestGetSwarmsBody);
			case RequestType.Poll:
				return this.poll(body as RequestPollBody);
			case RequestType.UploadAttachment:
				return this.uploadAttachment(body as RequestUploadAttachment);
			case RequestType.DownloadAttachment:
				return this.downloadAttachment(body as RequestDownloadAttachment);
			case RequestType.DeleteMessages:
				return this.deleteMessages(body as RequestDeleteMessages);
			case RequestType.SOGSRequest:
				return this.sogsRequest(body as RequestSogs);
			default:
				throw new SessionFetchError({
					code: SessionFetchErrorCode.UnknownMethod,
					message: "Invalid request type",
				});
		}
	}

	protected async storeMessage({
		swarm,
		data64,
		destination,
		namespace,
		timestamp,
		ttl,
	}: RequestStoreBody): Promise<ResponseStore> {
		const results = await this.storeOnNode(swarm, [
			{
				data: data64,
				namespace: namespace,
				pubkey: destination,
				timestamp: timestamp,
				ttl: ttl,
			},
		]);
		const hash = results[0].body.hash;
		if (typeof hash !== "string" || hash.length === 0) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.InvalidResponse,
				message: "Invalid hash received from store request",
			});
		}
		return { hash };
	}

	/**
	 * Send a 'store' request to the target swarm node
	 * @returns the Array of batch sub-results if it is a success
	 */
	protected async storeOnNode(swarm: Swarm, params: unknown[]) {
		const subRequests: BatchSubRequest[] = params.map((p) => ({
			method: "store",
			params: p,
		}));
		const result = await this.doSnodeBatchRequest(
			subRequests,
			{
				public_ip: swarm.ip,
				storage_port: Number(swarm.port),
				pubkey_ed25519: swarm.pubkey_ed25519,
				pubkey_x25519: swarm.pubkey_x25519,
			},
			4000,
		);
		if (!result || !result.length) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.InvalidResponse,
				message: "Invalid result in storeOnMode",
			});
		}
		const firstResult = result[0];
		if (firstResult.code !== 200) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.InvalidResponse,
				message: "Invalid status code: " + firstResult.code,
			});
		}
		return result;
	}

	protected async getSnodes(): Promise<ResponseGetSnodes> {
		for (const seedNode of this.seedNodes) {
			try {
				const snodesRequest = await this.fetchRaw(`https://${seedNode}/json_rpc`, {
					method: "POST",
					headers: {
						"User-Agent": this.userAgent,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 0,
						method: "get_n_service_nodes",
						params: {
							fields: {
								public_ip: true,
								storage_port: true,
								pubkey_x25519: true,
								pubkey_ed25519: true,
							},
						},
					}),
				});
				if (!snodesRequest.ok) {
					throw new Error("Failed to fetch snodes: " + snodesRequest.status);
				}
				const snodesResponse = (await snodesRequest.json()) as {
					result: { service_node_states: Snode[] };
				};
				const snodes = snodesResponse.result.service_node_states.filter(
					(snode) => snode.public_ip !== "0.0.0.0",
				);
				return { snodes };
			} catch (e) {
				if (process.env.NODE_ENV === "development") {
					console.error("Failed to fetch snodes from", seedNode, e);
				}
			}
		}
		throw new SessionFetchError({
			code: SessionFetchErrorCode.FetchFailed,
			message: "Couldn't fetch snodes using seeds",
		});
	}

	protected async getSwarms({ snode, pubkey }: RequestGetSwarmsBody): Promise<ResponseGetSwarms> {
		const result = await this.doSnodeBatchRequest(
			[
				{
					method: "get_swarm",
					params: {
						pubkey,
					},
				},
			],
			snode,
			10000,
		);
		const swarms = result[0].body.snodes;
		return { swarms };
	}

	protected async poll({ swarm, namespaces }: RequestPollBody): Promise<ResponsePoll> {
		if (namespaces.length === 0) {
			throw new SessionValidationError({
				code: SessionValidationErrorCode.InvalidNamespaces,
				message: `invalid number of retrieve namespace provided: ${namespaces.length}`,
			});
		}
		if (namespaces.some((ns) => ns.namespace === "all"))
			throw new SessionValidationError({
				code: SessionValidationErrorCode.UnsupportedFeature,
				message: 'namespace "all" is not supported yet',
			});
		const results = await this.pollSnode({ swarm, namespaces });
		if (results === null) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.InvalidResponse,
				message: "Polling failed",
			});
		}
		return { messages: results };
	}

	protected async pollSnode({ swarm, namespaces }: RequestPollBody) {
		const request = this.buildRetrieveRequest(namespaces);
		const results = await this.retrieveNextMessages(
			{
				public_ip: swarm.ip,
				storage_port: Number(swarm.port),
				pubkey_ed25519: swarm.pubkey_ed25519,
				pubkey_x25519: swarm.pubkey_x25519,
			},
			request,
			namespaces.map((ns) => ns.namespace),
		);
		// "all" namespaces are rejected in poll() before this point
		return results.map(({ messages, namespace }) => ({
			namespace: namespace as SnodeNamespaces,
			messages: messages.messages,
		}));
	}

	protected async retrieveNextMessages(
		targetNode: Snode,
		retrieveRequestsParams: BatchSubRequest[],
		namespaces: (SnodeNamespaces | "all")[],
	) {
		const timeOutMs = 4 * 1000;
		const results = await this.doSnodeBatchRequest(retrieveRequestsParams, targetNode, timeOutMs);
		if (!results || !Array.isArray(results) || !results.length) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.FetchFailed,
				message: `Could not connect to ${targetNode.public_ip}:${targetNode.storage_port}`,
			});
		}
		// the +1 is to take care of the extra `expire` method added once user config is released
		if (results.length !== namespaces.length && results.length !== namespaces.length + 1) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.InvalidResponse,
				message:
					"Invalid number of results. Expected: " +
					namespaces.length +
					" or " +
					(namespaces.length + 1) +
					" but got: " +
					results.length,
			});
		}
		return results.map((result, index) => ({
			code: result.code,
			messages: result.body,
			namespace: namespaces[index],
		}));
	}

	protected buildRetrieveRequest(namespaces: RequestNamespace[]): BatchSubRequest[] {
		const maxSizeMap = SnodeNamespace.maxSizeMap(
			namespaces.map((ns) => ns.namespace) as SnodeNamespaces[],
		);
		return namespaces.map(({ namespace, pubkey, isOurPubkey, lastHash, signature }) => {
			const foundMaxSize = maxSizeMap.find((m) => m.namespace === namespace)?.maxSize;
			const retrieveParam = {
				pubkey: pubkey,
				lastHash: lastHash || "",
				namespace,
				timestamp: signature.timestamp,
				maxSize: foundMaxSize,
			};
			if (namespace === SnodeNamespaces.ClosedGroupMessage) {
				if (isOurPubkey || !pubkey.startsWith("05")) {
					throw new Error(
						"SnodeNamespace `-10` (ClosedGroupMessage) can only be used to retrieve messages from a legacy closed group (prefix 05). If you're developer trying to poll user's closed chat groups and other groups, you're probably looking for SnodeNamespace `5` (UserGroups)",
					);
				}
				const retrieveLegacyClosedGroup = {
					...retrieveParam,
					namespace,
				};
				const { timestamp, ...retrieveParamsLegacy } = retrieveLegacyClosedGroup;
				void timestamp;
				// if we give a timestamp, a signature will be required by the service node, and we don't want to provide one as this is an unauthenticated namespace
				return {
					method: "retrieve",
					params: retrieveParamsLegacy,
				};
			}
			// all legacy closed group retrieves are unauthenticated and run above.
			// if we get here, this can only be a retrieve for our own swarm, which must be authenticated
			if (
				!SnodeNamespace.isUserConfigNamespace(namespace as SnodeNamespaces) &&
				namespace !== SnodeNamespaces.UserMessages
			) {
				throw new SessionValidationError({
					code: SessionValidationErrorCode.NotZeroNamespaceNotLegacyClosedGroup,
					message: "Namespace should be 0 when polling legacy closed group, got" + namespace,
				});
			}
			if (!isOurPubkey) {
				throw new SessionValidationError({
					code: SessionValidationErrorCode.NotOurPubkeyNotLegacyClosedGroup,
					message:
						"While polling for new messages that are not legacy closed group, pubkey can only be ours",
				});
			}
			return {
				method: "retrieve",
				params: {
					...retrieveParam,
					namespace: retrieveParam.namespace,
					...signature,
					pubkey_ed25519: signature.pubkeyEd25519,
				},
			};
		});
	}

	protected async uploadAttachment(
		body: RequestUploadAttachment,
	): Promise<ResponseUploadAttachment> {
		const request = await this.fetchRaw(`${FILE_SERVER_URL}/file`, {
			method: "POST",
			body: body.data,
		});
		if (request.status !== 200) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.UploadFailed,
				message: "Failed to upload attachment to filev2.getsession.org",
			});
		}
		const response = (await request.json()) as { id: string | number };
		return { id: Number(response.id), url: `${FILE_SERVER_URL}/file/${response.id}` };
	}

	protected async downloadAttachment(body: RequestDownloadAttachment): Promise<Uint8Array> {
		if (!/^\d+$/.test(body.id)) {
			throw new SessionValidationError({
				code: SessionValidationErrorCode.InvalidMessage,
				message: "File ID must be a number",
			});
		}
		const response = await this.fetchRaw(`${FILE_SERVER_URL}/file/${body.id}`, {
			method: "GET",
		});
		if (response.status !== 200) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.InvalidResponse,
				message: "Couldn't download file from filev2 server",
			});
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	protected async deleteMessages({
		pubkey,
		pubkey_ed25519,
		signature,
		swarm,
		hashes,
	}: RequestDeleteMessages): Promise<Record<string, never>> {
		const result = await this.doSnodeBatchRequest(
			[
				{
					method: "delete",
					params: {
						messages: hashes,
						pubkey,
						pubkey_ed25519,
						signature,
					},
				},
			],
			{
				public_ip: swarm.ip,
				storage_port: Number(swarm.port),
				pubkey_ed25519: swarm.pubkey_ed25519,
				pubkey_x25519: swarm.pubkey_x25519,
			},
			10000,
		);
		if (!result || !result.length) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.InvalidResponse,
				message: "Invalid result in storeOnMode",
			});
		}
		const firstResult = result[0];
		if (firstResult.code !== 200) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.InvalidResponse,
				message: "Invalid status code: " + firstResult.code,
			});
		}
		return {};
	}

	protected async sogsRequest({ host, endpoint, method, body, headers }: RequestSogs) {
		let response: Response;
		try {
			// SOGS passthrough uses fetchImpl directly (same as bun-network: no TLS overrides, caller-supplied headers)
			response = await this.fetchImpl(host + endpoint, {
				method,
				body: body || undefined,
				headers,
			});
		} catch (e) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.FetchFailed,
				message: e instanceof Error ? e.message : "Unknown fetch error",
			});
		}
		let responseBody;
		try {
			responseBody = await response.json();
		} catch {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.InvalidResponse,
				message: "Failed to parse JSON response for " + host + endpoint + ": " + response.status,
			});
		}
		return responseBody;
	}

	/**
	 * Make a JSON-RPC 2.0 request to a Session service node's storage RPC endpoint
	 */
	protected async snodeRpc({ method, params, targetNode, timeout = 10000 }: SnodeRpcParams) {
		const url = `https://${targetNode.public_ip}:${targetNode.storage_port}/storage_rpc/v1`;
		const body = {
			jsonrpc: "2.0",
			method,
			params: structuredClone(params),
		};
		return this.doRequest({
			url,
			options: {
				method: "POST",
				body: JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
			timeout,
		});
	}

	/**
	 * Performs an HTTP(S) request to a snode/seed endpoint and deserializes the response.
	 * Maps HTTP 421 to SessionFetchErrorCode.RetryWithOtherNode421Error so the client layer
	 * can retry with another node (same semantics as bun-network).
	 */
	protected async doRequest({
		options,
		url,
		timeout,
	}: {
		options: FetchInit;
		url: string;
		timeout: number;
	}): Promise<SnodeRpcResult> {
		const method = options.method || "GET";
		const headers: Record<string, string> = {
			"User-Agent": this.userAgent,
			"Accept-Language": "en-us",
			"Content-Type": "application/json",
		};
		let response: FetchLikeResponse;
		try {
			response = await this.fetchRaw(url, {
				method,
				headers,
				body: options.body,
				signal: AbortSignal.timeout(timeout),
			});
		} catch {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.FetchFailed,
				message: "Couldn't fetch " + url,
			});
		}
		if (response.status === 421) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.RetryWithOtherNode421Error,
				message: ERROR_421_HANDLED_RETRY_REQUEST,
			});
		}
		const result = await response.text();
		if (!response.ok) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.FetchFailed,
				message: "Error from snode: " + (result.length > 500 ? result.slice(0, 500) + "..." : result),
			});
		}
		return {
			body: result,
			status: response.status,
			bodyBinary: null,
		};
	}

	/**
	 * The equivalent of the batch send on sogs. The target node runs each sub request and
	 * returns a list of all the sub status and bodies. If the global status code is not 200,
	 * an exception is thrown. The body is already parsed from json and is enforced to be an
	 * Array of at least one element
	 * @param method can be either batch or sequence. A batch call will run all calls even if one of them fails. A sequence call will stop as soon as the first one fails
	 */
	protected async doSnodeBatchRequest(
		subRequests: BatchSubRequest[],
		targetNode: Snode,
		timeout: number,
		method: "batch" | "sequence" = "batch",
	) {
		if (subRequests.length > MAX_SUBREQUESTS_COUNT) {
			throw new SessionRuntimeError({
				code: SessionRuntimeErrorCode.Generic,
				message: `batch subRequests count cannot be more than ${MAX_SUBREQUESTS_COUNT}. Got ${subRequests.length}`,
			});
		}
		const result = await this.snodeRpc({
			method,
			params: { requests: subRequests },
			targetNode,
			timeout,
		});
		if (!result) {
			throw new SessionFetchError({
				code: SessionFetchErrorCode.FetchFailed,
				message: `Couldn't connect to ${targetNode.public_ip}:${targetNode.storage_port}`,
			});
		}
		return this.decodeBatchRequest(result);
	}

	/**
	 * Make sure the global batch status code is 200, parse the content as json and return it
	 */
	protected decodeBatchRequest(snodeResponse: SnodeRpcResult) {
		if (snodeResponse.status !== 200) {
			throw new SessionRuntimeError({
				code: SessionRuntimeErrorCode.Generic,
				message: `decodeBatchRequest invalid status code: ${snodeResponse.status}`,
			});
		}
		const parsed = JSON.parse(snodeResponse.body) as { results?: unknown[] };
		if (!Array.isArray(parsed.results)) {
			throw new SessionRuntimeError({
				code: SessionRuntimeErrorCode.Generic,
				message: "decodeBatchRequest results is not an array",
			});
		}
		if (!parsed.results.length) {
			throw new SessionRuntimeError({
				code: SessionRuntimeErrorCode.Generic,
				message: "decodeBatchRequest results an empty array",
			});
		}
		return parsed.results as { code: number; body: any }[];
	}

	/**
	 * Performs an HTTP request. Uses the injected `fetchImpl` (default global fetch, which
	 * verifies TLS). When `insecureTls` is enabled and the URL is HTTPS, falls back to a
	 * minimal node:https client with `rejectUnauthorized: false` — the standard fetch API has
	 * no per-request way to disable TLS verification on Node.
	 */
	protected fetchRaw(url: string, init: FetchInit): Promise<FetchLikeResponse> {
		if (this.insecureTls && url.startsWith("https:")) {
			return this.fetchInsecureHttps(url, init);
		}
		return this.fetchImpl(url, {
			method: init.method,
			headers: init.headers,
			body: init.body,
			signal: init.signal,
		} as RequestInit);
	}

	protected fetchInsecureHttps(url: string, init: FetchInit): Promise<FetchLikeResponse> {
		return new Promise((resolve, reject) => {
			const parsed = new URL(url);
			const request = httpsRequest(
				{
					hostname: parsed.hostname,
					port: parsed.port ? Number(parsed.port) : 443,
					path: parsed.pathname + parsed.search,
					method: init.method,
					headers: init.headers,
					rejectUnauthorized: false,
				},
				(response) => {
					const chunks: Uint8Array[] = [];
					response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
					response.on("end", () => {
						const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
						const bytes = new Uint8Array(totalLength);
						let offset = 0;
						for (const chunk of chunks) {
							bytes.set(chunk, offset);
							offset += chunk.length;
						}
						const status = response.statusCode ?? 0;
						resolve({
							status,
							ok: status >= 200 && status < 300,
							async text() {
								return new TextDecoder().decode(bytes);
							},
							async json() {
								return JSON.parse(new TextDecoder().decode(bytes));
							},
							async arrayBuffer(): Promise<ArrayBuffer> {
								const buffer = new ArrayBuffer(bytes.length);
								new Uint8Array(buffer).set(bytes);
								return buffer;
							},
						});
					});
					response.on("error", reject);
				},
			);
			request.on("error", reject);
			if (init.body !== undefined) {
				request.write(init.body);
			}
			request.end();
		});
	}
}
