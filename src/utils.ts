import { SessionValidationError, SessionValidationErrorCode } from "@session.js/errors";

export function removePrefixIfNeeded(prependedPublicKey: Uint8Array): Uint8Array;
export function removePrefixIfNeeded(sessionID: string): string;
export function removePrefixIfNeeded(input: string | Uint8Array): string | Uint8Array {
	if (typeof input === "string" && input.startsWith("05")) {
		return input.slice(2);
	} else if (input instanceof Uint8Array && input[0] === 5) {
		return input.slice(1);
	}
	return input;
}

export class Deferred<T = void> {
	promise: Promise<T>;
	resolve!: (value: T | PromiseLike<T>) => void;
	reject!: (reason?: T | PromiseLike<T>) => void;
	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

export function checkStorage(storage: unknown) {
	if (typeof storage !== "object" || storage === null) {
		throw new SessionValidationError({
			code: SessionValidationErrorCode.InvalidOptions,
			message: "Provided storage is invalid",
		});
	}
	const storageObj = storage as { [key: string]: unknown };
	["get", "set", "delete", "has"].forEach((method) => {
		if (!(method in storageObj) || typeof storageObj[method] !== "function") {
			throw new SessionValidationError({
				code: SessionValidationErrorCode.InvalidOptions,
				message: `Provided storage does not have method ${method}`,
			});
		}
	});
}

export function checkNetwork(network: unknown) {
	if (typeof network !== "object" || network === null) {
		throw new SessionValidationError({
			code: SessionValidationErrorCode.InvalidOptions,
			message: "Provided network is invalid",
		});
	}

	const storageObj = network as { [key: string]: unknown };
	["onRequest"].forEach((method) => {
		if (!(method in storageObj) || typeof storageObj[method] !== "function") {
			throw new SessionValidationError({
				code: SessionValidationErrorCode.InvalidOptions,
				message: `Provided network does not have method ${method}`,
			});
		}
	});
}

export function getPlaceholderDisplayName(sessionID: string): string {
	return `(${sessionID.slice(0, 4)}...${sessionID.slice(-4)})`;
}
