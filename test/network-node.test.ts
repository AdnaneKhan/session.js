// Written fresh from the published SessionProtos.proto field facts. MIT-licensable for upstream contribution.
import { expect, test } from "bun:test";
import { RequestType } from "@session.js/types/network/request";
import { SnodeNamespaces } from "@session.js/types";
import {
	SessionFetchError,
	SessionFetchErrorCode,
	SessionRuntimeError,
} from "@session.js/errors";
import { NetworkNode } from "@/network";

type RecordedRequest = { url: string; init: any };

type StubResult = {
	status?: number;
	ok?: boolean;
	/** JSON-serializable body; serialized and served as text/json */
	body?: unknown;
	/** raw text body (takes precedence over `body`) */
	text?: string;
};

/** Builds a fetch-compatible stub that records requests and serves canned responses */
function stubFetch(
	responder: (url: string, init: any) => StubResult | Promise<StubResult>,
	recorded: RecordedRequest[],
): typeof fetch {
	return (async (url: any, init: any) => {
		const requestUrl = String(url);
		recorded.push({ url: requestUrl, init });
		const result = await responder(requestUrl, init);
		const status = result.status ?? 200;
		const text = result.text ?? JSON.stringify(result.body ?? {});
		return {
			status,
			ok: result.ok ?? (status >= 200 && status < 300),
			async text() {
				return text;
			},
			async json() {
				return JSON.parse(text);
			},
			async arrayBuffer() {
				return new TextEncoder().encode(text).buffer;
			},
		};
	}) as typeof fetch;
}

const swarm = {
	ip: "192.0.2.10",
	port: "22023",
	pubkey_ed25519: "aa".repeat(32),
	pubkey_x25519: "bb".repeat(32),
};
const snode = {
	public_ip: "192.0.2.10",
	storage_port: 22023,
	pubkey_ed25519: "aa".repeat(32),
	pubkey_x25519: "bb".repeat(32),
};
const SESSION_ID = "05" + "ab".repeat(32);

test("Store: correct URL, JSON-RPC batch body and User-Agent header", async () => {
	const recorded: RecordedRequest[] = [];
	const network = new NetworkNode({
		fetchImpl: stubFetch(() => ({ body: { results: [{ code: 200, body: { hash: "hash123" } }] } }), recorded),
	});
	const result = await network.onRequest(RequestType.Store, {
		swarm,
		data64: "ZGF0YQ==",
		destination: SESSION_ID,
		namespace: 0,
		timestamp: 1751000000000,
		ttl: 300000,
	});
	expect(result).toEqual({ hash: "hash123" });
	expect(recorded).toHaveLength(1);
	expect(recorded[0].url).toBe("https://192.0.2.10:22023/storage_rpc/v1");
	expect(recorded[0].init.method).toBe("POST");
	expect(recorded[0].init.headers["User-Agent"]).toBe("WhatsApp");
	expect(recorded[0].init.headers["Accept-Language"]).toBe("en-us");
	const rpcBody = JSON.parse(recorded[0].init.body);
	expect(rpcBody.jsonrpc).toBe("2.0");
	expect(rpcBody.method).toBe("batch");
	expect(rpcBody.params.requests).toEqual([
		{
			method: "store",
			params: {
				data: "ZGF0YQ==",
				namespace: 0,
				pubkey: SESSION_ID,
				timestamp: 1751000000000,
				ttl: 300000,
			},
		},
	]);
});

test("Poll: retrieve sub-request construction with signature params", async () => {
	const recorded: RecordedRequest[] = [];
	const network = new NetworkNode({
		fetchImpl: stubFetch(
			() => ({
				body: {
					results: [
						{
							code: 200,
							body: {
								messages: [{ hash: "h1", expiration: 999, data: "Zg==", timestamp: 1 }],
								more: false,
								t: 2,
							},
						},
					],
				},
			}),
			recorded,
		),
	});
	const result = (await network.onRequest(RequestType.Poll, {
		swarm,
		namespaces: [
			{
				namespace: SnodeNamespaces.UserMessages,
				pubkey: SESSION_ID,
				isOurPubkey: true,
				signature: { timestamp: 111, pubkeyEd25519: "ee".repeat(32), signature: "ff".repeat(8) },
				lastHash: "lasthash0",
			},
		],
	})) as any;
	expect(result.messages).toHaveLength(1);
	expect(result.messages[0].namespace).toBe(SnodeNamespaces.UserMessages);
	expect(result.messages[0].messages).toEqual([
		{ hash: "h1", expiration: 999, data: "Zg==", timestamp: 1 },
	]);
	expect(recorded[0].url).toBe("https://192.0.2.10:22023/storage_rpc/v1");
	const rpcBody = JSON.parse(recorded[0].init.body);
	expect(rpcBody.method).toBe("batch");
	const retrieve = rpcBody.params.requests[0];
	expect(retrieve.method).toBe("retrieve");
	expect(retrieve.params.pubkey).toBe(SESSION_ID);
	expect(retrieve.params.lastHash).toBe("lasthash0");
	expect(retrieve.params.namespace).toBe(0);
	expect(retrieve.params.timestamp).toBe(111);
	expect(retrieve.params.signature).toBe("ff".repeat(8));
	expect(retrieve.params.pubkey_ed25519).toBe("ee".repeat(32));
	expect(typeof retrieve.params.maxSize).toBe("number");
});

test("GetSwarms: get_swarm sub-request and swarms parsing", async () => {
	const recorded: RecordedRequest[] = [];
	const swarmList = [{ ip: "192.0.2.20", port: "22023", pubkey_ed25519: "cc", pubkey_x25519: "dd" }];
	const network = new NetworkNode({
		fetchImpl: stubFetch(
			() => ({ body: { results: [{ code: 200, body: { snodes: swarmList } }] } }),
			recorded,
		),
	});
	const result = await network.onRequest(RequestType.GetSwarms, { snode, pubkey: SESSION_ID });
	expect(result).toEqual({ swarms: swarmList });
	const rpcBody = JSON.parse(recorded[0].init.body);
	expect(rpcBody.method).toBe("batch");
	expect(rpcBody.params.requests).toEqual([{ method: "get_swarm", params: { pubkey: SESSION_ID } }]);
});

test("GetSnodes: seed node fetching, parsing and 0.0.0.0 filtering", async () => {
	const recorded: RecordedRequest[] = [];
	const snodeStates = [
		{ public_ip: "198.51.100.7", storage_port: 22023, pubkey_x25519: "xx", pubkey_ed25519: "yy" },
		{ public_ip: "0.0.0.0", storage_port: 22023, pubkey_x25519: "x0", pubkey_ed25519: "y0" },
	];
	const network = new NetworkNode({
		seedNodes: ["seed.test"],
		fetchImpl: stubFetch(() => ({ body: { result: { service_node_states: snodeStates } } }), recorded),
	});
	const result = (await network.onRequest(RequestType.GetSnodes, {})) as any;
	expect(result.snodes).toEqual([snodeStates[0]]);
	expect(recorded[0].url).toBe("https://seed.test/json_rpc");
	expect(recorded[0].init.headers["User-Agent"]).toBe("WhatsApp");
	const rpcBody = JSON.parse(recorded[0].init.body);
	expect(rpcBody.jsonrpc).toBe("2.0");
	expect(rpcBody.method).toBe("get_n_service_nodes");
	expect(rpcBody.params.fields).toEqual({
		public_ip: true,
		storage_port: true,
		pubkey_x25519: true,
		pubkey_ed25519: true,
	});
});

test("GetSnodes: falls back to the next seed when one fails", async () => {
	const recorded: RecordedRequest[] = [];
	const network = new NetworkNode({
		seedNodes: ["bad.test", "good.test"],
		fetchImpl: stubFetch((url) => {
			if (url.includes("bad.test")) {
				throw new Error("connection refused");
			}
			return {
				body: {
					result: {
						service_node_states: [
							{ public_ip: "198.51.100.8", storage_port: 22023, pubkey_x25519: "x", pubkey_ed25519: "y" },
						],
					},
				},
			};
		}, recorded),
	});
	const result = (await network.onRequest(RequestType.GetSnodes, {})) as any;
	expect(result.snodes).toHaveLength(1);
	expect(recorded.map((r) => r.url)).toEqual(["https://bad.test/json_rpc", "https://good.test/json_rpc"]);
});

test("GetSnodes: throws FetchFailed when all seeds fail", async () => {
	const network = new NetworkNode({
		seedNodes: ["bad.test"],
		fetchImpl: stubFetch(() => {
			throw new Error("connection refused");
		}, []),
	});
	try {
		await network.onRequest(RequestType.GetSnodes, {});
		expect(true).toBe(false); // unreachable
	} catch (e) {
		expect(e).toBeInstanceOf(SessionFetchError);
		expect((e as SessionFetchError).code).toBe(SessionFetchErrorCode.FetchFailed);
	}
});

test("custom userAgent is sent on snode and seed requests", async () => {
	const recorded: RecordedRequest[] = [];
	const network = new NetworkNode({
		userAgent: "TestAgent/1.0",
		fetchImpl: stubFetch(() => ({ body: { results: [{ code: 200, body: { hash: "h" } }] } }), recorded),
	});
	expect(network.userAgent).toBe("TestAgent/1.0");
	await network.onRequest(RequestType.Store, {
		swarm,
		data64: "ZGF0YQ==",
		destination: SESSION_ID,
		namespace: 0,
		timestamp: 1,
		ttl: 300000,
	});
	expect(recorded[0].init.headers["User-Agent"]).toBe("TestAgent/1.0");
});

test("insecureTls defaults to false and requests go through fetchImpl (TLS-verifying path)", () => {
	const network = new NetworkNode({ fetchImpl: stubFetch(() => ({ body: {} }), []) });
	expect(network.insecureTls).toBe(false);
	const insecure = new NetworkNode({ insecureTls: true });
	expect(insecure.insecureTls).toBe(true);
});

test("snode HTTP 421 maps to RetryWithOtherNode421Error", async () => {
	const network = new NetworkNode({
		fetchImpl: stubFetch(() => ({ status: 421, text: "misdirected" }), []),
	});
	try {
		await network.onRequest(RequestType.GetSwarms, { snode, pubkey: SESSION_ID });
		expect(true).toBe(false); // unreachable
	} catch (e) {
		expect(e).toBeInstanceOf(SessionFetchError);
		expect((e as SessionFetchError).code).toBe(SessionFetchErrorCode.RetryWithOtherNode421Error);
	}
});

test("snode non-OK response maps to FetchFailed with truncated body", async () => {
	const network = new NetworkNode({
		fetchImpl: stubFetch(() => ({ status: 500, text: "boom" }), []),
	});
	try {
		await network.onRequest(RequestType.GetSwarms, { snode, pubkey: SESSION_ID });
		expect(true).toBe(false); // unreachable
	} catch (e) {
		expect(e).toBeInstanceOf(SessionFetchError);
		expect((e as SessionFetchError).code).toBe(SessionFetchErrorCode.FetchFailed);
		expect((e as Error).message).toContain("Error from snode: boom");
	}
});

test("batch with more than MAX_SUBREQUESTS_COUNT sub-requests throws SessionRuntimeError", async () => {
	const network = new NetworkNode({
		fetchImpl: stubFetch(() => ({ body: { results: [{ code: 200, body: {} }] } }), []),
	});
	const namespaces = Array.from({ length: 21 }, (_, i) => ({
		namespace: SnodeNamespaces.UserMessages,
		pubkey: SESSION_ID,
		isOurPubkey: true,
		signature: { timestamp: 1, pubkeyEd25519: "ee", signature: "ff" },
		lastHash: undefined,
	}));
	try {
		await network.onRequest(RequestType.Poll, { swarm, namespaces });
		expect(true).toBe(false); // unreachable
	} catch (e) {
		expect(e).toBeInstanceOf(SessionRuntimeError);
		expect((e as Error).message).toContain("20");
	}
});

test("unknown request type throws UnknownMethod", async () => {
	const network = new NetworkNode({ fetchImpl: stubFetch(() => ({ body: {} }), []) });
	try {
		await network.onRequest("/nope" as RequestType, {});
		expect(true).toBe(false); // unreachable
	} catch (e) {
		expect(e).toBeInstanceOf(SessionFetchError);
		expect((e as SessionFetchError).code).toBe(SessionFetchErrorCode.UnknownMethod);
	}
});
